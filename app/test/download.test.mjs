// 다운로드 파일 이름 정리 시험. 실행: cd app && node --test test/download.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseName, cleanName, editedName, MAX_NAME_BYTES, normalizeSaveName, safeName } from '../src/lib/download.ts';

test('금지 문자는 _ 로 바뀐다(역슬래시 포함)', () => {
  const bs = String.fromCharCode(92);
  assert.equal(safeName('a' + bs + 'b/c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(safeName('x\u0001y'), 'x_y');
});

test('끝의 점·공백을 없앤다', () => {
  assert.equal(safeName('보고서. . '), '보고서');
  assert.equal(safeName('...'), 'document');
  assert.equal(safeName('   '), 'document');
  assert.equal(baseName('a..pdf'), 'a');
});

test('Windows 예약어는 앞에 _ 를 붙인다(확장자가 붙어도, 대소문자 무시)', () => {
  for (const n of ['CON', 'nul', 'Aux', 'PRN', 'COM1', 'lpt9', 'con.txt', 'NUL.tar.gz']) assert.equal(safeName(n), `_${n}`, n);
  for (const n of ['CONSOLE', 'COM10', 'com0', 'x.con', 'nul-1']) assert.equal(safeName(n), n, n);
  assert.equal(baseName('CON.pdf'), '_CON');
});

test('길이는 UTF-8 200바이트로 제한하고 코드 포인트를 쪼개지 않는다', () => {
  const long = '가'.repeat(200);
  const out = safeName(long);
  assert.ok(new TextEncoder().encode(out).length <= MAX_NAME_BYTES);
  assert.equal(out, '가'.repeat(66));
  assert.equal(safeName('😀'.repeat(100)), '😀'.repeat(50));
  assert.ok(new TextEncoder().encode(editedName(long)).length <= 255);
  assert.equal(safeName('a'.repeat(300)).length, 200);
});

test('보통 이름은 그대로', () => {
  assert.equal(safeName('계약서 (2)'), '계약서 (2)');
  assert.equal(editedName('내 문서.PDF'), '내 문서-편집.pdf');
});

test('저장 파일 이름: 금지 문자 제거, .pdf 보정, 빈 값은 기본값', () => {
  const bs = String.fromCharCode(92);
  const fb = '기본-편집.pdf';
  assert.equal(normalizeSaveName('계약서', fb), '계약서.pdf');
  assert.equal(normalizeSaveName('계약서.PDF', fb), '계약서.pdf');
  assert.equal(normalizeSaveName('  a' + bs + 'b/c:d*e?f"g<h>i|j  ', fb), 'abcdefghij.pdf');
  assert.equal(normalizeSaveName('', fb), fb);
  assert.equal(normalizeSaveName('  ', fb), fb);
  assert.equal(normalizeSaveName('/:*?', fb), fb);
  assert.equal(normalizeSaveName('.pdf', fb), fb);
  assert.equal(normalizeSaveName('...', fb), fb);
  assert.equal(normalizeSaveName('CON', fb), '_CON.pdf');
  assert.equal(normalizeSaveName('a.pdf.pdf', fb), 'a.pdf.pdf');
  assert.ok(new TextEncoder().encode(normalizeSaveName('가'.repeat(300), fb)).length <= 204);
});

test('cleanName: normalizeSaveName 과 같은 규칙, 이름이 될 수 없으면 null', () => {
  assert.equal(cleanName('계약서'), '계약서.pdf');
  assert.equal(cleanName('a:b'), 'ab.pdf');
  assert.equal(cleanName(''), null);
  assert.equal(cleanName('...'), null);
  assert.equal(cleanName('.pdf'), null);
});
