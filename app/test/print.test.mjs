// 인쇄 순수 로직 시험: 대상 쪽 정하기·요약 문구, 해상도·메모리 계획, @page CSS. 실행: cd app && node --test test/print.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetFit, buildPageCss, defaultScope, estimateTotalBytes, MAX_PAGE_PX, MAX_TOTAL_BYTES, MIN_DPI, mixedOrientation, pageFit, rangeLabel, resolveTarget, selectedParts } from '../src/lib/print.ts';
import { parseRanges } from '../src/lib/ranges.ts';

const A = { key: 1, name: 'docA.pdf', total: 5, current: 2, selected: [] };
const B = { key: 2, name: 'docB.pdf', total: 4, current: 0, selected: [3, 1] };
const C = { key: 3, name: 'docC.pdf', total: 3, current: 0, selected: [0] };
const R = (scope, docs, active, mode = 'view', text = '') => resolveTarget(scope, docs, active, mode, text, parseRanges);

test('전체: 활성 파일의 모든 쪽, 요약은 파일명과 쪽 수', () => {
  const r = R('all', [A, B], 1);
  assert.ok(r.ok);
  assert.deepEqual(r.target.parts, [{ key: 1, name: 'docA.pdf', pages: [0, 1, 2, 3, 4] }]);
  assert.equal(r.target.count, 5);
  assert.equal(r.target.summary, 'docA.pdf 5쪽');
});

test('선택한 쪽: 보기 모드는 활성 파일만, 쪽 순서대로', () => {
  const r = R('selected', [A, B, C], 2);
  assert.ok(r.ok);
  assert.deepEqual(r.target.parts, [{ key: 2, name: 'docB.pdf', pages: [1, 3] }]);
  assert.equal(r.target.summary, '선택한 2쪽');
});

test('선택한 쪽: 정리 모드는 여러 파일을 파일 순서·쪽 순서대로 합친다', () => {
  const r = R('selected', [A, B, C], 1, 'organize');
  assert.ok(r.ok);
  assert.deepEqual(r.target.parts.map((p) => [p.key, p.pages]), [[2, [1, 3]], [3, [0]]]);
  assert.equal(r.target.count, 3);
  assert.equal(r.target.summary, '2개 파일에서 선택한 3쪽');
  assert.deepEqual(selectedParts([A, B, C], 1, 'view'), []);
});

test('선택한 쪽이 없으면 오류, 기본 범위는 전체', () => {
  const r = R('selected', [A], 1);
  assert.equal(r.ok, false);
  assert.equal(defaultScope([A], 1, 'view'), 'all');
  assert.equal(defaultScope([A, B], 2, 'view'), 'selected');
  assert.equal(defaultScope([A, B], 1, 'organize'), 'selected'); // 다른 파일의 선택도 정리 모드에서는 대상이다
});

test('현재 쪽: 범위 안으로 보정', () => {
  const r = R('current', [A], 1);
  assert.ok(r.ok);
  assert.deepEqual(r.target.parts[0].pages, [2]);
  assert.equal(r.target.summary, 'docA.pdf 3쪽');
  const o = R('current', [{ ...A, current: 99 }], 1);
  assert.ok(o.ok);
  assert.deepEqual(o.target.parts[0].pages, [4]);
});

test('범위 입력: 쪽 번호 순서·중복 제거, 오류는 문구로', () => {
  const r = R('range', [A], 1, 'view', '5, 1-2, 2');
  assert.ok(r.ok);
  assert.deepEqual(r.target.parts[0].pages, [0, 1, 4]);
  assert.equal(r.target.summary, 'docA.pdf 3쪽 (1-2, 5)');
  const open = R('range', [A], 1, 'view', '4-');
  assert.ok(open.ok);
  assert.deepEqual(open.target.parts[0].pages, [3, 4]);
  for (const bad of ['', '9', '3-1', 'x']) {
    const e = R('range', [A], 1, 'view', bad);
    assert.equal(e.ok, false, bad);
    assert.ok(!/나눌/.test(e.error), `나누기 문구가 새면 안 된다: ${e.error}`);
  }
});

test('문서가 없으면 대상 없음', () => {
  assert.equal(R('all', [], null).ok, false);
});

test('rangeLabel', () => {
  assert.equal(rangeLabel([0, 1, 2, 4]), '1-3, 5');
  assert.ok(rangeLabel(Array.from({ length: 80 }, (_, i) => i * 2)).endsWith('…'));
});

test('pageFit: 쪽당 픽셀 상한을 넘으면 배율을 낮춘다', () => {
  const a4 = pageFit(595, 842, 200);
  assert.equal(a4.capped, false);
  assert.ok(Math.abs(a4.dpi - 200) < 1e-9);
  const a0 = pageFit(2384, 3370, 300); // A0
  assert.equal(a0.capped, true);
  assert.ok(a0.px <= MAX_PAGE_PX * 1.0001, `${a0.px}`);
  assert.ok(a0.dpi < 300);
});

test('budgetFit: 예산이 넉넉하면 그대로, 모자라면 남은 쪽 몫에 맞춰 낮춘다', () => {
  const base = { wPt: 595, hPt: 842, wantDpi: 200, usedBytes: 0, remaining: 100, bytesPerPx: 0.3 };
  const ok = budgetFit(base);
  assert.equal(ok.budgeted, false);
  assert.ok(Math.abs(ok.dpi - 200) < 1e-9);
  const tight = budgetFit({ ...base, remaining: 600 });
  assert.equal(tight.budgeted, true);
  assert.ok(tight.dpi < 200 && tight.dpi >= MIN_DPI);
  assert.ok(tight.px * 0.3 * 600 <= MAX_TOTAL_BYTES * 1.001, '몫 × 쪽 수가 상한 안이어야 한다');
  const hopeless = budgetFit({ ...base, remaining: 100000 });
  assert.equal(hopeless.floor, true);
  assert.ok(Math.abs(hopeless.dpi - MIN_DPI) < 1e-6);
});

test('estimateTotalBytes: dpi 에 제곱 비례', () => {
  const s = [{ w: 595, h: 842 }];
  const a = estimateTotalBytes(s, 150);
  const b = estimateTotalBytes(s, 300);
  assert.ok(Math.abs(b / a - 4) < 1e-9);
});

test('buildPageCss: 첫 쪽 크기 기준, 방향이 다른 쪽만 flip', () => {
  const same = buildPageCss([{ w: 595, h: 842 }, { w: 600, h: 850 }]);
  assert.ok(same.css.startsWith('@page{size:595pt 842pt;margin:0}'));
  assert.ok(!same.css.includes('flip'));
  assert.deepEqual(same.flip, [false, false]);
  const mixed = [{ w: 595, h: 842 }, { w: 842, h: 595 }, { w: 595, h: 842 }, { w: 500, h: 500 }];
  assert.equal(mixedOrientation(mixed), true);
  const r = buildPageCss(mixed);
  assert.deepEqual(r.flip, [false, true, false, false]); // 정사각형은 첫 쪽과 같은 방향
  assert.ok(r.css.includes('@page flip{size:842pt 595pt;margin:0}'));
  assert.ok(r.css.includes('.pp.flip{page:flip;'));
  // 첫 쪽이 가로면 세로 쪽이 flip
  assert.deepEqual(buildPageCss([{ w: 842, h: 595 }, { w: 595, h: 842 }]).flip, [false, true]);
  assert.equal(buildPageCss([]).css, '');
});
