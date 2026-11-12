// 7·9단계 순수 로직 + 어댑터 연동 시험. 실행: cd app && node --test test/page-ops.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MupdfAdapter } from '../src/engine/mupdf-adapter.ts';
import { createPdfiumAdapter } from '../src/engine/pdfium-adapter.ts';
import { crc32, makeZip } from '../src/lib/zip.ts';
import { chunkEvery, parseRanges, splitNames } from '../src/lib/ranges.ts';
import { UndoHistory } from '../src/lib/history.ts';
import { addRotation, applyOrder, currentAfterDelete, detectRotation, dropOrder, isIdentity } from '../src/lib/page-ops.ts';
import { FIVE, inspect, makePdf } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'page-ops-'));

test('crc32: node zlib.crc32 과 일치', () => {
  for (const s of ['', 'a', '한글 PDF 123', 'x'.repeat(100000)]) {
    const b = new TextEncoder().encode(s);
    assert.equal(crc32(b), zlib.crc32(b));
  }
});

test('ZIP: python zipfile 로 열리고 내용·한글 이름이 같다', () => {
  const entries = [
    { name: '문서-1-3.pdf', data: new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 251)) },
    { name: 'b.pdf', data: new Uint8Array(0) },
    { name: 'c.pdf', data: new TextEncoder().encode('hello') },
  ];
  const f = path.join(OUT, 't.zip');
  fs.writeFileSync(f, makeZip(entries));
  const py = `
import zipfile,sys,json
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps([[i.filename,i.file_size,i.compress_type,hex(i.CRC)] for i in z.infolist()], ensure_ascii=False))`;
  const r = spawnSync('python', ['-I', '-X', 'utf8', '-c', py, f], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.map((g) => [g[0], g[1], g[2]]), entries.map((e) => [e.name, e.data.length, 0]));
  assert.equal(got[0][3], '0x' + crc32(entries[0].data).toString(16));
});

test('ranges: 1-3,5,8- / 오류 문구', () => {
  assert.deepEqual(parseRanges('1-3,5,8-', 10), { ok: true, groups: [[0, 1, 2], [4], [7, 8, 9]] });
  assert.deepEqual(parseRanges(' -2 ; 4~5 ', 6), { ok: true, groups: [[0, 1], [3, 4]] });
  for (const bad of ['', 'a', '0', '11', '3-2', '1-11', '--', '-']) assert.equal(parseRanges(bad, 10).ok, false, bad);
  assert.match(parseRanges('3-2', 10).error, /시작 쪽이 끝 쪽보다/);
  assert.match(parseRanges('11', 10).error, /1~10쪽/);
  assert.deepEqual(chunkEvery(3, 7).groups, [[0, 1, 2], [3, 4, 5], [6]]);
  assert.equal(chunkEvery(0, 7).ok, false);
  assert.deepEqual(splitNames('a', [[0, 1, 2], [4], [4]]), ['a-1-3.pdf', 'a-5.pdf', 'a-5 (2).pdf']);
});

test('history: 단계·메모리 상한', () => {
  const h = new UndoHistory(20, 1000);
  const snap = (n) => ({ bytes: new Uint8Array(n) });
  for (let i = 0; i < 30; i++) h.push(snap(10));
  assert.equal(h.undoStack.length, 20);
  const big = new UndoHistory(20, 1000);
  for (let i = 0; i < 30; i++) big.push(snap(300));
  assert.equal(big.undoStack.length, 3); // floor(1000/300)
  const huge = new UndoHistory(20, 1000);
  huge.push(snap(5000)); huge.push(snap(5000));
  assert.equal(huge.undoStack.length, 1); // 최소 1단계
  h.pushRedo(snap(1));
  h.push(snap(10));
  assert.equal(h.canRedo, false); // 새 조작은 다시하기 기록을 버린다
});

test('dropOrder / currentAfterDelete', () => {
  assert.deepEqual(dropOrder(5, [1], 4), [0, 2, 3, 1, 4]);
  assert.deepEqual(dropOrder(5, [1], 5), [0, 2, 3, 4, 1]);
  assert.deepEqual(dropOrder(5, [3, 4], 0), [3, 4, 0, 1, 2]);
  assert.deepEqual(dropOrder(5, [1, 3], 2), [0, 1, 3, 2, 4]);
  assert.ok(isIdentity(dropOrder(5, [2], 2)));
  assert.ok(isIdentity(dropOrder(5, [2], 3)));
  assert.equal(currentAfterDelete(3, [0, 1], 3), 1); // 앞 두 쪽 삭제 → 번호가 당겨진다
  assert.equal(currentAfterDelete(2, [2], 4), 2); // 현재 쪽 삭제 → 같은 자리(다음 쪽)
  assert.equal(currentAfterDelete(4, [4], 4), 3); // 마지막 쪽 삭제 → 새 마지막
  assert.equal(addRotation(270), 0);
});

async function mupdf() {
  const a = new MupdfAdapter();
  await a.init();
  return a;
}
async function pdfium() {
  const wasm = fs.readFileSync(path.resolve(here, '../node_modules/@embedpdf/pdfium/dist/pdfium.wasm'));
  const a = createPdfiumAdapter({ wasmBinary: wasm });
  await a.init();
  return a;
}

for (const [name, make] of [['mupdf', mupdf], ['pdfium', pdfium]]) {
  test(`${name}: applyOrder 가 임의 순열을 만든다`, async () => {
    const a = await make();
    const id = await a.open(makePdf(FIVE));
    const order = [3, 0, 4, 2, 1];
    await applyOrder(a, id, order);
    const r = await a.save(id, { incremental: false });
    assert.deepEqual(inspect(r.bytes).map((p) => p.text), order.map((i) => `PAGE-${i + 1}`));
    await a.close(id);
  });

  test(`${name}: detectRotation 은 기존 /Rotate 를 알아내고 문서를 바꾸지 않는다`, async () => {
    const a = await make();
    const id = await a.open(makePdf(FIVE));
    assert.equal(await detectRotation(a, id, 2), 90);
    assert.equal(await detectRotation(a, id, 0), 0);
    const r = await a.save(id, { incremental: false });
    const info = inspect(r.bytes);
    assert.equal(info[2].rotate, 90);
    assert.deepEqual([info[2].w, info[2].h], [420, 320]);
    await a.close(id);
  });

  test(`${name}: 복제(조작 전 사본을 열어 importPages)`, async () => {
    const a = await make();
    const bytes = makePdf(FIVE);
    const id = await a.open(bytes.slice());
    const tmp = await a.open(bytes.slice());
    await a.importPages(id, tmp, [1, 2], 3); // 2,3쪽을 3쪽 뒤에
    await a.close(tmp);
    const r = await a.save(id, { incremental: false });
    const info = inspect(r.bytes);
    assert.deepEqual(info.map((p) => p.text), ['PAGE-1', 'PAGE-2', 'PAGE-3', 'PAGE-2', 'PAGE-3', 'PAGE-4', 'PAGE-5']);
    assert.equal(info[4].rotate, 90);
    await a.close(id);
  });
}

test('mupdf: 같은 문서끼리 importPages 가 되는지(참고)', async () => {
  const a = await mupdf();
  const id = await a.open(makePdf(FIVE));
  let ok = true;
  try { await a.importPages(id, id, [0], 1); } catch { ok = false; }
  console.log('   mupdf same-doc importPages:', ok);
  await a.close(id);
});

test('qpdf: 조작 결과가 --check 를 통과', async () => {
  const a = await mupdf();
  const id = await a.open(makePdf(FIVE));
  await a.deletePages(id, [1]);
  await applyOrder(a, id, [3, 2, 1, 0]);
  const r = await a.save(id, { incremental: false, garbageCollect: true });
  const f = path.join(OUT, 'q.pdf');
  fs.writeFileSync(f, r.bytes);
  const q = spawnSync('qpdf', ['--check', f], { encoding: 'utf8' });
  assert.equal(q.status, 0, q.stdout + q.stderr);
});
