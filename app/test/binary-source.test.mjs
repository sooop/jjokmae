// 실행: node --test test/binary-source.test.mjs  (Node 22.6+ 타입 스트리핑)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBinarySource } from '../src/engine/binary-source.ts';

const payload = new Uint8Array(100_000).map((_, i) => i % 251);
const sha = createHash('sha256').update(payload).digest('hex');
const ref = (over = {}) => ({
  id: 't.wasm', path: 'engines/t.wasm', cdnUrl: 'https://cdn.example/t.wasm',
  sha256: sha, size: payload.byteLength, reason: '테스트', ...over,
});

function memStore() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => (m.set(k, v), true) };
}
function fakeFetch(bytes = payload) {
  const f = async () => {
    f.calls++;
    const parts = [bytes.slice(0, 30_000), bytes.slice(30_000, 60_000), bytes.slice(60_000)];
    const body = new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(p)); c.close(); } });
    return new Response(body, { headers: { 'content-length': String(bytes.byteLength) } });
  };
  f.calls = 0;
  return f;
}
const make = (o = {}) => {
  const store = memStore(), fetch = fakeFetch();
  return { store, fetch, src: createBinarySource({ target: 'single', store, fetch, subtle: globalThis.crypto.subtle, ...o }) };
};

test('해시 일치 시 저장하고 반환', async () => {
  const { src, store } = make();
  assert.equal(await src.has(ref()), false);
  const buf = await src.get(ref());
  assert.equal(buf.byteLength, payload.byteLength);
  assert.equal(store.m.size, 1);
  assert.equal(await src.has(ref()), true);
});

test('해시 불일치 시 저장 없이 오류', async () => {
  const { src, store } = make();
  await assert.rejects(src.get(ref({ sha256: '0'.repeat(64) })), (e) => e.code === 'hash-mismatch' && /일치하지 않아/.test(e.message));
  assert.equal(store.m.size, 0);
});

test('두 번째 호출은 fetch 하지 않음', async () => {
  const { src, fetch } = make();
  await src.get(ref());
  assert.equal(fetch.calls, 1);
  await src.get(ref());
  assert.equal(fetch.calls, 1);
});

test('진행률 콜백이 단조 증가하며 total 에 도달', async () => {
  const { src } = make();
  const seen = [];
  await src.get(ref(), { onProgress: (p) => seen.push(p) });
  assert.ok(seen.length >= 3);
  const loaded = seen.map((p) => p.loaded);
  assert.deepEqual(loaded, [...loaded].sort((a, b) => a - b));
  assert.equal(seen.at(-1).loaded, payload.byteLength);
  assert.equal(seen.at(-1).total, payload.byteLength);
});

test('crypto.subtle 없으면(single) 오류, 저장 안 함', async () => {
  const { src, store } = make({ subtle: null });
  await assert.rejects(src.get(ref()), (e) => e.code === 'no-subtle');
  assert.equal(store.m.size, 0);
});

test('confirmDownload false 면 fetch 없이 중단, 캐시 적중 시 호출 안 함', async () => {
  const { src, fetch } = make();
  await assert.rejects(src.get(ref(), { confirmDownload: () => false }), (e) => e.code === 'declined');
  assert.equal(fetch.calls, 0);
  await src.get(ref(), { confirmDownload: () => true });
  let asked = 0;
  await src.get(ref(), { confirmDownload: () => (asked++, true) });
  assert.equal(asked, 0);
});

test('static 은 같은 출처 경로로 fetch', async () => {
  const store = memStore();
  const urls = [];
  const f = async (u) => (urls.push(u), new Response(payload));
  const src = createBinarySource({ target: 'static', store, fetch: f, subtle: globalThis.crypto.subtle, baseUrl: 'https://site.example/app/' });
  await src.get(ref());
  assert.deepEqual(urls, ['https://site.example/app/engines/t.wasm']);
  assert.equal(store.m.size, 1);
});
