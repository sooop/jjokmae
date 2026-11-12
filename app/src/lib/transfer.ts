// 다중 문서 작업 공간의 순수 보조 함수(쪽 보내기 위치, 이름 중복 처리 등).
// 주의: erasable 문법만 쓴다(Node 타입 스트리핑으로 시험에서 직접 import).

/** 한 번에 열어 둘 수 있는 문서 수 */
export const MAX_DOCS = 12;

/** 대상 문서 안의 위치: 맨 앞, 맨 뒤, 또는 쪽 번호(1부터) 뒤 */
export type SendPos = 'start' | 'end' | { after: number };

/** 대상 문서(쪽 수 total)에 끼워 넣을 자리(0..total). 쪽 번호가 범위를 벗어나면 RangeError */
export function insertIndex(pos: SendPos, total: number): number {
  if (pos === 'start') return 0;
  if (pos === 'end') return total;
  const k = pos.after;
  if (!Number.isInteger(k) || k < 1 || k > total) throw new RangeError(`쪽 번호 범위 밖: ${k}`);
  return k;
}

export const range = (start: number, n: number): number[] => Array.from({ length: n }, (_, i) => start + i);

/** 열린 문서 이름과 겹치면 '이름 (2).pdf', '이름 (3).pdf' … 로 구분한다(대소문자 무시) */
export function uniqueName(existing: string[], name: string): string {
  const used = new Set(existing.map((s) => s.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const m = /^(.*?)(\.pdf)?$/i.exec(name)!;
  const base = m[1];
  const ext = m[2] ?? '';
  for (let n = 2; ; n++) {
    const cand = `${base} (${n})${ext}`;
    if (!used.has(cand.toLowerCase())) return cand;
  }
}

/** 새 파일로 보낼 때의 이름 '새 문서 N.pdf'(N 은 이미 열린 이름과 겹치지 않는 가장 작은 수 이상) */
export function newDocName(existing: string[], start = 1): { name: string; n: number } {
  const used = new Set(existing.map((s) => s.toLowerCase()));
  for (let n = start; ; n++) {
    const name = `새 문서 ${n}.pdf`;
    if (!used.has(name.toLowerCase())) return { name, n };
  }
}

/** 파일 이름 목록을 안내 문구용으로 줄인다: ‘a.pdf’, ‘b.pdf’ 외 2개 */
export function quoteNames(names: string[], max = 3): string {
  const q = (s: string) => `‘${s}’`;
  if (names.length <= max) return names.map(q).join(', ');
  return `${names.slice(0, max).map(q).join(', ')} 외 ${names.length - max}개`;
}

/** 위치를 사람이 읽는 말로: 맨 앞 / 맨 뒤 / 3쪽 뒤 */
export function posLabel(pos: SendPos): string {
  return pos === 'start' ? '맨 앞' : pos === 'end' ? '맨 뒤' : `${pos.after}쪽 뒤`;
}

/** 이동 묶음 번호 안에서 짝이 되는 문서를 찾는다: 각 문서의 스택 맨 위가 같은 번호인가 */
export interface BundleProbe {
  key: number;
  stack: { bundle?: number }[];
}
export function findBundlePartners(bundle: number, self: number, others: BundleProbe[]): { partners: number[]; blocked: number[] } {
  const partners: number[] = [];
  const blocked: number[] = [];
  for (const o of others) {
    if (o.key === self) continue;
    if (o.stack.length && o.stack[o.stack.length - 1].bundle === bundle) partners.push(o.key);
    else if (o.stack.some((s) => s.bundle === bundle)) blocked.push(o.key);
  }
  return { partners, blocked };
}

/** 보내기 메뉴의 대상 한 줄 */
export interface SendTargetRow {
  key: number;
  name: string;
  total: number;
  /** 보내는 쪽이 있는 문서 */
  self: boolean;
}

/** 병합 메뉴의 파일 한 줄 */
export interface MergeDoc {
  key: number;
  name: string;
  total: number;
}
