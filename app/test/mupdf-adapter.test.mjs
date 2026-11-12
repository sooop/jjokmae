// 실행: cd app && node --test test/   (Node 24 타입 스트리핑으로 .ts 를 직접 import)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MupdfAdapter } from '../src/engine/mupdf-adapter.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const H = path.resolve(here, '../../harness');
const SAMPLES = ['ko_embedded', 'ko_nonembedded', 'scan'].map((n) => ({ n, f: path.join(H, 'samples', n + '.pdf') }));
const FORM = path.join(H, 'out2/fixtures/form.pdf');
const SIGNED = path.join(H, 'out2/fixtures/signed.pdf');
// 산출물(PNG·PDF) 위치. PDFEDIT_TEST_OUT 으로 지정, 없으면 OS 임시 폴더
const OUT = process.env.PDFEDIT_TEST_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mupdf-adapter-'));
fs.mkdirSync(OUT, { recursive: true });

const read = (f) => new Uint8Array(fs.readFileSync(f));
const adapter = new MupdfAdapter();
await adapter.init();

function qpdfCheck(bytes, name) {
  const f = path.join(OUT, name);
  fs.writeFileSync(f, bytes);
  const r = spawnSync('qpdf', ['--check', f], { encoding: 'utf8' });
  const n = spawnSync('qpdf', ['--show-npages', f], { encoding: 'utf8' });
  return { exit: r.status, out: r.stdout + r.stderr, pages: Number(n.stdout.trim()) };
}

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (t, d) => {
    const b = Buffer.alloc(12 + d.length);
    b.writeUInt32BE(d.length, 0);
    b.write(t, 4, 'ascii');
    d.copy(b, 8);
    b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + d.length)), 8 + d.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const startsWith = (out, base) => Buffer.compare(Buffer.from(out.subarray(0, base.length)), Buffer.from(base)) === 0;

for (const { n, f } of SAMPLES) {
  test(`열기·크기·그리기·저장: ${n}`, async () => {
    const id = await adapter.open(read(f));
    const pc = await adapter.pageCount(id);
    assert.ok(pc >= 1);
    const sz = await adapter.pageSize(id, 0);
    for (const scale of [1, 2]) {
      const bmp = await adapter.renderPage(id, 0, scale);
      assert.equal(bmp.width, Math.ceil(sz.width * scale));
      assert.equal(bmp.height, Math.ceil(sz.height * scale));
      assert.equal(bmp.data.byteLength, bmp.width * bmp.height * 4);
    }
    const bmp = await adapter.renderPage(id, 0, 1);
    const px = new Uint8Array(bmp.data);
    let ink = 0;
    let opaque = true;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] !== 255) opaque = false;
      if (px[i] < 200 || px[i + 1] < 200 || px[i + 2] < 200) ink++;
    }
    assert.ok(opaque, '배경이 불투명 흰색이어야 한다');
    assert.ok(ink > 100, `내용이 그려져야 한다(ink=${ink})`);
    fs.writeFileSync(path.join(OUT, `${n}.adapter.png`), png(bmp.width, bmp.height, px));
    const s = await adapter.save(id, { incremental: false });
    const q = qpdfCheck(s.bytes, `${n}.full.pdf`);
    assert.equal(q.exit, 0, q.out);
    assert.equal(q.pages, pc);
    assert.equal(s.fullFallback, false);
    await adapter.close(id);
  });
}

test('회전(절대값)·pageSize 반영', async () => {
  const id = await adapter.open(read(SAMPLES[0].f));
  const s0 = await adapter.pageSize(id, 0);
  await adapter.rotatePage(id, 0, 90);
  const s90 = await adapter.pageSize(id, 0);
  assert.ok(Math.abs(s90.width - s0.height) < 0.01 && Math.abs(s90.height - s0.width) < 0.01);
  const b = await adapter.renderPage(id, 0, 1);
  assert.equal(b.width, Math.ceil(s90.width));
  await adapter.rotatePage(id, 0, 90); // 절대값이므로 누적되지 않는다
  assert.deepEqual(await adapter.pageSize(id, 0), s90);
  await adapter.rotatePage(id, 0, 0);
  assert.deepEqual(await adapter.pageSize(id, 0), s0);
  const q = qpdfCheck((await adapter.save(id, { incremental: false })).bytes, 'rot.pdf');
  assert.equal(q.exit, 0, q.out);
  await adapter.close(id);
});

test('병합·이동·삭제(내림차순)', async () => {
  const scan = await adapter.open(read(SAMPLES[2].f));
  const ko = await adapter.open(read(SAMPLES[0].f));
  const koN = await adapter.pageCount(ko);
  const scanN = await adapter.pageCount(scan);
  await adapter.importPages(ko, scan, Array.from({ length: scanN }, (_, i) => i), 0);
  assert.equal(await adapter.pageCount(ko), koN + scanN);
  await adapter.importPages(ko, scan, [0]);
  const total = koN + scanN + 1;
  assert.equal(await adapter.pageCount(ko), total);
  const sizes = async () => {
    const r = [];
    for (let i = 0; i < total; i++) r.push(JSON.stringify(await adapter.pageSize(ko, i)));
    return r;
  };
  const before = await sizes();
  await adapter.movePage(ko, total - 1, 0);
  assert.deepEqual(await sizes(), [before.at(-1), ...before.slice(0, -1)]);
  await adapter.deletePages(ko, [0, 1, 0]); // 순서 무관·중복 허용
  assert.equal(await adapter.pageCount(ko), total - 2);
  await assert.rejects(() => adapter.deletePages(ko, [999]));
  const res = await adapter.save(ko, { incremental: false, garbageCollect: true });
  const q = qpdfCheck(res.bytes, 'merge.pdf');
  assert.equal(q.exit, 0, q.out);
  assert.equal(q.pages, total - 2);
  await adapter.close(ko);
  await adapter.close(scan);
});

test('삭제 후 garbageCollect 로 크기 감소(scan 2쪽 중 1쪽 삭제)', async () => {
  const id = await adapter.open(read(SAMPLES[2].f));
  await adapter.deletePages(id, [1]);
  // garbage 저장은 메모리 문서를 재배열하므로 일반 저장을 먼저 한다
  const plain = await adapter.save(id, { incremental: false });
  const gc = await adapter.save(id, { incremental: false, garbageCollect: true });
  assert.ok(gc.bytes.length < plain.bytes.length * 0.7, `gc=${gc.bytes.length} plain=${plain.bytes.length}`);
  assert.equal(qpdfCheck(gc.bytes, 'scan.gc.pdf').pages, 1);
  await adapter.close(id);
});

test('주석 4종 추가·읽기·수정·삭제·저장·재로드', async () => {
  const id = await adapter.open(read(SAMPLES[0].f));
  const cleanId = await adapter.open(read(SAMPLES[0].f));
  const base = (await adapter.listAnnotations(id, 0)).length;
  const specs = [
    { type: 'highlight', rect: { x: 60, y: 120, width: 270, height: 22 }, color: '#ffeb00', contents: 'Highlight 하이라이트' },
    { type: 'square', rect: { x: 60, y: 200, width: 200, height: 60 }, color: '#ff0000', contents: 'Square' },
    { type: 'text', rect: { x: 350, y: 120, width: 20, height: 20 }, color: '#ffc800', contents: '메모 note 한글' },
    { type: 'freetext', rect: { x: 60, y: 300, width: 270, height: 40 }, color: '#000000', contents: 'FreeText ABC', extra: { fontSize: 14 } },
    { type: 'freetext', rect: { x: 60, y: 370, width: 270, height: 40 }, color: '#000000', contents: '한글 프리텍스트 가나다' },
  ];
  const added = [];
  for (const s of specs) {
    const a = await adapter.addAnnotation(id, 0, s);
    assert.equal(a.type, s.type);
    assert.equal(a.contents, s.contents);
    added.push(a);
  }
  const list = await adapter.listAnnotations(id, 0);
  assert.equal(list.length, base + 5, 'Popup 은 숨겨져야 한다: ' + list.map((a) => a.extra.subtype));
  assert.ok(!list.some((a) => a.extra.subtype === 'Popup'));
  assert.equal(new Set(list.map((a) => a.id)).size, list.length);
  assert.ok(list.find((a) => a.type === 'highlight').quadPoints.length >= 1);
  const clean = new Uint8Array((await adapter.renderPage(cleanId, 0, 1)).data);
  const withA = new Uint8Array((await adapter.renderPage(id, 0, 1)).data);
  let diff = 0;
  for (let i = 0; i < clean.length; i++) if (clean[i] !== withA[i]) diff++;
  assert.ok(diff > 500, `주석이 렌더에 나타나야 한다 diff=${diff}`);
  const sq = added[1];
  await adapter.updateAnnotation(id, 0, { ...sq, rect: { ...sq.rect, x: 80 }, contents: 'Square 수정' });
  const sq2 = (await adapter.listAnnotations(id, 0)).find((a) => a.id === sq.id);
  assert.equal(sq2.contents, 'Square 수정');
  assert.ok(Math.abs(sq2.rect.x - 80) < 0.5);
  const bytes = (await adapter.save(id, { incremental: false })).bytes;
  assert.equal(qpdfCheck(bytes, 'annot.pdf').exit, 0);
  const id2 = await adapter.open(bytes);
  const re = await adapter.listAnnotations(id2, 0);
  assert.equal(re.length, base + 5);
  assert.ok(re.some((a) => a.contents === '한글 프리텍스트 가나다'));
  const text = re.find((a) => a.type === 'text');
  await adapter.deleteAnnotation(id2, 0, text.id);
  assert.equal((await adapter.listAnnotations(id2, 0)).length, base + 4);
  await assert.rejects(() => adapter.deleteAnnotation(id2, 0, text.id));
  for (const d of [id, id2, cleanId]) await adapter.close(d);
});

test('양식: 열거·값 쓰기·재로드', async () => {
  const id = await adapter.open(read(FORM));
  const fields = await adapter.listFormFields(id);
  const names = fields.map((f) => f.name);
  assert.ok(names.includes('name') && names.includes('memo'), names.join(','));
  assert.equal(fields.find((f) => f.name === 'name').kind, 'text');
  await adapter.setFormFieldValue(id, 'name', 'Hello 123');
  await adapter.setFormFieldValue(id, 'memo', '홍길동 한글 값');
  await assert.rejects(() => adapter.setFormFieldValue(id, 'nope', 'x'));
  const res = await adapter.save(id, { incremental: false });
  assert.equal(qpdfCheck(res.bytes, 'form.pdf').exit, 0);
  const id2 = await adapter.open(res.bytes);
  const f2 = await adapter.listFormFields(id2);
  assert.equal(f2.find((f) => f.name === 'name').value, 'Hello 123');
  assert.equal(f2.find((f) => f.name === 'memo').value, '홍길동 한글 값');
  console.log('  form 주석 목록 유형:', JSON.stringify((await adapter.listAnnotations(id2, 0)).map((a) => a.extra.subtype)));
  await adapter.close(id);
  await adapter.close(id2);
});

test('flatten: 주석·양식이 구워지고 라이브 문서는 유지', async () => {
  const id = await adapter.open(read(FORM));
  await adapter.setFormFieldValue(id, 'name', 'Flat Value');
  await adapter.addAnnotation(id, 0, { type: 'square', rect: { x: 50, y: 50, width: 80, height: 40 }, color: '#00aa00' });
  const flat = await adapter.save(id, { incremental: false, flatten: true });
  assert.equal(qpdfCheck(flat.bytes, 'flat.pdf').exit, 0);
  const idF = await adapter.open(flat.bytes);
  assert.equal((await adapter.listFormFields(idF)).length, 0);
  assert.equal((await adapter.listAnnotations(idF, 0)).length, 0);
  assert.ok((await adapter.listFormFields(id)).length > 0, '라이브 문서는 굽지 않는다');
  const a = new Uint8Array((await adapter.renderPage(id, 0, 1)).data);
  const b = new Uint8Array((await adapter.renderPage(idF, 0, 1)).data);
  let d = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 40) d++;
  assert.ok(d < (a.length / 4) * 0.01, `flatten 전후 렌더 차이 화소=${d}`);
  await adapter.close(id);
  await adapter.close(idF);
});

test('서명 PDF 증분 저장: 원본 접두 보존·fullFallback=false', async () => {
  const orig = read(SIGNED);
  const id = await adapter.open(orig);
  const fields = await adapter.listFormFields(id);
  assert.ok(fields.some((f) => f.kind === 'signature'), '서명 필드 열거');
  await adapter.addAnnotation(id, 0, { type: 'text', rect: { x: 300, y: 100, width: 20, height: 20 }, color: '#ffc800', contents: 'after-sign note' });
  await adapter.setFormFieldValue(id, 'name', 'Filled After Sign');
  const res = await adapter.save(id, { incremental: true });
  assert.equal(res.fullFallback, false);
  assert.ok(res.bytes.length > orig.length);
  assert.ok(startsWith(res.bytes, orig), '원본 접두 보존');
  assert.equal(qpdfCheck(res.bytes, 'signed.incr.pdf').exit, 0);
  const id2 = await adapter.open(orig);
  const same = await adapter.save(id2, { incremental: true });
  assert.equal(same.bytes.length, orig.length); // 편집 없음 → 무변경
  const full = await adapter.save(id, { incremental: false });
  assert.ok(!startsWith(full.bytes, orig), '전체 저장은 접두가 깨진다(서명 무효화)');
  await adapter.close(id);
  await adapter.close(id2);
});

test('증분 요청 후 페이지 조작 케이스 실측', async () => {
  const rows = [];
  const cases = [
    ['삭제', (id) => adapter.deletePages(id, [1])],
    ['이동', (id) => adapter.movePage(id, 1, 0)],
    ['회전', (id) => adapter.rotatePage(id, 0, 90)],
    ['병합', async (id) => {
      const s = await adapter.open(read(SAMPLES[0].f));
      await adapter.importPages(id, s, [0]);
    }],
  ];
  for (const [label, edit] of cases) {
    const orig = read(SAMPLES[2].f);
    const id = await adapter.open(orig);
    await edit(id);
    const r = await adapter.save(id, { incremental: true });
    const pre = startsWith(r.bytes, orig);
    const q = qpdfCheck(r.bytes, `incr.${label}.pdf`);
    rows.push({ label, fullFallback: r.fullFallback, prefix: pre, qpdf: q.exit, pages: q.pages });
    assert.equal(q.exit, 0, q.out);
    if (!r.fullFallback) assert.ok(pre, '증분이라 보고했다면 접두가 보존되어야 한다');
    await adapter.close(id);
  }
  console.log('  증분 요청 결과:', JSON.stringify(rows));
  await assert.rejects(() => adapter.open(new Uint8Array([1, 2, 3, 4])));
});

// ---- 자원 해제(WASM 쪽 객체) ----
import * as mupdfLib from 'mupdf';

/** 클래스 프로토타입의 destroy 호출 수를 센다 */
function countDestroy(Cls, fn) {
  const orig = Cls.prototype.destroy;
  let n = 0;
  Cls.prototype.destroy = function (...a) { n++; return orig.apply(this, a); };
  return Promise.resolve()
    .then(fn)
    .then(
      (v) => ({ n, v }),
      (e) => { throw e; },
    )
    .finally(() => { Cls.prototype.destroy = orig; });
}

test('save 마다 WASM Buffer 를 destroy 한다(증분·전체·굽기)', async () => {
  const id = await adapter.open(read(SAMPLES[0].f));
  await adapter.addAnnotation(id, 0, { type: 'square', rect: { x: 40, y: 40, width: 60, height: 30 }, color: '#ff0000' });
  const { n } = await countDestroy(mupdfLib.Buffer, async () => {
    await adapter.save(id, { incremental: false });
    await adapter.save(id, { incremental: true });
    await adapter.save(id, { incremental: false, flatten: true });
  });
  // 저장 호출마다 최소 1개(검증용 재열기 등이 더 destroy 할 수 있다). 수정 전에는 0 이었다
  assert.ok(n >= 4, `Buffer.destroy 호출 수 ${n}`);
  await adapter.close(id);
});

test('addAnnotation: 이미지 스탬프는 쪽 번호가 틀려 콜백 전에 던져도 Image 를 해제한다', async () => {
  const id = await adapter.open(read(SAMPLES[0].f));
  const img = { bytes: new Uint8Array(png(4, 4, new Uint8Array(4 * 4 * 4).fill(200))), mime: 'image/png' };
  const stamp = { type: 'stamp', rect: { x: 10, y: 10, width: 20, height: 20 }, extra: { image: img } };
  const bad = await countDestroy(mupdfLib.Image, () => adapter.addAnnotation(id, 999, stamp).catch((e) => e));
  assert.ok(bad.v instanceof Error && /범위/.test(bad.v.message));
  assert.equal(bad.n, 1, '던진 경우에도 Image.destroy 1회');
  const good = await countDestroy(mupdfLib.Image, () => adapter.addAnnotation(id, 0, stamp));
  assert.equal(good.n, 1, '정상 경우에도 1회');
  await adapter.close(id);
});

test('deletePages([]) 는 deletedData 를 켜지 않는다', async () => {
  const id = await adapter.open(read(SAMPLES[2].f));
  await adapter.deletePages(id, []);
  const r = await adapter.save(id, { incremental: true });
  assert.ok(!(r.notes ?? []).some((x) => /삭제/.test(x)));
  await adapter.close(id);
});
