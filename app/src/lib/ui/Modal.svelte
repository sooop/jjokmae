<script lang="ts">
  // 공용 모달 틀: 배경 딤 + 가운데 창. 포커스 가두기(Tab), Esc, 배경 inert, 닫힐 때 포커스 복귀, 바깥 클릭(누름·뗌 모두 배경일 때만)을 맡는다.
  // 열림/닫힘은 부모가 open 으로 정한다. 닫는 길(Esc·배경 클릭)은 onclose 로 알릴 뿐 스스로 닫지 않는다.
  import { tick, untrack, type Snippet } from 'svelte';
  import { backdropIn, backdropOut, modalIn, modalOut } from '../motion';

  let {
    open,
    labelledby,
    onclose,
    backdropClose = true,
    fallbackFocus,
    children,
  }: {
    open: boolean;
    /** 제목 요소의 id */
    labelledby: string;
    onclose: () => void;
    /** false 면 배경을 눌러도 닫지 않는다(입력한 내용이 있을 때) */
    backdropClose?: boolean;
    /** 연 요소가 사라졌을 때 포커스를 받을 선택자 */
    fallbackFocus?: string;
    children: Snippet;
  } = $props();

  let layer: HTMLDivElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();
  let opener: HTMLElement | null = null;

  // 열리기 직전(DOM 이 바뀌기 전)의 포커스를 기억한다
  $effect.pre(() => {
    if (open) opener = untrack(() => document.activeElement as HTMLElement | null);
  });

  const FOCUSABLE = 'button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';
  const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.getClientRects().length > 0);

  $effect(() => {
    if (!open || !layer || !panel) return;
    const lay = layer;
    const pan = panel;
    // 창 뒤의 화면을 막는다(조상에는 걸지 않고 각 단계의 형제에만)
    const inerted: HTMLElement[] = [];
    let cur: HTMLElement = lay;
    while (cur.parentElement && cur !== document.body) {
      for (const sib of Array.from(cur.parentElement.children)) {
        if (sib === cur || !(sib instanceof HTMLElement) || sib.inert || sib.matches('[data-modal-safe]')) continue;
        sib.inert = true;
        inerted.push(sib);
      }
      cur = cur.parentElement;
    }
    // 열리면 창 안의 첫 입력(없으면 첫 단추)으로. 자식이 이미 포커스를 잡았으면 그대로 둔다
    void tick().then(() => {
      if (!pan.contains(document.activeElement)) (focusables()[0] ?? pan).focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        e.stopPropagation();
        onclose();
      } else if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) {
          e.preventDefault();
          pan.focus();
          return;
        }
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (i < 0 || (!e.shiftKey && i === f.length - 1) || (e.shiftKey && i === 0)) {
          e.preventDefault();
          f[e.shiftKey ? f.length - 1 : 0].focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      for (const el of inerted) el.inert = false;
      // 닫히는 동안 사용자가 다른 곳으로 옮겼다면 건드리지 않는다
      const a = document.activeElement;
      if (a && a !== document.body && !lay.contains(a)) return;
      const ok = (el: HTMLElement | null | undefined): el is HTMLElement => !!el && el.isConnected && el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled;
      const target = ok(opener) ? opener : fallbackFocus ? document.querySelector<HTMLElement>(fallbackFocus) : null;
      if (ok(target)) target.focus({ preventScroll: true });
    };
  });

  let downOnBackdrop = false;
</script>

{#if open}
  <div class="layer" bind:this={layer}>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="backdrop"
      aria-hidden="true"
      in:backdropIn|global
      out:backdropOut|global
      onpointerdown={() => (downOnBackdrop = true)}
      onclick={() => {
        const ok = downOnBackdrop;
        downOnBackdrop = false;
        if (ok && backdropClose) onclose();
      }}
    ></div>
    <div class="panel" role="dialog" aria-modal="true" aria-labelledby={labelledby} tabindex="-1" bind:this={panel} in:modalIn|global out:modalOut|global>
      {@render children()}
    </div>
  </div>
{/if}

<style>
  .layer { position: fixed; inset: 0; z-index: var(--z-modal); display: grid; place-items: center; padding: 16px; }
  .backdrop { position: absolute; inset: 0; background: var(--scrim); }
  .panel {
    position: relative;
    width: 400px;
    max-width: 100%;
    display: grid;
    gap: 14px;
    padding: 18px;
    background: var(--surface);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-3), var(--edge);
    outline: none;
  }
</style>
