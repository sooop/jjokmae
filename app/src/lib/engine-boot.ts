// 엔진 기동: BinarySource 로 WASM 을 받아 워커에 넘긴다.
import { BinaryError, createBinarySource, type BinaryProgress, type BinaryRef } from '../engine/binary-source';
import { MUPDF_WASM, PDFIUM_WASM } from '../engine/binaries';
import { createEngineClient, type EngineClient } from '../engine/worker-client';
import type { EngineKind } from '../engine/protocol';

const source = createBinarySource();

export const ENGINE_LABEL: Record<EngineKind, string> = { mupdf: 'MuPDF', pdfium: 'PDFium' };

export interface BootHandlers {
  /** single 타깃에서 캐시에 없을 때만 불린다. false 면 중단 */
  confirmDownload: (ref: BinaryRef) => Promise<boolean>;
  onProgress: (p: BinaryProgress) => void;
}

export async function bootEngine(engine: EngineKind, h: BootHandlers): Promise<EngineClient> {
  const ref = engine === 'mupdf' ? MUPDF_WASM : PDFIUM_WASM;
  const wasm = await source.get(ref, { onProgress: h.onProgress, confirmDownload: h.confirmDownload });
  // wasm 은 transfer 된다. 캐시에서 온 것도 읽기마다 새 복사본이므로 안전하다.
  return createEngineClient({ engine, wasm });
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 사용자에게 보여 줄 문구. 사용자가 취소한 경우는 null(아무것도 띄우지 않는다) */
export function bootErrorMessage(e: unknown, engine: EngineKind): { message: string; detail: string } | null {
  const detail = e instanceof Error ? e.message : String(e);
  if (e instanceof BinaryError) {
    switch (e.code) {
      case 'declined':
        return null;
      case 'hash-mismatch':
        return {
          message: `내려받은 ${ENGINE_LABEL[engine]} 파일이 예상과 달라 사용하지 않았습니다. 잠시 뒤 다시 시도해 주세요.`,
          detail,
        };
      case 'no-subtle':
        return {
          message: '이 환경에서는 내려받은 파일을 검증할 수 없습니다. 주소가 https 인 곳이나 최신 브라우저에서 열어 주세요.',
          detail,
        };
      default:
        return {
          message: `${ENGINE_LABEL[engine]} 엔진을 내려받지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.`,
          detail,
        };
    }
  }
  return {
    message: `${ENGINE_LABEL[engine]} 엔진을 시작하지 못했습니다. 다시 시도하거나 설정에서 다른 엔진을 선택해 주세요.`,
    detail,
  };
}
