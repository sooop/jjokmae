// 인쇄 작업 하나의 진행 상태와 흐름. 대화상자(PrintPopover)가 start() 를 부르고, 상태는 대화상자·툴바 버튼 옆 안내가 읽는다.
//
// 방식 A(자동): 인쇄용 사본 PDF 를 만들어 숨은 iframe 에서 print(). 막히거나 시간 안에 안 뜨면 방식 B 로 전환한다.
// 방식 B(이미지): 임시 문서에서 쪽을 한 장씩 렌더해 #print-root 에 깔고 window.print().
import { cleanupPrint, buildPrintRoot, FrameError, PrintCancelled, printRoot, printViaIframe, vectorBlockReason } from './print-run';
import type { PrintMethod, PrintPart } from './print';
import type { NoticeData } from './status';
import type { Workspace } from './workspace.svelte';

export interface PrintSpec {
  parts: PrintPart[];
  method: PrintMethod;
  dpi: number;
}

export type PrintPhase = 'idle' | 'prepare' | 'render';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class PrintJob {
  phase = $state<PrintPhase>('idle');
  done = $state(0);
  total = $state(0);
  canceling = $state(false);
  /** 실패 안내(닫기 전까지 남는다) */
  error = $state<NoticeData | null>(null);
  /** 방식 전환·해상도 조정 같은 한 줄 안내 */
  note = $state<NoticeData | null>(null);

  private ws: Workspace;
  private flush: () => Promise<void>;
  private cancelFlag = { value: false };

  constructor(ws: Workspace, flush: () => Promise<void>) {
    this.ws = ws;
    this.flush = flush;
  }

  get busy() {
    return this.phase !== 'idle';
  }

  reset() {
    this.error = null;
    this.note = null;
  }

  cancel() {
    if (!this.busy) return;
    this.cancelFlag.value = true;
    this.canceling = true;
  }

  /** 인쇄를 시작한다. 인쇄 창을 띄웠으면 true(대화상자를 닫는다), 취소·실패면 false */
  async start(spec: PrintSpec): Promise<boolean> {
    if (this.busy) return false;
    this.reset();
    this.cancelFlag = { value: false };
    this.canceling = false;
    this.done = 0;
    this.total = spec.parts.reduce((n, p) => n + p.pages.length, 0);
    this.phase = 'prepare';
    try {
      await this.flush();
      await this.ws.settleEdits();
      if (spec.method === 'auto') {
        const blocked = vectorBlockReason();
        if (blocked) {
          this.note = {
            kind: 'info',
            text:
              blocked === 'file'
                ? '파일로 직접 연 화면에서는 PDF 로 바로 인쇄할 수 없어 이미지 방식으로 인쇄합니다.'
                : '브라우저의 PDF 보기 기능이 꺼져 있어 이미지 방식으로 인쇄합니다.',
          };
        } else {
          const bytes = await this.ws.printCopy(spec.parts);
          if (this.cancelFlag.value) return false;
          try {
            await printViaIframe(bytes, this.cancelFlag);
            return true;
          } catch (e) {
            if (e instanceof PrintCancelled) return false;
            if (!(e instanceof FrameError)) throw e;
            if (this.cancelFlag.value) return false;
            this.note = { kind: 'info', text: '이 브라우저에서는 PDF 로 바로 인쇄할 수 없어 이미지 방식으로 인쇄합니다.', detail: e.message };
          }
        }
      }
      return await this.image(spec);
    } catch (e) {
      if (e instanceof PrintCancelled || this.cancelFlag.value) return false;
      this.error = { kind: 'error', text: '인쇄를 준비하지 못했습니다. 다시 시도해 주세요.', reassure: '열려 있는 문서는 그대로입니다.', detail: errText(e) };
      return false;
    } finally {
      this.phase = 'idle';
      this.canceling = false;
    }
  }

  private async image(spec: PrintSpec): Promise<boolean> {
    this.phase = 'render';
    const src = await this.ws.openPrintSources(spec.parts);
    let res;
    try {
      res = await buildPrintRoot(src.sources, {
        dpi: spec.dpi,
        cancel: this.cancelFlag,
        onProgress: (d, t) => {
          this.done = d;
          this.total = t;
        },
      });
    } finally {
      await src.close();
    }
    if (this.cancelFlag.value) {
      res.dispose();
      cleanupPrint();
      return false;
    }
    if (res.lowered) {
      const more = res.floor ? ' 쪽 수가 아주 많아 인쇄가 실패할 수 있습니다. 나눠서 인쇄해 보세요.' : '';
      const text = `메모리를 아끼려고 일부 쪽의 해상도를 낮췄습니다(최저 ${Math.round(res.minDpi)}dpi).${more}`;
      this.note = { kind: 'info', text: this.note ? `${this.note.text} ${text}` : text };
    }
    printRoot(res.dispose);
    return true;
  }
}
