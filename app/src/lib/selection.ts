// 쪽 선택 규칙(클릭·Ctrl·Shift)의 순수 함수. 보기 모드 썸네일과 정리 모드 격자가 같은 규칙을 쓴다.
// 주의: erasable 문법만 쓴다(Node 타입 스트리핑으로 시험에서 직접 import).

export interface Sel {
  selected: number[];
  anchor: number | null;
}

export const span = (a: number, b: number): number[] => {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
};

const uniqSorted = (xs: number[]) => [...new Set(xs)].sort((x, y) => x - y);

/** 쪽 i 를 눌렀을 때의 새 선택. Shift: 기준 쪽부터 i 까지(Ctrl 도 누르면 기존 선택에 더한다), Ctrl: 하나 더하거나 뺀다, 그 밖: 그 쪽만 */
export function clickSelect(selected: number[], anchor: number | null, i: number, mod: { shift: boolean; ctrl: boolean }): Sel {
  if (mod.shift && anchor != null) {
    const r = span(anchor, i);
    return { selected: mod.ctrl ? uniqSorted([...selected, ...r]) : r, anchor };
  }
  if (mod.ctrl) {
    const has = selected.includes(i);
    return { selected: has ? selected.filter((s) => s !== i) : uniqSorted([...selected, i]), anchor: i };
  }
  return { selected: [i], anchor: i };
}

/** 파일마다 고른 쪽을 (파일 순서, 쪽 순서)대로 펼친 합계 */
export function totalSelected(counts: number[]): number {
  return counts.reduce((a, b) => a + b, 0);
}
