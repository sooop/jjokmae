// 페이지 조작 보조(엔진은 EngineAdapter 인터페이스로만 만진다).
// 주의: erasable 문법만 쓴다(Node 타입 스트리핑으로 시험에서 직접 import).
import type { DocId, EngineAdapter, RenderedBitmap, Rotation } from '../engine/adapter';

/** 쪽 번호의 새 순서. order[새 위치] = 원래 인덱스 */
export type Order = number[];

/** moving 쪽들을 한 덩어리로 'before' 번 쪽(원래 인덱스, n 이면 맨 끝) 앞에 옮긴 새 순서 */
export function dropOrder(n: number, moving: number[], before: number): Order {
  const m = new Set(moving);
  const rest: number[] = [];
  let ins = 0;
  for (let i = 0; i < n; i++) {
    if (m.has(i)) continue;
    if (i < before) ins++;
    rest.push(i);
  }
  rest.splice(ins, 0, ...[...m].sort((a, b) => a - b));
  return rest;
}

export const isIdentity = (order: Order) => order.every((v, i) => v === i);

/** movePage 만으로 문서를 order 순서로 만든다(필요한 이동만 수행) */
export async function applyOrder(a: Pick<EngineAdapter, 'movePage'>, doc: DocId, order: Order): Promise<number> {
  const work = order.map((_, i) => i);
  let moves = 0;
  for (let p = 0; p < order.length; p++) {
    if (work[p] === order[p]) continue;
    const from = work.indexOf(order[p], p);
    await a.movePage(doc, from, p);
    work.splice(from, 1);
    work.splice(p, 0, order[p]);
    moves++;
  }
  return moves;
}

function sameImage(a: RenderedBitmap, b: RenderedBitmap): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const x = new Uint8Array(a.data);
  const y = new Uint8Array(b.data);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length < 2;
}

/**
 * 어댑터에는 현재 /Rotate 를 읽는 메서드가 없고 rotatePage 는 절대값이다. 이미 회전된 쪽에 '+90' 을 정확히 하려면
 * 기준 값을 알아야 하므로, 작은 비트맵을 비교해 알아낸다: 현재 모습과 같은 크기를 만드는 후보 중 모습이 같은 값.
 * 끝나면 문서는 원래 값으로 돌아가 있다.
 */
export async function detectRotation(
  a: Pick<EngineAdapter, 'pageSize' | 'renderPage' | 'rotatePage'>,
  doc: DocId,
  index: number,
): Promise<Rotation> {
  const s0 = await a.pageSize(doc, index);
  const scale = 48 / Math.max(1, s0.width, s0.height);
  const ref = await a.renderPage(doc, index, scale);
  const candidates: Rotation[] = [];
  let found: Rotation | null = null;
  for (const r of [0, 90, 180, 270] as Rotation[]) {
    await a.rotatePage(doc, index, r);
    const s = await a.pageSize(doc, index);
    if (Math.abs(s.width - s0.width) > 0.5 || Math.abs(s.height - s0.height) > 0.5) continue;
    candidates.push(r);
    if (sameImage(ref, await a.renderPage(doc, index, scale))) {
      found = r;
      break;
    }
  }
  const base = found ?? candidates[0] ?? 0;
  await a.rotatePage(doc, index, base);
  return base;
}

export const addRotation = (r: Rotation, delta = 90): Rotation => (((r + delta) % 360) as Rotation);

/** 삭제 뒤의 현재 쪽: 앞쪽이 지워진 만큼 당기고, 현재 쪽이 지워졌으면 같은 자리(다음 쪽)에 둔다 */
export function currentAfterDelete(current: number, deleted: number[], newTotal: number): number {
  const before = deleted.filter((d) => d < current).length;
  return Math.max(0, Math.min(newTotal - 1, current - before));
}
