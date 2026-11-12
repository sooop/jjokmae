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
  import { tick } from 'svelte';
  import CloseConfirm from './CloseConfirm.svelte';
  import type { TabNotice } from './status';
  import Icon from './ui/Icon.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Notice from './ui/Notice.svelte';

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
    onopenfile: () => void;
    onsendall: (mode: 'copy' | 'move') => void;
    oncontext: (req: { key: number; x: number; y: number }) => void;
    onconfirm: (choice: 'save' | 'discard' | 'cancel') => void;
    onclosenotice: () => void;
  } = $props();

  let moreOpen = $state(false);
  const confirmFile = $derived(confirm ? files.find((f) => f.key === confirm.key) : undefined);

  async function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const i = files.findIndex((f) => f.key === activeKey);
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const el = t.closest<HTMLElement>('[data-file-key]');
      if (!el) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      oncontext({ key: Number(el.dataset.fileKey), x: r.left + r.width / 2, y: r.top + r.height / 2 });
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
      <div class="more">
        <IconButton icon="chevron-down" label="선택한 쪽 모두 보내기 방식" haspopup expanded={moreOpen} disabled={busy || selTotal === 0} onclick={() => (moreOpen = !moreOpen)} />
        {#if moreOpen}
          <div class="mini" role="menu" tabindex="-1" onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), (moreOpen = false))}>
            <button type="button" role="menuitem" onclick={() => { moreOpen = false; onsendall('copy'); }}>복사 → 새 파일</button>
            <button type="button" role="menuitem" title="원본 파일들에서 지우고 새 파일로 옮깁니다. 되돌리기는 함께 적용됩니다" onclick={() => { moreOpen = false; onsendall('move'); }} data-testid="send-all-move">이동 → 새 파일</button>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <div class="list" role="listbox" tabindex="-1" aria-label="열린 파일" onkeydown={onKey} data-testid="file-list">
    {#each files as f (f.key)}
      {@const isSelf = f.key === activeKey}
      <div
        class="row"
        class:active={isSelf}
        class:droppable={dragging && !isSelf}
        class:over={dragOver === f.key}
        class:disabled={dragging && isSelf}
        role="presentation"
        data-file-key={f.key}
        data-tab-key={f.key}
        data-tab-name={f.name}
        data-droppable={dragging && !isSelf ? '' : undefined}
        oncontextmenu={(e) => onCtx(e, f.key)}
        onpointerdown={(e) => longDown(e, f.key)}
        onpointerup={longCancel}
        onpointercancel={longCancel}
        onpointermove={longCancel}
      >
        <div
          class="opt"
          role="option"
          id="file-{f.key}"
          aria-selected={isSelf}
          aria-disabled={dragging && isSelf ? 'true' : undefined}
          tabindex={isSelf ? 0 : -1}
          title={f.dirty ? `${f.name} (변경됨)` : f.name}
          onclick={() => onactivate(f.key)}
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
    {/each}
  </div>

  <div
    class="newslot"
    class:droppable={dragging}
    class:over={dragOver === 'new'}
    role="note"
    title="빈 칸입니다. 쪽을 끌어다 놓으면 그 쪽만 든 새 파일이 만들어집니다. 클릭해도 아무것도 만들어지지 않습니다."
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
    border-radius: var(--radius);
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.16);
  }
  .mini button { border: 0; text-align: left; background: transparent; }
  .mini button:hover { background: var(--hover); }
  .list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; display: grid; gap: 2px; align-content: start; }
  .row {
    display: flex;
    align-items: center;
    border: 1px solid transparent;
    border-radius: var(--radius);
  }
  .row:hover { background: var(--hover); }
  .row.active { background: var(--surface); border-color: var(--fg-muted); }
  .row.droppable { border: 1px dashed var(--fg-muted); }
  .row.over { background: var(--accent); color: var(--accent-fg); border: 1px solid var(--accent); }
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
    border-radius: 6px;
    background: transparent;
    color: inherit;
  }
  @media (pointer: coarse) {
    .x { width: 36px; height: 36px; min-width: 36px; min-height: 36px; }
  }
  .pad { padding: 2px 2px 6px; }
  .newslot {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 6px 8px 8px;
    min-height: 56px;
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    color: var(--fg-muted);
  }
  .newslot.droppable { border-color: var(--fg-muted); color: var(--fg); }
  .newslot.over { background: var(--accent); color: var(--accent-fg); border: 1px solid var(--accent); }
</style>
