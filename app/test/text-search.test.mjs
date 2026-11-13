// 쪽 안에서 찾기: 순수 매칭 규칙과 두 엔진의 searchPage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findInChars, needleTokens } from '../src/engine/text-search.ts';
import { MupdfAdapter } from '../src/engine/mupdf-adapter.ts';
import { createPdfiumAdapter } from '../src/engine/pdfium-adapter.ts';

/** 줄마다 문자열을 주면 글자 목록을 만든다(글자 폭 10, 줄 높이 20) */
function chars(...lines) {
  const out = [];
  lines.forEach((s, line) => {
    Array.from(s).forEach((ch, k) => {
      out.push({ ch, line, box: ch === ' ' ? null : { x0: k * 10, y0: line * 20, x1: k * 10 + 10, y1: line * 20 + 16 } });
    });
  });
  return out;
}
const boxOf = (q) => [q[0], q[1], q[6], q[7]];

test('needleTokens: 앞뒤 공백을 떼고 이어진 공백은 하나, 대소문자는 옵션대로', () => {
  assert.deepEqual(needleTokens('  Ab   c ', false), ['a', 'b', ' ', 'c']);
  assert.deepEqual(needleTokens('Ab', true), ['A', 'b']);
  assert.deepEqual(needleTokens('   ', false), []);
});

test('한 줄 안: 겹치지 않는 일치를 읽기 순서대로, 글자 상자를 묶은 quad 하나', () => {
  const c = chars('abc abcabc');
  const hits = findInChars(c, 'abc');
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((h) => h.length), [1, 1, 1]);
  assert.deepEqual(boxOf(hits[0][0]), [0, 0, 30, 16]);
  assert.deepEqual(boxOf(hits[1][0]), [40, 0, 70, 16]);
  assert.deepEqual(findInChars(chars('aaaa'), 'aa').length, 2);
});

test('대소문자: 기본은 구분하지 않고, matchCase 면 구분한다', () => {
  const c = chars('Hello hello HELLO');
  assert.equal(findInChars(c, 'hello').length, 3);
  assert.equal(findInChars(c, 'hello', { matchCase: true }).length, 1);
  assert.equal(findInChars(c, 'HELLO', { matchCase: true }).length, 1);
});

test('공백: 본문·찾는 말의 이어진 공백은 하나로 본다', () => {
  const c = chars('foo    bar');
  assert.equal(findInChars(c, 'foo bar').length, 1);
  assert.equal(findInChars(c, 'foo   bar').length, 1);
  assert.equal(findInChars(c, 'foobar').length, 0);
});

test('줄바꿈: 두 줄에 걸친 구절은 공백을 넣어도, 붙여 써도 맞고 quad 는 줄마다 하나', () => {
  const en = chars('the quick', 'brown fox');
  const h = findInChars(en, 'quick brown');
  assert.equal(h.length, 1);
  assert.equal(h[0].length, 2);
  assert.deepEqual(boxOf(h[0][0]), [40, 0, 90, 16]);
  assert.deepEqual(boxOf(h[0][1]), [0, 20, 50, 36]);
  const ko = chars('안녕하', '세요 여러분');
  assert.equal(findInChars(ko, '안녕하세요').length, 1);
  assert.equal(findInChars(ko, '안녕하 세요').length, 1);
  assert.equal(findInChars(ko, '세요 여러분').length, 1);
  // 줄 끝에 공백이 있는 경우에도 같다
  assert.equal(findInChars(chars('the quick ', 'brown'), 'quick brown').length, 1);
});

test('없는 말·빈 말·빈 쪽은 빈 배열', () => {
  assert.deepEqual(findInChars(chars('abc'), 'x'), []);
  assert.deepEqual(findInChars(chars('abc'), ''), []);
  assert.deepEqual(findInChars([], 'abc'), []);
});

// ---------- 두 엔진 ----------
const here = path.dirname(fileURLToPath(import.meta.url));
const H = path.resolve(here, '../../harness');
const read = (f) => new Uint8Array(fs.readFileSync(f));
const KO = path.join(H, 'samples', 'ko_embedded.pdf');
const SCAN = path.join(H, 'samples', 'scan.pdf');

const mupdf = new MupdfAdapter();
await mupdf.init();
const pdfium = createPdfiumAdapter({ wasmBinary: fs.readFileSync(path.resolve(here, "../node_modules/@embedpdf/pdfium/dist/pdfium.wasm")) });
await pdfium.init();

for (const A of [mupdf, pdfium]) {
  test(`${A.name}: searchPage — 본문에 있는 말을 찾고, 결과 quad 는 그 글자들의 textQuads 줄 안에 있다`, async () => {
    const id = await A.open(read(KO));
    const text = (await A.pageText(id, 0)).replace(/\s+/g, ' ').trim();
    assert.ok(text.length > 10, '표본에 글자가 있어야 한다');
    // 본문에서 낱말 하나를 골라 찾는다(공백으로 나뉜 첫 3글자 이상 토막)
    const word = text.split(' ').find((w) => w.length >= 3);
    assert.ok(word, text.slice(0, 80));
    const hits = await A.searchPage(id, 0, word);
    assert.ok(hits.length >= 1, `'${word}' 를 찾지 못함`);
    const size = await A.pageSize(id, 0);
    for (const h of hits) {
      for (const q of h) {
        assert.equal(q.length, 8);
        assert.ok(q[6] > q[0] && q[7] > q[1], 'quad 에 면적이 있다');
        assert.ok(q[0] >= -1 && q[1] >= -1 && q[6] <= size.width + 1 && q[7] <= size.height + 1, '쪽 안에 있다');
      }
    }
    // 대소문자·없는 말·빈 말
    assert.deepEqual(await A.searchPage(id, 0, '이런말은문서에없다zzz'), []);
    assert.deepEqual(await A.searchPage(id, 0, '   '), []);
    const all = await A.searchPage(id, 0, word, { matchCase: true });
    assert.ok(all.length >= 1 && all.length <= hits.length);
    await A.close(id);
  });

  test(`${A.name}: searchPage — 스캔본(글자 없음)은 빈 배열`, async () => {
    const id = await A.open(read(SCAN));
    assert.deepEqual(await A.searchPage(id, 0, 'a'), []);
    await A.close(id);
  });
}
