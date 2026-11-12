// 인쇄 실행(브라우저 전용): 방식 A 는 인쇄용 PDF 를 숨은 iframe 에 넣고 print(), 방식 B 는 쪽 이미지를 #print-root 에 깔고 window.print().
// 정리는 afterprint 나 포커스 복귀 때 하고, 끝내 신호가 없으면 마지막 안전 시간(MAX_HOLD_MS)이 지나 정리한다.
import type { DocId, PageSize, RenderedBitmap } from '../engine/adapter';
import type { EngineClient } from '../engine/worker-client';
import { budgetFit, buildPageCss, MAX_TOTAL_BYTES, pageFit } from './print';

/** 방식 B 의 원본: 문서마다 기준 바이트 사본을 연 임시 문서(라이브 문서와 무관) */
export interface PrintSource {
  client: EngineClient;
  id: DocId;
  /** 인쇄할 쪽(0부터) */
  pages: number[];
  /** pages 와 같은 순서의 쪽 크기(pt, 회전 반영) */
  sizes: PageSize[];
}

export class PrintCancelled extends Error {
  constructor() {
    super('인쇄 준비를 취소했다');
  }
}

/** 방식 A 를 쓸 수 없을 때(iframe 접근 차단·불러오기 실패) */
export class FrameError extends Error {
  reason: 'blocked' | 'timeout' | 'error';
  constructor(reason: 'blocked' | 'timeout' | 'error', message: string) {
    super(message);
    this.reason = reason;
  }
}

// ---------- 진단·시험 훅 ----------
interface DiagEvent {
  t: number;
  e: string;
  d?: string;
}
const diag: { events: DiagEvent[] } = ((globalThis as { __pdfeditPrint?: { events: DiagEvent[] } }).__pdfeditPrint ??= { events: [] });
function log(e: string, d?: string) {
  diag.events.push({ t: Math.round(performance.now()), e, d });
  if (diag.events.length > 300) diag.events.shift();
}
/** 시험에서만 쓴다: iframe 불러오기 실패를 흉내 낸다('noload' 는 불러오지 않음, 'throw' 는 print 접근 예외) */
interface Inject {
  iframe?: 'noload' | 'throw';
  timeoutMs?: number;
  /** 이미지 방식의 전체 인코딩 크기 상한(바이트)을 낮춰 해상도 자동 하향 경로를 확인한다 */
  limitBytes?: number;
}
const inject = (): Inject => (globalThis as { __pdfeditPrintInject?: Inject }).__pdfeditPrintInject ?? {};

const LOAD_TIMEOUT_MS = 8000;
/** 인쇄 창 신호(afterprint·포커스 복귀)가 없을 때 정리하는 마지막 시간 */
const MAX_HOLD_MS = 10 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 방식 A(iframe 의 PDF 인쇄)를 처음부터 쓸 수 없는 환경인가.
 * - file: 파일로 직접 연 화면(origin 'null')에서는 blob iframe 의 print 접근이 교차 출처로 막힌다
 * - viewer: 브라우저의 PDF 보기 기능이 꺼져 있으면 iframe 에 넣은 PDF 가 인쇄 대신 내려받기가 된다
 */
export function vectorBlockReason(): 'file' | 'viewer' | null {
  if (location.protocol === 'file:' || location.origin === 'null') return 'file';
  if (navigator.pdfViewerEnabled === false) return 'viewer';
  return null;
}

// ---------- 정리 ----------
const pending = new Set<() => void>();

/** 아직 정리되지 않은 이전 인쇄 자원(iframe·#print-root·URL)을 모두 정리한다 */
export function cleanupPrint() {
  for (const f of [...pending]) f();
}

/** print() 를 부른 뒤: afterprint 또는 (창이 포커스를 잃었다가 돌아오면) 정리한다 */
function armCleanup(fn: () => void, extra?: Window | null) {
  let done = false;
  let blurred = false;
  const tm = setTimeout(fin, MAX_HOLD_MS);
  const onAfter = () => void setTimeout(fin, 300);
  const onBlur = () => {
    blurred = true;
  };
  const onFocus = () => {
    if (blurred) setTimeout(fin, 800);
  };
  function fin() {
    if (done) return;
    done = true;
    clearTimeout(tm);
    pending.delete(fin);
    window.removeEventListener('afterprint', onAfter);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    try {
      extra?.removeEventListener('afterprint', onAfter);
    } catch {
      /* 교차 출처 */
    }
    log('cleanup');
    fn();
  }
  window.addEventListener('afterprint', onAfter);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  try {
    extra?.addEventListener('afterprint', onAfter);
  } catch {
    /* 교차 출처 */
  }
  pending.add(fin);
}

// ---------- 방식 A: iframe ----------
/**
 * 인쇄용 PDF 바이트를 숨은 iframe 에서 인쇄한다. 막히면 FrameError(호출자가 방식 B 로 전환한다).
 * cancel.value 가 서 있으면 불러온 뒤와 print() 직전에 iframe·URL 을 거두고 PrintCancelled 로 끝낸다.
 */
export async function printViaIframe(bytes: Uint8Array, cancel?: { value: boolean }): Promise<void> {
  cleanupPrint();
  const inj = inject();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const frame = document.createElement('iframe');
  frame.title = '인쇄용 PDF';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.dataset.printFrame = '';
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:1000px;border:0;opacity:0;pointer-events:none';
  const drop = () => {
    frame.remove();
    URL.revokeObjectURL(url);
  };
  log('iframe-start', `${bytes.byteLength}`);
  try {
    const loaded = new Promise<void>((res, rej) => {
      frame.addEventListener('load', () => res());
      frame.addEventListener('error', () => rej(new FrameError('error', 'iframe 불러오기 오류')));
    });
    if (inj.iframe !== 'noload') {
      frame.src = url;
      document.body.appendChild(frame);
    } // 'noload' 시험 주입: iframe 을 붙이지 않아 load 가 오지 않는다
    let timer = 0;
    const timeout = new Promise<never>((_, rej) => {
      timer = window.setTimeout(() => rej(new FrameError('timeout', 'iframe 불러오기 시간 초과')), inj.timeoutMs ?? LOAD_TIMEOUT_MS);
    });
    // 불러오는 동안(최대 LOAD_TIMEOUT_MS)에도 취소를 알아챈다
    let watch = 0;
    const canceled = new Promise<never>((_, rej) => {
      if (cancel) watch = window.setInterval(() => cancel.value && rej(new PrintCancelled()), 100);
    });
    try {
      await Promise.race([loaded, timeout, canceled]);
    } finally {
      clearTimeout(timer);
      clearInterval(watch);
    }
    log('iframe-loaded');
    if (cancel?.value) throw new PrintCancelled();
    await sleep(400); // PDF 뷰어가 문서를 올릴 시간
    if (cancel?.value) throw new PrintCancelled();
    let win: Window | null;
    try {
      if (inj.iframe === 'throw') throw new DOMException('주입한 접근 차단', 'SecurityError');
      win = frame.contentWindow;
      if (!win) throw new FrameError('error', 'iframe 창이 없다');
      win.focus();
      armCleanup(drop, win);
      win.print();
    } catch (e) {
      if (e instanceof FrameError) throw e;
      throw new FrameError('blocked', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
    log('iframe-print-called');
  } catch (e) {
    log('iframe-fail', e instanceof Error ? e.message : String(e));
    cleanupPrint(); // 이 시도에서 건 정리 장치(리스너·타이머)도 거둔다
    drop();
    throw e;
  }
}

// ---------- 방식 B: 이미지 ----------
export interface ImageRunOptions {
  dpi: number;
  cancel: { value: boolean };
  onProgress: (done: number, total: number) => void;
}

export interface ImageRunResult {
  count: number;
  /** 실제로 쓴 가장 낮은 dpi */
  minDpi: number;
  /** 원하는 dpi 보다 낮춘 쪽이 있는가(쪽당 픽셀 상한·전체 메모리 상한) */
  lowered: boolean;
  /** 최저 dpi 로도 메모리 상한을 맞추지 못했는가 */
  floor: boolean;
  /** 인코딩한 이미지 합계(바이트) */
  bytes: number;
  dispose: () => void;
}

async function encode(b: RenderedBitmap): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = b.width;
  c.height = b.height;
  try {
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('캔버스를 만들 수 없다');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(b.data), b.width, b.height), 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) throw new Error('쪽 이미지를 만들지 못했다');
    return blob;
  } finally {
    c.width = 0; // 비트맵 해제
    c.height = 0;
  }
}

/**
 * 대상 쪽을 한 번에 한 쪽씩 순서대로 렌더해 #print-root 에 <img> 로 깐다. 쪽마다 인코딩 크기를 재서 전체가
 * MAX_TOTAL_BYTES 를 넘을 것 같으면 남은 쪽의 dpi 를 낮춘다. 취소하면 PrintCancelled 로 끝나고 자원은 정리된다.
 */
export async function buildPrintRoot(sources: PrintSource[], o: ImageRunOptions): Promise<ImageRunResult> {
  cleanupPrint();
  const total = sources.reduce((n, s) => n + s.pages.length, 0);
  const dims = sources.flatMap((s) => s.sizes.map((z) => ({ w: z.width, h: z.height })));
  const { css, flip } = buildPageCss(dims);
  const root = document.createElement('div');
  root.id = 'print-root';
  root.setAttribute('aria-hidden', 'true');
  const style = document.createElement('style');
  style.id = 'print-page-css';
  style.textContent = css;
  const urls: string[] = [];
  const dispose = () => {
    root.remove();
    style.remove();
    for (const u of urls.splice(0)) URL.revokeObjectURL(u);
  };
  document.head.appendChild(style);
  document.body.appendChild(root);
  log('image-start', `${total}p ${o.dpi}dpi`);
  let n = 0;
  let used = 0;
  let pxSum = 0;
  let minDpi = Infinity;
  let lowered = false;
  let floor = false;
  try {
    o.onProgress(0, total);
    for (const s of sources) {
      for (let k = 0; k < s.pages.length; k++) {
        if (o.cancel.value) throw new PrintCancelled();
        const z = s.sizes[k];
        const bpp = Math.max(0.05, (used / Math.max(1, pxSum)) * 1.25);
        // 첫 쪽은 압축률을 모르니 쪽당 픽셀 상한만 적용하고, 그 뒤로는 실제 인코딩 크기로 남은 예산을 계산한다
        const fit =
          pxSum > 0
            ? budgetFit({ wPt: z.width, hPt: z.height, wantDpi: o.dpi, usedBytes: used, remaining: total - n, bytesPerPx: bpp, limit: inject().limitBytes ?? MAX_TOTAL_BYTES })
            : { ...pageFit(z.width, z.height, o.dpi), budgeted: false, floor: false };
        if (fit.dpi < o.dpi - 0.5) lowered = true;
        if (fit.floor) floor = true;
        minDpi = Math.min(minDpi, fit.dpi);
        o.onProgress(n + 1, total);
        const bmp = await s.client.renderPage(s.id, s.pages[k], fit.scale);
        if (o.cancel.value) throw new PrintCancelled();
        pxSum += bmp.width * bmp.height;
        const blob = await encode(bmp);
        used += blob.size;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const box = document.createElement('div');
        box.className = flip[n] ? 'pp flip' : 'pp';
        const img = new Image();
        img.alt = '';
        img.decoding = 'async';
        await new Promise<void>((res, rej) => {
          img.onload = () => res();
          img.onerror = () => rej(new Error(`${n + 1}쪽 이미지를 불러오지 못했다`));
          img.src = url;
        });
        box.appendChild(img);
        root.appendChild(box);
        n++;
      }
    }
  } catch (e) {
    dispose();
    log('image-fail', e instanceof Error ? e.message : String(e));
    throw e;
  }
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  log('image-ready', `${n}p ${Math.round(used / 1024)}KB min${Math.round(minDpi)}dpi`);
  return { count: n, minDpi: Number.isFinite(minDpi) ? minDpi : o.dpi, lowered, floor, bytes: used, dispose };
}

/** 준비한 #print-root 를 인쇄한다(afterprint 나 포커스 복귀에서 정리) */
export function printRoot(dispose: () => void) {
  armCleanup(dispose);
  log('window-print-called');
  window.print();
}
