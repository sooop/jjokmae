// PDFium 어댑터 통합 테스트. 실행: node --test app/test/pdfium-adapter.test.mjs (Node 24 타입 스트리핑으로 .ts 직접 import)
// 환경변수: PDFIUM_TEST_OUT = 렌더 PNG 저장 폴더(기본: OS 임시 폴더)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPdfiumAdapter } from '../src/engine/pdfium-adapter.ts';
import { MupdfAdapter } from '../src/engine/mupdf-adapter.ts';
import { buildRadioPdf } from './form-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const WASM = path.join(root, 'app', 'node_modules', '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm');
const SAMPLES = path.join(root, 'harness', 'samples');
const FIX = path.join(root, 'harness', 'out2', 'fixtures');
const OUT = process.env.PDFIUM_TEST_OUT || os.tmpdir();
const MALGUN = 'C:/Windows/Fonts/malgun.ttf';

const wasmBinary = fs.readFileSync(WASM);
const sample = (n) => fs.readFileSync(path.join(SAMPLES, n + '.pdf'));
const fixture = (n) => fs.readFileSync(path.join(FIX, n + '.pdf'));

// ---------- 도구 ----------
const hasQpdf = spawnSync('qpdf', ['--version']).status === 0;
let tmpSeq = 0;
function qpdfCheck(bytes) {
  if (!hasQpdf) return { exit: 0, skipped: true, npages: null };
  const f = path.join(os.tmpdir(), `pdfium-adapter-test-${process.pid}-${++tmpSeq}.pdf`);
  fs.writeFileSync(f, bytes);
  try {
    const chk = spawnSync('qpdf', ['--check', f], { encoding: 'utf8' });
    const np = spawnSync('qpdf', ['--show-npages', f], { encoding: 'utf8' });
    return { exit: chk.status, out: chk.stdout + chk.stderr, npages: parseInt(np.stdout, 10) };
  } finally {
    fs.rmSync(f, { force: true });
  }
}
const assertQpdfOk = (bytes, npages) => {
  const r = qpdfCheck(bytes);
  assert.equal(r.exit, 0, 'qpdf --check 실패: ' + r.out);
  if (npages !== undefined && !r.skipped) assert.equal(r.npages, npages, 'qpdf 쪽수');
};

function writePng(file, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
  );
}

const px = (bmp) => new Uint8Array(bmp.data);
/** 어두운(R<128) 화소 수 */
function darkPixels(bmp) {
  const d = px(bmp);
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++;
  return n;
}
/** 두 비트맵의 페이지 공간 사각형(x,y,w,h; 좌상단 원점, y 아래쪽) 영역에서 달라진 화소 수 */
function regionDiff(a, b, rect, scale) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  const x0 = Math.floor(rect.x * scale);
  const x1 = Math.ceil((rect.x + rect.width) * scale);
  const y0 = Math.floor(rect.y * scale);
  const y1 = Math.ceil((rect.y + rect.height) * scale);
  const da = px(a);
  const db = px(b);
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(a.height, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(a.width, x1); x++) {
      const i = (y * a.width + x) * 4;
      if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 30) n++;
    }
  return n;
}

/** 체크박스·라디오·콤보·목록·텍스트 위젯이 있는 최소 AcroForm PDF */
function buildFormPdf(pageExtra = '') {
  const objs = [];
  const stream = (dict, data) => `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`;
  objs[1] = '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 6 0 R 7 0 R 10 0 R 11 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 4 0 R >> >> /NeedAppearances true >> >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' + pageExtra + ' /Resources << /Font << /Helv 4 0 R >> >> /Annots [5 0 R 6 0 R 8 0 R 9 0 R 10 0 R 11 0 R] >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objs[5] = '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [100 700 300 720] /DA (/Helv 12 Tf 0 g) /F 4 /P 3 0 R /MK << /BC [0] >> >>';
  objs[6] = '<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /Rect [100 650 120 670] /V /Off /AS /Off /F 4 /P 3 0 R /MK << /BC [0] /CA (4) >> /DA (/ZaDb 0 Tf 0 g) /AP << /N << /Yes 12 0 R /Off 13 0 R >> >> >>';
  objs[7] = '<< /FT /Btn /Ff 32768 /T (color) /Kids [8 0 R 9 0 R] /V /Off >>';
  objs[8] = '<< /Type /Annot /Subtype /Widget /Parent 7 0 R /Rect [100 600 120 620] /AS /Off /F 4 /P 3 0 R /MK << /BC [0] /CA (l) >> /DA (/ZaDb 0 Tf 0 g) /AP << /N << /red 12 0 R /Off 13 0 R >> >> >>';
  objs[9] = '<< /Type /Annot /Subtype /Widget /Parent 7 0 R /Rect [140 600 160 620] /AS /Off /F 4 /P 3 0 R /MK << /BC [0] /CA (l) >> /DA (/ZaDb 0 Tf 0 g) /AP << /N << /blue 12 0 R /Off 13 0 R >> >> >>';
  objs[10] = '<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (city) /Opt [(Seoul) (Busan) (Daegu)] /V (Seoul) /Rect [100 560 250 580] /DA (/Helv 12 Tf 0 g) /F 4 /P 3 0 R /MK << /BC [0] >> >>';
  objs[11] = '<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 2097152 /T (langs) /Opt [(ko) (en) (ja)] /Rect [100 480 200 540] /DA (/Helv 12 Tf 0 g) /F 4 /P 3 0 R /MK << /BC [0] >> >>';
  objs[12] = stream('/Type /XObject /Subtype /Form /BBox [0 0 20 20]', '0 0 20 20 re 0 0 1 rg f');
  objs[13] = stream('/Type /XObject /Subtype /Form /BBox [0 0 20 20]', '');
  let out = '%PDF-1.7\n';
  const offs = [];
  for (let i = 1; i < objs.length; i++) {
    offs[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const x = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/**
 * 회전·MediaBox·CropBox 를 지정한 1쪽 PDF. 사용자 공간 (ox+20, oy+20) 에 60x30 검은 표식을 그린다(ox,oy = 보이는 영역의 좌하단).
 * media/crop: [x0,y0,x1,y1]
 */
function buildBoxPdf({ rotate = 0, media, crop }) {
  const [ox, oy] = crop ?? media;
  const content = `0 g ${ox + 20} ${oy + 20} 60 30 re f`;
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [${media.join(' ')}] ${crop ? `/CropBox [${crop.join(' ')}]` : ''} /Rotate ${rotate} /Contents 4 0 R /Resources << >> >>`;
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  let out = '%PDF-1.7\n';
  const offs = [];
  for (let i = 1; i < objs.length; i++) {
    offs[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const x = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** 조건에 맞는 화소들의 경계 상자 [x0,y0,x1,y1)(화소 단위). 없으면 null */
function pixelBBox(bmp, pred) {
  const d = px(bmp);
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < bmp.height; y++)
    for (let x = 0; x < bmp.width; x++) {
      const i = (y * bmp.width + x) * 4;
      if (pred(d[i], d[i + 1], d[i + 2])) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x + 1 > x1) x1 = x + 1;
        if (y + 1 > y1) y1 = y + 1;
      }
    }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}
const isRed = (r, g, b) => r > 180 && g < 100 && b < 100;
const isDark = (r, g, b) => r < 60 && g < 60 && b < 60;

const startsWith = (big, prefix) => big.length >= prefix.length && Buffer.compare(Buffer.from(big.subarray(0, prefix.length)), Buffer.from(prefix)) === 0;

let A; // 공용 어댑터(한글 폰트 없음)
let M; // MuPDF 어댑터(좌표 규약 대조용)
const opened = [];
const open = async (bytes, a = A) => {
  const id = await a.open(bytes);
  opened.push([a, id]);
  return id;
};
const sizes = async (id) => {
  const n = await A.pageCount(id);
  const r = [];
  for (let i = 0; i < n; i++) {
    const s = await A.pageSize(id, i);
    r.push(`${Math.round(s.width)}x${Math.round(s.height)}`);
  }
  return r;
};

before(async () => {
  A = createPdfiumAdapter({ wasmBinary });
  await A.init();
  M = new MupdfAdapter();
  await M.init();
  await A.init(); // 두 번째 호출은 무시되어야 한다
});

after(async () => {
  for (const [a, id] of opened) await a.close(id);
  assert.equal(A.openDocCount(), 0, '모든 문서가 close 되어야 한다');
});

describe('문서 열기·그리기', () => {
  test('이름과 초기화 전 호출 오류', async () => {
    assert.equal(A.name, 'pdfium');
    const raw = createPdfiumAdapter({ wasmBinary });
    await assert.rejects(() => raw.open(sample('scan')), /init/);
  });

  for (const name of ['ko_embedded', 'ko_nonembedded', 'scan']) {
    test(`열기·쪽수·크기·렌더: ${name}`, async () => {
      const id = await open(sample(name));
      const n = await A.pageCount(id);
      assert.ok(n >= 1);
      const sz = await A.pageSize(id, 0);
      assert.ok(Math.abs(sz.width - 595) < 2 && Math.abs(sz.height - 842) < 2, JSON.stringify(sz));
      const bmp = await A.renderPage(id, 0, 1.5);
      assert.equal(bmp.width, Math.round(sz.width * 1.5));
      assert.equal(bmp.height, Math.round(sz.height * 1.5));
      assert.equal(bmp.data.byteLength, bmp.width * bmp.height * 4);
      const d = px(bmp);
      assert.equal(d[3], 255);
      assert.ok(darkPixels(bmp) > 100, '내용이 그려져야 한다');
      const big = await A.renderPage(id, 0, 3);
      assert.equal(big.width, Math.round(sz.width * 3));
      await assert.rejects(() => A.renderPage(id, n, 1), RangeError);
      await assert.rejects(() => A.renderPage(id, 0, 0), RangeError);
    });
  }

  test('잘못된 PDF', async () => {
    await assert.rejects(() => A.open(new Uint8Array([1, 2, 3, 4])), /PDF 를 열 수 없다/);
    const n = A.openDocCount();
    await assert.rejects(() => A.open(new Uint8Array([1, 2, 3, 4])));
    assert.equal(A.openDocCount(), n, '실패한 open 이 문서 슬롯을 남기면 안 된다');
  });

  test('close 이후 사용 불가, 이중 close 는 무해', async () => {
    const id = await A.open(sample('scan'));
    await A.close(id);
    await A.close(id);
    await assert.rejects(() => A.pageCount(id), /열려 있지 않은 문서/);
  });
});

describe('한글 폰트 등록', () => {
  const have = fs.existsSync(MALGUN);
  test('폰트 없이는 한글 미내장 CID 폰트가 빈칸, 등록하면 그려진다', { skip: !have && '맑은 고딕 없음' }, async () => {
    const ko = createPdfiumAdapter({ wasmBinary, koreanFont: fs.readFileSync(MALGUN), koreanFontFace: 'Malgun Gothic' });
    await ko.init();
    const id1 = await open(sample('ko_nonembedded'));
    const id2 = await open(sample('ko_nonembedded'), ko);
    const noFont = await A.renderPage(id1, 0, 1.5);
    const withFont = await ko.renderPage(id2, 0, 1.5);
    const a = darkPixels(noFont);
    const b = darkPixels(withFont);
    assert.ok(b > a * 2, `폰트 등록 후 글자 화소가 늘어야 한다 (${a} → ${b})`);
    writePng(path.join(OUT, 'pdfium.ko_nonembedded.nofont.png'), noFont.width, noFont.height, px(noFont));
    writePng(path.join(OUT, 'pdfium.ko_nonembedded.malgun.png'), withFont.width, withFont.height, px(withFont));
  });
});

describe('페이지 조작', () => {
  test('회전', async () => {
    const id = await open(sample('ko_embedded'));
    const before = await A.pageSize(id, 0);
    await A.rotatePage(id, 0, 90);
    const rot = await A.pageSize(id, 0);
    assert.ok(Math.abs(rot.width - before.height) < 0.01 && Math.abs(rot.height - before.width) < 0.01);
    const bmp = await A.renderPage(id, 0, 1);
    assert.equal(bmp.width, Math.round(rot.width));
    await A.rotatePage(id, 0, 0);
    assert.deepEqual(await A.pageSize(id, 0), before);
    await A.rotatePage(id, 0, 180);
    assert.deepEqual(await A.pageSize(id, 0), before);
    await assert.rejects(() => A.rotatePage(id, 0, 45), RangeError);
    await assert.rejects(() => A.rotatePage(id, 99, 90), RangeError);
  });

  test('병합·이동·삭제 + 저장(qpdf, 쪽수)', async () => {
    const d = await open(sample('ko_embedded')); // 2쪽
    const sc = await open(sample('scan')); // 2쪽
    const f = await open(fixture('form')); // 1쪽
    const n0 = await A.pageCount(d);
    await A.importPages(d, f, [0], 1);
    assert.equal(await A.pageCount(d), n0 + 1);
    await A.importPages(d, sc, [0, 1]);
    assert.equal(await A.pageCount(d), n0 + 3);
    await A.rotatePage(d, 0, 90); // 표식: 0번 쪽만 가로
    assert.equal((await sizes(d))[0], '842x595');
    await A.movePage(d, 0, 2);
    assert.deepEqual((await sizes(d)).indexOf('842x595'), 2);
    await A.movePage(d, 2, 0);
    assert.equal((await sizes(d))[0], '842x595');
    await A.deletePages(d, [1, 3, 3]); // 중복 인덱스는 한 번만
    assert.equal(await A.pageCount(d), n0 + 1);
    assert.equal((await sizes(d))[0], '842x595');
    await assert.rejects(() => A.deletePages(d, [99]), RangeError);
    await assert.rejects(() => A.deletePages(d, [...Array(n0 + 1).keys()]), /모든 페이지/);
    await assert.rejects(() => A.importPages(d, d, [0]), /같은 문서/);

    const full = await A.save(d, { incremental: false });
    assert.equal(full.fullFallback, false);
    assertQpdfOk(full.bytes, n0 + 1);
    const incr = await A.save(d, { incremental: true });
    assert.equal(incr.fullFallback, false);
    assert.ok(incr.bytes.length > 1000);
    assertQpdfOk(incr.bytes, n0 + 1);
    // 저장본을 다시 열어 쪽수와 회전 표식이 유지되는지
    const re = await open(incr.bytes);
    assert.equal(await A.pageCount(re), n0 + 1);
    assert.equal((await sizes(re))[0], '842x595');
    // 저장은 열린 문서를 바꾸지 않는다
    assert.equal(await A.pageCount(d), n0 + 1);
  });

  test('삭제 후 전체 저장은 삭제 쪽 객체를 정리한다(scan.pdf)', async () => {
    const sc = sample('scan');
    const id = await open(sc);
    await A.deletePages(id, [1]);
    const out = await A.save(id, { incremental: false, garbageCollect: true });
    assertQpdfOk(out.bytes, 1);
    assert.ok(out.bytes.length < sc.length * 0.7, `${sc.length} → ${out.bytes.length}`);
    // garbageCollect 플래그와 무관하게 전체 저장이 정리한다(pdfium-adapter.ts save() 주석의 근거)
    const plain = await A.save(id, { incremental: false });
    assert.ok(plain.bytes.length < sc.length * 0.7, `gc 없음: ${sc.length} → ${plain.bytes.length}`);
    assert.equal(plain.bytes.length, out.bytes.length);
  });

  test('deletePages([]) 는 아무것도 지우지 않으므로 증분 저장에 삭제 데이터 비고가 붙지 않는다(두 엔진)', async () => {
    for (const E of [A, M]) {
      const id = await open(sample('scan'), E);
      await E.deletePages(id, []);
      const out = await E.save(id, { incremental: true });
      assert.ok(!(out.notes ?? []).some((n) => /삭제/.test(n)), `${E.name}: ${JSON.stringify(out.notes)}`);
      await E.deletePages(id, [1]);
      const out2 = await E.save(id, { incremental: true });
      assert.ok((out2.notes ?? []).some((n) => /삭제/.test(n)), `${E.name} 실제 삭제 후에는 비고가 있어야 한다`);
    }
  });
});

describe('주석', () => {
  test('종류별 추가·목록·그리기·수정·삭제·저장·재로드', async () => {
    const id = await open(sample('ko_embedded'));
    const SC = 1;
    const base = await A.renderPage(id, 0, SC);
    const specs = [
      { type: 'highlight', rect: { x: 60, y: 120, width: 270, height: 22 }, color: '#ffeb00', contents: 'Highlight 하이라이트' },
      { type: 'square', rect: { x: 60, y: 182, width: 200, height: 60 }, color: '#ff0000', contents: 'Square' },
      { type: 'text', rect: { x: 350, y: 122, width: 20, height: 20 }, color: '#ffc800', contents: '메모 note 한글' },
      { type: 'freetext', rect: { x: 60, y: 302, width: 270, height: 40 }, color: '#000000', contents: 'FreeText ABC' },
      { type: 'circle', rect: { x: 300, y: 182, width: 100, height: 60 }, color: '#0000ff' },
      { type: 'line', rect: { x: 60, y: 392, width: 100, height: 50 }, color: '#00aa00' },
      { type: 'ink', rect: { x: 200, y: 392, width: 100, height: 50 }, extra: { strokes: [[200, 442, 250, 392, 300, 422]] } },
    ];
    const created = [];
    for (const s of specs) {
      const a = await A.addAnnotation(id, 0, s);
      assert.equal(a.type, s.type);
      assert.ok(a.id);
      assert.equal(a.extra.hasAppearance, true, `${s.type} AP 생성`);
      assert.ok(Math.abs(a.rect.x - s.rect.x) < 1.5 && Math.abs(a.rect.y - s.rect.y) < 1.5, `${s.type} rect ${JSON.stringify(a.rect)}`);
      if (s.contents) assert.equal(a.contents, s.contents);
      created.push(a);
    }
    assert.equal(new Set(created.map((a) => a.id)).size, specs.length, 'id 는 서로 달라야 한다');
    // 기본 quad 는 페이지 공간의 상좌, 상우, 하좌, 하우
    const q0 = created[0].quadPoints;
    assert.equal(q0.length, 1);
    [60, 120, 330, 120, 60, 142, 330, 142].forEach((v, i) => assert.ok(Math.abs(q0[0][i] - v) < 0.01, `quad[${i}] ${q0[0][i]}`));
    assert.equal(created[1].color, '#ff0000');

    const list = await A.listAnnotations(id, 0);
    assert.equal(list.length, specs.length);
    assert.deepEqual(list.map((a) => a.type), specs.map((s) => s.type));

    const after = await A.renderPage(id, 0, SC);
    for (const s of specs) assert.ok(regionDiff(base, after, s.rect, SC) > 0, `${s.type} 가 그려져야 한다`);
    writePng(path.join(OUT, 'pdfium.annots.png'), after.width, after.height, px(after));

    // 수정: 내용·색
    const sq = list.find((a) => a.type === 'square');
    await A.updateAnnotation(id, 0, { ...sq, contents: 'changed', color: '#00ff00' });
    const sq2 = (await A.listAnnotations(id, 0)).find((a) => a.id === sq.id);
    assert.equal(sq2.contents, 'changed');
    assert.equal(sq2.color, '#00ff00');
    await assert.rejects(() => A.updateAnnotation(id, 0, { ...sq, type: 'circle' }), /종류는 바꿀 수 없다/);
    await assert.rejects(() => A.updateAnnotation(id, 0, { ...sq, id: 'nope' }), /찾을 수 없다/);

    // 삭제: 삭제 후에도 나머지 id 가 유지된다(/NM 기반)
    await A.deleteAnnotation(id, 0, list[0].id);
    const rest = await A.listAnnotations(id, 0);
    assert.equal(rest.length, specs.length - 1);
    assert.ok(!rest.some((a) => a.id === list[0].id));
    assert.ok(rest.some((a) => a.id === sq.id));
    await assert.rejects(() => A.deleteAnnotation(id, 0, list[0].id), /찾을 수 없다/);

    await assert.rejects(() => A.addAnnotation(id, 0, { type: 'other', rect: { x: 0, y: 0, width: 10, height: 10 } }), /만들 수 없는/);
    await assert.rejects(() => A.addAnnotation(id, 0, { type: 'stamp', rect: { x: 0, y: 0, width: 10, height: 10 } }), /extra\.image/); // 8단계: 이미지 없는 스탬프는 거부
    await assert.rejects(() => A.addAnnotation(id, 0, { type: 'ink', rect: { x: 0, y: 0, width: 10, height: 10 } }), /strokes/);
    assert.equal((await A.listAnnotations(id, 0)).length, specs.length - 1, '실패한 추가가 주석을 남기면 안 된다');

    // 저장 → qpdf → 재로드
    for (const incremental of [false, true]) {
      const out = await A.save(id, { incremental });
      assert.equal(out.fullFallback, false);
      assertQpdfOk(out.bytes, 2);
      const re = await open(out.bytes);
      const relist = await A.listAnnotations(re, 0);
      assert.equal(relist.length, specs.length - 1);
      assert.ok(relist.every((a) => a.extra.hasAppearance), '재로드 후에도 AP 가 있어야 한다');
      assert.deepEqual(relist.map((a) => a.id), rest.map((a) => a.id));
      const t = relist.find((a) => a.type === 'text');
      assert.equal(t.contents, '메모 note 한글');
    }
  });

  test('회전된 쪽에서도 주석 rect 는 페이지 공간(회전 반영)으로 왕복', async () => {
    const id = await open(sample('ko_embedded'));
    await A.rotatePage(id, 0, 90);
    const a = await A.addAnnotation(id, 0, { type: 'square', rect: { x: 100, y: 100, width: 50, height: 30 }, color: '#ff0000' });
    for (const [k, v] of Object.entries({ x: 100, y: 100, width: 50, height: 30 })) assert.ok(Math.abs(a.rect[k] - v) < 0.5, `${k} ${a.rect[k]}`);
  });

  test('flatten: 주석을 내용에 굽고, 열린 문서는 바뀌지 않는다', async () => {
    const id = await open(sample('ko_embedded'));
    await A.addAnnotation(id, 0, { type: 'square', rect: { x: 60, y: 182, width: 200, height: 60 }, color: '#ff0000' });
    const out = await A.save(id, { incremental: true, flatten: true });
    assert.equal(out.fullFallback, true, '굽기는 증분이 불가능하다');
    assertQpdfOk(out.bytes, 2);
    const re = await open(out.bytes);
    assert.equal((await A.listAnnotations(re, 0)).length, 0);
    const flat = await A.renderPage(re, 0, 1);
    const live = await A.renderPage(id, 0, 1);
    assert.ok(regionDiff(flat, live, { x: 60, y: 182, width: 200, height: 60 }, 1) < 40, '굽기 전후 그림이 거의 같아야 한다');
    assert.equal((await A.listAnnotations(id, 0)).length, 1, '원본 문서는 그대로');
  });
});

describe('좌표 규약: 페이지 공간(좌상단 원점, 회전 반영) — MuPDF 어댑터와 대조', () => {
  const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
  const nearRect = (r, e, tol, msg) => {
    for (const k of ['x', 'y', 'width', 'height']) near(r[k], e[k], tol, `${msg} ${k}`);
  };
  const SQ = { x: 40, y: 70, width: 80, height: 50 };
  const CASES = [];
  for (const rotate of [0, 90, 180, 270]) {
    CASES.push({ name: `rotate ${rotate}, MediaBox 원점 0`, rotate, media: [0, 0, 400, 500] });
    CASES.push({ name: `rotate ${rotate}, CropBox 오프셋`, rotate, media: [0, 0, 400, 500], crop: [50, 30, 350, 430] });
    CASES.push({ name: `rotate ${rotate}, 음수 MediaBox 원점`, rotate, media: [-20, -10, 380, 490] });
  }

  for (const c of CASES) {
    test(c.name, async () => {
      const bytes = buildBoxPdf(c);
      const result = {};
      for (const [key, ad] of [['pdfium', A], ['mupdf', M]]) {
        const id = await open(bytes, ad);
        const sz = await ad.pageSize(id, 0);
        const swap = c.rotate === 90 || c.rotate === 270;
        const box = c.crop ?? c.media;
        near(sz.width, swap ? box[3] - box[1] : box[2] - box[0], 0.01, `${key} pageSize.width`);
        near(sz.height, swap ? box[2] - box[0] : box[3] - box[1], 0.01, `${key} pageSize.height`);
        const hl = { x: 150, y: 200, width: 100, height: 20 };
        await ad.addAnnotation(id, 0, { type: 'square', rect: SQ, color: '#ff0000', extra: { borderWidth: 2 } });
        await ad.addAnnotation(id, 0, { type: 'circle', rect: { x: 150, y: 60, width: 60, height: 40 }, color: '#0000ff', extra: { borderWidth: 2 } });
        await ad.addAnnotation(id, 0, { type: 'highlight', rect: hl, color: '#ffeb00' });
        // 저장 → 재로드 → 목록
        const saved = await ad.save(id, { incremental: false });
        const re = await open(saved.bytes, ad);
        const list = await ad.listAnnotations(re, 0);
        const sq = list.find((a) => a.type === 'square');
        const ci = list.find((a) => a.type === 'circle');
        const hi = list.find((a) => a.type === 'highlight');
        nearRect(sq.rect, SQ, 0.5, `${key} square`);
        nearRect(ci.rect, { x: 150, y: 60, width: 60, height: 40 }, 0.5, `${key} circle`);
        // MuPDF 는 하이라이트 rect 를 quad 보다 바깥으로 부풀려 돌려준다(엔진 고유) — quad 로 비교하고 rect 는 PDFium 만 확인
        if (key === 'pdfium') nearRect(hi.rect, hl, 0.5, `${key} highlight rect`);
        // quad 경계 상자도 입력 사각형과 같아야 한다
        const q = hi.quadPoints[0];
        const xs = [q[0], q[2], q[4], q[6]];
        const ys = [q[1], q[3], q[5], q[7]];
        near(Math.min(...xs), hl.x, 0.5, `${key} quad x0`);
        near(Math.max(...xs), hl.x + hl.width, 0.5, `${key} quad x1`);
        near(Math.min(...ys), hl.y, 0.5, `${key} quad y0`);
        near(Math.max(...ys), hl.y + hl.height, 0.5, `${key} quad y1`);
        const bmp = await ad.renderPage(re, 0, 1);
        result[key] = { bmp, base: pixelBBox(bmp, isDark), red: pixelBBox(bmp, isRed), list };
        if (process.env.PDFIUM_TEST_PNG) writePng(path.join(OUT, `coord.${key}.${c.name.replace(/\W+/g, '_')}.png`), bmp.width, bmp.height, px(bmp));
      }
      // 렌더 비트맵 대조: 같은 크기, 표식(원본 내용)과 빨간 사각형 위치가 두 엔진에서 일치
      const { pdfium: p, mupdf: m } = result;
      assert.equal(p.bmp.width, m.bmp.width);
      assert.equal(p.bmp.height, m.bmp.height);
      assert.ok(p.base && m.base && p.red && m.red, '표식·주석이 그려져야 한다');
      p.base.forEach((v, i) => near(v, m.base[i], 1.5, `표식 bbox[${i}] pdfium=${p.base} mupdf=${m.base}`));
      p.red.forEach((v, i) => near(v, m.red[i], 2, `빨간 사각형 bbox[${i}] pdfium=${p.red} mupdf=${m.red}`));
      // 사각형은 입력 rect 안팎 선 굵기(2) 이내에 그려진다
      near(p.red[0], SQ.x, 2.5, 'pdfium red x0');
      near(p.red[1], SQ.y, 2.5, 'pdfium red y0');
      near(p.red[2], SQ.x + SQ.width, 2.5, 'pdfium red x1');
      near(p.red[3], SQ.y + SQ.height, 2.5, 'pdfium red y1');
    });

    test(`line·ink extra 좌표 왕복(pdfium): ${c.name}`, async () => {
      const id = await open(buildBoxPdf(c));
      const line = await A.addAnnotation(id, 0, { type: 'line', rect: { x: 30, y: 60, width: 90, height: 40 }, color: '#00aa00', extra: { start: [30, 60], end: [120, 100] } });
      const stroke = [30, 150, 70, 170, 110, 140];
      const ink = await A.addAnnotation(id, 0, { type: 'ink', rect: { x: 30, y: 140, width: 80, height: 30 }, extra: { strokes: [stroke] } });
      const saved = await A.save(id, { incremental: false });
      const re = await open(saved.bytes);
      const list = await A.listAnnotations(re, 0);
      const l = list.find((a) => a.type === 'line');
      const k = list.find((a) => a.type === 'ink');
      [30, 60].forEach((v, i) => near(l.extra.start[i], v, 0.5, `line start[${i}]`));
      [120, 100].forEach((v, i) => near(l.extra.end[i], v, 0.5, `line end[${i}]`));
      assert.equal(k.extra.strokes.length, 1);
      stroke.forEach((v, i) => near(k.extra.strokes[0][i], v, 0.5, `ink[${i}]`));
      assert.ok(line.id && ink.id);
    });
  }

  test('양식 필드 rect 도 두 엔진이 같은 페이지 공간 값을 낸다(회전 90 + CropBox 오프셋)', async () => {
    const extra = '/Rotate 90 /CropBox [20 50 520 800]';
    const bytes = buildFormPdf(extra);
    const idP = await open(bytes, A);
    const idM = await open(bytes, M);
    const fp = await A.listFormFields(idP);
    const fm = await M.listFormFields(idM);
    const sz = await A.pageSize(idP, 0);
    near(sz.width, 750, 0.01, 'pageSize.width');
    near(sz.height, 500, 0.01, 'pageSize.height');
    for (const name of ['name', 'agree', 'city', 'langs']) {
      const a = fp.find((f) => f.name === name);
      const b = fm.find((f) => f.name === name);
      assert.ok(a && b, name);
      nearRect(a.rect, b.rect, 0.5, `form ${name}`);
    }
    // name 필드 사용자 [100 700 300 720], CropBox 좌하단 (20,50), 시계방향 90: 페이지 x = 사용자 y-50 = 650..670, 페이지 y = 사용자 x-20 = 80..280
    const name = fp.find((f) => f.name === 'name');
    nearRect(name.rect, { x: 650, y: 80, width: 20, height: 200 }, 0.5, 'name 절대값');
    // 값 설정(클릭·포커스는 사용자 공간으로 내부 변환)이 회전 페이지에서도 동작한다
    await A.setFormFieldValue(idP, 'agree', true);
    assert.equal((await A.listFormFields(idP)).find((f) => f.name === 'agree').value, true);
  });
});

describe('부분 갱신·렌더 상한: 두 엔진 공통', () => {
  for (const [label, get] of [['pdfium', () => A], ['mupdf', () => M]]) {
    test(`${label}: updateAnnotation 에서 contents·borderWidth 가 없으면 기존 값을 유지한다`, async () => {
      const E = get();
      const id = await open(sample('ko_embedded'), E);
      const created = await E.addAnnotation(id, 0, {
        type: 'square', rect: { x: 60, y: 182, width: 200, height: 60 }, color: '#ff0000', contents: '보존할 메모', extra: { borderWidth: 5 },
      });
      // 색·위치만 바꾸는 부분 갱신(contents·extra 없음)
      await E.updateAnnotation(id, 0, { id: created.id, type: 'square', rect: { x: 70, y: 190, width: 200, height: 60 }, color: '#0000ff' });
      const after = (await E.listAnnotations(id, 0)).find((a) => a.type === 'square');
      assert.equal(after.contents, '보존할 메모', '내용 보존');
      assert.equal(after.rect.x, 70);
      // 저장본을 MuPDF 로 읽어 선 굵기 확인(PDFium 은 읽기에 borderWidth 를 내지 않는다)
      const out = await E.save(id, { incremental: false });
      const re = await open(out.bytes, M);
      const sq = (await M.listAnnotations(re, 0)).find((a) => a.type === 'square');
      assert.equal(sq.extra.borderWidth, 5, '선 굵기 유지');
      // 명시하면 바뀌고, contents '' 는 지운다
      await E.updateAnnotation(id, 0, { id: created.id, type: 'square', rect: after.rect, color: '#0000ff', contents: '', extra: { borderWidth: 3 } });
      assert.equal((await E.listAnnotations(id, 0)).find((a) => a.type === 'square').contents ?? '', '');
      const out2 = await E.save(id, { incremental: false });
      const re2 = await open(out2.bytes, M);
      assert.equal((await M.listAnnotations(re2, 0)).find((a) => a.type === 'square').extra.borderWidth, 3);
    });

    test(`${label}: 렌더 비트맵이 256MB 를 넘으면 이해할 수 있는 RangeError`, async () => {
      const E = get();
      const id = await open(sample('ko_embedded'), E);
      await assert.rejects(() => E.renderPage(id, 0, 40), (e) => e instanceof RangeError && /너무 크다/.test(e.message) && /256MB/.test(e.message) && /배율/.test(e.message));
      const ok = await E.renderPage(id, 0, 1);
      assert.ok(ok.width > 100);
    });
  }
});

describe('양식', () => {
  test('form.pdf 텍스트 필드: 목록·값 설정·저장·재로드·그리기', async () => {
    const id = await open(fixture('form'));
    const fields = await A.listFormFields(id);
    assert.deepEqual(fields.map((f) => [f.name, f.kind]), [['name', 'text'], ['memo', 'text']]);
    const base = await A.renderPage(id, 0, 1.5);
    await A.setFormFieldValue(id, 'name', 'Hello 123');
    await A.setFormFieldValue(id, 'memo', '홍길동 한글 값');
    const after = await A.renderPage(id, 0, 1.5);
    const rects = Object.fromEntries(fields.map((f) => [f.name, f.rect]));
    assert.ok(regionDiff(base, after, rects.name, 1.5) > 0, '위젯이 그려져야 한다(FFLDraw)');
    writePng(path.join(OUT, 'pdfium.form.png'), after.width, after.height, px(after));
    const out = await A.save(id, { incremental: false });
    assertQpdfOk(out.bytes, 1);
    const re = await open(out.bytes);
    const f2 = Object.fromEntries((await A.listFormFields(re)).map((f) => [f.name, f.value]));
    assert.deepEqual(f2, { name: 'Hello 123', memo: '홍길동 한글 값' });
    await assert.rejects(() => A.setFormFieldValue(id, 'nope', 'x'), /찾을 수 없다/);
  });

  test('한글 값은 한글 폰트 등록 시 그려진다', { skip: !fs.existsSync(MALGUN) && '맑은 고딕 없음' }, async () => {
    const ko = createPdfiumAdapter({ wasmBinary, koreanFont: fs.readFileSync(MALGUN), koreanFontFace: 'Malgun Gothic' });
    await ko.init();
    const id = await open(fixture('form'), ko);
    const memo = (await ko.listFormFields(id)).find((f) => f.name === 'memo');
    const base = await ko.renderPage(id, 0, 1.5);
    await ko.setFormFieldValue(id, 'memo', '홍길동 한글 값');
    const after = await ko.renderPage(id, 0, 1.5);
    assert.ok(regionDiff(base, after, memo.rect, 1.5) > 30);
    writePng(path.join(OUT, 'pdfium.form.ko.malgun.png'), after.width, after.height, px(after));
  });

  test('체크박스·라디오·콤보·목록', async () => {
    const id = await open(buildFormPdf());
    // 라디오는 위젯 하나가 필드 하나(이름 공통, options[0]=켜짐 값, value=boolean)라 byName 은 라디오를 빼고 만든다
    const byName = async () => Object.fromEntries((await A.listFormFields(id)).filter((f) => f.kind !== 'radio').map((f) => [f.name, f]));
    const radios = async () => (await A.listFormFields(id)).filter((f) => f.kind === 'radio').map((f) => [f.name, f.options[0], f.value]);
    let f = await byName();
    assert.deepEqual(Object.keys(f), ['name', 'agree', 'city', 'langs']);
    assert.deepEqual(f.agree.kind, 'checkbox');
    assert.equal(f.agree.value, false);
    assert.deepEqual(await radios(), [['color', 'red', false], ['color', 'blue', false]]);
    assert.equal(f.city.value, 'Seoul');
    assert.deepEqual(f.city.options, ['Seoul', 'Busan', 'Daegu']);
    assert.deepEqual(f.langs.value, []);

    await A.setFormFieldValue(id, 'name', 'abc');
    await A.setFormFieldValue(id, 'agree', true);
    await A.setFormFieldValue(id, 'color', 'blue');
    assert.deepEqual(await radios(), [['color', 'red', false], ['color', 'blue', true]]);
    await A.setFormFieldValue(id, 'city', 'Busan');
    await A.setFormFieldValue(id, 'langs', ['ko', 'ja']);
    await assert.rejects(() => A.setFormFieldValue(id, 'agree', 'yes'), TypeError);
    await assert.rejects(() => A.setFormFieldValue(id, 'langs', ['xx']), /목록에 없는/);

    const check = async (bytes) => {
      const re = await open(bytes);
      const g = Object.fromEntries((await A.listFormFields(re)).filter((x) => x.kind !== 'radio').map((x) => [x.name, x.value]));
      assert.deepEqual(g, { name: 'abc', agree: true, city: 'Busan', langs: ['ko', 'ja'] });
      const rr = (await A.listFormFields(re)).filter((x) => x.kind === 'radio').map((x) => [x.options[0], x.value]);
      assert.deepEqual(rr, [['red', false], ['blue', true]]);
    };
    f = await byName();
    assert.equal(f.agree.value, true);
    for (const incremental of [false, true]) {
      const out = await A.save(id, { incremental });
      assertQpdfOk(out.bytes, 1);
      await check(out.bytes);
    }
    await A.setFormFieldValue(id, 'agree', false);
    assert.equal((await byName()).agree.value, false);
  });
});

describe('양식 계약: 두 엔진 공통(라디오 그룹·체크박스)', () => {
  for (const [label, get] of [['pdfium', () => A], ['mupdf', () => M]]) {
    test(`${label}: 라디오 3개 그룹에서 두 번째 선택 → 저장 → 재로드`, async () => {
      const E = get();
      const id = await open(buildRadioPdf(), E);
      const radios = async (d) => (await E.listFormFields(d)).filter((f) => f.kind === 'radio');
      const view = (rs) => rs.map((f) => [f.name, f.options[0], f.value]);

      const r0 = await radios(id);
      assert.deepEqual(view(r0), [['grp', 'a', false], ['grp', 'b', false], ['grp', 'c', false]], '위젯 단위 필드·boolean·options[0]');
      assert.ok(r0[0].rect.x < r0[1].rect.x && r0[1].rect.x < r0[2].rect.x, '위젯마다 자기 rect');

      // UI 가 하는 호출: setFormFieldValue(name, field.options[0])
      await E.setFormFieldValue(id, 'grp', r0[1].options[0]);
      assert.deepEqual(view(await radios(id)), [['grp', 'a', false], ['grp', 'b', true], ['grp', 'c', false]]);
      // 이미 선택된 값을 다시 선택해도 그대로
      await E.setFormFieldValue(id, 'grp', 'b');
      assert.deepEqual((await radios(id)).map((f) => f.value), [false, true, false]);

      for (const incremental of [false, true]) {
        const out = await E.save(id, { incremental });
        assertQpdfOk(out.bytes, 1);
        const re = await open(out.bytes, E);
        assert.deepEqual(view(await radios(re)), [['grp', 'a', false], ['grp', 'b', true], ['grp', 'c', false]], `재로드(incremental=${incremental})`);
      }
      // 다른 위젯으로 옮기면 두 번째는 해제된다
      await E.setFormFieldValue(id, 'grp', 'c');
      assert.deepEqual((await radios(id)).map((f) => f.value), [false, false, true]);
    });

    test(`${label}: 라디오 set 의 경계(true=첫 위젯, false=무동작, 없는 값=오류)와 체크박스 boolean 전용`, async () => {
      const E = get();
      const id = await open(buildRadioPdf(), E);
      const vals = async () => (await E.listFormFields(id)).filter((f) => f.kind === 'radio').map((f) => f.value);
      await E.setFormFieldValue(id, 'grp', true);
      assert.deepEqual(await vals(), [true, false, false]);
      await E.setFormFieldValue(id, 'grp', false);
      assert.deepEqual(await vals(), [true, false, false], 'false 는 무동작');
      await assert.rejects(() => E.setFormFieldValue(id, 'grp', 'zzz'), /찾을 수 없다/);
      assert.deepEqual(await vals(), [true, false, false]);

      const chk = async () => (await E.listFormFields(id)).find((f) => f.name === 'chk');
      assert.equal((await chk()).kind, 'checkbox');
      assert.equal((await chk()).value, false);
      await assert.rejects(() => E.setFormFieldValue(id, 'chk', 'Yes'), TypeError);
      await assert.rejects(() => E.setFormFieldValue(id, 'chk', 'Off'), TypeError);
      await E.setFormFieldValue(id, 'chk', true);
      assert.equal((await chk()).value, true);
      await E.setFormFieldValue(id, 'chk', false);
      assert.equal((await chk()).value, false);
    });
  }
});

describe('암호 PDF 저장: 두 엔진 공통', { skip: !hasQpdf && 'qpdf 없음' }, () => {
  const encrypted = (keyBits, extra = []) => {
    const src = path.join(os.tmpdir(), `enc-src-${process.pid}-${keyBits}.pdf`);
    const dst = path.join(os.tmpdir(), `enc-dst-${process.pid}-${keyBits}.pdf`);
    fs.writeFileSync(src, sample('ko_embedded'));
    const r = spawnSync('qpdf', ['--encrypt', 'secret', 'owner', String(keyBits), ...extra, '--', src, dst], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const bytes = new Uint8Array(fs.readFileSync(dst));
    fs.rmSync(src, { force: true });
    fs.rmSync(dst, { force: true });
    return bytes;
  };
  for (const [label, get] of [['pdfium', () => A], ['mupdf', () => M]]) {
    for (const [bits, extra] of [[256, []], [128, ['--use-aes=y']]]) {
      test(`${label}: AES-${bits} 암호 PDF — 증분·전체·굽기 저장이 실패하거나 거짓 폴백하지 않는다`, async () => {
        const E = get();
        const orig = encrypted(bits, extra);
        const opts = { password: 'secret' };
        const id = await E.open(orig, opts);
        opened.push([E, id]);
        const pages = await E.pageCount(id);
        await E.addAnnotation(id, 0, { type: 'square', rect: { x: 50, y: 50, width: 80, height: 40 }, color: '#ff0000', contents: 'enc-note' });

        const inc = await E.save(id, { incremental: true });
        assert.equal(inc.fullFallback, false, '암호 PDF 의 증분 저장이 전체 저장으로 내려가면 안 된다');
        assert.ok(startsWith(inc.bytes, orig), '원본 접두 보존');
        const full = await E.save(id, { incremental: false });
        const flat = await E.save(id, { incremental: false, flatten: true });
        for (const [name, out] of [['inc', inc], ['full', full], ['flat', flat]]) {
          const f = path.join(os.tmpdir(), `enc-out-${process.pid}-${label}-${bits}-${name}.pdf`);
          fs.writeFileSync(f, out.bytes);
          try {
            const c = spawnSync('qpdf', ['--password=secret', '--check', f], { encoding: 'utf8' });
            assert.equal(c.status, 0, `${name}: ` + c.stdout + c.stderr);
            const n = spawnSync('qpdf', ['--password=secret', '--show-npages', f], { encoding: 'utf8' });
            assert.equal(Number(n.stdout.trim()), pages, name);
            const e = spawnSync('qpdf', ['--password=secret', '--show-encryption', f], { encoding: 'utf8' }).stdout;
            assert.doesNotMatch(e, /File is not encrypted/, `${name}: 암호화 유지`);
          } finally {
            fs.rmSync(f, { force: true });
          }
        }
        // 재로드: 암호로 열리고 주석이 남는다(굽기본은 주석이 내용이 된다)
        for (const out of [inc, full]) {
          const re = await E.open(out.bytes, opts);
          opened.push([E, re]);
          assert.ok((await E.listAnnotations(re, 0)).some((a) => a.contents === 'enc-note'));
        }
        const rf = await E.open(flat.bytes, opts);
        opened.push([E, rf]);
        assert.equal((await E.listAnnotations(rf, 0)).length, 0, '굽기본에는 주석 객체가 남지 않는다');
        await assert.rejects(() => E.open(full.bytes), /암호|비밀번호/);
      });
    }
  }
});

describe('서명 PDF 증분 저장', () => {
  test('원본 접두 보존, 주석 추가, qpdf 통과', async () => {
    const orig = fixture('signed');
    const id = await open(orig);
    await A.addAnnotation(id, 0, { type: 'text', rect: { x: 300, y: 700, width: 20, height: 20 }, color: '#ffc800', contents: 'after-sign note' });
    const out = await A.save(id, { incremental: true });
    assert.equal(out.fullFallback, false);
    assert.ok(startsWith(out.bytes, orig), '원본 바이트가 접두로 보존되어야 한다');
    assert.ok(out.bytes.length > orig.length);
    assertQpdfOk(out.bytes, 1);
    const re = await open(out.bytes);
    assert.equal((await A.listAnnotations(re, 0)).some((a) => a.contents === 'after-sign note'), true);
  });

  test('양식 입력 후 증분 저장도 접두 보존', async () => {
    const orig = fixture('signed');
    const id = await open(orig);
    await A.setFormFieldValue(id, 'name', 'Filled After Sign');
    const out = await A.save(id, { incremental: true });
    assert.equal(out.fullFallback, false);
    assert.ok(startsWith(out.bytes, orig));
    assertQpdfOk(out.bytes, 1);
    const re = await open(out.bytes);
    assert.equal((await A.listFormFields(re)).find((f) => f.name === 'name').value, 'Filled After Sign');
  });

  test('전체 저장은 접두를 보존하지 않는다(서명이 깨짐) — 증분 요청이 기본이어야 하는 이유', async () => {
    const orig = fixture('signed');
    const id = await open(orig);
    const out = await A.save(id, { incremental: false });
    assert.equal(startsWith(out.bytes, orig), false);
  });

  test('삭제·병합 뒤 증분 저장도 유효하거나 fullFallback 으로 알린다', async () => {
    const orig = fixture('signed');
    const id = await open(orig);
    const sc = await open(sample('scan'));
    await A.importPages(id, sc, [0]);
    const out = await A.save(id, { incremental: true });
    assertQpdfOk(out.bytes, 2);
    if (!out.fullFallback) assert.ok(startsWith(out.bytes, orig));
  });
});

describe('메모리', () => {
  test('열기·그리기·주석·저장·close 를 반복해도 힙이 계속 늘지 않는다', async () => {
    const bytes = sample('ko_embedded');
    const cycle = async () => {
      const id = await A.open(bytes);
      await A.renderPage(id, 0, 1.5);
      await A.addAnnotation(id, 0, { type: 'square', rect: { x: 60, y: 182, width: 200, height: 60 } });
      await A.listFormFields(id);
      await A.save(id, { incremental: false });
      await A.save(id, { incremental: true, flatten: true });
      await A.close(id);
    };
    for (let i = 0; i < 3; i++) await cycle(); // 예열
    const h0 = A.heapBytes();
    const docs0 = A.openDocCount();
    for (let i = 0; i < 25; i++) await cycle();
    const grown = A.heapBytes() - h0;
    assert.equal(A.openDocCount(), docs0);
    // 한 사이클이 새는 크기(비트맵 ≥2MB, 문서 ≥수십 KB)가 누적되면 수십 MB 가 된다
    assert.ok(grown <= 16 * 1024 * 1024, `힙이 ${(grown / 1048576).toFixed(1)}MB 늘었다`);
  });
});
