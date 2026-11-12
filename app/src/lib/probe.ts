// file:// 환경 점검용. URL 해시가 #probe 일 때만 실행하고 결과를 <html data-probe> 에 기록한다.
import { createEngineClient, createEngineWorker } from '../engine/worker-client';

async function worker(): Promise<string> {
  const w = createEngineWorker();
  try {
    return await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 5000);
      w.onmessage = () => { clearTimeout(t); resolve('ok'); };
      w.onerror = (e) => { clearTimeout(t); reject(new Error(e.message || 'worker error')); };
      w.postMessage({ type: 'ping', id: 1 });
    });
  } finally {
    w.terminate();
  }
}

// 실제 RPC 경로: 클라이언트로 mupdf 를 띄워 PDF 1쪽을 그린다. 바이트는 probe 서버/파일에서 받는다.
async function render(): Promise<string> {
  const base = new URLSearchParams(location.search).get("assets") ?? "";
  if (!base) return "skip (no ?assets=)";
  const [wasm, pdf] = await Promise.all([
    fetch(base + "mupdf-wasm.wasm").then((r) => r.arrayBuffer()),
    fetch(base + "ko_nonembedded.pdf").then((r) => r.arrayBuffer()),
  ]);
  const c = await createEngineClient({ engine: "mupdf", wasm });
  try {
    const id = await c.open(pdf);
    const pages = await c.pageCount(id);
    const b = await c.renderPage(id, 0, 1);
    return `ok ${b.width}x${b.height} pages=${pages}`;
  } finally {
    c.dispose();
  }
}

async function idb(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = indexedDB.open('pdf-edit-probe', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('k');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('k', 'readwrite');
      tx.objectStore('k').put('v', 'a');
      tx.oncomplete = () => { db.close(); indexedDB.deleteDatabase('pdf-edit-probe'); resolve('ok'); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

export async function runProbe(): Promise<void> {
  const r: Record<string, string> = { protocol: location.protocol, subtle: String(!!globalThis.crypto?.subtle) };
  for (const [k, f] of [['worker', worker], ['render', render], ['indexedDB', idb]] as const) {
    try { r[k] = await f(); } catch (e) { r[k] = 'FAIL ' + String(e); }
  }
  document.documentElement.dataset.probe = JSON.stringify(r);
}
