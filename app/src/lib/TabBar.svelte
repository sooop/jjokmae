<script lang="ts">
  // 열린 파일 탭 막대. 탭마다 파일명(말줄임), 변경됨 점, 닫기 버튼. 넘치면 가로로 스크롤하고 활성 탭이 보이게 맞춘다.
  // 쪽을 끌어 올 때(dragging)는 활성이 아닌 탭이 놓을 수 있는 대상으로 강조된다.
  import { onMount, tick } from 'svelte';
  import { flip } from 'svelte/animate';
  import { growIn, reduced, shrinkOut, solveSpring, SPRING } from './motion';
  import type { TabNotice } from './status';
  import CloseConfirm from './CloseConfirm.svelte';
  import Icon from './ui/Icon.svelte';
  import Notice from './ui/Notice.svelte';

  let {
    tabs,
    activeKey,
    dragging = false,
    dragOver = null,
    notice,
    confirm,
    onactivate,
    onclose,
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
    };
  });

  async function onKey(e: KeyboardEvent) {
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
    {#each tabs as t (t.key)}
      <div
        animate:flip={{ duration: reduced() ? 0 : flipSpring.duration, easing: flipSpring.fn }}
        in:growIn={{ w: 240, minW: 120 }}
        out:shrinkOut={{ w: 240, minW: 120 }}
        class="tab"
        class:active={t.key === activeKey}
        class:droppable={dragging && t.key !== activeKey}
        class:over={dragOver === t.key}
        role="presentation"
        data-tab-key={t.key}
        data-tab-name={t.name}
        data-droppable={dragging && t.key !== activeKey ? '' : undefined}
      >
        <button
          type="button"
          class="name"
          role="tab"
          id="tab-{t.key}"
          aria-selected={t.key === activeKey}
          tabindex={t.key === activeKey ? 0 : -1}
          title={t.dirty ? `${t.name} (변경됨)` : t.name}
          onclick={() => onactivate(t.key)}
          data-testid="tab"
        >
          <span class="nm">{t.name}</span>
          {#if t.dirty}<span class="dot" role="img" aria-label="변경됨" data-testid="tab-dirty"></span>{/if}
        </button>
        <button type="button" class="x" aria-label="{t.name} 닫기" title="닫기 (Ctrl+W)" onclick={() => onclose(t.key)} data-testid="tab-close">
          <Icon name="close" size={14} />
        </button>
      </div>
    {/each}
  </div>

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
