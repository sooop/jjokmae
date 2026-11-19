// 다중 문서 작업 공간의 순수 로직 시험: 이름 중복, 보낼 위치, 이동 묶음 짝 찾기, 되돌리기 기록 풀. 실행: cd app && node --test test/workspace.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryPool, UndoHistory } from '../src/lib/history.ts';
import { cleanName } from '../src/lib/download.ts';
import { findBundlePartners, insertIndex, moveItem, newDocName, posLabel, quoteNames, range, uniqueName } from '../src/lib/transfer.ts';

test('uniqueName: 겹치면 (2), (3) … 으로 구분한다', () => {
  assert.equal(uniqueName([], 'a.pdf'), 'a.pdf');
  assert.equal(uniqueName(['a.pdf'], 'a.pdf'), 'a (2).pdf');
  assert.equal(uniqueName(['a.pdf', 'a (2).pdf'], 'a.pdf'), 'a (3).pdf');
  assert.equal(uniqueName(['A.PDF'], 'a.pdf'), 'a (2).pdf'); // 대소문자 무시
  assert.equal(uniqueName(['x'], 'x'), 'x (2)'); // 확장자 없는 이름(MIME 으로만 PDF 판정)
});

// 이름 변경(ws.renameDoc)이 쓰는 규칙: 입력 정리(cleanName) 뒤 다른 열린 파일과 겹치면 uniqueName 으로 구분한다
const renameTo = (others, input) => {
  const c = cleanName(input);
  return c ? uniqueName(others, c) : null;
};
test('이름 변경: 금지 문자 제거·.pdf 보정, 빈 값은 취소(null), 겹치면 (2) 로 구분', () => {
  assert.equal(renameTo([], '계약서'), '계약서.pdf');
  assert.equal(renameTo([], ' 계약서:최종?.PDF '), '계약서최종.pdf');
  assert.equal(renameTo([], ''), null);
  assert.equal(renameTo([], '  '), null);
  assert.equal(renameTo([], '/:*?'), null);
  assert.equal(renameTo([], '.pdf'), null);
  assert.equal(renameTo(['a.pdf'], 'a'), 'a (2).pdf');
  assert.equal(renameTo(['A.pdf', 'a (2).pdf'], 'a.pdf'), 'a (3).pdf'); // 대소문자 무시
  assert.equal(renameTo(['b.pdf'], 'a'), 'a.pdf');
  assert.equal(renameTo([], 'CON'), '_CON.pdf');
});

test('newDocName: 새 문서 N.pdf', () => {
  assert.deepEqual(newDocName([]), { name: '새 문서 1.pdf', n: 1 });
  assert.deepEqual(newDocName(['새 문서 1.pdf', '새 문서 2.pdf']), { name: '새 문서 3.pdf', n: 3 });
  assert.deepEqual(newDocName(['새 문서 1.pdf'], 2), { name: '새 문서 2.pdf', n: 2 });
});

test('insertIndex: 맨 앞 / 맨 뒤 / 쪽 번호 뒤(범위 밖은 오류)', () => {
  assert.equal(insertIndex('start', 5), 0);
  assert.equal(insertIndex('end', 5), 5);
  assert.equal(insertIndex({ after: 3 }, 5), 3);
  assert.equal(insertIndex({ after: 5 }, 5), 5);
  for (const bad of [0, 6, -1, 1.5, NaN]) assert.throws(() => insertIndex({ after: bad }, 5), RangeError);
  assert.equal(posLabel({ after: 2 }), '2쪽 뒤');
  assert.deepEqual(range(3, 3), [3, 4, 5]);
});

test('quoteNames: 많으면 줄여 쓴다', () => {
  assert.equal(quoteNames(['a.pdf', 'b.pdf']), '‘a.pdf’, ‘b.pdf’');
  assert.equal(quoteNames(['a', 'b', 'c', 'd', 'e']), '‘a’, ‘b’, ‘c’ 외 2개');
});

test('findBundlePartners: 맨 위가 같은 번호면 짝, 더 아래에 있으면 막힘, 없으면 단독', () => {
  const others = [
    { key: 1, stack: [{ bundle: 7 }] }, // 짝
    { key: 2, stack: [{ bundle: 7 }, {}] }, // 이후 편집이 있어 막힘
    { key: 3, stack: [{}, {}] }, // 무관
    { key: 4, stack: [] },
  ];
  assert.deepEqual(findBundlePartners(7, 0, others), { partners: [1], blocked: [2] });
  assert.deepEqual(findBundlePartners(9, 0, others), { partners: [], blocked: [] });
});

const snap = (n, bundle) => ({ bytes: new Uint8Array(n), bundle });

test('HistoryPool: 합계가 상한을 넘으면 가장 오래 쓰지 않은 문서의 오래된 단계부터 줄인다', () => {
  const pool = new HistoryPool(1000);
  const a = new UndoHistory(20, 100000, pool);
  const b = new UndoHistory(20, 100000, pool);
  const c = new UndoHistory(20, 100000, pool);
  for (let i = 0; i < 3; i++) a.push(snap(100)); // 300 (가장 오래됨)
  for (let i = 0; i < 3; i++) b.push(snap(100)); // 300
  for (let i = 0; i < 3; i++) c.push(snap(100)); // 300 → 합계 900
  assert.equal(pool.bytes, 900);
  c.push(snap(300)); // 1200 → a 에서 2단계(오래된 것)를 줄여 1000 이하
  assert.ok(pool.bytes <= 1000, String(pool.bytes));
  assert.equal(a.undoStack.length, 1);
  assert.equal(b.undoStack.length, 3);
  assert.equal(c.undoStack.length, 4);
  // 방금 쓴 문서(b)를 touch 한 뒤 더 쌓으면 이번에는 a 가 아니라 c 가 가장 오래된 문서다
  b.push(snap(100));
  b.push(snap(100));
  assert.ok(pool.bytes <= 1000);
  assert.ok(c.undoStack.length < 4);
  assert.equal(b.undoStack.length, 5);
});

test('HistoryPool: 문서마다 1단계는 남기고, 그래도 넘으면 오래된 문서를 0단계까지 줄인다', () => {
  const pool = new HistoryPool(500);
  const a = new UndoHistory(20, 100000, pool);
  const b = new UndoHistory(20, 100000, pool);
  a.push(snap(300));
  b.push(snap(300)); // 600 > 500, 둘 다 1단계뿐 → 오래된 a 를 비운다(b 는 방금 쓴 문서라 유지)
  assert.equal(a.undoStack.length, 0);
  assert.equal(b.undoStack.length, 1);
  assert.equal(pool.bytes, 300);
  // 한 문서가 상한보다 커도 그 문서의 마지막 1단계는 남긴다
  const big = new UndoHistory(20, 100000, pool);
  big.push(snap(900));
  assert.equal(big.undoStack.length, 1);
  assert.equal(b.undoStack.length, 0);
});

test('HistoryPool: 다시하기 기록을 먼저 버리고, 버려진 단계는 ondrop 으로 알린다', () => {
  const pool = new HistoryPool(500);
  const a = new UndoHistory(20, 100000, pool);
  const dropped = [];
  a.ondrop = (s) => dropped.push(s.bundle);
  a.push(snap(100, 1));
  a.push(snap(100, 2));
  a.pushRedo(snap(100, 3));
  const b = new UndoHistory(20, 100000, pool);
  b.push(snap(400)); // 합계 700 > 500 → a 의 다시하기(3) → 그래도 넘으면 a 의 오래된 되돌리기(1)
  assert.deepEqual(dropped, [3, 1]);
  assert.ok(pool.bytes <= 500);
  // dispose 하면 풀에서 빠진다
  a.dispose();
  assert.equal(pool.size, 1);
});

test('UndoHistory: 풀 없이 쓰는 기존 동작은 그대로', () => {
  const h = new UndoHistory(20, 1000);
  for (let i = 0; i < 30; i++) h.push(snap(10));
  assert.equal(h.undoStack.length, 20);
  h.pushRedo(snap(1));
  h.push(snap(10));
  assert.equal(h.canRedo, false);
});

test('pushRedo/pushUndo 도 문서 상한(단계 수·바이트)을 다시 검사한다', () => {
  const snap = (n) => ({ bytes: new Uint8Array(n) });
  const h = new UndoHistory(3, 1000);
  for (let i = 0; i < 6; i++) h.pushRedo(snap(10));
  assert.equal(h.redoStack.length, 3); // 단계 수 상한
  for (let i = 0; i < 6; i++) h.pushUndo(snap(10));
  assert.equal(h.undoStack.length, 3);
  const b = new UndoHistory(20, 1000);
  for (let i = 0; i < 10; i++) b.pushRedo(snap(300));
  assert.ok(b.redoStack.length <= 3 && b.redoStack.length >= 1); // floor(1000/300)
  assert.ok(b.bytes <= 1000);
  const dropped = [];
  const c = new UndoHistory(2, 1000);
  c.ondrop = (s) => dropped.push(s);
  for (let i = 0; i < 4; i++) c.pushRedo(snap(1));
  assert.equal(dropped.length, 2); // 버려진 단계는 ondrop 으로 알린다
});

test('moveItem: 문서 순서 변경은 항목(키)을 그대로 두고 범위를 보정한다', () => {
  const docs = [{ key: 1 }, { key: 2 }, { key: 3 }, { key: 4 }];
  const keys = (l) => l.map((d) => d.key);
  assert.deepEqual(keys(moveItem(docs, 0, 2)), [2, 3, 1, 4]);
  assert.deepEqual(keys(moveItem(docs, 3, 0)), [4, 1, 2, 3]);
  assert.deepEqual(keys(moveItem(docs, 1, 99)), [1, 3, 4, 2]); // 큰 값은 끝으로
  assert.deepEqual(keys(moveItem(docs, 2, -5)), [3, 1, 2, 4]); // 음수는 맨 앞으로
  assert.deepEqual(keys(moveItem(docs, 1, 1)), [1, 2, 3, 4]); // 제자리
  assert.deepEqual(keys(moveItem(docs, 9, 0)), [1, 2, 3, 4]); // 없는 항목은 그대로
  assert.deepEqual(keys(moveItem(docs, 1, NaN)), [1, 2, 3, 4]);
  const out = moveItem(docs, 0, 3);
  assert.notEqual(out, docs); // 원본은 바뀌지 않는다
  assert.deepEqual(keys(docs), [1, 2, 3, 4]);
  assert.ok(out.every((d) => docs.includes(d))); // 같은 객체(활성 문서·키 유지)
  assert.deepEqual(moveItem([], 0, 0), []);
  assert.deepEqual(moveItem([7], 0, 5), [7]);
});

