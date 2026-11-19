// 터치·펜으로 쪽 칸을 길게 누르기: 정리 격자(PageGrid)와 썸네일 패널(Thumbnails)이 함께 쓴다.
// 한 번의 길게 누르기에 '끌기'와 '메뉴'가 모두 걸려 있어서 충돌하지 않게 순서를 정한다.
//   누름 → (움직이면 세로 스크롤이므로 취소) → 500ms 가만히 있으면 '준비'(칸이 떠오르고 진동)
//   준비 뒤: 8px 넘게 움직이면 끌기 시작(DragSession) / 움직이지 않고 손을 떼면 그 자리에 메뉴
// 준비 뒤에는 브라우저가 스크롤을 시작하지 못하게 touchmove 를 막는다(스크롤이 시작되기 전이라 막을 수 있다).
// 안드로이드는 길게 누르면 contextmenu 도 보내므로, 호출한 쪽은 recent() 로 그 이벤트를 걸러 메뉴가 두 번 열리지 않게 한다.

export interface TouchHoldHooks {
  /** 준비됐다: 칸을 띄우는 표시(없어질 때 index 는 -1) */
  arm(index: number): void;
  /** 준비 뒤 움직임 없이 손을 뗐다(또는 포인터가 취소됐다): 메뉴를 연다 */
  menu(index: number, x: number, y: number): void;
  /** 준비 뒤 움직였다: 끌기를 시작한다(e 는 현재 이동 이벤트) */
  drag(e: PointerEvent, index: number): void;
  /** 이어 오는 click 이 쪽 선택으로 처리되지 않게 한다 */
  suppressClick(): void;
}

export const HOLD_MS = 500;
const SLOP = 8;

export class TouchHold {
  private hooks: TouchHoldHooks;
  private timer = 0;
  private st: { id: number; x: number; y: number; index: number; armed: boolean } | null = null;
  private at = 0;

  constructor(hooks: TouchHoldHooks) {
    this.hooks = hooks;
  }

  /** 길게 누르기로 메뉴를 연 직후인가(뒤따르는 contextmenu 이벤트를 걸러 낸다) */
  recent(ms = 800) {
    return Date.now() - this.at < ms;
  }

  /** 마우스가 아닌 포인터를 눌렀다 */
  press(e: PointerEvent, index: number) {
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    this.cancel();
    this.st = { id: e.pointerId, x: e.clientX, y: e.clientY, index, armed: false };
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onEnd);
    window.addEventListener('pointercancel', this.onEnd);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      const s = this.st;
      if (!s) return;
      s.armed = true;
      this.at = Date.now();
      // 끌기로 이어지면 놓을 때까지 스크롤을 막아야 하므로, 손을 뗄 때까지 유지한다
      window.addEventListener('touchmove', this.block, { passive: false });
      const free = () => {
        window.removeEventListener('touchmove', this.block);
        window.removeEventListener('pointerup', free, true);
        window.removeEventListener('pointercancel', free, true);
      };
      window.addEventListener('pointerup', free, true);
      window.addEventListener('pointercancel', free, true);
      navigator.vibrate?.(12);
      this.hooks.arm(s.index);
    }, HOLD_MS);
  }

  private block = (e: TouchEvent) => {
    if (e.cancelable) e.preventDefault();
  };

  private onMove = (e: PointerEvent) => {
    const s = this.st;
    if (!s || e.pointerId !== s.id) return;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) <= SLOP) return;
    if (!s.armed) {
      this.cancel(); // 준비 전에 움직였다: 세로 스크롤
      return;
    }
    const index = s.index;
    this.cancel();
    this.hooks.suppressClick();
    this.hooks.drag(e, index);
  };

  private onEnd = (e: PointerEvent) => {
    const s = this.st;
    if (!s || e.pointerId !== s.id) return;
    const armed = s.armed;
    this.cancel();
    if (armed) {
      this.hooks.suppressClick();
      this.at = Date.now();
      this.hooks.menu(s.index, e.clientX || s.x, e.clientY || s.y);
    }
  };

  /** 대기·준비를 버린다(칸을 띄운 표시도 거둔다) */
  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
    const was = this.st?.armed;
    this.st = null;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onEnd);
    window.removeEventListener('pointercancel', this.onEnd);
    if (was) this.hooks.arm(-1);
  }
}
