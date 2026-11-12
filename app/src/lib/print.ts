// 인쇄의 순수 로직: 대상 쪽 정하기, 안내 문구, 이미지 방식의 해상도·메모리 계획, 인쇄용 @page CSS.
// 주의: erasable 문법만 쓴다(Node 타입 스트리핑으로 시험에서 직접 import).
/** 쪽 범위 해석기(ranges.ts 의 parseRanges). 순수 모듈로 두려고 호출자가 넘긴다 */
export type RangeParser = (text: string, total: number) => { ok: true; groups: number[][] } | { ok: false; error: string };

export type PrintScope = 'all' | 'selected' | 'current' | 'range';
export type PrintMethod = 'auto' | 'image';

/** 인쇄 대상을 정하는 데 필요한 문서 정보 */
export interface PrintDocInfo {
  key: number;
  name: string;
  total: number;
  current: number;
  selected: number[];
}

/** 한 파일에서 인쇄할 쪽(0부터, 오름차순) */
export interface PrintPart {
  key: number;
  name: string;
  pages: number[];
}

export interface PrintTarget {
  parts: PrintPart[];
  /** 전체 쪽 수 */
  count: number;
  /** 대화상자 맨 위 요약 */
  summary: string;
}

export type TargetResult = { ok: true; target: PrintTarget } | { ok: false; error: string };

const sortedUnique = (pages: number[]) => [...new Set(pages)].sort((a, b) => a - b);

/**
 * 선택한 쪽이 있는 파일들. 보기 모드는 지금 보이는 파일(활성) 하나, 정리 모드는 모든 파일에서 골라 둔 쪽을
 * (파일 순서, 쪽 순서)대로 모은다(정리 모드의 파일 목록에 파일별 선택 수가 보이기 때문).
 */
export function selectedParts(docs: PrintDocInfo[], activeKey: number | null, mode: 'view' | 'organize'): PrintPart[] {
  const pool = mode === 'organize' ? docs : docs.filter((d) => d.key === activeKey);
  return pool
    .map((d) => ({ key: d.key, name: d.name, pages: sortedUnique(d.selected).filter((i) => i >= 0 && i < d.total) }))
    .filter((p) => p.pages.length > 0);
}

const all = (n: number) => Array.from({ length: n }, (_, i) => i);

export function resolveTarget(
  scope: PrintScope,
  docs: PrintDocInfo[],
  activeKey: number | null,
  mode: 'view' | 'organize',
  rangeText: string,
  parseRanges: RangeParser,
): TargetResult {
  const d = docs.find((x) => x.key === activeKey);
  if (!d) return { ok: false, error: '인쇄할 문서가 없습니다.' };
  if (scope === 'selected') {
    const parts = selectedParts(docs, activeKey, mode);
    const count = parts.reduce((n, p) => n + p.pages.length, 0);
    if (!count) return { ok: false, error: '선택한 쪽이 없습니다.' };
    const summary = parts.length > 1 ? `${parts.length}개 파일에서 선택한 ${count}쪽` : `선택한 ${count}쪽`;
    return { ok: true, target: { parts, count, summary } };
  }
  if (scope === 'current') {
    const i = Math.min(d.total - 1, Math.max(0, d.current));
    return { ok: true, target: { parts: [{ key: d.key, name: d.name, pages: [i] }], count: 1, summary: `${d.name} ${i + 1}쪽` } };
  }
  if (scope === 'range') {
    const r = parseRanges(rangeText, d.total);
    if (!r.ok) return { ok: false, error: r.error.replace('나눌 쪽 범위', '인쇄할 쪽 범위') };
    const pages = sortedUnique(r.groups.flat());
    return { ok: true, target: { parts: [{ key: d.key, name: d.name, pages }], count: pages.length, summary: `${d.name} ${pages.length}쪽 (${rangeLabel(pages)})` } };
  }
  return { ok: true, target: { parts: [{ key: d.key, name: d.name, pages: all(d.total) }], count: d.total, summary: `${d.name} ${d.total}쪽` } };
}

/** [0,1,2,4] → '1-3, 5'(사용자 쪽 번호). 길면 줄인다 */
export function rangeLabel(pages: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(j > i ? `${pages[i] + 1}-${pages[j] + 1}` : `${pages[i] + 1}`);
    i = j + 1;
  }
  const s = out.join(', ');
  return s.length > 28 ? `${s.slice(0, 26)}…` : s;
}

/** 대화상자를 열 때 처음 고를 범위: 고른 쪽이 있으면 선택한 쪽, 없으면 전체 */
export function defaultScope(docs: PrintDocInfo[], activeKey: number | null, mode: 'view' | 'organize'): PrintScope {
  return selectedParts(docs, activeKey, mode).length ? 'selected' : 'all';
}

// ---------- 이미지 방식: 해상도·메모리 ----------

export const DPI_CHOICES = [150, 200, 300] as const;
export const DEFAULT_DPI = 200;
/** 쪽 하나의 비트맵 픽셀 상한(약 6000×6000). 넘으면 해상도를 낮춘다 */
export const MAX_PAGE_PX = 36_000_000;
/** 인코딩한 쪽 이미지(Blob) 전체의 추정 상한 */
export const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
/** 처음 쓰는 압축 추정치(JPEG, 픽셀당 바이트). 쪽을 만들면서 실제 값으로 고친다 */
export const PRIOR_BYTES_PER_PX = 0.3;
export const MIN_DPI = 72;

export interface PageFit {
  /** 72dpi 기준 배율 */
  scale: number;
  dpi: number;
  px: number;
  /** 쪽당 픽셀 상한 때문에 낮췄는가 */
  capped: boolean;
}

/** 쪽 크기(pt)와 원하는 dpi 에서 쪽당 픽셀 상한을 지키는 배율 */
export function pageFit(wPt: number, hPt: number, dpi: number): PageFit {
  let s = dpi / 72;
  const px0 = wPt * s * (hPt * s);
  let capped = false;
  if (px0 > MAX_PAGE_PX) {
    s *= Math.sqrt(MAX_PAGE_PX / px0);
    capped = true;
  }
  return { scale: s, dpi: s * 72, px: wPt * s * (hPt * s), capped };
}

export interface BudgetInput {
  wPt: number;
  hPt: number;
  wantDpi: number;
  /** 지금까지 인코딩한 바이트 */
  usedBytes: number;
  /** 이 쪽을 포함해 남은 쪽 수 */
  remaining: number;
  /** 압축 추정치(픽셀당 바이트) */
  bytesPerPx: number;
  limit?: number;
}

/**
 * 이 쪽에 쓸 해상도. 남은 예산(상한 - 사용량)을 남은 쪽 수로 나눈 몫에 맞게 낮춘다(MIN_DPI 까지).
 * 몫을 맞출 수 없으면 floor 가 true 가 되어, 호출자가 경고할 수 있다.
 */
export function budgetFit(i: BudgetInput): PageFit & { budgeted: boolean; floor: boolean } {
  const fit = pageFit(i.wPt, i.hPt, i.wantDpi);
  const limit = i.limit ?? MAX_TOTAL_BYTES;
  const share = Math.max(0, limit - i.usedBytes) / Math.max(1, i.remaining);
  const need = fit.px * i.bytesPerPx;
  if (need <= share) return { ...fit, budgeted: false, floor: false };
  const k = Math.sqrt(share / need);
  let dpi = Math.max(MIN_DPI, fit.dpi * k);
  let floor = false;
  if (fit.dpi * k < MIN_DPI) floor = true;
  dpi = Math.min(dpi, fit.dpi);
  const out = pageFit(i.wPt, i.hPt, dpi);
  return { ...out, capped: fit.capped, budgeted: true, floor };
}

/** 쪽 크기들을 한 dpi 로 만들 때 전체 인코딩 크기 추정(대화상자 경고용) */
export function estimateTotalBytes(sizes: { w: number; h: number }[], dpi: number, bytesPerPx = PRIOR_BYTES_PER_PX): number {
  let t = 0;
  for (const s of sizes) t += pageFit(s.w, s.h, dpi).px * bytesPerPx;
  return t;
}

// ---------- 인쇄용 CSS ----------

export interface PageDims {
  w: number;
  h: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const landscape = (s: PageDims) => s.w > s.h;
/** 거의 정사각형이면 첫 쪽과 같은 방향으로 본다 */
const flips = (s: PageDims, first: PageDims) => Math.abs(s.w - s.h) >= 1 && landscape(s) !== landscape(first);

/** 쪽마다 방향이 첫 쪽과 다른가 */
export function mixedOrientation(sizes: PageDims[]): boolean {
  return sizes.length > 1 && sizes.some((s) => flips(s, sizes[0]));
}

/**
 * 인쇄용 @page 규칙과 쪽 칸 크기. 종이 크기는 첫 쪽 기준이고, 방향이 다른 쪽은 이름 붙은 쪽(page: flip)으로
 * 가로·세로만 바꾼다. 쪽 안의 이미지는 칸에 맞춰 contain 으로 들어간다.
 * 칸 높이는 종이보다 0.5pt 작게 잡아 반올림 오차로 빈 쪽이 하나 더 생기지 않게 한다.
 */
export function buildPageCss(sizes: PageDims[]): { css: string; flip: boolean[] } {
  if (!sizes.length) return { css: '', flip: [] };
  const first = sizes[0];
  const W = r2(first.w);
  const H = r2(first.h);
  const flip = sizes.map((s) => flips(s, first));
  const any = flip.some(Boolean);
  const box = (w: number, h: number) => `width:${r2(w - 0.5)}pt;height:${r2(h - 0.5)}pt`;
  let css = `@page{size:${W}pt ${H}pt;margin:0}`;
  if (any) css += `@page flip{size:${H}pt ${W}pt;margin:0}`;
  css += `#print-root .pp{${box(W, H)}}`;
  if (any) css += `#print-root .pp.flip{page:flip;${box(H, W)}}`;
  return { css, flip };
}
