// 한 줄 목록(가로 탭 막대·세로 파일 목록·병합 목록)의 항목 순서를 끌어서 바꾸는 제스처.
// 쪽 끌기(drag-session)와 별개다: 이쪽은 같은 목록 안의 재정렬뿐이고, 다른 탭 위에 놓는 전송은 하지 않는다.
// 누름 → 5px 문턱(그 전에는 클릭) → 고스트(스프링 추적) + 빈 슬롯 → 놓기(고스트가 슬롯으로 착지) · Esc/포커스 이동/신호 유실은 취소.
// 항목의 자리 이동(FLIP)은 호출한 컴포넌트가 animate:flip 으로 한다. 여기서는 미리보기 순서만 hooks.preview 로 알린다.
import { buttonsLost, holdGesture, releaseGesture, watchPointerLoss } from '../drag-session';
import { reduced } from './index';

export type Axis = 'x' | 'y';
interface Pt {
  x: number;
  y: number;
}

export interface SortHooks {
  axis: Axis;
  /** 목록 컨테이너. 스크롤러이면서 항목의 offsetParent 여야 한다(position: relative) */
  scroller(): HTMLElement | undefined;
  /** 항목 요소(레이아웃상 자리를 재는 대상) */
  itemEl(key: number): HTMLElement | null;
  /** 지금 확정된 순서 */
  keys(): number[];
  /** 끄는 동안의 미리보기 순서(null 이면 해제) */
  preview(order: number[] | null): void;
  /** 빈 슬롯으로 보일 항목(null 이면 해제). 착지가 끝날 때까지 유지된다 */
  slot(key: number | null): void;
  /** 놓았다: toIndex 는 다른 항목을 뺀 뒤 기준의 새 자리 */
  commit(key: number, toIndex: number): void;
  /** 끌기 시작·끝(스크린리더 안내 등, 선택) */
  announce?(msg: string): void;
  /** 고스트 이름(선택) */
  nameOf?(key: number): string;
}

/** Alt+방향키 대체 수단: 가로는 ←/→, 세로는 ↑/↓. 해당하지 않으면 null */
export function keyShift(e: KeyboardEvent, axis: Axis): -1 | 1 | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const [a, b] = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
  return e.key === a ? -1 : e.key === b ? 1 : null;
}
/** 스크린리더 안내 문구 */
export const posMsg = (name: string, index: number, total: number) => `${name}, ${total}개 중 ${index + 1}번째로 이동했습니다`;

// ---------- 고스트: 집은 항목의 복제본이 스프링으로 포인터를 따라온다 ----------
interface Chan {
  v: number;
  vel: number;
  to: number;
  k: number;
  c: number;
}
const chan = (v: number, k: number, c: number): Chan => ({ v, vel: 0, to: v, k, c });
function step(ch: Chan, dt: number) {
  ch.vel += (-ch.k * (ch.v - ch.to) - ch.c * ch.vel) * dt;
  ch.v += ch.vel * dt;
}
/** 넓은 행은 가로 속도에 따른 기울기를 ±2.5° 까지만 */
const TILT = 2.5;

class RowGhost {
  readonly el: HTMLElement;
  private x: Chan;
  private y: Chan;
  private sc: Chan;
  private rot = chan(0, 300, 20);
  private gx: number;
  private gy: number;
  private raf = 0;
  private last = 0;
  private alive = true;
  private parked = false;
  private rm = reduced();

  constructor(src: HTMLElement, rect: DOMRect, pointer: Pt) {
    const el = (this.el = src.cloneNode(true) as HTMLElement);
    // 복제본이 문서의 id·테스트 식별자·포커스를 흩뜨리지 않게 한다
    for (const n of [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))]) {
      n.removeAttribute('id');
      n.removeAttribute('data-testid');
      n.removeAttribute('data-tab-key');
      n.removeAttribute('data-file-key');
      n.removeAttribute('data-merge-row');
      n.removeAttribute('tabindex');
      n.removeAttribute('style');
    }
    el.className = `${el.className} sort-ghost`;
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('data-testid', 'sort-ghost');
    this.gx = Math.max(0, Math.min(rect.width, pointer.x - rect.left));
    this.gy = Math.max(0, Math.min(rect.height, pointer.y - rect.top));
    el.style.cssText = `position:fixed;left:0;top:0;width:${rect.width}px;height:${rect.height}px;margin:0;box-sizing:border-box;z-index:80;pointer-events:none;will-change:transform;background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:var(--r-md);box-shadow:var(--shadow-ghost);transform-origin:${this.gx}px ${this.gy}px;list-style:none;overflow:hidden;opacity:1;`;
    document.body.appendChild(el);
    this.x = chan(rect.left, 520, 36);
    this.y = chan(rect.top, 520, 36);
    this.sc = chan(1, 360, 22);
    this.x.to = pointer.x - this.gx;
    this.y.to = pointer.y - this.gy;
    this.sc.to = 1.045;
    if (this.rm) {
      this.x.v = this.x.to;
      this.y.v = this.y.to;
      this.sc.v = this.sc.to;
    }
    this.paint();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (t: number) => {
    if (!this.alive) return;
    const dt = Math.min(0.05, Math.max(0.001, (t - this.last) / 1000));
    this.last = t;
    let rem = dt;
    while (rem > 0) {
      const h = Math.min(rem, 1 / 120);
      step(this.x, h);
      step(this.y, h);
      step(this.sc, h);
      step(this.rot, h);
      rem -= h;
    }
    if (!this.rm && !this.parked) this.rot.to = Math.max(-TILT, Math.min(TILT, this.x.vel * 0.004));
    this.paint();
    this.raf = requestAnimationFrame(this.tick);
  };

  private paint() {
    this.el.style.transform = `translate3d(${this.x.v}px,${this.y.v}px,0) rotate(${this.rot.v}deg) scale(${this.sc.v})`;
  }

  move(p: Pt) {
    if (this.parked) return;
    this.x.to = p.x - this.gx;
    this.y.to = p.y - this.gy;
    if (this.rm) {
      this.x.v = this.x.to;
      this.y.v = this.y.to;
      this.paint();
    }
  }

  /** 취소·착지: 주어진 화면 위치(좌상단)로 스프링으로 내려앉은 뒤 사라진다 */
  land(to: Pt | null): Promise<void> {
    if (!this.alive) return Promise.resolve();
    if (!to || this.rm) {
      this.destroy();
      return Promise.resolve();
    }
    this.parked = true;
    this.x.k = 460;
    this.y.k = 460;
    this.x.to = to.x;
    this.y.to = to.y;
    this.sc.to = 1;
    this.rot.to = 0;
    return new Promise((res) => {
      const t0 = performance.now();
      const chk = () => {
        if (!this.alive) return res();
        const near = Math.abs(this.x.v - this.x.to) < 1.2 && Math.abs(this.y.v - this.y.to) < 1.2 && Math.abs(this.x.vel) < 20 && Math.abs(this.y.vel) < 20;
        if (near || performance.now() - t0 > 650) {
          this.destroy();
          res();
        } else requestAnimationFrame(chk);
      };
      requestAnimationFrame(chk);
    });
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.el.remove();
  }
}

// ---------- 제스처 ----------
const THRESHOLD = 5;
const EDGE = 48;
const EDGE_STEP = 14;

type End = 'drop' | 'cancel' | 'abort';

export class SortDrag {
  private hooks: SortHooks;
  private press: { x: number; y: number; id: number; key: number; handle: boolean } | null = null;
  private active = false;
  private landing = false;
  private disposed = false;
  private pt: Pt = { x: 0, y: 0 };
  private order: number[] = [];
  private startKeys = '';
  private ghost: RowGhost | null = null;
  private edgeV = 0;
  private edgeRaf = 0;
  private unwatch: (() => void) | null = null;
  private bodyStyle: { cursor: string; userSelect: string } | null = null;

  constructor(hooks: SortHooks) {
    this.hooks = hooks;
  }

  /** 끌어서 순서를 바꾸는 중이거나 착지 중인가 */
  get busy() {
    return this.active || this.landing;
  }

  /**
   * 항목에서 포인터를 눌렀다. 마우스·펜은 항목 어디서든, 터치는 handle(손잡이)에서만 시작한다.
   * 문턱(5px) 전에 놓으면 아무 일도 하지 않으므로 클릭이 그대로 처리된다.
   */
  start(e: PointerEvent, key: number, handle = false) {
    if (this.press || this.landing || this.disposed) return;
    if (e.pointerType === 'touch' ? !handle : e.button !== 0) return;
    this.press = { x: e.clientX, y: e.clientY, id: e.pointerId, key, handle };
    this.pt = { x: e.clientX, y: e.clientY };
    this.startKeys = this.hooks.keys().join(',');
    holdGesture(this);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onCancel);
    window.addEventListener('keydown', this.onKey, true);
    this.unwatch = watchPointerLoss(this.onCancel);
  }

  private detach() {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onCancel);
    window.removeEventListener('keydown', this.onKey, true);
    this.unwatch?.();
    this.unwatch = null;
  }

  private onMove = (e: PointerEvent) => {
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    if (buttonsLost(e)) {
      this.end('cancel');
      return;
    }
    this.pt = { x: e.clientX, y: e.clientY };
    if (!this.active) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < THRESHOLD) return;
      if (!this.begin()) {
        this.end('abort');
        return;
      }
    }
    e.preventDefault();
    this.update();
  };

  private begin(): boolean {
    const p = this.press;
    const el = p ? this.hooks.itemEl(p.key) : null;
    if (!p || !el) return false;
    const keys = this.hooks.keys();
    if (!keys.includes(p.key) || keys.length < 2) return false;
    this.order = keys;
    this.active = true;
    const r = el.getBoundingClientRect();
    this.ghost = new RowGhost(el, r, this.pt);
    this.hooks.slot(p.key);
    this.bodyStyle = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    this.hooks.announce?.(`${this.hooks.nameOf?.(p.key) ?? '항목'}을 끌고 있습니다. Esc 로 취소합니다`);
    this.edgeLoop();
    return true;
  }

  /** 포인터 위치를 목록 안 좌표(스크롤 포함)로 */
  private along(): number {
    const sc = this.hooks.scroller();
    if (!sc) return 0;
    const r = sc.getBoundingClientRect();
    return this.hooks.axis === 'x' ? this.pt.x - r.left - sc.clientLeft + sc.scrollLeft : this.pt.y - r.top - sc.clientTop + sc.scrollTop;
  }

  /** 다른 항목들 가운데 포인터보다 앞에 있는 수 = 놓을 자리. 미끄러지는 화면 위치가 아니라 레이아웃상의 자리(offset)로 판정한다 */
  private insertion(): number {
    const p = this.press!;
    const pos = this.along();
    const others = this.order.filter((k) => k !== p.key);
    for (let i = 0; i < others.length; i++) {
      const el = this.hooks.itemEl(others[i]);
      if (!el) continue;
      const c = this.hooks.axis === 'x' ? el.offsetLeft + el.offsetWidth / 2 : el.offsetTop + el.offsetHeight / 2;
      if (pos < c) return i;
    }
    return others.length;
  }

  private update() {
    const p = this.press;
    if (!p || !this.active) return;
    // 끄는 사이 목록이 바뀌었으면(닫기·열기·되돌리기) 옮기지 않고 버린다
    if (this.hooks.keys().join(',') !== this.startKeys) {
      this.end('abort');
      return;
    }
    this.ghost?.move(this.pt);
    const at = this.insertion();
    if (at !== this.order.indexOf(p.key)) {
      const o = this.order.filter((k) => k !== p.key);
      o.splice(at, 0, p.key);
      this.order = o;
      this.hooks.preview(o);
    }
    // 가장자리 자동 스크롤
    const sc = this.hooks.scroller();
    this.edgeV = 0;
    if (sc) {
      const r = sc.getBoundingClientRect();
      const v = this.hooks.axis === 'x' ? this.pt.x : this.pt.y;
      const lo = this.hooks.axis === 'x' ? r.left : r.top;
      const hi = this.hooks.axis === 'x' ? r.right : r.bottom;
      if (v < lo + EDGE) this.edgeV = -Math.min(1, (lo + EDGE - v) / EDGE);
      else if (v > hi - EDGE) this.edgeV = Math.min(1, (v - (hi - EDGE)) / EDGE);
    }
  }

  private edgeLoop() {
    if (this.edgeRaf) return;
    const tick = () => {
      this.edgeRaf = 0;
      if (!this.active) return;
      const sc = this.hooks.scroller();
      if (this.edgeV && sc) {
        const d = this.edgeV * EDGE_STEP;
        if (this.hooks.axis === 'x') sc.scrollLeft += d;
        else sc.scrollTop += d;
        this.update();
      }
      this.edgeRaf = requestAnimationFrame(tick);
    };
    this.edgeRaf = requestAnimationFrame(tick);
  }

  private onUp = (e: PointerEvent) => {
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    this.end(this.active ? 'drop' : 'abort', true);
  };
  private onCancel = () => {
    if (this.press) this.end('cancel');
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.active) {
      e.stopPropagation();
      e.preventDefault();
      this.end('cancel');
    }
  };

  /** 끌기 직후의 click(활성화·닫기)이 일어나지 않게 한다 */
  private swallowClick() {
    const stop = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, true), 60);
  }

  private end(mode: End, up = false) {
    const p = this.press;
    this.detach();
    if (this.edgeRaf) cancelAnimationFrame(this.edgeRaf);
    this.edgeRaf = 0;
    this.edgeV = 0;
    this.press = null;
    releaseGesture(this);
    if (!this.active || !p) return;
    this.active = false;
    if (this.bodyStyle) {
      document.body.style.cursor = this.bodyStyle.cursor;
      document.body.style.userSelect = this.bodyStyle.userSelect;
      this.bodyStyle = null;
    }
    if (up) this.swallowClick();
    const ghost = this.ghost;
    this.ghost = null;
    if (mode === 'abort') {
      ghost?.destroy();
      this.hooks.preview(null);
      this.hooks.slot(null);
      return;
    }
    let to = this.order.indexOf(p.key);
    if (mode === 'cancel') {
      to = -1;
      this.hooks.preview(null);
    } else {
      this.hooks.commit(p.key, to);
    }
    this.landing = true;
    void this.settle(ghost, p.key, mode === 'drop' ? to : -1);
  }

  /** 고스트가 들어갈 자리로 내려앉은 뒤 슬롯을 거둔다 */
  private async settle(ghost: RowGhost | null, key: number, committed: number) {
    // 컴포넌트가 새 순서를 그린 뒤의 레이아웃 자리를 잰다
    await Promise.resolve();
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const el = this.hooks.itemEl(key);
    const sc = this.hooks.scroller();
    let to: Pt | null = null;
    if (el && sc && !this.disposed) {
      const r = sc.getBoundingClientRect();
      to = { x: r.left + sc.clientLeft - sc.scrollLeft + el.offsetLeft, y: r.top + sc.clientTop - sc.scrollTop + el.offsetTop };
    }
    await ghost?.land(to);
    this.landing = false;
    if (this.disposed) return;
    this.hooks.preview(null);
    this.hooks.slot(null);
    if (committed >= 0) {
      const name = this.hooks.nameOf?.(key);
      const keys = this.hooks.keys();
      if (name) this.hooks.announce?.(posMsg(name, keys.indexOf(key), keys.length));
    } else this.hooks.announce?.('이동을 취소했습니다');
  }

  /** 컴포넌트가 사라진다 */
  dispose() {
    this.disposed = true;
    this.detach();
    if (this.edgeRaf) cancelAnimationFrame(this.edgeRaf);
    this.edgeRaf = 0;
    this.ghost?.destroy();
    this.ghost = null;
    if (this.bodyStyle) {
      document.body.style.cursor = this.bodyStyle.cursor;
      document.body.style.userSelect = this.bodyStyle.userSelect;
      this.bodyStyle = null;
    }
    this.press = null;
    this.active = false;
    releaseGesture(this);
  }
}
