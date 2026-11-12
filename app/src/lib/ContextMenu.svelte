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
  import { onMount, tick } from 'svelte';
  import Icon from './ui/Icon.svelte';

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
  let pos = $state({ left: -9999, top: -9999 });
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
    root?.querySelectorAll<HTMLElement>('[role=menuitem]')[active]?.focus();
  }

  $effect(() => {
    void rows;
    active = firstEnabled(0);
    void place();
    void focusActive();
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
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('resize', gone);
    return () => {
      window.removeEventListener('pointerdown', down, true);
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
>
  {#each rows as r, i (r.id)}
    <button
      type="button"
      role="menuitem"
      class="item"
      class:back={r.id === '__back'}
      disabled={r.disabled}
      aria-haspopup={r.sub ? 'menu' : undefined}
      tabindex={i === active ? 0 : -1}
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
    border-radius: var(--radius);
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
    outline: none;
  }
  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 32px;
    padding: 4px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    text-align: left;
  }
  @media (pointer: coarse) {
    .item { min-height: 40px; }
  }
  .item:focus-visible { outline: 2px solid var(--fg); outline-offset: -2px; background: var(--hover); }
  .item:hover:not(:disabled) { background: var(--hover); }
  .back { color: var(--fg-muted); font-weight: 600; }
  .lb { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
