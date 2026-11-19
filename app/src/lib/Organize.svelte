<script lang="ts">
  // 정리 모드 화면: 왼쪽 파일 목록 + 오른쪽 썸네일 격자(본문 뷰어 없음). 우클릭·길게 누르기 메뉴와 보내기 팝오버를 여기서 맡는다.
  // 문서 목록·활성 문서·쪽 선택·되돌리기 기록은 Workspace 하나를 보기 모드와 공유한다.
  import { untrack, type Snippet } from 'svelte';
  import { rangeFill } from './motion';
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
  import PageMenu, { type PageMenuReq } from './PageMenu.svelte';
  import FileList from './FileList.svelte';
  import PageGrid, { type CtxRequest, type DropTarget } from './PageGrid.svelte';
  import PageTools from './PageTools.svelte';
  import * as pa from './page-actions';
  import type { ScreenRect } from './motion/drag-ghost';
  import type { PrintScope } from './print';
  import { GRID_MAX, GRID_MIN } from './settings';
  import { Workspace, type DocState } from './workspace.svelte';

  let {
    ws,
    thumb,
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
  // 끌던 격자가 사라지면(문서 전환·모드 전환) 끌기 알림도 비운다. 격자는 파괴 중에 부모 상태를 쓰지 않는다
  $effect(() => {
    void ws.activeKey;
    untrack(() => (dragTab = null));
  });

  // ---------- 메뉴 ----------
  type MenuState =
    | ({ kind: 'page' } & PageMenuReq)
    | { kind: 'file'; x: number; y: number; key: number };
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

  const fileItems = $derived.by((): MenuItem[] => {
    const m = menu;
    if (!m || m.kind !== 'file') return [];
    const d = ws.docOf(m.key);
    const total = d?.total ?? 0;
    const n = d?.selected.length ?? 0;
    return [
      // 선택은 파일마다 따로 들고 있다(DocState.selected): 이 파일의 선택만 바꾸고 다른 파일의 선택은 그대로 둔다
      {
        id: 'selectall',
        label: '이 파일의 모든 쪽 선택',
        disabled: !d || n >= total,
        title: d && n >= total ? '이미 모든 쪽이 선택되어 있습니다' : undefined,
      },
      {
        id: 'selectnone',
        label: '이 파일의 쪽 선택 해제',
        disabled: !d || n === 0,
        title: d && n === 0 ? '선택된 쪽이 없습니다' : undefined,
      },
      { id: 'save', label: '저장', disabled: !d },
      { id: 'print', label: '인쇄…', title: '이 파일 전체를 인쇄합니다' },
      { id: 'close', label: '닫기', divider: true },
    ];
  });

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
    else if (id === 'selectnone') {
      d.selected = [];
      d.anchor = null;
      ws.activate(d.key);
    } else if (id === 'selectall') {
      d.selected = Array.from({ length: d.total }, (_, i) => i);
      d.anchor = 0;
      ws.activate(d.key);
    }
  }

  function onTabDrop(moving: number[], target: DropTarget, rects?: ScreenRect[], move = false) {
    const d = doc;
    if (!d) return;
    void pa.send(ws, { from: d, pages: moving, mode: move ? 'move' : 'copy', target: target === 'new' ? { type: 'new' } : { type: 'doc', key: target, pos: 'end' } }, rects);
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
    onmove={(k, i) => ws.moveDoc(k, i)}
    onrename={(k, n) => ws.renameDoc(k, n)}
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
          use:rangeFill={thumb}
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
            stateId={d.stateId}
            selected={d.selected}
            anchor={d.anchor}
            {thumb}
            initialScroll={d.gridScroll}
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
  <PageMenu {ws} req={menu} {onsplit} onprint={() => onprint('selected')} onclose={(refocus) => closeMenu(refocus)} />
{:else if menu?.kind === 'file'}
  <ContextMenu x={menu.x} y={menu.y} label={ws.docOf(menu.key)?.name ?? '파일'} items={fileItems} onpick={pickFile} onclose={() => closeMenu()} />
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
  }
  .val { min-width: 5ch; font-size: 12px; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
  .gridhost { position: relative; flex: 1; min-height: 0; }
</style>
