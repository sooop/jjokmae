<script lang="ts">
  // 정리 모드 화면: 왼쪽 파일 목록 + 오른쪽 썸네일 격자(본문 뷰어 없음). 우클릭·길게 누르기 메뉴와 보내기 팝오버를 여기서 맡는다.
  // 문서 목록·활성 문서·쪽 선택·되돌리기 기록은 Workspace 하나를 보기 모드와 공유한다.
  import type { Snippet } from 'svelte';
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
  import FileList from './FileList.svelte';
  import PageGrid, { type CtxRequest, type DropTarget } from './PageGrid.svelte';
  import PageTools from './PageTools.svelte';
  import * as pa from './page-actions';
  import type { ScreenRect } from './motion/drag-ghost';
  import SendPopover from './SendPopover.svelte';
  import type { PrintScope } from './print';
  import { GRID_MAX, GRID_MIN } from './settings';
  import type { SendPos } from './transfer';
  import { Workspace, type DocState } from './workspace.svelte';

  let {
    ws,
    thumb,
    actions,
    sendButton,
    onthumb,
    onopenfile,
    onconfirm,
    onsave,
    onsplit,
    onprint,
  }: {
    ws: Workspace;
    thumb: number;
    /** 칸마다 뜨는 아이콘 버튼 줄(보기 모드 썸네일과 같은 것) */
    actions: Snippet<[number]>;
    /** 위쪽 도구 줄에 끼우는 '선택한 쪽 보내기' 버튼 */
    sendButton: Snippet;
    onthumb: (v: number) => void;
    onopenfile: () => void;
    onconfirm: (choice: 'save' | 'discard' | 'cancel') => void;
    onsave: (d: DocState) => void;
    onsplit: () => void;
    /** 인쇄 대화상자를 연다(툴바 인쇄 버튼에 붙는다) */
    onprint: (scope: PrintScope) => void;
  } = $props();

  const doc = $derived(ws.active);
  const files = $derived(ws.docs.map((d) => ({ key: d.key, name: d.name, total: d.total, dirty: d.dirty, sel: d.selected.length })));

  /** 쪽을 끌고 있을 때 파일 목록에 알리는 상태 */
  let dragTab = $state<{ over: DropTarget | null } | null>(null);

  // ---------- 메뉴 ----------
  type MenuState =
    | { kind: 'page'; x: number; y: number; fromKey: number; pages: number[] }
    | { kind: 'file'; x: number; y: number; key: number }
    | { kind: 'send'; x: number; y: number; fromKey: number; pages: number[]; mode: 'copy' | 'move' };
  let menu = $state<MenuState | null>(null);

  function focusGrid() {
    document.querySelector<HTMLElement>('[data-testid=grid]')?.focus({ preventScroll: true });
  }
  function closeMenu(refocus = true) {
    const was = menu;
    menu = null;
    if (refocus && was && was.kind !== 'file') focusGrid();
  }

  function onCtx(r: CtxRequest) {
    const d = doc;
    if (!d) return;
    menu = { kind: 'page', x: r.x, y: r.y, fromKey: d.key, pages: r.pages };
  }

  const pageItems = $derived.by((): MenuItem[] => {
    const m = menu;
    if (!m || m.kind !== 'page') return [];
    const d = ws.docOf(m.fromKey);
    if (!d) return [];
    const all = m.pages.length >= d.total;
    const targets = (mode: 'copy' | 'move'): MenuItem[] => [
      {
        id: `${mode}:new`,
        label: '새 파일',
        disabled: mode === 'move' && all,
        title: mode === 'move' && all ? '모든 쪽을 옮기면 원본이 빈 문서가 됩니다. 복사를 쓰거나 한 쪽 이상 남겨 주세요.' : undefined,
      },
      ...ws.docs.map((t) => ({
        id: `${mode}:doc:${t.key}`,
        label: `‘${t.name}’ 맨 뒤${t.key === d.key ? ' (이 파일)' : ''}`,
        disabled: mode === 'move' && t.key !== d.key && all,
        title: mode === 'move' && t.key !== d.key && all ? '모든 쪽을 옮기면 원본이 빈 문서가 됩니다.' : t.name,
      })),
      { id: `${mode}:pos`, label: '위치 지정…' },
    ];
    return [
      { id: 'copy', label: '복사 →', sub: targets('copy') },
      { id: 'move', label: '이동 →', sub: targets('move') },
      { id: 'dup', label: '복제' },
      { id: 'rot', label: '회전' },
      { id: 'del', label: '삭제', disabled: all, title: all ? '모든 쪽을 삭제할 수 없습니다. 한 쪽 이상 남겨 주세요.' : undefined },
      { id: 'extract', label: '추출', title: '고른 쪽만 새 PDF 로 저장합니다' },
      { id: 'split', label: '분할…' },
      { id: 'print', label: '인쇄…', title: '고른 쪽을 인쇄합니다' },
    ];
  });

  const fileItems = $derived.by((): MenuItem[] => {
    const m = menu;
    if (!m || m.kind !== 'file') return [];
    const d = ws.docOf(m.key);
    return [
      { id: 'close', label: '닫기' },
      { id: 'save', label: '저장', disabled: !d },
      { id: 'print', label: '인쇄…', title: '이 파일 전체를 인쇄합니다' },
      { id: 'selectall', label: '이 파일의 모든 쪽 선택' },
    ];
  });

  function pickPage(path: string[]) {
    const m = menu;
    if (!m || m.kind !== 'page') return;
    const d = ws.docOf(m.fromKey);
    if (!d) return;
    const id = path[path.length - 1];
    const pages = m.pages;
    const [head, kind, key] = id.split(':');
    if (head === 'copy' || head === 'move') {
      const mode = head;
      if (kind === 'pos') {
        menu = { kind: 'send', x: m.x, y: m.y, fromKey: m.fromKey, pages, mode };
        return;
      }
      closeMenu();
      if (kind === 'new') void pa.send(ws, { from: d, pages, mode, target: { type: 'new' } });
      else void pa.send(ws, { from: d, pages, mode, target: { type: 'doc', key: Number(key), pos: 'end' } });
      return;
    }
    closeMenu();
    if (id === 'dup') pa.duplicate(ws, pages);
    else if (id === 'rot') pa.rotate(ws, pages);
    else if (id === 'del') pa.remove(ws, pages);
    else if (id === 'extract') void ws.extract(pages);
    else if (id === 'split') onsplit();
    else if (id === 'print') {
      // 메뉴를 연 쪽(선택에 속하면 선택 전체)을 인쇄 대상으로 삼는다
      const same = d.selected.length === pages.length && pages.every((p) => d.selected.includes(p));
      if (!same) d.selected = [...pages];
      onprint('selected');
    }
  }

  function pickFile(path: string[]) {
    const m = menu;
    if (!m || m.kind !== 'file') return;
    const d = ws.docOf(m.key);
    closeMenu();
    if (!d) return;
    const id = path[path.length - 1];
    if (id === 'close') void ws.close(d.key);
    else if (id === 'save') onsave(d);
    else if (id === 'print') {
      ws.activate(d.key);
      onprint('all');
    }
    else if (id === 'selectall') {
      d.selected = Array.from({ length: d.total }, (_, i) => i);
      d.anchor = 0;
      ws.activate(d.key);
    }
  }

  // 위치 지정(보내기 팝오버)을 메뉴가 열린 자리에 띄운다
  let sendHost: HTMLDivElement | undefined = $state();
  let adj = $state({ dx: 0, dy: 0 });
  $effect(() => {
    if (menu?.kind !== 'send') return;
    adj = { dx: 0, dy: 0 };
    queueMicrotask(() => {
      const pop = sendHost?.firstElementChild as HTMLElement | null;
      if (!pop) return;
      const r = pop.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      adj = { dx: Math.min(0, vw - 8 - r.right), dy: r.bottom > vh - 8 ? Math.max(8 - r.top, vh - 8 - r.bottom) : 0 };
    });
  });
  $effect(() => {
    if (menu?.kind !== 'send') return;
    const down = (e: PointerEvent) => {
      if (sendHost && !sendHost.contains(e.target as Node)) closeMenu();
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  });

  function onSendRun(mode: 'copy' | 'move', target: { type: 'new' } | { type: 'doc'; key: number; pos: SendPos }) {
    const m = menu;
    if (!m || m.kind !== 'send') return;
    const d = ws.docOf(m.fromKey);
    closeMenu();
    if (d) void pa.send(ws, { from: d, pages: m.pages, mode, target });
  }

  function onTabDrop(moving: number[], target: DropTarget, rects?: ScreenRect[]) {
    const d = doc;
    if (!d) return;
    void pa.send(ws, { from: d, pages: moving, mode: 'copy', target: target === 'new' ? { type: 'new' } : { type: 'doc', key: target, pos: 'end' } }, rects);
  }

  const sel = $derived(doc?.selected ?? []);
</script>

<div class="org" data-testid="organize">
  <FileList
    {files}
    activeKey={ws.activeKey}
    dragging={dragTab != null}
    dragOver={dragTab?.over ?? null}
    selTotal={ws.selectionTotal}
    busy={ws.opBusy}
    notice={ws.tabNotice}
    confirm={ws.confirmClose}
    onactivate={(k) => ws.activate(k)}
    onclose={(k) => void ws.close(k)}
    {onopenfile}
    onsendall={(m) => void ws.sendSelectionToNew(m)}
    oncontext={(r) => (menu = { kind: 'file', x: r.x, y: r.y, key: r.key })}
    {onconfirm}
    onclosenotice={() => (ws.tabNotice = null)}
  />

  <section class="main" aria-label="쪽 정리">
    <div class="bar">
      <div class="tools">
        <PageTools
          inline
          count={sel.length}
          busy={ws.opBusy}
          notice={ws.pagesNotice}
          onrotate={() => pa.rotate(ws, sel)}
          oncopy={() => pa.duplicate(ws, sel)}
          ondelete={() => pa.remove(ws, sel)}
          onextract={() => void ws.extract(sel)}
          onprint={() => onprint('selected')}
          onclear={() => doc && (doc.selected = [])}
          onclosenotice={() => (ws.pagesNotice = null)}
          extra={sendButton}
        />
      </div>
      <label class="size" title="썸네일 크기 (Ctrl+휠로도 조절)">
        <input
          type="range"
          min={GRID_MIN}
          max={GRID_MAX}
          step="4"
          value={thumb}
          aria-label="썸네일 크기"
          aria-valuetext="{thumb}px"
          oninput={(e) => onthumb(Number(e.currentTarget.value))}
          data-testid="thumb-size"
        />
        <span class="val">{thumb}px</span>
      </label>
    </div>
    <div class="gridhost">
      {#if doc}
        {#each [doc] as d (d.key)}
          <PageGrid
            sizes={d.sizes}
            scheduler={d.scheduler}
            rev={d.rev}
            gen={d.gen}
            selected={d.selected}
            anchor={d.anchor}
            {thumb}
            initialScroll={d.gridScroll}
            {actions}
            {onthumb}
            onscrollpos={(t) => (d.gridScroll = t)}
            onchange={(s, a) => {
              d.selected = s;
              d.anchor = a;
            }}
            onreorder={(m, b, s) => pa.reorder(ws, m, b, s)}
            ontabdrop={onTabDrop}
            ondragtab={(s) => (dragTab = s)}
            onopen={(i) => ws.openPage(i)}
            oncontext={onCtx}
            onremove={(p) => pa.remove(ws, p)}
          />
        {/each}
      {/if}
    </div>
  </section>
</div>

{#if menu?.kind === 'page'}
  <ContextMenu x={menu.x} y={menu.y} label="{menu.pages.length}쪽" items={pageItems} onpick={pickPage} onclose={() => closeMenu()} />
{:else if menu?.kind === 'file'}
  <ContextMenu x={menu.x} y={menu.y} label={ws.docOf(menu.key)?.name ?? '파일'} items={fileItems} onpick={pickFile} onclose={() => closeMenu()} />
{:else if menu?.kind === 'send'}
  {@const m = menu}
  <div class="sendhost" bind:this={sendHost} style:left="{m.x + adj.dx}px" style:top="{m.y + adj.dy}px" data-testid="send-host">
    <SendPopover
      count={m.pages.length}
      docs={ws.docs.map((d) => ({ key: d.key, name: d.name, total: d.total, self: d.key === m.fromKey }))}
      busy={ws.opBusy}
      initialMode={m.mode}
      onrun={onSendRun}
      onclose={() => closeMenu()}
    />
  </div>
{/if}

<style>
  .org { flex: 1; min-width: 0; display: flex; min-height: 0; animation: kf-fade var(--dur-base) var(--ease-out); }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .bar {
    flex: none;
    display: flex;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 4px 16px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
  }
  .tools { flex: 1 1 auto; min-width: 0; }
  .size { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
  .size input[type='range'] {
    width: 150px;
    min-height: 28px;
    padding: 0;
    border: 0;
    background: transparent;
    accent-color: var(--accent);
  }
  .val { min-width: 5ch; font-size: 12px; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
  .gridhost { position: relative; flex: 1; min-height: 0; }
  .sendhost { position: fixed; z-index: 60; width: 0; height: 0; }
</style>
