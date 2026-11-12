// 엔진 인스턴스 수명 관리(종류마다 하나). Workspace 에서 뺀 순수 로직이라 node 시험에서 직접 import 한다.
// - 같은 종류를 동시에 acquire 해도 기동은 한 번만 한다(진행 중인 Promise 를 공유).
// - 죽은 엔진(워커 사망)은 폐기하고 새로 기동한다.
// - pin 한 종류는 그 문서가 하나도 없어도 releaseUnused 가 내리지 않는다(열기·되살리기·인쇄 임시 문서가 쓰는 동안).
// 주의: erasable 문법만 쓴다(Node 타입 스트리핑으로 시험에서 직접 import).

export interface PooledClient {
  dispose(): void;
}

export class EnginePool<K extends string, C extends PooledClient> {
  private engines = new Map<K, C>();
  private boots = new Map<K, Promise<C>>();
  private pins = new Map<K, number>();
  private boot: (kind: K) => Promise<C>;
  private isDead: (c: C) => boolean;

  constructor(boot: (kind: K) => Promise<C>, isDead: (c: C) => boolean = () => false) {
    this.boot = boot;
    this.isDead = isDead;
  }

  /** 지금 등록된 엔진(죽었어도 돌려준다: 그 엔진에서 연 문서는 그 인스턴스로만 다뤄야 한다) */
  get(kind: K): C | undefined {
    return this.engines.get(kind);
  }
  kinds(): K[] {
    return [...this.engines.keys()];
  }
  isBooting(kind: K): boolean {
    return this.boots.has(kind);
  }

  async acquire(kind: K): Promise<C> {
    const have = this.engines.get(kind);
    if (have && !this.isDead(have)) return have;
    const running = this.boots.get(kind);
    if (running) return running;
    if (have) {
      this.engines.delete(kind);
      try {
        have.dispose();
      } catch {
        // 이미 죽은 워커
      }
    }
    const p: Promise<C> = this.boot(kind)
      .then((c) => {
        this.engines.set(kind, c);
        return c;
      })
      .finally(() => {
        if (this.boots.get(kind) === p) this.boots.delete(kind);
      });
    this.boots.set(kind, p);
    return p;
  }

  pin(kind: K): void {
    this.pins.set(kind, (this.pins.get(kind) ?? 0) + 1);
  }
  unpin(kind: K): void {
    const n = (this.pins.get(kind) ?? 0) - 1;
    if (n > 0) this.pins.set(kind, n);
    else this.pins.delete(kind);
  }
  pinned(kind: K): number {
    return this.pins.get(kind) ?? 0;
  }

  /** 문서가 없고(inUse false) pin 도 기동 중인 것도 없는 엔진을 내린다. 내린 종류를 돌려준다 */
  releaseUnused(inUse: (kind: K) => boolean): K[] {
    const out: K[] = [];
    for (const [kind, c] of [...this.engines]) {
      if (this.pins.has(kind) || this.boots.has(kind) || inUse(kind)) continue;
      try {
        c.dispose();
      } catch {
        // 무시
      }
      this.engines.delete(kind);
      out.push(kind);
    }
    return out;
  }
}
