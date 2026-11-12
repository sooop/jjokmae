// 연속 저장·재기준화·저장 정합성 검사 시험(MuPDF·PDFium 공통). 실행: node --test test/save-chain.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { createPdfiumAdapter } from '../src/engine/pdfium-adapter.ts';
import { MupdfAdapter } from '../src/engine/mupdf-adapter.ts';
import { FIVE, inspect, makePdf } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const SIGNED = fs.readFileSync(path.join(root, 'harness/out2/fixtures/signed.pdf'));
const WASM = fs.readFileSync(path.join(root, 'app/node_modules/@embedpdf/pdfium/dist/pdfium.wasm'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'save-chain-'));

const mu = new MupdfAdapter();
await mu.init();
const pd = createPdfiumAdapter({ wasmBinary: WASM });
await pd.init();
const ENGINES = [mu, pd];

let seq = 0;
function qpdf(bytes) {
  const f = path.join(TMP, `c${++seq}.pdf`);
  fs.writeFileSync(f, bytes);
  const r = spawnSync('qpdf', ['--check', f], { encoding: 'utf8' });
  return { exit: r.status, out: r.stdout + r.stderr };
}
const assertQpdf = (bytes, label) => {
  const r = qpdf(bytes);
  assert.equal(r.exit, 0, `${label}: qpdf --check 실패\n${r.out}`);
  assert.ok(!/warning/i.test(r.out), `${label}: qpdf 경고\n${r.out}`);
};
const startsWith = (b, p) => b.length >= p.length && Buffer.compare(Buffer.from(b.subarray(0, p.length)), Buffer.from(p)) === 0;
const rot = (bytes) => inspect(bytes).map((p) => p.rotate).join(',');
/** 로드 경고 없이 열리는지(mupdf 로 재로드) + 쪽수 */
function reload(bytes) {
  const warns = [];
  mupdf.setLog({ warning: (s) => warns.push(s), error: (s) => warns.push(s) });
  try {
    const d = mupdf.Document.openDocument(bytes, 'application/pdf');
    return { pages: d.countPages(), warns, doc: d };
  } finally {
    mupdf.setLog(null);
  }
}
async function annotCount(bytes) {
  const id = await mu.open(bytes);
  try {
    let n = 0;
    for (let i = 0; i < (await mu.pageCount(id)); i++) n += (await mu.listAnnotations(id, i)).length;
    return n;
  } finally {
    await mu.close(id);
  }
}

for (const A of ENGINES) {
  test(`${A.name}: 증분 저장 3회 + 사이 편집이 모두 누적되고 매번 유효하다`, async () => {
    const orig = makePdf(FIVE);
    const id = await A.open(orig);
    const outs = [];
    await A.rotatePage(id, 0, 90);
    outs.push(await A.save(id, { incremental: true }));
    await A.rotatePage(id, 1, 180);
    outs.push(await A.save(id, { incremental: true }));
    await A.addAnnotation(id, 2, { type: 'square', rect: { x: 20, y: 20, width: 50, height: 40 }, color: '#ff0000', contents: 'chain' });
    outs.push(await A.save(id, { incremental: true }));
    await A.rotatePage(id, 4, 270);
    outs.push(await A.save(id, { incremental: true })); // 4번째
    const want = ['90,0,90,0,0', '90,180,90,0,0', '90,180,90,0,0', '90,180,90,0,270'];
    outs.forEach((o, i) => {
      assert.equal(o.fullFallback, false, `#${i + 1} fullFallback`);
      assertQpdf(o.bytes, `${A.name} #${i + 1}`);
      assert.ok(startsWith(o.bytes, orig), `#${i + 1} 원본 접두 보존`);
      if (i > 0 && A.name === 'mupdf') assert.ok(startsWith(o.bytes, outs[i - 1].bytes), `#${i + 1} 직전 저장 접두 보존(mupdf 는 마지막 저장이 기준)`);
      const r = reload(o.bytes);
      assert.equal(r.pages, 5, `#${i + 1} 쪽수`);
      assert.deepEqual(r.warns, [], `#${i + 1} 로드 경고`);
      assert.equal(rot(o.bytes), want[i], `#${i + 1} 편집 반영`);
    });
    assert.equal(await annotCount(outs[2].bytes), 1, '3회차에 주석 반영');
    assert.equal(await annotCount(outs[3].bytes), 1);
    assert.equal(await annotCount(outs[1].bytes), 0);
    await A.close(id);
  });

  test(`${A.name}: 전체 저장 뒤 증분 저장이 앞선 변경을 빠뜨리지 않는다`, async () => {
    const orig = makePdf(FIVE);
    const id = await A.open(orig);
    await A.rotatePage(id, 0, 90);
    const full = await A.save(id, { incremental: false });
    assertQpdf(full.bytes, `${A.name} full`);
    await A.rotatePage(id, 1, 180);
    const inc = await A.save(id, { incremental: true });
    assert.equal(inc.fullFallback, false);
    assertQpdf(inc.bytes, `${A.name} inc after full`);
    assert.equal(rot(inc.bytes), '90,180,90,0,0');
    // 전체 저장 → 증분 → 전체 저장 → 증분 반복
    await A.rotatePage(id, 3, 90);
    await A.save(id, { incremental: false });
    await A.rotatePage(id, 4, 180);
    const inc2 = await A.save(id, { incremental: true });
    assertQpdf(inc2.bytes, `${A.name} inc2`);
    assert.equal(rot(inc2.bytes), '90,180,90,90,180');
    assert.deepEqual(reload(inc2.bytes).warns, []);
    await A.close(id);
  });

  test(`${A.name}: 저장 뒤에도 DocId·편집 가능, 주석 id 유지(garbageCollect 없는 저장)`, async () => {
    const id = await A.open(makePdf(FIVE));
    const a = await A.addAnnotation(id, 0, { type: 'square', rect: { x: 10, y: 10, width: 40, height: 30 }, color: '#ff0000' });
    await A.save(id, { incremental: true });
    await A.save(id, { incremental: false });
    const ids = (await A.listAnnotations(id, 0)).map((x) => x.id);
    assert.deepEqual(ids, [a.id], '저장 뒤 주석 id 유지');
    await A.updateAnnotation(id, 0, { ...a, color: '#00ff00', contents: 'after-save' });
    const out = await A.save(id, { incremental: true });
    assertQpdf(out.bytes, `${A.name} edit-after-save`);
    const id2 = await A.open(out.bytes);
    const l = await A.listAnnotations(id2, 0);
    assert.equal(l.length, 1);
    assert.equal(l[0].contents, 'after-save');
    assert.equal(l[0].color, '#00ff00');
    await A.close(id2);
    await A.close(id);
  });

  test(`${A.name}: 서명 PDF 증분 저장 체인 — 매번 qpdf 통과·접두 보존·편집 반영`, async () => {
    const orig = new Uint8Array(SIGNED);
    const id = await A.open(orig);
    const base = await annotCount(orig);
    const outs = [];
    for (let k = 1; k <= 3; k++) {
      await A.addAnnotation(id, 0, { type: 'square', rect: { x: 20 * k, y: 300, width: 30, height: 20 }, color: '#0000ff', contents: `s${k}` });
      const r = await A.save(id, { incremental: true });
      outs.push(r);
      assert.equal(r.fullFallback, false, `#${k} fullFallback`);
      assertQpdf(r.bytes, `${A.name} signed #${k}`);
      assert.ok(startsWith(r.bytes, orig), `#${k} 서명 원본 접두 보존`);
      assert.equal(await annotCount(r.bytes), base + k, `#${k} 편집 반영`);
      assert.deepEqual(reload(r.bytes).warns, [], `#${k} 로드 경고`);
    }
    // 서명 사전의 ByteRange·Contents 가 접두에 그대로 있다
    assert.ok(Buffer.from(orig).includes(Buffer.from('/ByteRange')));
    // 전체 저장으로 내려가면 알림이 있다(서명 무효)
    const full = await A.save(id, { incremental: false });
    assert.ok(full.notes?.some((n) => /서명/.test(n)), '전체 저장 비고에 서명 무효 안내');
    await A.close(id);
  });

  test(`${A.name}: notes — 증분+삭제는 삭제한 쪽의 데이터가 남음을 알린다`, async () => {
    const id = await A.open(makePdf(FIVE));
    await A.deletePages(id, [4]);
    const inc = await A.save(id, { incremental: true });
    assert.ok(inc.notes?.some((n) => n.includes('삭제한 쪽의 데이터가 파일에 남음')), JSON.stringify(inc.notes));
    assert.equal(inc.fullFallback, false);
    assert.equal(reload(inc.bytes).pages, 4);
    assertQpdf(inc.bytes, `${A.name} inc after delete`);
    const full = await A.save(id, { incremental: false, garbageCollect: true });
    assert.ok(!full.notes?.some((n) => n.includes('삭제한 쪽의 데이터가 파일에 남')), '정리 저장에는 경고 없음');
    // 삭제 없는 증분 저장은 비고 없음
    const id2 = await A.open(makePdf(FIVE));
    await A.rotatePage(id2, 0, 90);
    assert.equal((await A.save(id2, { incremental: true })).notes, undefined);
    await A.close(id);
    await A.close(id2);
  });
}

test('mupdf: 저장 정합성 검사가 실패하면 fullFallback=true 로 전체 저장하고 이후 저장도 유효하다', async () => {
  class Forced extends MupdfAdapter {
    failInc = true;
    checkResult(e, bytes, want, prefix) {
      if (prefix && this.failInc) return { ok: false, hard: true, opened: null, problems: ['강제 실패'] };
      return super.checkResult(e, bytes, want, prefix);
    }
  }
  const F = new Forced();
  await F.init();
  const orig = makePdf(FIVE);
  const id = await F.open(orig);
  await F.rotatePage(id, 0, 90);
  const r = await F.save(id, { incremental: true });
  assert.equal(r.fullFallback, true);
  assert.ok(r.notes?.some((n) => n.includes('전체 저장으로 대체')), JSON.stringify(r.notes));
  assertQpdf(r.bytes, 'forced fallback');
  assert.equal(rot(r.bytes), '90,0,90,0,0');
  F.failInc = false;
  await F.rotatePage(id, 1, 180);
  const r2 = await F.save(id, { incremental: true });
  assert.equal(r2.fullFallback, false);
  assert.ok(startsWith(r2.bytes, r.bytes), '대체 저장 결과가 새 기준');
  assert.equal(rot(r2.bytes), '90,180,90,0,0');
  assertQpdf(r2.bytes, 'after fallback');
});

test('mupdf: 비밀번호 문서도 저장 뒤 재기준화된다', async () => {
  const d = new mupdf.PDFDocument();
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < 3; i++) d.insertPage(-1, d.addPage([0, 0, 200, 200], 0, { Font: { F1: font } }, `BT /F1 20 Tf 10 100 Td (P${i}) Tj ET`));
  const enc = d.saveToBuffer('encrypt=aes-256,user-password=pw,owner-password=pw').asUint8Array().slice();
  await assert.rejects(() => mu.open(enc), /비밀번호/);
  const id = await mu.open(enc, { password: 'pw' });
  await mu.rotatePage(id, 0, 90);
  const a = await mu.save(id, { incremental: true });
  await mu.rotatePage(id, 1, 180);
  const b = await mu.save(id, { incremental: true });
  for (const [o, n] of [[a, 'A'], [b, 'B']]) {
    const id2 = await mu.open(o.bytes, { password: 'pw' });
    assert.equal(await mu.pageCount(id2), 3, n);
    await mu.close(id2);
  }
  const id3 = await mu.open(b.bytes, { password: 'pw' });
  assert.deepEqual([(await mu.pageSize(id3, 0)).width, (await mu.pageSize(id3, 1)).width], [200, 200]);
  assert.equal((await mu.pageSize(id3, 0)).height, 200);
  await mu.close(id3);
  await mu.close(id);
});
