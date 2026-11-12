// 모션 모듈 시험(스프링 수학, 쪽 이동 계획, 확대 슬라이더 눈금). 실행: cd app && node --test test/motion.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPRING, settleTime, solveSpring, stepResponse } from '../src/lib/motion/spring.ts';
import { duplicatePlan, invertPlan, noteState, planFor, recordPlan, removePlan, reorderPlan, rotatePlan } from '../src/lib/motion/plan.ts';
import { ZOOM_SLIDER_MAX, sliderToZoom, zoomToSlider } from '../src/lib/zoom-scale.ts';
import { GRID_MAX, GRID_MIN, clampGrid, loadSettings, saveSettings, defaultSettings } from '../src/lib/settings.ts';

const sz = (n) => Array.from({ length: n }, (_, i) => ({ width: 300 + i, height: 400 + i }));

test('스프링: 0 에서 출발해 1 로 수렴하고, 약한 감쇠는 1 을 넘어 한 번 출렁인다', () => {
  for (const [name, s] of Object.entries(SPRING)) {
    assert.equal(stepResponse(s, 0), 0, name);
    assert.ok(Math.abs(stepResponse(s, 5) - 1) < 1e-3, `${name} 수렴`);
    const T = settleTime(s);
    assert.ok(T > 0.1 && T < 1.5, `${name} 정착 ${T}s`);
  }
  const peak = (s) => Math.max(...Array.from({ length: 200 }, (_, i) => stepResponse(s, (i / 200) * settleTime(s))));
  assert.ok(peak(SPRING.bouncy) > 1.05, 'bouncy 는 넘친다');
  assert.ok(peak(SPRING.heavy) < 1.01, 'heavy 는 거의 넘치지 않는다');
});

test('solveSpring: 정규화 진행도 0→0, 1→1, linear() 문자열과 지속 시간', () => {
  const r = solveSpring(SPRING.pop);
  assert.equal(r.fn(0), 0);
  assert.equal(r.fn(1), 1);
  assert.match(r.css, /^linear\(0, /);
  assert.ok(r.duration >= 200 && r.duration <= 800);
  assert.equal(solveSpring(SPRING.pop), r, '같은 사양은 캐시');
});

test('reorderPlan: order[새 위치] = 원래 인덱스 를 from→to 로 옮긴다', () => {
  const p = reorderPlan(sz(4), [1, 2, 0, 3]);
  assert.deepEqual(p.entries.map((e) => [e.from, e.to]), [[1, 0], [2, 1], [0, 2], [3, 3]]);
  assert.equal(p.newSizes[2].width, 300);
});

test('removePlan: 지운 쪽은 to=null, 뒤 쪽은 앞으로 당겨진다', () => {
  const p = removePlan(sz(5), [1, 3]);
  assert.deepEqual(p.entries.map((e) => [e.from, e.to]), [[0, 0], [1, null], [2, 1], [3, null], [4, 2]]);
  assert.equal(p.newSizes.length, 3);
});

test('duplicatePlan: 복제본은 원본에서 갈라져 나오고 뒤 쪽은 밀린다', () => {
  const p = duplicatePlan(sz(3), [0, 1], 2);
  assert.deepEqual(p.entries.filter((e) => e.from != null).map((e) => [e.from, e.to]), [[0, 0], [1, 1], [2, 4]]);
  assert.deepEqual(p.entries.filter((e) => e.from == null).map((e) => [e.to, e.via]), [[2, 0], [3, 1]]);
  assert.equal(p.newSizes.length, 5);
});

test('rotatePlan: 돌린 쪽은 가로세로가 바뀌고 rot 이 붙는다', () => {
  const p = rotatePlan(sz(3), [1]);
  assert.equal(p.entries[1].rot, 90);
  assert.equal(p.entries[0].rot, undefined);
  assert.deepEqual([p.newSizes[1].width, p.newSizes[1].height], [401, 301]);
});

test('invertPlan: 같은 조작을 거꾸로, 두 번 뒤집으면 원래대로', () => {
  const p = reorderPlan(sz(3), [2, 0, 1]);
  const q = invertPlan(p);
  assert.deepEqual(q.entries.map((e) => [e.from, e.to]), [[0, 2], [1, 0], [2, 1]]);
  assert.equal(q.oldSizes, p.newSizes);
  const r = invertPlan(rotatePlan(sz(2), [0]));
  assert.equal(r.entries[0].rot, -90);
});

test('되돌리기 연출: 조작 뒤 상태 id 로 이어 주고, 쪽 수가 다르면 쓰지 않는다', () => {
  const p = removePlan(sz(4), [0]);
  recordPlan(7, 100, p);
  noteState(7, 101);
  const undo = planFor(101, 'undo', 3); // 지금 3쪽 → 되돌리면 4쪽
  assert.ok(undo);
  assert.equal(undo.entries.find((e) => e.from == null)?.to, 0, '지웠던 쪽이 다시 생긴다');
  assert.equal(planFor(101, 'undo', 9), null);
  const redo = planFor(100, 'redo', 4);
  assert.equal(redo, p);
});

test('확대 슬라이더: 25%→0, 100%→500(가운데), 400%→1000 의 로그 눈금, 왕복이 보존된다', () => {
  assert.equal(zoomToSlider(0.25), 0);
  assert.equal(zoomToSlider(1), ZOOM_SLIDER_MAX / 2);
  assert.equal(zoomToSlider(4), ZOOM_SLIDER_MAX);
  assert.equal(sliderToZoom(0), 0.25);
  assert.equal(sliderToZoom(500), 1);
  assert.equal(sliderToZoom(1000), 4);
  for (const z of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]) assert.ok(Math.abs(sliderToZoom(zoomToSlider(z)) - z) < 0.01, String(z));
  assert.equal(sliderToZoom(-50), 0.25);
  assert.equal(sliderToZoom(5000), 4);
});

test('썸네일 최대 크기는 640px, 저장된 400 은 그대로 두고 범위를 넘는 값만 보정한다', () => {
  assert.equal(GRID_MAX, 640);
  assert.equal(GRID_MIN, 80);
  assert.equal(clampGrid(9999), 640);
  assert.equal(clampGrid(400), 400);
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)) };
  saveSettings({ ...defaultSettings, gridThumb: 500 });
  assert.equal(loadSettings().gridThumb, 500);
  m.set('pdf-edit:settings', JSON.stringify({ gridThumb: 5000 }));
  assert.equal(loadSettings().gridThumb, 640);
});
