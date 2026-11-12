// 엔진 워커: 선택된 어댑터 하나만 동적 import 해 호스팅하고, 어댑터 메서드를 요청 ID 로 프록시한다.
// bitmap·save 바이트는 transfer 로 돌려준다.
import type { EngineAdapter, RenderedBitmap, SaveResult } from './adapter';
import { ADAPTER_METHODS, type AdapterMethod, type FromWorker, type InitMessage, type ToWorker } from './protocol';

const allowed = new Set<string>(ADAPTER_METHODS);
let adapter: EngineAdapter | null = null;
let ready: Promise<void> | null = null;

function reply(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, { transfer });
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

async function startEngine(m: InitMessage): Promise<void> {
  if (m.engine === 'mupdf') {
    const { createMupdfAdapter } = await import('./mupdf-adapter');
    adapter = createMupdfAdapter({ wasmBinary: m.wasm });
  } else {
    const { createPdfiumAdapter } = await import('./pdfium-adapter');
    adapter = createPdfiumAdapter({ wasmBinary: m.wasm, koreanFont: m.koreanFont });
  }
  await adapter.init();
}

function transferablesOf(method: AdapterMethod, result: unknown): { result: unknown; transfer: Transferable[] } {
  if (method === 'renderPage') {
    const b = result as RenderedBitmap;
    return { result: b, transfer: [b.data] };
  }
  if (method === 'save') {
    const r = result as SaveResult;
    const u8 = r.bytes;
    const exact = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength;
    const bytes = exact ? u8 : u8.slice();
    return { result: { ...r, bytes }, transfer: [bytes.buffer as ArrayBuffer] };
  }
  return { result, transfer: [] };
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;

  if (m.type === 'ping') {
    reply({ id: m.id, ok: true, result: 'pong' });
    return;
  }

  if (m.type === 'init') {
    ready = startEngine(m);
    ready.then(
      () => reply({ id: m.id, ok: true, result: null }),
      (err) => reply({ id: m.id, ok: false, error: errText(err) }),
    );
    return;
  }

  if (m.type === 'call') {
    void (async () => {
      try {
        if (!ready) throw new Error('엔진이 초기화되지 않았다');
        await ready;
        if (!adapter || !allowed.has(m.method)) throw new Error(`알 수 없는 메서드: ${m.method}`);
        const fn = (adapter as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m.method];
        const out = await fn.apply(adapter, m.args);
        const { result, transfer } = transferablesOf(m.method, out);
        reply({ id: m.id, ok: true, result }, transfer);
      } catch (err) {
        reply({ id: m.id, ok: false, error: errText(err) });
      }
    })();
  }
};
