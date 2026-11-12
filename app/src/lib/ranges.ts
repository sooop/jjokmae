// 분할 입력 해석. 쪽 번호는 사용자 기준 1부터, 결과는 0부터.
// 주의: erasable 문법만 쓴다(Node 타입 스트리핑으로 시험에서 직접 import).

export type RangeResult = { ok: true; groups: number[][] } | { ok: false; error: string };

const EXAMPLE = '예: 1-3,5,8-';

/** '1-3,5,8-' → [[0,1,2],[4],[7..total-1]]. 쉼표 하나가 파일 하나. '-3' 은 1~3쪽, '8-' 은 8쪽~끝 */
export function parseRanges(text: string, total: number): RangeResult {
  // '-' 양옆 공백은 범위의 일부로 본다('1 - 3' → '1-3'). 그 밖의 공백·쉼표·세미콜론은 구분자
  const tokens = text.replace(/\s*([-~–])\s*/g, '$1').split(/[,;\s]+/).filter(Boolean);
  if (!tokens.length) return { ok: false, error: `나눌 쪽 범위를 입력해 주세요. ${EXAMPLE}` };
  const groups: number[][] = [];
  for (const tok of tokens) {
    let start: number;
    let end: number;
    let m: RegExpExecArray | null;
    if (/^\d+$/.test(tok)) {
      start = end = Number(tok);
    } else if ((m = /^(\d+)?[-~–](\d+)?$/.exec(tok)) && (m[1] || m[2])) {
      start = m[1] ? Number(m[1]) : 1;
      end = m[2] ? Number(m[2]) : total;
    } else {
      return { ok: false, error: `‘${tok}’을(를) 읽을 수 없습니다. 쉼표로 나누고 ${EXAMPLE} 처럼 입력해 주세요.` };
    }
    if (start < 1 || end < 1 || start > total || end > total) {
      return { ok: false, error: `‘${tok}’이(가) 쪽 범위를 벗어났습니다. 이 문서는 1~${total}쪽입니다.` };
    }
    if (start > end) return { ok: false, error: `‘${tok}’은(는) 시작 쪽이 끝 쪽보다 큽니다.` };
    const g: number[] = [];
    for (let i = start; i <= end; i++) g.push(i - 1);
    groups.push(g);
  }
  return { ok: true, groups };
}

/** N쪽마다 나누기 */
export function chunkEvery(n: number, total: number): RangeResult {
  if (!Number.isInteger(n) || n < 1) return { ok: false, error: '쪽 수는 1 이상의 정수로 입력해 주세요.' };
  const groups: number[][] = [];
  for (let s = 0; s < total; s += n) {
    const g: number[] = [];
    for (let i = s; i < Math.min(total, s + n); i++) g.push(i);
    groups.push(g);
  }
  return { ok: true, groups };
}

/** 쪽 묶음에 맞는 파일 이름('<원본>-1-3.pdf', '<원본>-5.pdf'). 겹치면 (2), (3) 을 붙인다 */
export function splitNames(base: string, groups: number[][]): string[] {
  const seen = new Map<string, number>();
  return groups.map((g) => {
    const a = g[0] + 1;
    const b = g[g.length - 1] + 1;
    const stem = a === b ? `${base}-${a}` : `${base}-${a}-${b}`;
    const k = (seen.get(stem) ?? 0) + 1;
    seen.set(stem, k);
    return k === 1 ? `${stem}.pdf` : `${stem} (${k}).pdf`;
  });
}
