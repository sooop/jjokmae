import type { BinaryRef } from '../engine/binary-source';
import type { EngineKind } from '../engine/protocol';

/** 뷰어 영역에 앵커되는 상태 카드. 오류는 해제(×)나 성공 전까지 남는다 */
export type ViewerStatus =
  | { phase: 'confirm'; engine: EngineKind; ref: BinaryRef; decide: (ok: boolean) => void }
  | { phase: 'download'; engine: EngineKind; loaded: number; total: number }
  | { phase: 'start'; engine: EngineKind }
  | { phase: 'opening'; name: string }
  | { phase: 'error'; message: string; detail?: string; retry?: () => void };

/** 버튼·패널 옆에 붙는 안내(Notice). 오류는 닫기 전까지 남는다 */
export interface NoticeData {
  kind: 'info' | 'error';
  text: string;
  reassure?: string;
  detail?: string;
}

/** 탭 막대 아래, 해당 탭 옆에 붙는 안내 */
export interface TabNotice extends NoticeData {
  /** 안내가 가리키는 탭(문서 key) */
  key: number;
}
