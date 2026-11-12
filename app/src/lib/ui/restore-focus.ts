// 팝오버·서랍·확인창·메뉴가 닫힐 때 열기 전에 있던 곳으로 포커스를 돌려주는 액션.
// 열릴 때의 document.activeElement 를 기억한다(사용자가 트리거를 눌러 연 경우 그 트리거).
// 닫힐 때 포커스가 body 로 사라졌거나 닫히는 요소 안에 있을 때만 돌려준다 — 사용자가 이미 다른 곳을 눌러 옮겼다면 건드리지 않는다.
// 기억해 둔 요소가 없어졌거나 쓸 수 없으면 fallback(선택자 또는 함수)이 가리키는 대상으로 간다.

export interface RestoreFocusOpts {
  /** 트리거가 사라졌을 때 대신 받을 대상 */
  fallback?: string | string[] | (() => HTMLElement | null | undefined);
}

function usable(el: Element | null | undefined): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement) || !el.isConnected) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  return el.getClientRects().length > 0;
}

function tryFocus(el: HTMLElement | null | undefined): boolean {
  if (!usable(el)) return false;
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}

export function restoreFocus(node: HTMLElement, opts: RestoreFocusOpts = {}) {
  let prev = document.activeElement as HTMLElement | null;
  // 이미 이 요소 안에 포커스가 들어와 있으면(열리자마자 첫 칸에 포커스) 트리거를 알 수 없다
  if (prev && (prev === document.body || node.contains(prev))) prev = null;
  let o = opts;
  return {
    update(next: RestoreFocusOpts = {}) {
      o = next;
    },
    destroy() {
      const cur = document.activeElement;
      // 닫히는 동안 사용자가 다른 입력 요소로 옮겼다면 그대로 둔다
      if (cur && cur !== document.body && !node.contains(cur)) return;
      if (tryFocus(prev)) return;
      // 대체 대상은 같은 갱신에서 새로 생기거나 선택 표시가 바뀌는 요소일 수 있어(탭을 닫은 뒤 새 활성 탭) 한 박자 뒤에 찾는다
      const go = () => {
        const a = document.activeElement;
        if (a && a !== document.body && !node.contains(a)) return; // 그 사이 다른 곳이 포커스를 받았다
        const f = o.fallback;
        if (typeof f === 'function') tryFocus(f());
        else for (const sel of typeof f === 'string' ? [f] : (f ?? [])) if (tryFocus(document.querySelector<HTMLElement>(sel))) return;
      };
      queueMicrotask(go);
      requestAnimationFrame(go);
    },
  };
}
