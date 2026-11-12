// 렌더 요청 스케줄러. 문서(엔진 클라이언트)마다 하나를 만든다.
// - 동시에 워커로 나가는 요청은 maxInFlight 개로 제한한다(나머지는 메인 스레드 큐에서 대기하므로 취소할 수 있다).
// - 대기 중인 요청은 priority() 가 가장 작은 것부터 보낸다(보내는 시점에 계산한다).
// - 취소: 대기 중이면 큐에서 빼고, 이미 나간 것은 결과가 오면 버린다.
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
}

export class RenderScheduler {
  private queue: Entry[] = [];
  private inFlight = 0;
  private disposed = false;

  constructor(
    private adapter: EngineAdapter,
    private doc: DocId,
    private maxInFlight = 2,
    private onError?: (e: unknown) => void,
  ) {}

  request(index: number, scale: number, priority: () => number): RenderJob {
    let entry!: Entry;
    const promise = new Promise<RenderedBitmap | null>((resolve) => {
      entry = { index, scale, priority, resolve, canceled: false, started: false };
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

  private run(e: Entry) {
    e.started = true;
    this.inFlight++;
    stats.calls++;
    stats.log.push([e.index, e.scale]);
    if (stats.log.length > 600) stats.log.shift();
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    const t0 = performance.now();
    this.adapter
      .renderPage(this.doc, e.index, e.scale)
      .then(
        (b) => {
          if (e.canceled || this.disposed) {
            stats.discarded++;
            e.resolve(null);
          } else {
            stats.delivered++;
            stats.totalMs += performance.now() - t0;
            e.resolve(b);
          }
        },
        (err) => {
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
