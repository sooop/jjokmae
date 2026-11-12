// 렌더 요청 스케줄러. 문서(엔진 클라이언트)마다 하나를 만든다.
// - 동시에 워커로 나가는 요청은 maxInFlight 개로 제한한다(나머지는 메인 스레드 큐에서 대기하므로 취소할 수 있다).
// - 대기 중인 요청은 priority() 가 가장 작은 것부터 보낸다(보내는 시점에 계산한다).
// - 취소: 대기 중이면 큐에서 빼고, 이미 나간 것은 결과가 오면 버린다.
// - rebind: 문서 id 가 바뀌어도(저장 뒤 다시 열기) 대기 큐는 그대로 두고 새 id 로 보낸다. 옛 id 로 이미 나간 요청은
//   결과를 버리고(또는 옛 문서가 닫혀 실패하면) 같은 요청을 새 id 로 다시 보내, 호출자의 Promise 가 비트맵으로 끝나게 한다.
import type { DocId, EngineAdapter, RenderedBitmap } from '../engine/adapter';

export interface RenderStats {
  /** renderPage 를 실제로 호출한 횟수 */
  calls: number;
  /** 호출이 끝나 호출자에게 전달된 비트맵 수 */
  delivered: number;
  /** 호출이 나간 뒤 취소되어 버려진 결과 수 */
  discarded: number;
  /** 워커로 나가기 전에 취소된 요청 수 */
  canceledQueued: number;
  inFlight: number;
  maxInFlight: number;
  /** 전달된 결과의 렌더 소요 합(ms, 왕복 포함) */
  totalMs: number;
  errors: number;
  /** 메인 스레드에서 비트맵을 캔버스에 그린 횟수·누적 ms·최대 ms */
  draws: number;
  drawMs: number;
  drawMax: number;
  /** 주석·양식 목록을 읽은 횟수 */
  annotLists: number;
  /** 최근 renderPage 호출 [쪽, 배율] (최대 600개) */
  log: [number, number][];
}

export const stats: RenderStats = {
  calls: 0,
  delivered: 0,
  discarded: 0,
  canceledQueued: 0,
  inFlight: 0,
  maxInFlight: 0,
  totalMs: 0,
  errors: 0,
  draws: 0,
  drawMs: 0,
  drawMax: 0,
  annotLists: 0,
  log: [],
};
(globalThis as { __pdfeditStats?: RenderStats }).__pdfeditStats = stats;

export interface RenderJob {
  /** 취소되었거나 실패하면 null */
  promise: Promise<RenderedBitmap | null>;
  cancel(): void;
}

interface Entry {
  index: number;
  scale: number;
  priority: () => number;
  resolve: (b: RenderedBitmap | null) => void;
  canceled: boolean;
  started: boolean;
  /** 워커로 나갈 때의 문서 세대(rebind 로 바뀌면 그 결과는 쓰지 않는다) */
  epoch: number;
}

export class RenderScheduler {
  private queue: Entry[] = [];
  private inFlight = 0;
  /** 시험용: 지금 나가 있는 요청 수 */
  get pending() {
    return this.inFlight;
  }
  private disposed = false;
  private epoch = 0;

  private adapter: Pick<EngineAdapter, 'renderPage'>;
  private doc: DocId;
  private maxInFlight: number;
  private onError?: (e: unknown) => void;

  // 주의: erasable 문법만 쓴다(Node 타입 스트리핑으로 시험에서 직접 import) — 생성자 매개변수 속성 금지
  constructor(adapter: Pick<EngineAdapter, 'renderPage'>, doc: DocId, maxInFlight = 2, onError?: (e: unknown) => void) {
    this.adapter = adapter;
    this.doc = doc;
    this.maxInFlight = maxInFlight;
    this.onError = onError;
  }

  request(index: number, scale: number, priority: () => number): RenderJob {
    let entry!: Entry;
    const promise = new Promise<RenderedBitmap | null>((resolve) => {
      entry = { index, scale, priority, resolve, canceled: false, started: false, epoch: 0 };
    });
    if (this.disposed) {
      entry.resolve(null);
    } else {
      this.queue.push(entry);
      this.pump();
    }
    return {
      promise,
      cancel: () => {
        if (entry.canceled) return;
        entry.canceled = true;
        if (!entry.started) {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          stats.canceledQueued++;
          entry.resolve(null);
        }
      },
    };
  }

  /** 같은 문서를 다른 id 로 다시 열었을 때: 대기 큐를 보존하고 이후 요청을 새 id 로 보낸다 */
  rebind(newId: DocId) {
    if (this.disposed || newId === this.doc) return;
    this.doc = newId;
    this.epoch++;
  }

  /** 대기 중인 요청을 모두 취소하고 이후 요청을 거절한다 */
  dispose() {
    this.disposed = true;
    for (const e of this.queue.splice(0)) {
      e.canceled = true;
      stats.canceledQueued++;
      e.resolve(null);
    }
  }

  private pump() {
    while (this.inFlight < this.maxInFlight && this.queue.length) {
      let best = 0;
      let bestP = this.queue[0].priority();
      for (let i = 1; i < this.queue.length; i++) {
        const p = this.queue[i].priority();
        if (p < bestP) {
          best = i;
          bestP = p;
        }
      }
      const e = this.queue.splice(best, 1)[0];
      this.run(e);
    }
  }

  private requeue(e: Entry) {
    e.started = false;
    this.queue.push(e);
  }

  private run(e: Entry) {
    e.started = true;
    this.inFlight++;
    stats.calls++;
    stats.log.push([e.index, e.scale]);
    if (stats.log.length > 600) stats.log.shift();
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    e.epoch = this.epoch;
    const t0 = performance.now();
    let call: Promise<RenderedBitmap>;
    try {
      call = Promise.resolve(this.adapter.renderPage(this.doc, e.index, e.scale));
    } catch (err) {
      call = Promise.reject(err);
    }
    call
      .then(
        (b) => {
          if (e.canceled || this.disposed) {
            stats.discarded++;
            e.resolve(null);
          } else if (e.epoch !== this.epoch) {
            // 옛 id 로 나간 결과: 버리고 새 id 로 다시 보낸다
            stats.discarded++;
            this.requeue(e);
          } else {
            stats.delivered++;
            stats.totalMs += performance.now() - t0;
            e.resolve(b);
          }
        },
        (err) => {
          if (!this.disposed && !e.canceled && e.epoch !== this.epoch) {
            // 옛 문서가 닫혀 실패했다: 새 id 로 다시 보낸다
            this.requeue(e);
            return;
          }
          stats.errors++;
          if (!this.disposed && !e.canceled) this.onError?.(err);
          e.resolve(null);
        },
      )
      .finally(() => {
        this.inFlight--;
        stats.inFlight--;
        this.pump();
      });
  }
}
