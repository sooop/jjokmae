// 쪽 비트맵 캐시: 내용 id + 배율로 찾고, 상한을 넘으면 오래 안 쓴 것부터 닫아 버린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BitmapCache, freshCids, newCid } from '../src/lib/bitmap-cache.ts';

const fake = (w, h) => ({ width: w, height: h, closed: false, close() { this.closed = true; } });

test('newCid·freshCids: 겹치지 않는 id', () => {
  const a = newCid();
  const list = freshCids(4);
  assert.equal(new Set([a, ...list]).size, 5);
});

test('get 은 같은 내용·같은 배율만, nearest 는 같은 내용의 가장 가까운 배율', () => {
  const c = new BitmapCache(1000, 500);
  const small = fake(10, 10);
  const big = fake(20, 20);
  assert.equal(c.put(1, 0.5, small), true);
  assert.equal(c.put(1, 2, big), true);
  assert.equal(c.get(1, 0.5), small);
  assert.equal(c.get(1, 1), null);
  assert.equal(c.get(2, 0.5), null);
  assert.equal(c.nearest(1, 1.9), big);
  assert.equal(c.nearest(1, 0.6), small);
  assert.equal(c.nearest(2, 1), null);
});

test('너무 큰 그림은 받지 않는다(호출자가 닫는다)', () => {
  const c = new BitmapCache(1000, 100);
  const b = fake(20, 20);
  assert.equal(c.put(1, 1, b), false);
  assert.equal(b.closed, false);
  assert.deepEqual(c.stats(), { entries: 0, px: 0 });
});

test('상한을 넘으면 오래 안 쓴 것부터 닫고, 방금 쓴 것은 남는다', () => {
  const c = new BitmapCache(300, 200);
  const a = fake(10, 10);
  const b = fake(10, 10);
  const d = fake(10, 10);
  c.put(1, 1, a);
  c.put(2, 1, b);
  c.put(3, 1, d);
  assert.equal(c.get(1, 1), a); // 1 을 최근 사용으로
  const e = fake(10, 10);
  c.put(4, 1, e);
  assert.equal(b.closed, true);
  assert.equal(c.get(2, 1), null);
  assert.equal(c.nearest(2, 1), null);
  assert.equal(c.get(1, 1), a);
  assert.equal(a.closed, false);
  assert.deepEqual(c.stats(), { entries: 3, px: 300 });
});

test('같은 열쇠로 다시 넣으면 옛 그림을 닫고 바꾼다', () => {
  const c = new BitmapCache(1000, 500);
  const a = fake(10, 10);
  const b = fake(10, 10);
  c.put(1, 1, a);
  c.put(1, 1, b);
  assert.equal(a.closed, true);
  assert.equal(c.get(1, 1), b);
  assert.deepEqual(c.stats(), { entries: 1, px: 100 });
});
