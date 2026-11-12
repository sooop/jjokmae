// 되돌리기/다시하기 기록. 조작 전 문서 바이트 스냅샷을 보관한다(메모리 상한이 있다).
// 문서마다 UndoHistory 하나를 두고, 열린 문서 전체의 합계는 HistoryPool 이 관리한다.
// 주의: erasable 문법만 쓴다(Node 타입 스트리핑으로 시험에서 직접 import).

export const MAX_STEPS = 20;
/** 문서 하나의 스냅샷 바이트 합계 상한. 넘으면 오래된 것부터 버린다(최소 1단계는 남긴다) */
export const BUDGET_BYTES = 256 * 1024 * 1024;
/** 열린 문서 전체의 스냅샷 바이트 합계 상한. 넘으면 가장 오래 쓰지 않은 문서의 오래된 단계부터 줄인다 */
export const POOL_BUDGET_BYTES = 512 * 1024 * 1024;

/** 되돌리기로 닫힌 새 탭의 바이트(다시하기로 되살리려고 보관) 합계 상한. 넘으면 오래된 것부터 버린다 */
export const GHOST_BUDGET_BYTES = 128 * 1024 * 1024;

export interface HasBytes {
  bytes: Uint8Array;
  /** 두 문서에 걸친 조작(쪽 이동)이면 같은 번호 */
  bundle?: number;
}

/** 문서별 기록이 풀에 알려야 하는 최소한 */
interface PoolMember {
  touched: number;
  undoStack: HasBytes[];
  redoStack: HasBytes[];
  readonly bytes: number;
  dropOldest(kind: 'redo' | 'undo'): HasBytes | undefined;
}

export class HistoryPool {
  budget: number;
  private members = new Set<PoolMember>();
  private clock = 0;
  /** 풀이 단계를 버린 횟수(시험·진단용) */
  dropped = 0;

  constructor(budget = POOL_BUDGET_BYTES) {
    this.budget = budget;
  }

  add(h: PoolMember): void {
    this.members.add(h);
    this.touch(h);
  }
  remove(h: PoolMember): void {
    this.members.delete(h);
  }
  touch(h: PoolMember): void {
    h.touched = ++this.clock;
  }
  get size() {
    return this.members.size;
  }
  get bytes() {
    let n = 0;
    for (const h of this.members) n += h.bytes;
    return n;
  }

  /**
   * 합계가 상한을 넘으면 줄인다. 가장 오래 쓰지 않은 문서부터, 문서 안에서는 다시하기 → 오래된 되돌리기 순으로 버린다.
   * 1차: 문서마다 되돌리기 1단계는 남긴다. 2차: 방금 쓴 문서(keep)를 뺀 문서는 0단계까지 줄인다.
   * 3차: keep 문서도 1단계까지 줄인다(그래도 넘으면 한 문서가 상한보다 큰 것이므로 더 줄이지 않는다).
   */
  enforce(keep?: PoolMember): void {
    const passes: { minUndo: number; includeKeep: boolean }[] = [
      { minUndo: 1, includeKeep: false },
      { minUndo: 0, includeKeep: false },
      { minUndo: 1, includeKeep: true },
    ];
    for (const p of passes) {
      while (this.bytes > this.budget) {
        const order = [...this.members].filter((h) => p.includeKeep || h !== keep).sort((a, b) => a.touched - b.touched);
        let did = false;
        for (const h of order) {
          if (h.redoStack.length) {
            h.dropOldest('redo');
            did = true;
          } else if (h.undoStack.length > p.minUndo) {
            h.dropOldest('undo');
            did = true;
          }
          if (did) break;
        }
        if (!did) break;
        this.dropped++;
      }
      if (this.bytes <= this.budget) return;
    }
  }
}

export class UndoHistory<S extends HasBytes> {
  undoStack: S[] = [];
  redoStack: S[] = [];
  /** 풀에서 '얼마나 최근에 쓰였나'를 비교하는 값 */
  touched = 0;
  /** 단계가 용량 때문에 버려질 때 불린다(두 문서에 걸친 단계의 연결이 끊긴 것을 알릴 때 쓴다) */
  ondrop?: (s: S) => void;

  private maxSteps: number;
  private budget: number;
  private pool: HistoryPool | null;

  constructor(maxSteps = MAX_STEPS, budget = BUDGET_BYTES, pool: HistoryPool | null = null) {
    this.maxSteps = maxSteps;
    this.budget = budget;
    this.pool = pool;
    pool?.add(this as unknown as PoolMember);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get bytes() {
    let n = 0;
    for (const s of this.undoStack) n += s.bytes.length;
    for (const s of this.redoStack) n += s.bytes.length;
    return n;
  }

  /** 문서 크기에 따른 실제 단계 수 상한 */
  stepsFor(docBytes: number): number {
    return Math.max(1, Math.min(this.maxSteps, Math.floor(this.budget / Math.max(1, docBytes))));
  }

  /** 조작 직전 상태를 쌓는다. 다시하기 기록은 버린다 */
  push(s: S): void {
    for (const r of this.redoStack) this.ondrop?.(r);
    this.redoStack = [];
    this.undoStack.push(s);
    this.trim(s.bytes.length);
    this.afterChange();
  }

  /** 되돌리기 직전의 '현재' 상태를 다시하기 쪽에 넣는다 */
  pushRedo(s: S): void {
    this.redoStack.push(s);
    this.trimRedo(s.bytes.length);
    this.afterChange();
  }
  pushUndo(s: S): void {
    this.undoStack.push(s);
    this.trim(s.bytes.length);
    this.afterChange();
  }
  popUndo(): S | undefined {
    const s = this.undoStack.pop();
    this.pool?.touch(this as unknown as PoolMember);
    return s;
  }
  popRedo(): S | undefined {
    const s = this.redoStack.pop();
    this.pool?.touch(this as unknown as PoolMember);
    return s;
  }

  /** 다시하기 쪽의 깊은 끝(가장 나중 단계)부터 index 번째(0 = 가장 깊은 것)까지 버린다. 그 단계를 다시할 수 없게 되어 뒤따르는 단계도 쓸 수 없을 때 */
  dropRedoThrough(index: number): S[] {
    const gone = this.redoStack.splice(0, index + 1);
    for (const s of gone) this.ondrop?.(s);
    return gone;
  }

  /** 풀이 호출: 가장 오래된 단계 하나를 버린다 */
  dropOldest(kind: 'redo' | 'undo'): S | undefined {
    const s = kind === 'redo' ? this.redoStack.shift() : this.undoStack.shift();
    if (s) this.ondrop?.(s);
    return s;
  }

  private afterChange() {
    if (!this.pool) return;
    this.pool.touch(this as unknown as PoolMember);
    this.pool.enforce(this as unknown as PoolMember);
  }

  private trim(docBytes: number) {
    const max = this.stepsFor(docBytes);
    while (this.undoStack.length > max) this.dropOldest('undo');
    while (this.undoStack.length > 1 && this.bytes > this.budget) this.dropOldest('undo');
  }

  /** 다시하기 쪽의 문서 상한: 단계 수와 바이트 합계(되돌리기 쪽 포함)를 넘으면 오래된 다시하기부터 버린다(방금 넣은 1단계는 남긴다) */
  private trimRedo(docBytes: number) {
    const max = this.stepsFor(docBytes);
    while (this.redoStack.length > max) this.dropOldest('redo');
    while (this.redoStack.length > 1 && this.bytes > this.budget) this.dropOldest('redo');
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** 문서를 닫을 때: 풀에서 빠지고 기록을 비운다 */
  dispose() {
    this.pool?.remove(this as unknown as PoolMember);
    this.clear();
  }
}

/**
 * 이동 묶음 번호 → 되돌리기로 닫힌 새 탭의 내용. 바이트 합계 상한을 넘으면 오래된 것부터 버리고 onEvict 로 알린다
 * (그 묶음의 다시하기 단계는 되살릴 수 없으므로 호출자가 함께 정리한다). 가장 최근에 넣은 것은 상한보다 커도 남긴다.
 */
export class GhostStore<G extends { bytes: Uint8Array }> {
  private map = new Map<number, G>();
  private budget: number;
  /** 상한 때문에 버려진 묶음 번호를 알린다(delete 로 직접 지운 것은 알리지 않는다) */
  onEvict?: (bundle: number) => void;

  constructor(budget = GHOST_BUDGET_BYTES) {
    this.budget = budget;
  }

  get size() {
    return this.map.size;
  }
  get bytes() {
    let n = 0;
    for (const g of this.map.values()) n += g.bytes.length;
    return n;
  }
  has(bundle: number) {
    return this.map.has(bundle);
  }
  get(bundle: number): G | undefined {
    return this.map.get(bundle);
  }
  delete(bundle: number) {
    this.map.delete(bundle);
  }
  set(bundle: number, g: G): void {
    this.map.delete(bundle);
    this.map.set(bundle, g);
    while (this.map.size > 1 && this.bytes > this.budget) {
      const oldest = this.map.keys().next().value as number;
      this.map.delete(oldest);
      this.onEvict?.(oldest);
    }
  }
}
