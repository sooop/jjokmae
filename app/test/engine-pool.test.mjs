// 엔진 수명 관리(EnginePool)와 다시하기용 ghost 저장소 시험. 실행: cd app && node --test test/engine-pool.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EnginePool } from '../src/lib/engine-pool.ts';
import { GhostStore, UndoHistory } from '../src/lib/history.ts';

function setup(isDead) {
  const boots = [];
  const made = [];
  const pool = new EnginePool(
    (kind) =>
      new Promise((resolve, reject) => {
        boots.push({ kind, resolve: () => { const c = { kind, dead: false, disposed: 0, dispose() { this.disposed++; this.dead = true; } }; made.push(c); resolve(c); }, reject });
      }),
    isDead ?? ((c) => c.dead),
  );
  return { pool, boots, made };
}

test('같은 종류를 동시에 acquire 해도 기동은 한 번이다', async () => {
  const { pool, boots } = setup();
  const a = pool.acquire('mupdf');
  const b = pool.acquire('mupdf');
  const c = pool.acquire('pdfium');
  assert.equal(boots.length, 2);
  boots[0].resolve();
  boots[1].resolve();
  const [x, y] = await Promise.all([a, b, c]);
  assert.equal(x, y);
  assert.deepEqual(pool.kinds().sort(), ['mupdf', 'pdfium']);
  assert.equal(await pool.acquire('mupdf'), x); // 이미 있으면 재기동 없음
  assert.equal(boots.length, 2);
});

test('기동 실패 뒤에는 다시 기동할 수 있다', async () => {
  const { pool, boots } = setup();
  const a = pool.acquire('mupdf');
  boots[0].reject(new Error('실패'));
  await assert.rejects(a);
  const b = pool.acquire('mupdf');
  assert.equal(boots.length, 2);
  boots[1].resolve();
  assert.ok(await b);
});

test('죽은 엔진은 폐기하고 새로 기동한다', async () => {
  const { pool, boots, made } = setup();
  const p = pool.acquire('mupdf');
  boots[0].resolve();
  const first = await p;
  first.dead = true;
  const q = pool.acquire('mupdf');
  assert.equal(boots.length, 2);
  assert.equal(first.disposed, 1);
  boots[1].resolve();
  const second = await q;
  assert.notEqual(first, second);
  assert.equal(pool.get('mupdf'), second);
  assert.equal(made.length, 2);
});

test('pin 한 종류는 문서가 없어도 내리지 않고, 기동 중인 종류도 내리지 않는다', async () => {
  const { pool, boots } = setup();
  const p = pool.acquire('mupdf');
  boots[0].resolve();
  const c = await p;
  pool.pin('mupdf');
  pool.pin('mupdf');
  assert.deepEqual(pool.releaseUnused(() => false), []);
  pool.unpin('mupdf');
  assert.deepEqual(pool.releaseUnused(() => false), []); // 아직 1개 남았다
  pool.unpin('mupdf');
  assert.deepEqual(pool.releaseUnused(() => true), []); // 문서가 있으면 유지
  assert.deepEqual(pool.releaseUnused(() => false), ['mupdf']);
  assert.equal(c.disposed, 1);
  assert.equal(pool.get('mupdf'), undefined);
});

test('다른 종류가 기동 중일 때 그 종류의 엔진이 내려가지 않는다(종류별 pin)', async () => {
  const { pool, boots } = setup();
  const p = pool.acquire('mupdf');
  boots[0].resolve();
  await p;
  pool.pin('pdfium');
  const q = pool.acquire('pdfium');
  // pdfium 기동 중: mupdf 는 문서가 없으면 내려가고, pdfium 은 기동·pin 으로 보호된다
  assert.deepEqual(pool.releaseUnused(() => false), ['mupdf']);
  boots[1].resolve();
  await q;
  assert.deepEqual(pool.releaseUnused(() => false), []);
  pool.unpin('pdfium');
  assert.deepEqual(pool.releaseUnused(() => false), ['pdfium']);
});

test('GhostStore: 합계 상한을 넘으면 오래된 것부터 버리고 알린다(최신 1개는 남긴다)', () => {
  const g = new GhostStore(100);
  const evicted = [];
  g.onEvict = (b) => evicted.push(b);
  const mk = (n) => ({ bytes: new Uint8Array(n) });
  g.set(1, mk(40));
  g.set(2, mk(40));
  assert.deepEqual(evicted, []);
  g.set(3, mk(40));
  assert.deepEqual(evicted, [1]);
  assert.ok(!g.has(1) && g.has(2) && g.has(3));
  g.set(4, mk(500)); // 혼자 상한보다 커도 최신은 남긴다
  assert.deepEqual(evicted, [1, 2, 3]);
  assert.ok(g.has(4));
  g.delete(4); // 직접 지운 것은 알리지 않는다
  assert.deepEqual(evicted, [1, 2, 3]);
  assert.equal(g.size, 0);
});

test('UndoHistory.dropRedoThrough: 깊은 끝부터 해당 단계까지 버린다', () => {
  const h = new UndoHistory();
  const dropped = [];
  h.ondrop = (s) => dropped.push(s.id);
  for (const id of ['late', 'mid', 'early']) h.pushRedo({ bytes: new Uint8Array(1), id }); // top = early
  h.dropRedoThrough(1); // mid 와 그보다 나중(late) 을 버린다
  assert.deepEqual(h.redoStack.map((s) => s.id), ['early']);
  assert.deepEqual(dropped, ['late', 'mid']);
});
