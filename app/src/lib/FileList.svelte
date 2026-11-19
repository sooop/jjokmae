<script lang="ts" module>
  export interface FileRow {
    key: number;
    name: string;
    total: number;
    dirty: boolean;
    /** 이 파일에서 골라 둔 쪽 수 */
    sel: number;
  }
</script>

<script lang="ts">
  // 정리 모드 왼쪽 파일 목록. 파일마다 이름·쪽 수·변경됨 점·파일별 선택 쪽 수·닫기 버튼.
  // 쪽을 끌어 오면(dragging) 활성이 아닌 파일 항목과 맨 아래 '새 파일' 칸이 놓을 수 있는 대상으로 강조된다.
  import { onDestroy, onMount, tick } from 'svelte';
  import { flip } from 'svelte/animate';
  import { popIn, popOut, reduced, slideDownIn, slideUpOut, solveSpring, SPRING } from './motion';
  import CloseConfirm from './CloseConfirm.svelte';
  import type { TabNotice } from './status';
  import { keyShift, posMsg, SortDrag } from './motion/sort-drag';
  import Icon from './ui/Icon.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Notice from './ui/Notice.svelte';
  import RenameInput from './ui/RenameInput.svelte';
  import { restoreFocus } from './ui/restore-focus';

  let {
    files,
    activeKey,
    dragging = false,
    dragOver = null,
    selTotal,
    busy,
    notice,
    confirm,
    onactivate,
    onclose,
    onmove,
    onrename,
    onopenfile,
    onsendall,
    oncontext,
    onconfirm,
    onclosenotice,
  }: {
    files: FileRow[];
    activeKey: number | null;
    /** 쪽을 끌고 있는가 */
    dragging?: boolean;
    dragOver?: number | 'new' | null;
    /** 모든 파일에서 골라 둔 쪽 수의 합 */
    selTotal: number;
    busy: boolean;
    notice: TabNotice | null;
    confirm: { key: number; busy: boolean } | null;
    onactivate: (key: number) => void;
    onclose: (key: number) => void;
    /** 파일을 끌거나 Alt+↑/↓ 로 toIndex 자리로 옮긴다 */
    onmove: (key: number, toIndex: number) => void;
    /** 이름 변경을 확정했다(입력은 아직 정리 전) */
    onrename: (key: number, name: string) => void;
    onopenfile: () => void;
    onsendall: (mode: 'copy' | 'move') => void;
    oncontext: (req: { key: number; x: number; y: number }) => void;
    onconfirm: (choice: 'save' | 'discard' | 'cancel') => void;
    onclosenotice: () => void;
  } = $props();

  let moreOpen = $state(false);
  let moreRoot: HTMLDivElement | undefined = $state();
  let moreMenu: HTMLDivElement | undefined = $state();
  // 고른 쪽이 없어지면 메뉴는 닫힌다
  $effect(() => {
    if (moreOpen && selTotal === 0) moreOpen = false;
  });
  // 열려 있는 동안: 바깥 누르기·Esc(포커스 위치와 무관)로 닫고, 열릴 때 첫 항목으로 포커스
  $effect(() => {
    if (!moreOpen) return;
    const down = (e: PointerEvent) => {
      if (moreRoot && !moreRoot.contains(e.target as Node)) moreOpen = false;
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      moreOpen = false;
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    void tick().then(() => moreMenu?.querySelector<HTMLElement>('[role=menuitem]')?.focus());
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  });
  function onMoreKey(e: KeyboardEvent) {
    const items = Array.from(moreMenu?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    let to = -1;
    if (e.key === 'ArrowDown') to = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') to = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = items.length - 1;
    else if (e.key === 'Tab') moreOpen = false;
    if (to >= 0) {
      e.preventDefault();
      items[to].focus();
    }
  }
  let listEl: HTMLDivElement | undefined = $state();
  /** 활성 항목 표시: 항목 사이를 스프링으로 미끄러진다 */
  let ink = $state<{ y: number; h: number } | null>(null);
  let inkReady = $state(false);
  const flipSpring = solveSpring(SPRING.glide);
  function measureInk() {
    const el = activeKey != null ? listEl?.querySelector<HTMLElement>(`[data-file-key="${activeKey}"]`) : null;
    if (!el || !listEl) {
      ink = null;
      return;
    }
    const y = el.getBoundingClientRect().top - listEl.getBoundingClientRect().top + listEl.scrollTop;
    const h = el.offsetHeight;
    if (!ink || Math.abs(ink.y - y) > 0.5 || ink.h !== h) ink = { y, h };
  }
  let trackRaf = 0;
  let trackUntil = 0;
  function track(ms = 600) {
    trackUntil = performance.now() + ms;
    if (trackRaf) return;
    const loop = () => {
      measureInk();
      trackRaf = performance.now() < trackUntil ? requestAnimationFrame(loop) : 0;
    };
    trackRaf = requestAnimationFrame(loop);
  }
  $effect(() => {
    void activeKey;
    void files.length;
    void shown;
    void confirm;
    void notice;
    void tick().then(() => {
      measureInk();
      track();
    });
  });
  onMount(() => {
    const t = setTimeout(() => (inkReady = true), 60);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(trackRaf);
    };
  });
  // 파일 순서 바꾸기: 끄는 동안 미리보기 순서로 그리고(나머지는 FLIP 으로 비킨다), 끄는 항목은 빈 슬롯으로 둔다
  let preview = $state<number[] | null>(null);
  let slotKey = $state<number | null>(null);
  let live = $state('');
  const shown = $derived(preview ? preview.map((k) => files.find((f) => f.key === k)).filter((f): f is FileRow => !!f) : files);
  const entryEl = (k: number) => listEl?.querySelector<HTMLElement>(`[data-file-key="${k}"]`)?.closest<HTMLElement>('.entry') ?? null;
  const sort = new SortDrag({
    axis: 'y',
    scroller: () => listEl,
    itemEl: entryEl,
    keys: () => files.map((f) => f.key),
    preview: (o) => (preview = o),
    slot: (k) => (slotKey = k),
    commit: (k, i) => onmove(k, i),
    announce: (m) => (live = m),
    nameOf: (k) => files.find((f) => f.key === k)?.name ?? '',
  });
  onDestroy(() => sort.dispose());
  // 이름 변경: 이름을 더블클릭하거나 F2. 입력칸이 행의 이름 자리를 대신한다
  let editing = $state<number | null>(null);
  function startRename(key: number) {
    if (sort.busy || confirm || dragging) return;
    editing = key;
  }
  async function endRename(byKey: boolean) {
    const k = editing;
    editing = null;
    if (!byKey || k == null) return;
    await tick();
    document.getElementById(`file-${k}`)?.focus();
  }
  async function moveBy(key: number, d: -1 | 1) {
    const i = files.findIndex((f) => f.key === key);
    const j = i + d;
    if (i < 0 || j < 0 || j >= files.length) return;
    onmove(key, j);
    live = posMsg(files[i].name, j, files.length);
    await tick();
    document.getElementById(`file-${key}`)?.focus();
  }
  const confirmFile = $derived(confirm ? files.find((f) => f.key === confirm.key) : undefined);

  async function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const i = files.findIndex((f) => f.key === activeKey);
    if (e.key === 'F2' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const k = Number(t.closest<HTMLElement>('[data-file-key]')?.dataset.fileKey);
      if (Number.isNaN(k)) return;
      e.preventDefault();
      startRename(k);
      return;
    }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const el = t.closest<HTMLElement>('[data-file-key]');
      if (!el) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      oncontext({ key: Number(el.dataset.fileKey), x: r.left + r.width / 2, y: r.top + r.height / 2 });
      return;
    }
    const sh = keyShift(e, 'y');
    if (sh) {
      const k = Number(t.closest<HTMLElement>('[data-file-key]')?.dataset.fileKey);
      if (Number.isNaN(k)) return;
      e.preventDefault();
      await moveBy(k, sh);
      return;
    }
    const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key) || e.ctrlKey || e.altKey || e.metaKey || !files.length || t.closest('button.x')) return;
    e.preventDefault();
    const n = files.length;
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : Math.min(n - 1, Math.max(0, (i < 0 ? 0 : i) + (e.key === 'ArrowDown' ? 1 : -1)));
    const key = files[j].key;
    onactivate(key);
    await tick();
    document.getElementById(`file-${key}`)?.focus();
  }

  function onCtx(e: MouseEvent, key: number) {
    e.preventDefault();
    oncontext({ key, x: e.clientX, y: e.clientY });
  }

  // 터치: 길게 누르면 우클릭 메뉴
  let longTimer = 0;
  function rowDown(e: PointerEvent, key: number) {
    if (!(e.target as Element).closest('button.x')) sort.start(e, key);
    longDown(e, key);
  }
  function longDown(e: PointerEvent, key: number) {
    if (e.pointerType === 'mouse' || (e.target as Element).closest('button.x')) return;
    clearTimeout(longTimer);
    const x = e.clientX;
    const y = e.clientY;
    longTimer = window.setTimeout(() => oncontext({ key, x, y }), 500);
  }
  const longCancel = () => clearTimeout(longTimer);
</script>

<aside class="files" aria-label="파일 목록" data-testid="files">
  <div class="head">
    <button type="button" class="open" onclick={onopenfile} title="파일 열기 (Ctrl+O)" data-testid="open-file">
      <Icon name="folder" size={16} /><span>파일 열기</span>
    </button>
    <div class="all" title="파일마다 골라 둔 쪽을 파일 순서대로 합쳐 새 파일로 만듭니다. 고른 쪽이 없으면 쓸 수 없습니다.">
      <button type="button" class="allnew" disabled={busy || selTotal === 0} onclick={() => onsendall('copy')} data-testid="send-all-new">
        선택한 쪽 모두 → 새 파일{selTotal ? ` (${selTotal})` : ''}
      </button>
      <div class="more" bind:this={moreRoot}>
        <IconButton icon="chevron-down" label="선택한 쪽 모두 보내기 방식" haspopup="menu" expanded={moreOpen} disabled={busy || selTotal === 0} onclick={() => (moreOpen = !moreOpen)} />
        {#if moreOpen}
          <div class="mini stagger" role="menu" tabindex="-1" bind:this={moreMenu} use:restoreFocus={{ fallback: 'button[aria-label="선택한 쪽 모두 보내기 방식"]' }} in:popIn|global={{ origin: 'top right' }} out:popOut|global={{ origin: 'top right' }} onkeydown={onMoreKey}>
            <button type="button" role="menuitem" onclick={() => { moreOpen = false; onsendall('copy'); }}>복사 → 새 파일</button>
            <button type="button" role="menuitem" title="원본 파일들에서 지우고 새 파일로 옮깁니다. 되돌리기는 함께 적용됩니다" onclick={() => { moreOpen = false; onsendall('move'); }} data-testid="send-all-move">이동 → 새 파일</button>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <div class="list" bind:this={listEl} role="listbox" tabindex="-1" aria-label="열린 파일" onkeydown={onKey} data-testid="file-list">
    {#if ink}<span class="ink" class:ready={inkReady} style:transform="translateY({ink.y}px)" style:height="{ink.h}px" aria-hidden="true"></span>{/if}
    {#each shown as f (f.key)}
      {@const isSelf = f.key === activeKey}
      <div class="entry" animate:flip={{ duration: reduced() ? 0 : flipSpring.duration, easing: flipSpring.fn }} in:slideDownIn={{ h: 64 }} out:slideUpOut={{ h: 64 }}>
      <div
        class="row"
        class:active={isSelf}
        class:droppable={dragging && !isSelf}
        class:over={dragOver === f.key}
        class:disabled={dragging && isSelf}
        class:slot={slotKey === f.key}
        role="presentation"
        data-file-key={f.key}
        data-tab-key={f.key}
        data-tab-name={f.name}
        data-droppable={dragging && !isSelf ? '' : undefined}
        oncontextmenu={(e) => onCtx(e, f.key)}
        onpointerdown={(e) => rowDown(e, f.key)}
        onpointerup={longCancel}
        onpointercancel={longCancel}
        onpointermove={longCancel}
      >
        {#if editing === f.key}
        <div class="opt editing">
          <span class="l1">
            <RenameInput
              value={f.name}
              label="{f.name} 이름 변경"
              oncommit={(n, byKey) => { onrename(f.key, n); void endRename(byKey); }}
              oncancel={(byKey) => void endRename(byKey)}
            />
          </span>
          <span class="l2"><span class="pages">{f.total}쪽</span></span>
        </div>
        {:else}
        <div
          class="opt"
          role="option"
          id="file-{f.key}"
          aria-selected={isSelf}
          aria-disabled={dragging && isSelf ? 'true' : undefined}
          tabindex={isSelf ? 0 : -1}
          title={f.dirty ? `${f.name} (변경됨)` : f.name}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown F2"
          onclick={() => onactivate(f.key)}
          ondblclick={() => startRename(f.key)}
          onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onactivate(f.key))}
          data-testid="file"
        >
          <span class="l1">
            <span class="nm">{f.name}</span>
            {#if f.dirty}<span class="dot" role="img" aria-label="변경됨" data-testid="file-dirty"></span>{/if}
          </span>
          <span class="l2">
            <span class="pages">{f.total}쪽</span>
            {#if f.sel > 0}<span class="badge" role="img" aria-label="선택한 쪽 {f.sel}개" title="이 파일에서 고른 쪽 {f.sel}개" data-testid="file-sel">{f.sel}</span>{/if}
          </span>
        </div>
        {/if}
        <button type="button" class="x" aria-label="{f.name} 닫기" title="닫기 (Ctrl+W)" onclick={() => onclose(f.key)} data-testid="file-close">
          <Icon name="close" size={14} />
        </button>
      </div>
      {#if confirm && confirm.key === f.key && confirmFile}
        <div class="pad"><CloseConfirm fluid name={confirmFile.name} busy={confirm.busy} {onconfirm} /></div>
      {:else if notice && notice.key === f.key}
        <div class="pad" data-testid="tab-notice">
          <Notice kind={notice.kind} text={notice.text} reassure={notice.reassure} detail={notice.detail} onclose={onclosenotice} />
        </div>
      {/if}
      </div>
    {/each}
  </div>
  <span class="live" aria-live="polite" role="status">{live}</span>

  <div
    class="newslot"
    class:droppable={dragging}
    class:over={dragOver === 'new'}
    role="note"
    title="쪽을 끌어다 놓으면 그 쪽만 든 새 파일이 만들어집니다 (Shift 를 누른 채 놓으면 복사가 아니라 이동)"
    data-new-file=""
    data-tab-name="새 파일"
    data-droppable={dragging ? '' : undefined}
    data-testid="new-slot"
  >
    <Icon name="plus" size={16} /><span>새 파일</span>
  </div>
</aside>

<style>
  .files {
    position: relative;
    flex: none;
    width: 248px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface-2);
    border-right: 1px solid var(--border);
  }
  .head { display: grid; gap: 6px; padding: 8px; border-bottom: 1px solid var(--border); }
  .open { display: flex; align-items: center; justify-content: center; gap: 6px; }
  .all { display: flex; align-items: center; gap: 2px; }
  .allnew { flex: 1; min-width: 0; padding: 4px 8px; font-size: 13px; line-height: 1.3; text-align: left; }
  .more { position: relative; }
  .mini {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 30;
    display: grid;
    gap: 1px;
    min-width: 168px;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-2), var(--edge);
  }
  .mini button { border: 0; text-align: left; background: transparent; box-shadow: none; }
  .mini button:hover { background: var(--hover); }
  .list { position: relative; flex: 1; min-height: 0; overflow-y: auto; padding: 6px; display: grid; gap: 2px; align-content: start; }
  .ink {
    position: absolute;
    left: 6px;
    right: 6px;
    top: 0;
    border-radius: var(--r-md);
    background: var(--surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-1);
    pointer-events: none;
  }
  .ink.ready { transition: transform var(--spring-glide-dur) var(--spring-glide), height var(--spring-glide-dur) var(--spring-glide); }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    border: 1px solid transparent;
    border-radius: var(--r-md);
    transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), opacity var(--dur-base) var(--ease-out);
  }
  .row:hover:not(.active):not(.over) { background: var(--hover); }
  .row.droppable { border: 1px dashed var(--fg-muted); }
  .row.over { background: var(--accent); color: var(--accent-fg); border: 1px solid var(--accent); }
  .row.slot { background: color-mix(in srgb, var(--accent) 12%, transparent); border: 1px dashed var(--fg-muted); }
  .row.slot > * { opacity: 0; }
  .live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .row.disabled { opacity: 0.45; }
  .opt {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 2px;
    padding: 6px 4px 6px 10px;
    border-radius: var(--radius);
    cursor: pointer;
    outline: none;
  }
  .opt.editing { cursor: default; }
  .opt:focus-visible { outline: 2px solid var(--fg); outline-offset: -2px; }
  .l1, .l2 { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .active .nm { font-weight: 600; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .pages { font-size: 12px; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
  .over .pages { color: inherit; }
  .badge {
    min-width: 20px;
    padding: 0 6px;
    border-radius: 10px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 12px;
    line-height: 18px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .over .badge { background: var(--accent-fg); color: var(--accent); }
  .x {
    flex: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    min-width: 28px;
    min-height: 28px;
    margin-right: 4px;
    padding: 0;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    box-shadow: none;
    color: inherit;
    opacity: 0.55;
  }
  .row:hover .x, .row:focus-within .x, .row.active .x { opacity: 0.9; }
  .x:hover:not(:disabled) { opacity: 1; background: var(--press); }
  @media (pointer: coarse) {
    .x { width: 36px; height: 36px; min-width: 36px; min-height: 36px; }
  }
  .pad { padding: 2px 2px 6px; }
  .entry { position: relative; }
  .newslot {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 6px 8px 8px;
    min-height: 56px;
    border: 1px dashed var(--border);
    border-radius: var(--r-md);
    color: var(--fg-muted);
    transition: background-color var(--dur-base) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), transform var(--spring-pop-dur) var(--spring-pop);
  }
  .newslot.droppable { border-color: var(--fg-muted); color: var(--fg); }
  .newslot.over { background: var(--accent); color: var(--accent-fg); border: 1px solid var(--accent); transform: scale(1.03); }
</style>
