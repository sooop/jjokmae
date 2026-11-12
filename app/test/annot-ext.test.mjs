// 8단계 준비: 이미지 스탬프·텍스트 quad·주석 속성 수정 시험(MuPDF·PDFium 공통). 실행: node --test test/annot-ext.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { createPdfiumAdapter } from '../src/engine/pdfium-adapter.ts';
import { MupdfAdapter } from '../src/engine/mupdf-adapter.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const KO = fs.readFileSync(path.join(root, 'harness/samples/ko_embedded.pdf'));
const SCAN = fs.readFileSync(path.join(root, 'harness/samples/scan.pdf'));
const WASM = fs.readFileSync(path.join(root, 'app/node_modules/@embedpdf/pdfium/dist/pdfium.wasm'));

const mu = new MupdfAdapter();
await mu.init();
const pd = createPdfiumAdapter({ wasmBinary: WASM });
await pd.init();
const ENGINES = [mu, pd];

function makePng(w, h, fn) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(fn(x, y), y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (t, d) => {
    const b = Buffer.alloc(12 + d.length);
    b.writeUInt32BE(d.length, 0);
    b.write(t, 4, 'latin1');
    d.copy(b, 8);
    b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + d.length)) >>> 0, 8 + d.length);
    return b;
  };
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0);
  ih.writeUInt32BE(h, 4);
  ih[8] = 8;
  ih[9] = 6;
  return new Uint8Array(
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
  );
}
/** 왼쪽 절반 불투명 빨강, 오른쪽 절반 반투명 파랑 */
const PNG = makePng(40, 20, (x) => (x < 20 ? [255, 0, 0, 255] : [0, 0, 255, 128]));
function makeJpeg() {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 32, 32], false);
  const px = pix.getPixels();
  for (let i = 0; i < 32 * 32; i++) {
    px[i * 3] = 0;
    px[i * 3 + 1] = 200;
    px[i * 3 + 2] = 0;
  }
  return pix.asJPEG(95, false).slice();
}

async function pixel(A, id, page, x, y) {
  const b = await A.renderPage(id, page, 1);
  const d = new Uint8Array(b.data);
  const o = (Math.floor(y) * b.width + Math.floor(x)) * 4;
  return [d[o], d[o + 1], d[o + 2]];
}
/** 사각형 안에서 조건을 만족하는 화소 비율 */
async function ratio(A, id, page, r, pred) {
  const b = await A.renderPage(id, page, 1);
  const d = new Uint8Array(b.data);
  let hit = 0;
  let tot = 0;
  for (let y = Math.ceil(r.y); y < Math.floor(r.y + r.height); y++) {
    for (let x = Math.ceil(r.x); x < Math.floor(r.x + r.width); x++) {
      const o = (y * b.width + x) * 4;
      tot++;
      if (pred(d[o], d[o + 1], d[o + 2])) hit++;
    }
  }
  return tot ? hit / tot : 0;
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} ≈ ${b} (±${tol})`);
const yellowish = (r, g, b) => r > 200 && g > 200 && b < 170;
const bbox = (q) => ({ x0: Math.min(q[0], q[2], q[4], q[6]), x1: Math.max(q[0], q[2], q[4], q[6]), y0: Math.min(q[1], q[3], q[5], q[7]), y1: Math.max(q[1], q[3], q[5], q[7]) });

for (const A of ENGINES) {
  test(`${A.name}: PNG 이미지 스탬프 — 추가·읽기·렌더·이동/크기·저장 재로드`, async () => {
    const id = await A.open(KO);
    const rect = { x: 100, y: 100, width: 200, height: 100 };
    const st = await A.addAnnotation(id, 0, { type: 'stamp', rect, extra: { image: { bytes: PNG, mime: 'image/png' } }, contents: 'sig' });
    assert.equal(st.type, 'stamp');
    near(st.rect.x, 100, 0.5, 'x');
    near(st.rect.width, 200, 0.5, 'w');
    near(st.rect.height, 100, 0.5, 'h');
    // 왼쪽 절반은 불투명 빨강(아래 글자를 가린다), 오른쪽 절반은 파랑 쪽
    const left = await pixel(A, id, 0, 140, 150);
    assert.ok(left[0] > 240 && left[1] < 20 && left[2] < 20, `불투명 빨강: ${left}`);
    const right = await pixel(A, id, 0, 260, 150);
    assert.ok(right[2] > right[0] + 40, `반투명 파랑이 섞임: ${right}`);
    assert.deepEqual(await pixel(A, id, 0, 400, 400), (await pixel(A, id, 0, 400, 400)));
    // 목록에서 stamp 로 노출
    const l = await A.listAnnotations(id, 0);
    assert.equal(l.filter((a) => a.type === 'stamp').length, 1);
    // 이동·크기: AP 가 새 rect 로 늘어나 그려진다
    await A.updateAnnotation(id, 0, { ...st, rect: { x: 100, y: 400, width: 100, height: 50 } });
    const moved = (await A.listAnnotations(id, 0)).find((a) => a.id === st.id);
    near(moved.rect.y, 400, 0.5, 'moved y');
    near(moved.rect.width, 100, 0.5, 'moved w');
    const mv = await pixel(A, id, 0, 120, 425);
    assert.ok(mv[0] > 240 && mv[1] < 20, `이동한 곳이 빨강: ${mv}`);
    const old = await pixel(A, id, 0, 140, 150);
    assert.ok(!(old[0] > 240 && old[1] < 20 && old[2] < 20), `원래 자리는 비었다: ${old}`);
    // 저장 → 재로드 후에도 stamp 이고 그려진다
    const out = await A.save(id, { incremental: true });
    const id2 = await A.open(out.bytes);
    const l2 = await A.listAnnotations(id2, 0);
    assert.equal(l2.filter((a) => a.type === 'stamp').length, 1);
    const mv2 = await pixel(A, id2, 0, 120, 425);
    assert.ok(mv2[0] > 240 && mv2[1] < 20, `재로드 렌더: ${mv2}`);
    await A.close(id2);
    await A.close(id);
  });

  test(`${A.name}: JPEG 이미지 스탬프`, async () => {
    const id = await A.open(KO);
    await A.addAnnotation(id, 0, { type: 'stamp', rect: { x: 100, y: 600, width: 64, height: 64 }, extra: { image: { bytes: makeJpeg(), mime: 'image/jpeg' } } });
    const p = await pixel(A, id, 0, 130, 630);
    assert.ok(p[1] > 150 && p[0] < 80 && p[2] < 80, `초록: ${p}`);
    await A.close(id);
  });

  test(`${A.name}: 이미지 스탬프 오류 — 이미지 없음·형식 불일치·깨진 데이터는 거부하고 주석을 남기지 않는다`, async () => {
    const id = await A.open(KO);
    const base = (await A.listAnnotations(id, 0)).length;
    const r = { x: 10, y: 10, width: 20, height: 20 };
    await assert.rejects(() => A.addAnnotation(id, 0, { type: 'stamp', rect: r }), /extra\.image/);
    await assert.rejects(() => A.addAnnotation(id, 0, { type: 'stamp', rect: r, extra: { image: { bytes: PNG, mime: 'image/jpeg' } } }));
    await assert.rejects(() => A.addAnnotation(id, 0, { type: 'stamp', rect: r, extra: { image: { bytes: new Uint8Array([1, 2, 3, 4]), mime: 'image/png' } } }));
    assert.equal((await A.listAnnotations(id, 0)).length, base);
    await A.close(id);
  });

  test(`${A.name}: pageText·textQuads — 한글 문서에서 알려진 줄 위의 quad`, async () => {
    const id = await A.open(KO);
    const text = await A.pageText(id, 0);
    assert.ok(text.replace(/\s/g, '').includes('가나다라마바사아자차카타파하'), '쪽 텍스트');
    // 3번째 본문 줄은 y 87..104, 4번째는 104..122(페이지 공간). 3행 중간에서 4행 중간까지 드래그
    const from = { x: 100, y: 95 };
    const to = { x: 300, y: 113 };
    const q = await A.textQuads(id, 0, from, to);
    assert.equal(q.length, 2, `줄 단위 quad 2개: ${JSON.stringify(q)}`);
    const [b1, b2] = q.map(bbox);
    assert.ok(q.every((v) => v.length === 8));
    // 각 quad 의 세로 중심이 해당 줄 안에 있다
    const c1 = (b1.y0 + b1.y1) / 2;
    const c2 = (b2.y0 + b2.y1) / 2;
    assert.ok(c1 > 87 && c1 < 104, `1줄 중심 ${c1}`);
    assert.ok(c2 > 104 && c2 < 122, `2줄 중심 ${c2}`);
    assert.ok(b1.y1 - b1.y0 > 10 && b1.y1 - b1.y0 < 22, `줄 높이 ${b1.y1 - b1.y0}`);
    // 가로: 첫 줄은 시작점 근처부터 줄 끝까지, 둘째 줄은 줄 처음부터 끝점 근처까지
    near(b1.x0, 100, 14, '1줄 시작');
    assert.ok(b1.x1 > 470, `1줄 끝 ${b1.x1}`);
    near(b2.x0, 56.8, 3, '2줄 시작');
    near(b2.x1, 300, 14, '2줄 끝');
    // 한 줄 안의 드래그는 quad 1개, from/to 를 바꿔도 같다
    const one = await A.textQuads(id, 0, { x: 100, y: 95 }, { x: 200, y: 96 });
    assert.equal(one.length, 1);
    assert.deepEqual(await A.textQuads(id, 0, to, from), q);
    // 글자가 없는 곳: 빈 여백 한가운데 끝점끼리(아래 여백)
    assert.deepEqual(await A.textQuads(id, 0, { x: 5, y: 835 }, { x: 8, y: 838 }), []);
    // 그 quad 로 하이라이트 추가 → 노랗게 칠해지고 rect 는 quad 경계와 같다
    const hl = await A.addAnnotation(id, 0, { type: 'highlight', rect: { x: 0, y: 0, width: 1, height: 1 }, quadPoints: q, color: '#ffeb00' });
    assert.equal(hl.type, 'highlight');
    const hb = { x0: Math.min(b1.x0, b2.x0), y0: b1.y0, x1: Math.max(b1.x1, b2.x1), y1: b2.y1 };
    near(hl.rect.x, hb.x0, 0.5, 'hl.rect.x');
    near(hl.rect.y, hb.y0, 0.5, 'hl.rect.y');
    near(hl.rect.x + hl.rect.width, hb.x1, 0.5, 'hl.rect.right');
    near(hl.rect.y + hl.rect.height, hb.y1, 0.5, 'hl.rect.bottom');
    const r1 = await ratio(A, id, 0, { x: b1.x0 + 2, y: b1.y0 + 2, width: b1.x1 - b1.x0 - 4, height: b1.y1 - b1.y0 - 4 }, yellowish);
    const r2 = await ratio(A, id, 0, { x: b2.x0 + 2, y: b2.y0 + 2, width: b2.x1 - b2.x0 - 4, height: b2.y1 - b2.y0 - 4 }, yellowish);
    assert.ok(r1 > 0.35 && r2 > 0.35, `하이라이트 노란 비율 ${r1.toFixed(2)} / ${r2.toFixed(2)}`);
    // 노랗지 않은 화소는 글자 획(어두운 화소)뿐이어야 한다
    const dark = (r, g, b) => yellowish(r, g, b) || (r < 140 && g < 140 && b < 140) || (r > 120 && g > 120 && b < 200 && r - b > 20);
    const d1 = await ratio(A, id, 0, { x: b1.x0 + 2, y: b1.y0 + 2, width: b1.x1 - b1.x0 - 4, height: b1.y1 - b1.y0 - 4 }, dark);
    assert.ok(d1 > 0.9, `하이라이트 영역에 흰 구멍이 없다 ${d1.toFixed(2)}`);
    const outside = await ratio(A, id, 0, { x: 60, y: 240, width: 300, height: 14 }, yellowish);
    assert.ok(outside < 0.02, `다른 줄은 칠해지지 않음 ${outside}`);
    // 저장·재로드 뒤 하이라이트 rect 도 같다
    const out = await A.save(id, { incremental: false });
    const id2 = await A.open(out.bytes);
    const re = (await A.listAnnotations(id2, 0)).find((a) => a.type === 'highlight');
    near(re.rect.x, hb.x0, 0.5, '재로드 rect.x');
    near(re.rect.height, hb.y1 - hb.y0, 0.5, '재로드 rect.h');
    assert.equal(re.quadPoints.length, 2);
    await A.close(id2);
    await A.close(id);
  });

  test(`${A.name}: 스캔본은 글자가 없어 빈 배열`, async () => {
    const id = await A.open(SCAN);
    assert.equal((await A.pageText(id, 0)).trim(), '');
    assert.deepEqual(await A.textQuads(id, 0, { x: 50, y: 50 }, { x: 300, y: 300 }), []);
    await A.close(id);
  });

  test(`${A.name}: updateAnnotation — 색·내용·rect 이동·크기 (highlight/square/circle/freetext/ink/line)`, async () => {
    const id = await A.open(KO);
    const specs = {
      highlight: { type: 'highlight', rect: { x: 60, y: 120, width: 270, height: 22 }, color: '#ffeb00', contents: 'a' },
      square: { type: 'square', rect: { x: 60, y: 200, width: 100, height: 50 }, color: '#ff0000', contents: 'a' },
      circle: { type: 'circle', rect: { x: 60, y: 300, width: 100, height: 50 }, color: '#ff0000', contents: 'a' },
      freetext: { type: 'freetext', rect: { x: 60, y: 450, width: 150, height: 30 }, color: '#000000', contents: 'a', extra: { fontSize: 12 } },
    };
    if (A.name === 'pdfium') {
      specs.ink = { type: 'ink', rect: { x: 300, y: 600, width: 50, height: 50 }, color: '#ff0000', extra: { strokes: [[300, 600, 350, 650, 330, 610]] } };
      specs.line = { type: 'line', rect: { x: 300, y: 700, width: 100, height: 40 }, color: '#0000ff', extra: { start: [300, 700], end: [400, 740] } };
    }
    for (const [k, sp] of Object.entries(specs)) {
      const a = await A.addAnnotation(id, 0, sp);
      const nr = { x: a.rect.x + 30, y: a.rect.y + 20, width: a.rect.width + 20, height: a.rect.height + 10 };
      await A.updateAnnotation(id, 0, { ...a, color: '#00ff00', contents: 'changed', rect: nr });
      const b = (await A.listAnnotations(id, 0)).find((x) => x.id === a.id);
      assert.ok(b, `${k} 유지`);
      assert.equal(b.color, '#00ff00', `${k} 색`);
      assert.equal(b.contents, 'changed', `${k} 내용`);
      // ink 의 rect 는 획 경계 + 선 두께 여백이라 크기가 몇 pt 어긋날 수 있다
      const tol = k === 'ink' ? 3.5 : 1.5;
      near(b.rect.x, nr.x, tol, `${k} rect.x`);
      near(b.rect.y, nr.y, tol, `${k} rect.y`);
      near(b.rect.width, nr.width, tol, `${k} rect.w`);
      near(b.rect.height, nr.height, tol, `${k} rect.h`);
    }
    // 하이라이트: rect 이동 뒤 렌더가 새 위치에서 노랗다(quad 가 따라 움직인다)
    const hl = (await A.listAnnotations(id, 0)).find((x) => x.type === 'highlight');
    await A.updateAnnotation(id, 0, { ...hl, color: '#ffeb00' });
    const rr = hl.rect;
    const ry = await ratio(A, id, 0, { x: rr.x + 2, y: rr.y + 2, width: rr.width - 4, height: rr.height - 4 }, yellowish);
    assert.ok(ry > 0.5, `이동한 하이라이트 렌더 ${ry}`);
    await A.close(id);
  });

  test(`${A.name}: text(메모) 주석은 크기가 고정이다 — 색·내용은 바뀌고 위치는 따라간다`, async () => {
    const id = await A.open(KO);
    const a = await A.addAnnotation(id, 0, { type: 'text', rect: { x: 60, y: 400, width: 24, height: 24 }, color: '#ffc800', contents: 'n' });
    await A.updateAnnotation(id, 0, { ...a, color: '#00ff00', contents: 'changed', rect: { ...a.rect, x: a.rect.x + 50 } });
    const b = (await A.listAnnotations(id, 0)).find((x) => x.id === a.id);
    assert.equal(b.color, '#00ff00');
    assert.equal(b.contents, 'changed');
    near(b.rect.x, a.rect.x + 50, 1, 'x');
    near(b.rect.width, a.rect.width, 0.5, '크기 고정(width)');
    await A.close(id);
  });
}
