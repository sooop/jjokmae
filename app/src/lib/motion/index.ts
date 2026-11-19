// 앱 전체가 쓰는 모션 모듈: 모션 줄이기 판정, WAAPI 보조, Svelte 전환(팝오버·서랍·대화상자·탭), 액션.
// 스프링 수학은 spring.ts, 쪽 이동 연출은 page-flip.ts, 드래그 고스트는 drag-ghost.ts.
import type { Action } from 'svelte/action';
import { cubicIn, cubicOut, DUR, EASE, solveSpring, SPRING, type SpringName, type SpringSpec } from './spring';

export { DUR, EASE, SPRING, solveSpring, type SpringName, type SpringSpec };

const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
/** 이동·크기 모션을 쓰지 않는 환경인가(짧은 페이드만 남긴다) */
export const reduced = (): boolean => !!mq?.matches;

export const springOf = (s: SpringName | SpringSpec) => solveSpring(typeof s === 'string' ? SPRING[s] : s);

export interface AnimOpts {
  spring?: SpringName | SpringSpec;
  /** spring 이 없을 때 */
  easing?: string;
  duration?: number;
  delay?: number;
  fill?: FillMode;
}

/**
 * WAAPI 래퍼. 모션 줄이기에서는 transform 키프레임을 버리고 opacity 만 짧게 남긴다(없으면 아무것도 하지 않는다).
 * 끝난 애니메이션은 호출자가 cancel 할 수 있도록 그대로 돌려준다.
 */
export function animate(el: Element, frames: Keyframe[], o: AnimOpts = {}): Animation | null {
  if (!el.animate) return null;
  if (reduced()) {
    const op = frames.filter((f) => f.opacity != null).map((f) => ({ opacity: f.opacity }));
    if (op.length < 2) return null;
    return el.animate(op, { duration: 120, easing: 'linear', fill: o.fill ?? 'both', delay: Math.min(o.delay ?? 0, 60) });
  }
  const sp = o.spring ? springOf(o.spring) : null;
  return el.animate(frames, {
    duration: o.duration ?? sp?.duration ?? DUR.base,
    easing: sp ? sp.css : (o.easing ?? EASE.out),
    delay: o.delay ?? 0,
    fill: o.fill ?? 'both',
  });
}

// ---------- Svelte 전환 ----------
// 주의: 팝오버·서랍은 부모의 {#if} 가 켜고 끄므로 transition:fn|global 로 쓴다.

interface PopOpts {
  /** transform-origin: 앵커에 가까운 모서리 */
  origin?: string;
  /** 시작 크기 */
  from?: number;
  /** 시작할 때 앵커 쪽으로 치우친 거리(px) */
  y?: number;
}

/** 앵커 지점을 원점으로 자라나는 스프링(들어올 때) */
export function popIn(_n: Element, { origin = 'top left', from = 0.9, y = -6 }: PopOpts = {}) {
  if (reduced()) return { duration: 120, css: (t: number) => `opacity:${t}` };
  const sp = solveSpring(SPRING.pop);
  return {
    duration: sp.duration,
    easing: sp.fn,
    css: (t: number) => `transform-origin:${origin};opacity:${Math.min(1, t * 2.4)};transform:translateY(${(1 - t) * y}px) scale(${from + (1 - from) * t})`,
  };
}

/** 닫힐 때는 더 빠르게 접힌다 */
export function popOut(_n: Element, { origin = 'top left', from = 0.96, y = -3 }: PopOpts = {}) {
  if (reduced()) return { duration: 90, css: (t: number) => `opacity:${t}` };
  return {
    duration: 120,
    easing: cubicIn,
    css: (t: number) => `transform-origin:${origin};opacity:${t};transform:translateY(${(1 - t) * y}px) scale(${from + (1 - from) * t})`,
  };
}

/** 서랍: 오른쪽에서 묵직하게 미끄러져 들어온다 */
export function drawerIn(_n: Element, { dist = 340 }: { dist?: number } = {}) {
  if (reduced()) return { duration: 140, css: (t: number) => `opacity:${t}` };
  const sp = solveSpring(SPRING.heavy);
  return { duration: sp.duration, easing: sp.fn, css: (t: number) => `transform:translateX(${(1 - t) * dist}px)` };
}
export function drawerOut(_n: Element, { dist = 340 }: { dist?: number } = {}) {
  if (reduced()) return { duration: 100, css: (t: number) => `opacity:${t}` };
  return { duration: 170, easing: cubicIn, css: (t: number) => `transform:translateX(${(1 - t) * dist}px)` };
}

/** 서랍 뒤 배경 딤 */
export function scrimFade(_n: Element, { out = false }: { out?: boolean } = {}) {
  return { duration: out ? 140 : 240, css: (t: number) => `opacity:${t}` };
}

/** 모달 본체: 배율 0.95 에서 스프링으로 자란다(≈400ms). 닫힘은 130ms, 배율 0.97 까지만 */
export function modalIn(_n: Element) {
  if (reduced()) return { duration: 120, css: (t: number) => `opacity:${t}` };
  const sp = solveSpring(SPRING.pop);
  return { duration: sp.duration, easing: sp.fn, css: (t: number) => `opacity:${Math.min(1, Math.max(0, t) * 2.4)};transform:scale(${0.95 + 0.05 * t})` };
}
export function modalOut(_n: Element) {
  if (reduced()) return { duration: 90, css: (t: number) => `opacity:${t}` };
  return { duration: 130, easing: cubicIn, css: (t: number) => `opacity:${t};transform:scale(${0.97 + 0.03 * t})` };
}
/** 모달 배경(딤): 본체보다 110ms 늦게 400ms 동안 어두워지고, 닫힘은 140ms. 본체가 먼저 움직여 시선을 붙든다 */
export function backdropIn(_n: Element) {
  if (reduced()) return { duration: 120, css: (t: number) => `opacity:${t}` };
  return { delay: 110, duration: 400, easing: (t: number) => 1 - Math.pow(1 - t, 3), css: (t: number) => `opacity:${t}` };
}
export function backdropOut(_n: Element) {
  return { duration: reduced() ? 90 : 140, css: (t: number) => `opacity:${t}` };
}

/** 안내 카드: 앵커 쪽에서 살짝 떠오르며 등장, 퇴장은 빠르게 */
export function noticeIn(_n: Element, { y = -8 }: { y?: number } = {}) {
  if (reduced()) return { duration: 120, css: (t: number) => `opacity:${t}` };
  const sp = solveSpring(SPRING.bouncy);
  return { duration: sp.duration, easing: sp.fn, css: (t: number) => `opacity:${Math.min(1, t * 3)};transform:translateY(${(1 - t) * y}px) scale(${0.94 + 0.06 * t})` };
}
export function noticeOut(_n: Element, { y = -4 }: { y?: number } = {}) {
  if (reduced()) return { duration: 90, css: (t: number) => `opacity:${t}` };
  return { duration: 130, easing: cubicIn, css: (t: number) => `opacity:${t};transform:translateY(${(1 - t) * y}px) scale(${0.97 + 0.03 * t})` };
}

/** 탭·파일 항목이 폭을 키우며 들어온다 / 줄어들며 사라진다(수평 스트립이라 폭만 건드린다) */
export function growIn(node: Element, { w = 240, minW = 0 }: { w?: number; minW?: number } = {}) {
  if (reduced()) return { duration: 120, css: (t: number) => `opacity:${t}` };
  const sp = solveSpring(SPRING.glide);
  void node;
  return {
    duration: sp.duration,
    easing: sp.fn,
    css: (t: number) => `overflow:hidden;opacity:${Math.min(1, Math.max(0, t * 2))};max-width:${Math.max(0, t) * w}px;min-width:${Math.max(0, t) * minW}px;transform:scale(${0.88 + 0.12 * Math.min(1, t)})`,
  };
}
export function shrinkOut(_n: Element, { w = 240, minW = 0 }: { w?: number; minW?: number } = {}) {
  if (reduced()) return { duration: 90, css: (t: number) => `opacity:${t}` };
  return { duration: 200, easing: EASE_IN_OUT_FN, css: (t: number) => `overflow:hidden;opacity:${t};max-width:${t * w}px;min-width:${t * minW}px;transform:scale(${0.88 + 0.12 * t})` };
}
const EASE_IN_OUT_FN = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** 세로 목록 항목(파일 목록·병합 목록)이 높이를 키우며 들어온다 */
export function slideDownIn(_n: Element, { h = 52 }: { h?: number } = {}) {
  if (reduced()) return { duration: 120, css: (t: number) => `opacity:${t}` };
  const sp = solveSpring(SPRING.glide);
  return { duration: sp.duration, easing: sp.fn, css: (t: number) => `overflow:hidden;opacity:${Math.min(1, t * 2)};max-height:${Math.max(0, t) * h}px;transform:scale(${0.94 + 0.06 * Math.min(1, t)})` };
}
export function slideUpOut(_n: Element, { h = 52 }: { h?: number } = {}) {
  if (reduced()) return { duration: 90, css: (t: number) => `opacity:${t}` };
  return { duration: 200, easing: EASE_IN_OUT_FN, css: (t: number) => `overflow:hidden;opacity:${t};max-height:${t * h}px;transform:scale(${0.94 + 0.06 * t})` };
}

/** 접기·펼치기(slide): 펼침 220ms ease-out, 접힘 200ms ease-in-out. 높이·투명도만 움직인다 */
export function collapseIn(node: Element) {
  if (reduced()) return { duration: 120, css: (t: number) => `opacity:${t}` };
  const h = (node as HTMLElement).offsetHeight;
  return { duration: 220, easing: (t: number) => 1 - Math.pow(1 - t, 3), css: (t: number) => `overflow:hidden;height:${t * h}px;opacity:${t}` };
}
export function collapseOut(node: Element) {
  if (reduced()) return { duration: 90, css: (t: number) => `opacity:${t}` };
  const h = (node as HTMLElement).offsetHeight;
  return { duration: 200, easing: EASE_IN_OUT_FN, css: (t: number) => `overflow:hidden;height:${t * h}px;opacity:${t}` };
}

// ---------- 액션 ----------

/** range 입력의 채움선 위치(--p)를 값에 맞춰 둔다. 값이 바뀔 때마다 param 으로 알린다 */
export const rangeFill: Action<HTMLInputElement, unknown> = (node) => {
  const set = () => {
    const min = Number(node.min || 0);
    const max = Number(node.max || 100);
    const v = Number(node.value);
    node.style.setProperty('--p', `${max > min ? ((v - min) / (max - min)) * 100 : 0}%`);
  };
  set();
  node.addEventListener('input', set);
  return {
    update: set,
    destroy: () => node.removeEventListener('input', set),
  };
};

/** 요소를 한 번 튕긴다(대상이 받는 반응). 같은 요소에 겹쳐 불려도 이전 것을 이어받는다 */
const pulsing = new WeakMap<Element, Animation>();
export function pulse(el: Element | null | undefined, strength = 1) {
  if (!el) return;
  pulsing.get(el)?.cancel();
  const s = 1 + 0.05 * strength;
  const a = animate(el, [{ transform: 'scale(1)' }, { transform: `scale(${s})`, offset: 0.35 }, { transform: 'scale(1)' }], { spring: 'bouncy', fill: 'none' });
  if (a) pulsing.set(el, a);
  el.setAttribute('data-pulse', '');
  setTimeout(() => el.removeAttribute('data-pulse'), 620);
}

// ---------- 보기 ↔ 정리 화면 전환 ----------
// 나가는 요소는 자리를 비워 들어오는 화면이 바로 제자리를 잡게 한다(레이아웃이 밀리지 않게 절대 위치로 띄운다).
function leaveInPlace(n: Element) {
  const el = n as HTMLElement;
  const par = el.offsetParent as HTMLElement | null;
  if (!par) return;
  const r = el.getBoundingClientRect();
  const p = par.getBoundingClientRect();
  el.style.position = 'absolute';
  el.style.left = `${r.left - p.left + par.scrollLeft}px`;
  el.style.top = `${r.top - p.top + par.scrollTop}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
  el.style.margin = '0';
  el.style.pointerEvents = 'none';
  // 나가는 중에 다시 켜지면 Svelte 는 같은 요소를 되살린다: 그대로 두면 띄운 자리와 크기가 남으므로, 끝날 시간이 지나도 붙어 있으면 되돌린다
  setTimeout(() => {
    if (!el.isConnected) return;
    for (const k of ['position', 'left', 'top', 'width', 'height', 'margin', 'pointer-events']) el.style.removeProperty(k);
  }, 400);
}
/** 옆 패널이 들어온다: 들어오는 쪽에서 40px 미끄러지며 나타난다(220ms) */
export function panelIn(_n: Element, { dx = -40 }: { dx?: number } = {}) {
  if (reduced()) return { duration: 120, css: (t: number) => `opacity:${t}` };
  return { duration: DUR.base, easing: cubicOut, css: (t: number) => `opacity:${t};transform:translateX(${(1 - t) * dx}px)` };
}
/** 옆 패널이 나간다: 나가는 쪽으로 40px 미끄러지며 사라진다(170ms) */
export function panelOut(n: Element, { dx = -40 }: { dx?: number } = {}) {
  leaveInPlace(n);
  if (reduced()) return { duration: 90, css: (t: number) => `opacity:${t}` };
  return { duration: 170, easing: cubicIn, css: (t: number) => `opacity:${t};transform:translateX(${(1 - t) * dx}px)` };
}
/** 화면 본체가 나간다: 이동 없이 빠르게 흐려진다(120ms) */
export function softOut(n: Element) {
  leaveInPlace(n);
  return { duration: 120, easing: cubicIn, css: (t: number) => `opacity:${t}` };
}
