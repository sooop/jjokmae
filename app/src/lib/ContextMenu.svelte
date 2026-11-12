<script lang="ts" module>
  export interface MenuItem {
    id: string;
    label: string;
    disabled?: boolean;
    /** 마우스를 올리면 보이는 설명(꺼진 항목이면 왜 꺼졌는지) */
    title?: string;
    /** 하위 항목이 있으면 눌렀을 때 이 메뉴 안에서 하위 목록으로 들어간다 */
    sub?: MenuItem[];
  }
</script>

<script lang="ts">
  // 앵커 팝오버 메뉴. 화면 가장자리에 맞춰 위치를 보정하고, Esc·바깥 누르기로 닫고, 방향키로 이동한다.
  // 하위 목록은 같은 자리에서 목록을 갈아 끼우는 방식(맨 위 '뒤로' 항목, ← / Backspace)이라 터치·키보드에서도 같다.
  import { onMount, tick, untrack } from 'svelte';
  import { popIn, popOut } from './motion';
  import Icon from './ui/Icon.svelte';
  import { restoreFocus } from './ui/restore-focus';

  let {
    x,
    y,
    items,
    label,
    onpick,
    onclose,
  }: {
    x: number;
    y: number;
    items: MenuItem[];
    label: string;
    onpick: (path: string[]) => void;
    onclose: () => void;
  } = $props();

  /** 들어와 있는 하위 목록 경로(항목 id) */
  let path = $state<string[]>([]);
  let root: HTMLDivElement | undefined = $state();
  let pos = $state(untrack(() => ({ left: x, top: y })));
  /** 움직이는 강조 띠: 활성 항목 자리로 스프링으로 미끄러진다 */
  let hl = $state<{ y: number; h: number } | null>(null);
  let active = $state(0);

  const levels = $derived.by(() => {
    const out: { title: string; items: MenuItem[] }[] = [{ title: label, items }];
    for (const id of path) {
      const cur = out[out.length - 1].items.find((i) => i.id === id);
      if (!cur?.sub) break;
      out.push({ title: cur.label.replace(/\s*→$/, ''), items: cur.sub });
    }
    return out;
  });
  const level = $derived(levels[levels.length - 1]);
  const rows = $derived<MenuItem[]>(path.length ? [{ id: '__back', label: `‹ ${level.title}` }, ...level.items] : level.items);

  function enabled(i: number) {
    return !rows[i]?.disabled;
  }
  function firstEnabled(from = 0, dir = 1) {
    const n = rows.length;
    for (let k = 0; k < n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (enabled(i)) return i;
    }
    return 0;
  }

  async function place() {
    await tick();
    if (!root) return;
    const w = root.offsetWidth;
    const h = root.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(x, vw - w - 8));
    const top = y + h > vh - 8 ? Math.max(8, y - h) : y;
    pos = { left, top: Math.min(top, Math.max(8, vh - h - 8)) };
  }

  async function focusActive() {
    await tick();
    const el = root?.querySelectorAll<HTMLElement>('[role=menuitem]')[active];
    // 포커스는 항상 메뉴 안으로: 항목이 아직 없으면 메뉴 자신이 받아 Esc 가 닫게 한다
    (el ?? root)?.focus({ preventScroll: true });
  }

  async function moveHl() {
    await tick();
    const el = root?.querySelectorAll<HTMLElement>('[role=menuitem]')[active];
    hl = el && !rows[active]?.disabled ? { y: el.offsetTop, h: el.offsetHeight } : null;
  }

  $effect(() => {
    void rows;
    active = firstEnabled(0);
    void place();
    void focusActive();
  });
  $effect(() => {
    void active;
    void rows;
    void moveHl();
  });

  function choose(i: number) {
    const r = rows[i];
    if (!r || r.disabled) return;
    if (r.id === '__back') {
      path = path.slice(0, -1);
      return;
    }
    if (r.sub) {
      path = [...path, r.id];
      return;
    }
    onpick([...path, r.id]);
  }

  function onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const n = rows.length;
    let handled = true;
    if (e.key === 'ArrowDown') active = firstEnabled(active + 1, 1);
    else if (e.key === 'ArrowUp') active = firstEnabled(active - 1, -1);
    else if (e.key === 'Home') active = firstEnabled(0, 1);
    else if (e.key === 'End') active = firstEnabled(n - 1, -1);
    else if (e.key === 'ArrowRight' && rows[active]?.sub) choose(active);
    else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && path.length) path = path.slice(0, -1);
    else if (e.key === 'Escape') {
      e.stopPropagation();
      onclose();
    } else if (e.key === 'Tab') onclose();
    else handled = false;
    if (handled) {
      e.preventDefault();
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') void focusActive();
    }
  }

  onMount(() => {
    const down = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) onclose();
    };
    const gone = () => onclose();
    // 터치 길게 누르기로 열면 손을 뗄 때 포커스가 원래 칸으로 돌아갈 수 있다. 메뉴가 열려 있는 동안은 Esc 를 항상 메뉴가 받는다
    const winKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onclose();
        return;
      }
      if (root && !root.contains(document.activeElement) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) void focusActive();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', winKey, true);
    window.addEventListener('resize', gone);
    void focusActive();
    const t = window.setTimeout(() => {
      if (root && !root.contains(document.activeElement)) void focusActive();
    }, 350);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', winKey, true);
      window.removeEventListener('resize', gone);
    };
  });
</script>

<div
  class="menu"
  bind:this={root}
  role="menu"
  tabindex="-1"
  aria-label={level.title}
  style:left="{pos.left}px"
  style:top="{pos.top}px"
  onkeydown={onKey}
  oncontextmenu={(e) => e.preventDefault()}
  data-testid="context-menu"
  use:restoreFocus={{ fallback: ['[data-testid=grid]', '[data-testid=file][aria-selected=true]'] }}
  in:popIn|global={{ origin: 'top left', from: 0.88, y: -4 }}
  out:popOut|global={{ origin: 'top left' }}
>
  {#if hl}<span class="hl" style:transform="translateY({hl.y}px)" style:height="{hl.h}px" aria-hidden="true"></span>{/if}
  {#each rows as r, i (r.id)}
    <button
      type="button"
      role="menuitem"
      class="item"
      class:back={r.id === '__back'}
      disabled={r.disabled}
      aria-haspopup={r.sub ? 'menu' : undefined}
      tabindex={i === active ? 0 : -1}
      style:--i={i}
      title={r.title}
      data-menu-id={r.id}
      onclick={() => choose(i)}
      onpointermove={() => { if (!r.disabled && active !== i) active = i; }}
    >
      <span class="lb">{r.label}</span>
      {#if r.sub}<Icon name="chevron-right" size={14} />{/if}
    </button>
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 60;
    min-width: 200px;
    max-width: min(320px, calc(100vw - 16px));
    max-height: calc(100vh - 16px);
    overflow-y: auto;
    display: grid;
    gap: 1px;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-3), var(--edge);
    outline: none;
  }
  .hl {
    position: absolute;
    left: 4px;
    right: 4px;
    top: 0;
    border-radius: var(--r-sm);
    background: var(--hover);
    pointer-events: none;
    transition: transform var(--spring-pop-dur) var(--spring-pop), height var(--dur-fast) var(--ease-out);
    animation: kf-fade var(--dur-fast) var(--ease-out);
  }
  .item {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 32px;
    padding: 4px 10px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    box-shadow: none;
    text-align: left;
    animation: var(--kf-rise) var(--dur-slow) var(--ease-out) backwards;
    animation-delay: calc(min(var(--i, 0), 9) * 20ms + 30ms);
  }
  .item:active:not(:disabled) { transform: scale(0.98); background: transparent; }
  @media (pointer: coarse) {
    .item { min-height: 40px; }
  }
  .item:focus-visible { outline: 2px solid var(--fg); outline-offset: -2px; }
  .item:hover:not(:disabled) { background: transparent; border-color: transparent; }
  .back { color: var(--fg-muted); font-weight: 600; }
  .lb { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
