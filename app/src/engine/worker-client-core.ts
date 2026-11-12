// 엔진 워커 클라이언트의 본체(워커 인스턴스를 받는다). vite 별칭(engine-spawn-impl)에 의존하지 않아 Node 시험에서 가짜 워커로 검증할 수 있다.
// 워커 생성과 공개 진입점은 worker-client.ts.
import type { EngineAdapter } from './adapter';
import type { AdapterMethod, EngineKind, FromWorker, ToWorker } from './protocol';

export interface EngineClient extends EngineAdapter {
  /** 워커를 종료한다. 열린 문서는 모두 사라진다 */
  dispose(): void;
  /**
   * 워커가 죽었는가(워커 오류·메시지 오류·dispose). true 가 되면 대기 중이던 호출은 모두 reject 되고 이후 호출도 즉시 reject 된다.
   * 되돌릴 수 없다: 새 엔진이 필요하면 createEngineClient 로 다시 만들고 문서를 다시 열어야 한다.
   */
  readonly dead: boolean;
  /** 죽은 이유(살아 있으면 null) */
  readonly deadReason: Error | null;
}

export interface EngineClientOptions {
  engine: EngineKind;
  /** WASM 바이트. 워커로 transfer 되므로 호출 뒤 이 버퍼는 쓸 수 없다 */
  wasm: ArrayBuffer;
  koreanFont?: ArrayBuffer;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** 주어진 워커에서 엔진을 초기화한 뒤 프록시를 돌려준다. 실패하면 워커를 정리하고 reject 한다 */
export async function createEngineClientOn(
  worker: Worker,
  opts: EngineClientOptions,
  /** 프록시할 메서드 목록(protocol.ts 의 ADAPTER_METHODS). 런타임 import 를 피하려고 인수로 받는다 */
  methods: readonly AdapterMethod[],
): Promise<EngineClient> {
  const pending = new Map<number, Pending>();
  let seq = 0;
  let dead: Error | null = null;

  const failAll = (err: Error) => {
    if (!dead) dead = err;
    // 오류 뒤의 워커는 상태를 알 수 없으므로 끝낸다(남겨 두면 메모리·스레드가 샌다)
    try {
      worker.terminate();
    } catch {
      /* 이미 종료 */
    }
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const d = e.data;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.ok) p.resolve(d.result);
    else p.reject(new Error(d.error));
  };
  worker.onerror = (e) => failAll(new Error(e.message || '엔진 워커 오류'));
  worker.onmessageerror = () => failAll(new Error('엔진 워커 메시지 오류'));

  const send = (msg: DistributiveOmit<ToWorker, 'id'>, transfer: Transferable[] = []): Promise<unknown> => {
    if (dead) return Promise.reject(dead);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ ...msg, id }, { transfer });
      } catch (e) {
        // DataCloneError 등: 이 호출만 실패한다(워커는 살아 있다). 응답이 올 수 없으니 대기 항목을 남기지 않는다
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  };

  const transfers: Transferable[] = [opts.wasm];
  if (opts.koreanFont) transfers.push(opts.koreanFont);
  try {
    await send({ type: 'init', engine: opts.engine, wasm: opts.wasm, koreanFont: opts.koreanFont }, transfers);
  } catch (e) {
    worker.terminate();
    throw e;
  }

  const call = (method: AdapterMethod, args: unknown[], transfer: Transferable[] = []) =>
    send({ type: 'call', method, args }, transfer);

  const client: Record<string, unknown> = {
    name: opts.engine,
    init: async () => {},
    dispose: () => {
      failAll(new Error('엔진이 종료되었다'));
    },
  };
  Object.defineProperty(client, 'dead', { get: () => dead !== null, enumerable: true });
  Object.defineProperty(client, 'deadReason', { get: () => dead, enumerable: true });
  for (const method of methods) {
    client[method] = (...args: unknown[]) => call(method, args);
  }
  // open: 바이트를 복사하지 않고 transfer 한다(호출 뒤 넘긴 버퍼는 비워진다)
  client.open = (bytes: ArrayBuffer | Uint8Array, o?: unknown) => {
    let buf: ArrayBuffer;
    if (bytes instanceof Uint8Array) {
      const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
      buf = (exact ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
    } else buf = bytes;
    return call('open', [buf, o], [buf]);
  };
  return client as unknown as EngineClient;
}
