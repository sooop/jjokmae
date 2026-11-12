// 실행: node --test test/worker-client.test.mjs  (가짜 Worker 로 클라이언트 본체를 검증)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngineClientOn } from '../src/engine/worker-client-core.ts';

const METHODS = ['open', 'close', 'pageCount'];

/** 가짜 Worker. onPost 로 postMessage 동작을 바꾼다. 기본: init 과 호출에 ok 로 답한다 */
function fakeWorker(onPost) {
  const w = {
    terminated: 0,
    posted: [],
    terminate() { w.terminated++; },
    postMessage(msg, opts) {
      w.posted.push(msg);
      if (onPost) return onPost(w, msg, opts);
      queueMicrotask(() => w.onmessage({ data: { id: msg.id, ok: true, result: msg.type === 'init' ? undefined : 7 } }));
    },
  };
  return w;
}
const opts = () => ({ engine: 'mupdf', wasm: new ArrayBuffer(8) });

test('정상 호출과 dead 초기값', async () => {
  const w = fakeWorker();
  const c = await createEngineClientOn(w, opts(), METHODS);
  assert.equal(c.dead, false);
  assert.equal(c.deadReason, null);
  assert.equal(await c.pageCount('d'), 7);
});

test('onerror: 대기 중인 호출을 reject 하고 워커를 terminate, dead=true, 이후 호출도 즉시 reject', async () => {
  const w = fakeWorker((ww, msg) => {
    if (msg.type === 'init') queueMicrotask(() => ww.onmessage({ data: { id: msg.id, ok: true } }));
    // 호출에는 답하지 않는다(대기 상태 유지)
  });
  const c = await createEngineClientOn(w, opts(), METHODS);
  const p1 = c.pageCount('d');
  const p2 = c.close('d');
  w.onerror({ message: '워커 폭발' });
  await assert.rejects(p1, /워커 폭발/);
  await assert.rejects(p2, /워커 폭발/);
  assert.equal(w.terminated, 1);
  assert.equal(c.dead, true);
  assert.match(c.deadReason.message, /워커 폭발/);
  const before = w.posted.length;
  await assert.rejects(c.pageCount('d'), /워커 폭발/);
  assert.equal(w.posted.length, before, '죽은 뒤에는 postMessage 하지 않는다');
});

test('onmessageerror 도 워커를 terminate 하고 dead', async () => {
  const w = fakeWorker((ww, msg) => {
    if (msg.type === 'init') queueMicrotask(() => ww.onmessage({ data: { id: msg.id, ok: true } }));
  });
  const c = await createEngineClientOn(w, opts(), METHODS);
  const p = c.pageCount('d');
  w.onmessageerror();
  await assert.rejects(p, /메시지 오류/);
  assert.equal(w.terminated, 1);
  assert.equal(c.dead, true);
});

test('postMessage 가 던지면(DataCloneError) 그 호출만 reject 되고 pending 은 남지 않으며 워커는 살아 있다', async () => {
  let fail = false;
  const w = fakeWorker((ww, msg) => {
    if (fail && msg.type === 'call') throw new DOMException('복제 불가', 'DataCloneError');
    queueMicrotask(() => ww.onmessage({ data: { id: msg.id, ok: true, result: 1 } }));
  });
  const c = await createEngineClientOn(w, opts(), METHODS);
  fail = true;
  await assert.rejects(c.pageCount('d'), (e) => e.name === 'DataCloneError');
  assert.equal(c.dead, false);
  assert.equal(w.terminated, 0);
  // 이후 호출은 정상 동작한다(pending 항목 누수 자체는 외부에서 관찰할 수 없어 코드 검토로만 확인: worker-client-core.ts 의 catch 에서 delete)
  fail = false;
  assert.equal(await c.pageCount('d'), 1);
});

test('dispose 는 워커를 종료하고 dead', async () => {
  const w = fakeWorker();
  const c = await createEngineClientOn(w, opts(), METHODS);
  c.dispose();
  assert.equal(w.terminated, 1);
  assert.equal(c.dead, true);
  await assert.rejects(c.pageCount('d'), /종료/);
});

test('초기화 실패 시 워커를 terminate 하고 reject', async () => {
  const w = fakeWorker((ww, msg) => queueMicrotask(() => ww.onmessage({ data: { id: msg.id, ok: false, error: 'wasm 로드 실패' } })));
  await assert.rejects(createEngineClientOn(w, opts(), METHODS), /wasm 로드 실패/);
  assert.equal(w.terminated, 1);
});
