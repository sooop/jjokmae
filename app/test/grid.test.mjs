// 정리 모드 격자 배치·선택 규칙·설정 보정의 순수 로직 시험. 실행: cd app && node --test test/grid.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { bandHits, cellAt, cellRect, dropAt, gridGeom, moveFocus, renderBucket, visibleRows } from '../src/lib/grid.ts';
import { clickSelect, span } from '../src/lib/selection.ts';
import { clampGrid, clampSide, defaultSettings, GRID_MAX, GRID_MIN, SIDE_MAX, SIDE_MIN } from '../src/lib/settings.ts';

// 폭 1000, 칸 폭 150 → (1000-24+12)/(162)=6.09 → 6열
const g = (n = 20, w = 1000, t = 150) => gridGeom(w, t, n);

test('gridGeom: 열 수·행 수·높이, 칸은 같은 크기이고 겹치지 않는다', () => {
  const x = g();
  assert.equal(x.cols, 6);
  assert.equal(x.rows, 4);
  const a = cellRect(x, 0);
  const b = cellRect(x, 1);
  const c = cellRect(x, 6);
  assert.equal(b.x - a.x, x.cellW + x.gap);
  assert.equal(c.y - a.y, x.cellH + x.gap);
  assert.equal(c.x, a.x);
  assert.ok(cellRect(x, 19).y + x.cellH + x.pad === x.height);
  // 아주 좁아도 1열
  assert.equal(gridGeom(50, 150, 5).cols, 1);
  // 최소·최대 크기에서 폭을 넘지 않는다
  for (const t of [GRID_MIN, GRID_MAX]) {
    const y = gridGeom(900, t, 300);
    const last = cellRect(y, y.cols - 1);
    assert.ok(last.x + last.w + y.pad <= 900, `t=${t}`);
  }
});

test('visibleRows: 스크롤 위치의 보이는 행(300쪽 최소 크기)', () => {
  const x = gridGeom(1160, GRID_MIN, 300);
  assert.equal(x.cols, 12);
  assert.equal(x.rows, 25);
  const [a, b] = visibleRows(x, 0, 700);
  assert.equal(a, 0);
  assert.ok(b >= 4 && b <= 6, String(b));
  const [c, d] = visibleRows(x, 1000, 700);
  assert.ok(c > a && d >= c);
  assert.deepEqual(visibleRows(gridGeom(500, 100, 0), 0, 500), [0, -1]);
});

test('dropAt: 같은 행의 틈은 x 로, 행은 y 로 고르고, 행 끝·맨 끝에서는 앞 칸 오른쪽에 선을 긋는다', () => {
  const x = g(20);
  const r0 = cellRect(x, 0);
  const r7 = cellRect(x, 7); // 2행 1열(0부터 1행)
  // 0번 칸의 왼쪽 → 0 앞
  assert.equal(dropAt(x, r0.x - 2, r0.y + 10).before, 0);
  // 3번 칸 중심보다 왼쪽 → 3 앞, 오른쪽 → 4 앞
  const r3 = cellRect(x, 3);
  assert.equal(dropAt(x, r3.x + 10, r3.y + 10).before, 3);
  assert.equal(dropAt(x, r3.x + r3.w - 10, r3.y + 10).before, 4);
  // 행을 가로지르는 위치: 7번 칸 왼쪽 → 7 앞
  assert.equal(dropAt(x, r7.x + 5, r7.y + 20).before, 7);
  // 행 끝 오른쪽 바깥: 다음 행 첫 칸 앞이지만 선은 이 행 마지막 칸 오른쪽
  const r5 = cellRect(x, 5);
  const e = dropAt(x, 990, r5.y + 20);
  assert.equal(e.before, 6);
  assert.equal(e.line.x, r5.x + r5.w + x.gap / 2);
  // 맨 끝(마지막 행이 덜 찬 경우): 선은 마지막 칸 오른쪽
  const last = cellRect(x, 19);
  const f = dropAt(x, last.x + last.w + 100, last.y + 20);
  assert.equal(f.before, 20);
  assert.equal(f.line.x, last.x + last.w + x.gap / 2);
  // 아래로 벗어나면 마지막 행
  assert.equal(dropAt(x, 0, 99999).before >= 18, true);
});

test('cellAt·bandHits: 칸 위 판정과 영역 선택(Ctrl 합집합은 호출자 몫)', () => {
  const x = g(20);
  const r8 = cellRect(x, 8);
  assert.equal(cellAt(x, r8.x + 3, r8.y + 3), 8);
  assert.equal(cellAt(x, r8.x - 3, r8.y + 3), -1); // 칸 사이 틈
  const r19 = cellRect(x, 19);
  assert.equal(cellAt(x, r19.x + r19.w + x.cellW, r19.y + 3), -1); // 빈 칸 자리
  // 7·8·13·14 를 포함하는 사각형
  const a = cellRect(x, 7);
  const b = cellRect(x, 14);
  assert.deepEqual(bandHits(x, a.x + 5, a.y + 5, b.x + 5, b.y + 5), [7, 8, 13, 14]);
  // 거꾸로 끌어도 같다
  assert.deepEqual(bandHits(x, b.x + 5, b.y + 5, a.x + 5, a.y + 5), [7, 8, 13, 14]);
  // 아무 칸에도 닿지 않는 틈
  const gapX = a.x + a.w + 2;
  assert.deepEqual(bandHits(x, gapX, a.y + 5, gapX + 3, a.y + 9), []);
  // 마지막 줄이 덜 찬 곳의 빈 자리는 제외
  assert.deepEqual(bandHits(x, 0, r19.y, 1000, r19.y + 10), [18, 19]);
});

test('moveFocus: 방향키·Home·End·PageUp/Down', () => {
  const x = g(20);
  assert.equal(moveFocus(x, 7, 'ArrowRight'), 8);
  assert.equal(moveFocus(x, 0, 'ArrowLeft'), 0);
  assert.equal(moveFocus(x, 7, 'ArrowDown'), 13);
  assert.equal(moveFocus(x, 7, 'ArrowUp'), 1);
  assert.equal(moveFocus(x, 2, 'ArrowUp'), 2);
  assert.equal(moveFocus(x, 16, 'ArrowDown'), 19); // 덜 찬 마지막 줄 → 끝 칸
  assert.equal(moveFocus(x, 19, 'ArrowDown'), 19);
  assert.equal(moveFocus(x, 5, 'Home'), 0);
  assert.equal(moveFocus(x, 5, 'End'), 19);
  assert.equal(moveFocus(x, 1, 'PageDown', 2), 13);
  assert.equal(moveFocus(x, 14, 'PageUp', 2), 2);
});

test('renderBucket: 16px 단위로 올림(슬라이더를 조금 움직여도 다시 그리지 않는다)', () => {
  assert.equal(renderBucket(80), 80);
  assert.equal(renderBucket(81), 96);
  assert.equal(renderBucket(320), 320);
  assert.equal(renderBucket(161), renderBucket(170));
});

test('clickSelect: 클릭·Ctrl·Shift 규칙', () => {
  const m = (shift, ctrl) => ({ shift, ctrl });
  assert.deepEqual(clickSelect([1, 2], 1, 5, m(false, false)), { selected: [5], anchor: 5 });
  assert.deepEqual(clickSelect([1, 2], 1, 5, m(false, true)), { selected: [1, 2, 5], anchor: 5 });
  assert.deepEqual(clickSelect([1, 2, 5], 5, 2, m(false, true)), { selected: [1, 5], anchor: 2 });
  assert.deepEqual(clickSelect([5], 5, 2, m(true, false)), { selected: [2, 3, 4, 5], anchor: 5 });
  assert.deepEqual(clickSelect([0], 5, 7, m(true, true)), { selected: [0, 5, 6, 7], anchor: 5 });
  // 기준 쪽이 없으면 Shift 도 한 쪽 선택
  assert.deepEqual(clickSelect([], null, 3, m(true, false)), { selected: [3], anchor: 3 });
  assert.deepEqual(span(4, 2), [2, 3, 4]);
});

test('settings: 썸네일 크기 범위 보정', () => {
  assert.equal(clampGrid(10), GRID_MIN);
  assert.equal(clampGrid(9999), GRID_MAX);
  assert.equal(clampGrid(NaN), defaultSettings.gridThumb);
  assert.equal(clampSide(50), SIDE_MIN);
  assert.equal(clampSide(1000), SIDE_MAX);
  assert.equal(clampSide(150.4), 150);
  assert.ok(defaultSettings.gridThumb >= GRID_MIN && defaultSettings.gridThumb <= GRID_MAX);
  assert.equal(defaultSettings.mode, 'view');
});
