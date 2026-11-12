// 엔진 워커 클라이언트. EngineAdapter 와 같은 시그니처의 프록시를 돌려준다.
// 워커 생성은 타깃별로 vite 별칭(engine-spawn-impl)이 고른다(vite.config.ts 참고).
import { spawnEngineWorker } from 'engine-spawn-impl';
import type { EngineAdapter } from './adapter';
import { ADAPTER_METHODS, type AdapterMethod, type EngineKind, type FromWorker, type ToWorker } from './protocol';

export function createEngineWorker(): Worker {
  return spawnEngineWorker();
}

export interface EngineClient extends EngineAdapter {
  /** 워커를 종료한다. 열린 문서는 모두 사라진다 */
  dispose(): void;
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

/** 워커를 띄우고 엔진을 초기화한 뒤 프록시를 돌려준다. 실패하면 워커를 정리하고 reject 한다 */
export async function createEngineClient(opts: EngineClientOptions): Promise<EngineClient> {
  const worker = createEngineWorker();
  const pending = new Map<number, Pending>();
  let seq = 0;
  let dead: Error | null = null;

  const failAll = (err: Error) => {
    dead = err;
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
      worker.postMessage({ ...msg, id }, { transfer });
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
      worker.terminate();
    },
  };
  for (const method of ADAPTER_METHODS) {
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
