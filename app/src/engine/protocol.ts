// 메인 스레드 ↔ 엔진 워커 메시지 규약.
import type { EngineAdapter } from './adapter';

export type EngineKind = 'mupdf' | 'pdfium';

/** 워커가 프록시하는 어댑터 메서드(name·init 제외) */
export const ADAPTER_METHODS = [
  'open',
  'close',
  'pageCount',
  'pageSize',
  'renderPage',
  'rotatePage',
  'deletePages',
  'movePage',
  'importPages',
  'listAnnotations',
  'addAnnotation',
  'updateAnnotation',
  'deleteAnnotation',
  'textQuads',
  'pageText',
  'searchPage',
  'listFormFields',
  'setFormFieldValue',
  'save',
] as const satisfies readonly (keyof EngineAdapter)[];

export type AdapterMethod = (typeof ADAPTER_METHODS)[number];

export interface InitMessage {
  type: 'init';
  id: number;
  engine: EngineKind;
  /** transfer 된다 */
  wasm: ArrayBuffer;
  /** PDFium 한글 폰트(선택, transfer) */
  koreanFont?: ArrayBuffer;
}

export interface CallMessage {
  type: 'call';
  id: number;
  method: AdapterMethod;
  args: unknown[];
}

export interface PingMessage {
  type: 'ping';
  id: number;
}

export type ToWorker = InitMessage | CallMessage | PingMessage;

export type FromWorker =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
