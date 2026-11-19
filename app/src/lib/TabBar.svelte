<script lang="ts">
  // 열린 파일 탭 막대. 탭마다 파일명(말줄임), 변경됨 점, 닫기 버튼. 넘치면 가로로 스크롤하고 활성 탭이 보이게 맞춘다.
  // 쪽을 끌어 올 때(dragging)는 활성이 아닌 탭이 놓을 수 있는 대상으로 강조된다.
  import { onMount, tick } from 'svelte';
  import { flip } from 'svelte/animate';
  import { growIn, reduced, shrinkOut, solveSpring, SPRING } from './motion';
  import { keyShift, posMsg, SortDrag } from './motion/sort-drag';
  import type { TabNotice } from './status';
  import CloseConfirm from './CloseConfirm.svelte';
  import Icon from './ui/Icon.svelte';
  import Notice from './ui/Notice.svelte';
  import RenameInput from './ui/RenameInput.svelte';

  let {
    tabs,
    activeKey,
    dragging = false,
    dragOver = null,
    notice,
    confirm,
    onactivate,
    onclose,
    onmove,
    onrename,
    onclosenotice,
    onconfirm,
  }: {
    tabs: { key: number; name: string; dirty: boolean }[];
    activeKey: number | null;
    /** 썸네일을 끌고 있는가 */
    dragging?: boolean;
    /** 끌고 있는 쪽이 올라와 있는 탭 */
    dragOver?: number | null;
    notice: TabNotice | null;
    /** 닫기 확인을 기다리는 탭 */
    confirm: { key: number; busy: boolean } | null;
    onactivate: (key: number) => void;
    onclose: (key: number) => void;
    /** 탭을 끌거나 Alt+←/→ 로 toIndex 자리로 옮긴다 */
    onmove: (key: number, toIndex: number) => void;
    /** 이름 변경을 확정했다(입력은 아직 정리 전) */
    onrename: (key: number, name: string) => void;
    onclosenotice: () => void;
    onconfirm: (choice: 'save' | 'discard' | 'cancel') => void;
  } = $props();

  let bar: HTMLDivElement | undefined = $state();
  let strip: HTMLDivElement | undefined = $state();
  let anchorLeft = $state(0);
  /** 활성 탭 표시: 탭 사이를 스프링으로 미끄러진다 */
  let ink = $state<{ x: number; w: number } | null>(null);
  let inkReady = $state(false);
  function measureInk() {
    const el = activeKey != null ? tabEl(activeKey) : null;
    if (!el) {
      ink = null;
      return;
    }
    if (!ink || ink.x !== el.offsetLeft || ink.w !== el.offsetWidth) ink = { x: el.offsetLeft, w: el.offsetWidth };
  }
  let trackUntil = 0;
  let trackRaf = 0;
  /** 탭이 늘거나 줄어 폭이 움직이는 동안 표시가 따라가도록 잠시 매 프레임 잰다 */
  function track(ms = 600) {
    trackUntil = performance.now() + ms;
    if (trackRaf) return;
    const loop = () => {
      measureInk();
      trackRaf = performance.now() < trackUntil ? requestAnimationFrame(loop) : 0;
    };
    trackRaf = requestAnimationFrame(loop);
  }
  const flipSpring = solveSpring(SPRING.glide);

  // 탭 순서 바꾸기: 끄는 동안 미리보기 순서로 그리고(나머지 탭은 FLIP 으로 비킨다), 끄는 탭은 빈 슬롯으로 둔다
  let preview = $state<number[] | null>(null);
  let slotKey = $state<number | null>(null);
  let live = $state('');
  const shown = $derived(preview ? preview.map((k) => tabs.find((t) => t.key === k)).filter((t): t is (typeof tabs)[number] => !!t) : tabs);
  const sort = new SortDrag({
    axis: 'x',
    scroller: () => strip,
    itemEl: (k) => tabEl(k),
    keys: () => tabs.map((t) => t.key),
    preview: (o) => (preview = o),
    slot: (k) => (slotKey = k),
    commit: (k, i) => onmove(k, i),
    announce: (m) => (live = m),
    nameOf: (k) => tabs.find((t) => t.key === k)?.name ?? '',
  });
  // 이름 변경: 이름을 더블클릭하거나 F2. 입력칸이 탭의 이름 단추 자리를 대신한다
  let editing = $state<number | null>(null);
  function startRename(key: number) {
    if (sort.busy || confirm) return;
    editing = key;
  }
  async function endRename(byKey: boolean) {
    const k = editing;
    editing = null;
    if (!byKey || k == null) return;
    await tick();
    document.getElementById(`tab-${k}`)?.focus();
  }
  function onTabDown(e: PointerEvent, key: number) {
    if ((e.target as Element).closest('.x')) return;
    sort.start(e, key);
  }
  async function moveBy(key: number, d: -1 | 1) {
    const i = tabs.findIndex((t) => t.key === key);
    const j = i + d;
    if (i < 0 || j < 0 || j >= tabs.length) return;
    onmove(key, j);
    live = posMsg(tabs[i].name, j, tabs.length);
    await tick();
    document.getElementById(`tab-${key}`)?.focus();
    tabEl(key)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  const confirmTab = $derived(confirm ? tabs.find((t) => t.key === confirm.key) : undefined);
  const anchorKey = $derived(confirm?.key ?? notice?.key ?? null);

  function tabEl(key: number): HTMLElement | null {
    return strip?.querySelector<HTMLElement>(`[data-tab-key="${key}"]`) ?? null;
  }

  function placeAnchor() {
    if (anchorKey == null || !strip || !bar) return;
    const el = tabEl(anchorKey);
    if (!el) return;
    const left = el.getBoundingClientRect().left - bar.getBoundingClientRect().left;
    anchorLeft = Math.max(0, Math.min(left, bar.clientWidth - 320));
  }

  // 활성 탭이 항상 보이게 한다
  $effect(() => {
    const k = activeKey;
    void tabs.length;
    if (k == null) return;
    void tick().then(() => tabEl(k)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  });

  $effect(() => {
    void anchorKey;
    void tabs;
    void tick().then(placeAnchor);
  });

  $effect(() => {
    void activeKey;
    void tabs.length;
    void shown;
    void tick().then(() => {
      measureInk();
      track();
    });
  });

  onMount(() => {
    const ro = new ResizeObserver(() => {
      placeAnchor();
      measureInk();
    });
    if (bar) ro.observe(bar);
    // 첫 배치 뒤부터 표시가 미끄러지게 한다(처음 자리는 애니메이션 없이)
    const t = setTimeout(() => (inkReady = true), 60);
    return () => {
      ro.disconnect();
      clearTimeout(t);
      cancelAnimationFrame(trackRaf);
      sort.dispose();
    };
  });

  async function onKey(e: KeyboardEvent) {
    if (e.key === 'F2' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const key = Number((e.target as HTMLElement).closest<HTMLElement>('[data-tab-key]')?.dataset.tabKey);
      if (Number.isNaN(key)) return;
      e.preventDefault();
      startRename(key);
      return;
    }
    const sh = keyShift(e, 'x');
    if (sh) {
      const key = Number((e.target as HTMLElement).closest<HTMLElement>('[data-tab-key]')?.dataset.tabKey);
      if (Number.isNaN(key)) return;
      e.preventDefault();
      await moveBy(key, sh);
      return;
    }
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key) || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    const n = tabs.length;
    if (!n) return;
    const i = Math.max(0, tabs.findIndex((t) => t.key === activeKey));
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
    const key = tabs[j].key;
    onactivate(key);
    await tick();
    document.getElementById(`tab-${key}`)?.focus();
  }
</script>

<div class="tabbar" bind:this={bar}>
  <div class="strip" bind:this={strip} role="tablist" tabindex="-1" aria-label="열린 파일" onkeydown={onKey} data-testid="tabs">
    {#if ink}<span class="ink" class:ready={inkReady} style:transform="translateX({ink.x}px)" style:width="{ink.w}px" aria-hidden="true"></span>{/if}
    {#each shown as t (t.key)}
      <div
        animate:flip={{ duration: reduced() ? 0 : flipSpring.duration, easing: flipSpring.fn }}
        in:growIn={{ w: 240, minW: 120 }}
        out:shrinkOut={{ w: 240, minW: 120 }}
        class="tab"
        class:active={t.key === activeKey}
        class:droppable={dragging && t.key !== activeKey}
        class:over={dragOver === t.key}
        class:slot={slotKey === t.key}
        role="presentation"
        data-tab-key={t.key}
        data-tab-name={t.name}
        onpointerdown={(e) => onTabDown(e, t.key)}
        data-droppable={dragging && t.key !== activeKey ? '' : undefined}
      >
        {#if editing === t.key}
          <div class="name editing">
            <RenameInput
              value={t.name}
              label="{t.name} 이름 변경"
              oncommit={(n, byKey) => { onrename(t.key, n); void endRename(byKey); }}
              oncancel={(byKey) => void endRename(byKey)}
            />
          </div>
        {:else}
        <button
          type="button"
          class="name"
          role="tab"
          id="tab-{t.key}"
          aria-selected={t.key === activeKey}
          tabindex={t.key === activeKey ? 0 : -1}
          title={t.dirty ? `${t.name} (변경됨)` : t.name}
          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight F2"
          onclick={() => onactivate(t.key)}
          ondblclick={() => startRename(t.key)}
          data-testid="tab"
        >
          <span class="nm">{t.name}</span>
          {#if t.dirty}<span class="dot" role="img" aria-label="변경됨" data-testid="tab-dirty"></span>{/if}
        </button>
        {/if}
        <button type="button" class="x" aria-label="{t.name} 닫기" title="닫기 (Ctrl+W)" onclick={() => onclose(t.key)} data-testid="tab-close">
          <Icon name="close" size={14} />
        </button>
      </div>
    {/each}
  </div>
  <span class="live" aria-live="polite" role="status">{live}</span>

  {#if confirm && confirmTab}
    <div class="anchor" style:left="{anchorLeft}px">
      <div class="confirm-pos"><CloseConfirm name={confirmTab.name} busy={confirm.busy} onconfirm={onconfirm} /></div>
    </div>
  {:else if notice}
    <!-- 흐름 안에 둔다: 아래 쪽 도구·보내기 버튼 같은 조작 대상을 덮지 않는다 -->
    <div class="nrow" data-testid="tab-notice">
      <Notice kind={notice.kind} text={notice.text} reassure={notice.reassure} detail={notice.detail} onclose={onclosenotice} />
    </div>
  {/if}
</div>

<style>
  .tabbar {
    position: relative;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    padding: 4px 8px 0;
  }
  .nrow { padding: 0 0 8px; }
  .ink {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 4px;
    border-radius: var(--r-md);
    background: var(--surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-1);
    pointer-events: none;
  }
  .ink.ready { transition: transform var(--spring-glide-dur) var(--spring-glide), width var(--spring-glide-dur) var(--spring-glide); }
  .strip {
    position: relative;
    display: flex;
    gap: 2px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    padding-bottom: 4px;
    outline: none;
  }
  .tab {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    min-width: 120px;
    max-width: 240px;
    position: relative;
    border: 1px solid transparent;
    border-radius: var(--r-md);
    background: transparent;
    transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
  }
  .tab:hover:not(.active):not(.over) { background: var(--hover); }
  .tab.slot { background: color-mix(in srgb, var(--accent) 12%, transparent); border: 1px dashed var(--fg-muted); }
  .tab.slot > * { opacity: 0; }
  .live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .tab.droppable { border: 1px dashed var(--fg-muted); }
  .tab.over { background: var(--accent); color: var(--accent-fg); border: 1px solid var(--accent); }
  .name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px 0 10px;
    border: 0;
    border-radius: var(--r-md);
    background: transparent;
    box-shadow: none;
    color: inherit;
    text-align: left;
  }
  .name.editing { padding: 0 4px 0 4px; }
  .name:hover:not(:disabled), .name:active:not(:disabled) { background: transparent; border-color: transparent; transform: none; }
  .tab.active .name { font-weight: 600; }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: var(--kf-pop) var(--spring-bouncy-dur) var(--spring-bouncy) both; }
  .x {
    flex: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    min-width: 28px;
    min-height: 28px;
    margin-right: 2px;
    padding: 0;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    box-shadow: none;
    color: inherit;
    opacity: 0.7;
  }
  .x:hover:not(:disabled) { opacity: 1; background: var(--press); }
  .tab:not(:hover):not(:focus-within):not(.active) .x { opacity: 0.62; }
  @media (pointer: coarse) {
    .x { width: 36px; height: 36px; min-width: 36px; min-height: 36px; }
  }
  .anchor { position: absolute; top: 0; height: 100%; width: 0; }
  .confirm-pos { position: absolute; top: calc(100% + 6px); left: 0; z-index: 30; }
</style>
