// RenderScheduler 시험: 가짜 renderPage 로 rebind·취소·dispose·우선순위·동시 실행 상한·동기 예외 복구를 본다.
// 실행: cd app && node --test test/render-queue.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderScheduler } from '../src/lib/render-queue.ts';

/** 호출을 보류했다가 시험이 직접 끝내는 가짜 어댑터 */
function fake() {
  const calls = [];
  const a = {
    calls,
    renderPage(doc, index, scale) {
      return new Promise((resolve, reject) => {
        calls.push({ doc, index, scale, resolve: () => resolve({ width: 1, height: 1, data: new ArrayBuffer(4), tag: `${doc}:${index}` }), reject });
      });
    },
  };
  return a;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('동시 실행 수는 상한(2)을 넘지 않고, 끝나면 다음 것이 나간다', async () => {
  const a = fake();
  const s = new RenderScheduler(a, 'A', 2);
  const jobs = [0, 1, 2, 3].map((i) => s.request(i, 1, () => i));
  assert.equal(a.calls.length, 2);
  a.calls[0].resolve();
  await tick();
  assert.equal(a.calls.length, 3);
  a.calls[1].resolve();
  a.calls[2].resolve();
  await tick();
  assert.equal(a.calls.length, 4);
  a.calls[3].resolve();
  const r = await Promise.all(jobs.map((j) => j.promise));
  assert.ok(r.every((b) => b));
});

test('우선순위가 작은 요청이 먼저 나간다(보내는 시점에 평가)', async () => {
  const a = fake();
  const s = new RenderScheduler(a, 'A', 1);
  const pr = { 1: 5, 2: 9, 3: 1 };
  s.request(0, 1, () => 0); // 바로 나감
  s.request(1, 1, () => pr[1]);
  s.request(2, 1, () => pr[2]);
  s.request(3, 1, () => pr[3]);
  pr[2] = 0; // 대기 중에 바뀐 우선순위가 반영된다
  a.calls[0].resolve();
  await tick();
  assert.equal(a.calls[1].index, 2);
  a.calls[1].resolve();
  await tick();
  assert.equal(a.calls[2].index, 3);
});

test('대기 중 취소는 null 로 끝나고 호출되지 않는다', async () => {
  const a = fake();
  const s = new RenderScheduler(a, 'A', 1);
  s.request(0, 1, () => 0);
  const j = s.request(1, 1, () => 1);
  j.cancel();
  assert.equal(await j.promise, null);
  a.calls[0].resolve();
  await tick();
  assert.equal(a.calls.length, 1);
});

test('나간 뒤 취소하면 결과를 버린다', async () => {
  const a = fake();
  const s = new RenderScheduler(a, 'A', 2);
  const j = s.request(0, 1, () => 0);
  j.cancel();
  a.calls[0].resolve();
  assert.equal(await j.promise, null);
});

test('dispose: 대기 요청은 null, 이후 요청도 null', async () => {
  const a = fake();
  const s = new RenderScheduler(a, 'A', 1);
  s.request(0, 1, () => 0);
  const q = s.request(1, 1, () => 1);
  s.dispose();
  assert.equal(await q.promise, null);
  assert.equal(await s.request(2, 1, () => 0).promise, null);
  assert.equal(a.calls.length, 1);
});

test('rebind: 대기 큐를 보존하고 새 id 로 보낸다', async () => {
  const a = fake();
  const s = new RenderScheduler(a, 'A', 1);
  s.request(0, 1, () => 0);
  const q = s.request(1, 1, () => 1);
  s.rebind('B');
  a.calls[0].resolve(); // 옛 id 로 나간 요청은 결과가 버려지고 새 id 로 다시 나간다
  await tick();
  const c1 = a.calls[1];
  assert.equal(c1.doc, 'B'); // 대기하던 요청이 새 id 로 나갔다(우선순위 1 < 재큐 0 은 아님: 0 이 먼저 나갈 수 있다)
  assert.ok([0, 1].includes(c1.index));
  // 남은 요청을 모두 끝낸다
  for (let k = 1; k < 5; k++) {
    await tick();
    a.calls[k]?.resolve();
  }
  assert.ok(await q.promise);
  assert.ok(a.calls.slice(1).every((c) => c.doc === 'B'));
});

test('rebind: 옛 id 로 나간 요청은 결과를 버리고 같은 요청을 새 id 로 다시 보내 비트맵으로 끝난다', async () => {
  const a = fake();
  const s = new RenderScheduler(a, 'A', 2);
  const j = s.request(7, 2, () => 0);
  assert.equal(a.calls[0].doc, 'A');
  s.rebind('B');
  a.calls[0].resolve();
  await tick();
  assert.equal(a.calls.length, 2);
  assert.deepEqual([a.calls[1].doc, a.calls[1].index, a.calls[1].scale], ['B', 7, 2]);
  a.calls[1].resolve();
  const b = await j.promise;
  assert.equal(b.tag, 'B:7');
});

test('rebind: 옛 문서가 닫혀 실패해도 재시도한다(onError 없음)', async () => {
  const a = fake();
  const errs = [];
  const s = new RenderScheduler(a, 'A', 2, (e) => errs.push(e));
  const j = s.request(3, 1, () => 0);
  s.rebind('B');
  a.calls[0].reject(new Error('문서가 닫혔다'));
  await tick();
  assert.equal(a.calls[1].doc, 'B');
  a.calls[1].resolve();
  assert.equal((await j.promise).tag, 'B:3');
  assert.equal(errs.length, 0);
});

test('rebind 뒤 새 id 에서의 실패는 재시도하지 않고 null + onError', async () => {
  const a = fake();
  const errs = [];
  const s = new RenderScheduler(a, 'A', 2, (e) => errs.push(e));
  s.rebind('B');
  const j = s.request(0, 1, () => 0);
  a.calls[0].reject(new Error('진짜 실패'));
  assert.equal(await j.promise, null);
  assert.equal(errs.length, 1);
  assert.equal(a.calls.length, 1);
});

test('rebind 후 재시도 대기 중 취소하면 null', async () => {
  const a = fake();
  const s = new RenderScheduler(a, 'A', 1);
  const j = s.request(0, 1, () => 0);
  s.request(1, 1, () => 5);
  s.rebind('B');
  a.calls[0].resolve();
  await tick();
  // j 는 (우선순위 0) 새 id 로 다시 나갔다. 그 호출 중에 취소하면 결과를 버린다
  j.cancel();
  a.calls[1].resolve();
  assert.equal(await j.promise, null);
});

test('rebind 뒤 dispose 하면 재시도하지 않고 null', async () => {
  const a = fake();
  const s = new RenderScheduler(a, 'A', 1);
  const j = s.request(0, 1, () => 0);
  s.rebind('B');
  s.dispose();
  a.calls[0].resolve();
  assert.equal(await j.promise, null);
  assert.equal(a.calls.length, 1);
});

test('renderPage 가 동기로 던져도 inFlight 가 복구되어 다음 요청이 나간다', async () => {
  let n = 0;
  const calls = [];
  const adapter = {
    renderPage(doc, index) {
      calls.push(index);
      if (n++ === 0) throw new Error('동기 예외');
      return Promise.resolve({ width: 1, height: 1, data: new ArrayBuffer(4) });
    },
  };
  const errs = [];
  const s = new RenderScheduler(adapter, 'A', 1, (e) => errs.push(e));
  const j0 = s.request(0, 1, () => 0);
  const j1 = s.request(1, 1, () => 1);
  assert.equal(await j0.promise, null);
  assert.ok(await j1.promise);
  assert.equal(errs.length, 1);
  assert.deepEqual(calls, [0, 1]);
  await tick();
  assert.equal(s.pending, 0);
});
