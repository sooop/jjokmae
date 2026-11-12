// 정리 모드 격자의 배치 계산(순수 함수). 모든 칸은 같은 크기라 행·열 산술만으로 위치·드롭 자리·영역 선택을 구한다.
// 주의: erasable 문법만 쓴다(Node 타입 스트리핑으로 시험에서 직접 import).

export const GRID_GAP = 12;
export const GRID_PAD = 12;
export const GRID_LABEL = 22;
/** 칸의 쪽 영역 높이 = 폭 × 이 값(A4 세로 비율보다 약간 큼) */
export const GRID_ASPECT = 1.42;

export interface GridGeom {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  gap: number;
  pad: number;
  /** 남는 가로 공간을 양쪽에 나눈 여백 */
  ox: number;
  /** 콘텐츠 전체 높이 */
  height: number;
  n: number;
}

export function gridGeom(width: number, thumb: number, n: number): GridGeom {
  const gap = GRID_GAP;
  const pad = GRID_PAD;
  const cellW = Math.round(thumb);
  const cellH = Math.round(cellW * GRID_ASPECT) + GRID_LABEL;
  const cols = Math.max(1, Math.floor((width - 2 * pad + gap) / (cellW + gap)));
  const used = cols * cellW + (cols - 1) * gap;
  const ox = Math.max(0, Math.floor((width - 2 * pad - used) / 2));
  const rows = Math.max(0, Math.ceil(n / cols));
  const height = rows ? pad * 2 + rows * cellH + (rows - 1) * gap : pad * 2;
  return { cols, rows, cellW, cellH, gap, pad, ox, height, n };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function cellRect(g: GridGeom, i: number): Rect {
  const c = i % g.cols;
  const r = Math.floor(i / g.cols);
  return { x: g.ox + g.pad + c * (g.cellW + g.gap), y: g.pad + r * (g.cellH + g.gap), w: g.cellW, h: g.cellH };
}

/** 스크롤 위치에서 보이는 행 범위(양끝 포함). 칸이 없으면 [0, -1] */
export function visibleRows(g: GridGeom, scrollTop: number, viewH: number): [number, number] {
  if (!g.rows) return [0, -1];
  const rh = g.cellH + g.gap;
  const r0 = Math.max(0, Math.floor((scrollTop - g.pad) / rh));
  const r1 = Math.min(g.rows - 1, Math.floor((scrollTop + viewH - g.pad) / rh));
  return [Math.min(r0, g.rows - 1), Math.max(r1, r0)];
}

export interface DropSpot {
  /** 이 번호의 쪽 앞에 넣는다(n 이면 맨 끝) */
  before: number;
  /** 세로 삽입선(콘텐츠 좌표) */
  line: { x: number; y: number; h: number };
}

/** 콘텐츠 좌표 (x, y) 에서 놓을 자리. 행은 y 로, 같은 행 안의 틈은 x 로 고른다 */
export function dropAt(g: GridGeom, x: number, y: number): DropSpot {
  const n = g.n;
  if (!n) return { before: 0, line: { x: g.ox + g.pad - g.gap / 2, y: g.pad, h: g.cellH } };
  const r = Math.min(g.rows - 1, Math.max(0, Math.floor((y - g.pad + g.gap / 2) / (g.cellH + g.gap))));
  const inRow = Math.min(g.cols, n - r * g.cols);
  let k = Math.floor((x - g.ox - g.pad + (g.cellW + g.gap) / 2) / (g.cellW + g.gap));
  k = Math.min(inRow, Math.max(0, k));
  const before = r * g.cols + k;
  if (k < inRow) {
    const c = cellRect(g, before);
    return { before, line: { x: c.x - g.gap / 2, y: c.y, h: g.cellH } };
  }
  const c = cellRect(g, before - 1);
  return { before, line: { x: c.x + c.w + g.gap / 2, y: c.y, h: g.cellH } };
}

/** 칸 위의 점이면 그 칸 번호, 아니면 -1 */
export function cellAt(g: GridGeom, x: number, y: number): number {
  const c = Math.floor((x - g.ox - g.pad) / (g.cellW + g.gap));
  const r = Math.floor((y - g.pad) / (g.cellH + g.gap));
  if (c < 0 || c >= g.cols || r < 0) return -1;
  const i = r * g.cols + c;
  if (i >= g.n) return -1;
  const rc = cellRect(g, i);
  return x >= rc.x && x <= rc.x + rc.w && y >= rc.y && y <= rc.y + rc.h ? i : -1;
}

/** 두 점이 이루는 영역(콘텐츠 좌표)과 겹치는 칸 번호들(오름차순) */
export function bandHits(g: GridGeom, x1: number, y1: number, x2: number, y2: number): number[] {
  const ax = Math.min(x1, x2);
  const bx = Math.max(x1, x2);
  const ay = Math.min(y1, y2);
  const by = Math.max(y1, y2);
  const cw = g.cellW + g.gap;
  const rh = g.cellH + g.gap;
  const c0 = Math.max(0, Math.floor((ax - g.ox - g.pad) / cw));
  const c1 = Math.min(g.cols - 1, Math.floor((bx - g.ox - g.pad) / cw));
  const r0 = Math.max(0, Math.floor((ay - g.pad) / rh));
  const r1 = Math.min(g.rows - 1, Math.floor((by - g.pad) / rh));
  const out: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * g.cols + c;
      if (i >= g.n) continue;
      const rc = cellRect(g, i);
      if (ax <= rc.x + rc.w && bx >= rc.x && ay <= rc.y + rc.h && by >= rc.y) out.push(i);
    }
  }
  return out;
}

/** 방향키로 포커스를 옮긴 칸 번호 */
export function moveFocus(g: GridGeom, from: number, key: string, pageRows = 3): number {
  const n = g.n;
  if (!n) return 0;
  const cur = Math.min(n - 1, Math.max(0, from));
  let to = cur;
  switch (key) {
    case 'ArrowLeft':
      to = cur - 1;
      break;
    case 'ArrowRight':
      to = cur + 1;
      break;
    case 'ArrowUp':
      to = cur - g.cols;
      if (to < 0) to = cur; // 첫 줄에서는 그대로
      break;
    case 'ArrowDown':
      to = cur + g.cols;
      // 마지막 줄이 덜 찬 경우: 아래 줄이 있으면 그 줄의 끝 칸으로
      if (to >= n && Math.floor(cur / g.cols) < g.rows - 1) to = n - 1;
      break;
    case 'Home':
      to = 0;
      break;
    case 'End':
      to = n - 1;
      break;
    case 'PageUp':
      to = cur - g.cols * pageRows;
      break;
    case 'PageDown':
      to = cur + g.cols * pageRows;
      break;
  }
  return Math.min(n - 1, Math.max(0, to));
}

/** 렌더 해상도 기준 폭: 슬라이더를 조금 움직일 때마다 다시 그리지 않도록 16px 단위로 올림 */
export const renderBucket = (thumb: number): number => Math.ceil(thumb / 16) * 16;
