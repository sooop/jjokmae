// 가상 스크롤 계산 보조. 페이지 자리 높이를 미리 알고 있으므로 누적합 + 이분 탐색으로 끝낸다.

export interface Layout {
  tops: number[];
  total: number;
}

export function computeLayout(heights: number[], gap: number, pad: number): Layout {
  const tops = new Array<number>(heights.length);
  let y = pad;
  for (let i = 0; i < heights.length; i++) {
    tops[i] = y;
    y += heights[i] + gap;
  }
  return { tops, total: heights.length ? y - gap + pad : pad * 2 };
}

/** tops[i] <= y 를 만족하는 마지막 i. y 가 첫 항목 위면 0 */
export function indexAt(tops: number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}
