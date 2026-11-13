<script lang="ts">
  // 썸네일 패널 위쪽: 선택한 쪽에 대한 일괄 조작(회전·복제·삭제·추출). 안내는 이 줄 아래에 붙는다.
  // 줄이 좁아 단추가 다 들어가지 않으면 두 줄로 접지 않고, 넘치는 단추를 '더 보기' 메뉴로 옮긴다.
  import { onMount, type Snippet } from 'svelte';
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
  import type { NoticeData } from './status';
  import IconButton from './ui/IconButton.svelte';
  import Notice from './ui/Notice.svelte';

  let {
    count,
    busy,
    notice,
    onrotate,
    oncopy,
    ondelete,
    onextract,
    onprint,
    onclear,
    onclosenotice,
    extra,
    inline = false,
  }: {
    /** true 면 한 줄로 늘어놓는다(정리 모드 위쪽 도구 줄) */
    inline?: boolean;
    count: number;
    busy: boolean;
    notice: NoticeData | null;
    onrotate: () => void;
    oncopy: () => void;
    ondelete: () => void;
    onextract: () => void;
    onprint: () => void;
    onclear: () => void;
    onclosenotice: () => void;
    /** 보내기 버튼처럼 이 줄에 끼우는 항목(자기 팝오버를 가진다) */
    extra?: Snippet;
  } = $props();

  const off = $derived(busy || count === 0);

  type Act = 'rotate' | 'copy' | 'extract' | 'print' | 'trash';
  const ACTS: Record<Act, { label: string; run: () => void }> = {
    rotate: { label: '시계 방향 90° 회전', run: () => onrotate() },
    copy: { label: '뒤에 복제', run: () => oncopy() },
    extract: { label: '새 PDF 로 저장', run: () => onextract() },
    print: { label: '인쇄', run: () => onprint() },
    trash: { label: '삭제', run: () => ondelete() },
  };
  /** 자리가 모자랄 때 메뉴로 먼저 옮기는 순서(덜 자주 쓰는 것부터) */
  const SPILL: Act[] = ['print', 'extract', 'copy', 'rotate', 'trash'];
  const SHOWN: Act[] = ['rotate', 'copy', 'extract', 'print', 'trash'];

  let btnsEl: HTMLDivElement | undefined = $state();
  let moreEl: HTMLDivElement | undefined = $state();
  let avail = $state(Infinity);
  let btnW = 32;
  const spilled = $derived.by(() => {
    const total = SHOWN.length + (extra ? 1 : 0);
    const slots = Math.floor((avail + 0.5) / btnW);
    if (inline || slots >= total) return new Set<Act>();
    // 보내기 단추(자기 팝오버가 있다)와 '더 보기' 단추의 자리를 뺀 만큼만 남긴다
    const keep = Math.max(0, slots - 1 - (extra ? 1 : 0));
    return new Set(SPILL.slice(0, SHOWN.length - keep));
  });
  const menuItems = $derived<MenuItem[]>(SHOWN.filter((a) => spilled.has(a)).map((a) => ({ id: a, label: ACTS[a].label, disabled: off || undefined })));
  let menu = $state<{ x: number; y: number } | null>(null);
  $effect(() => {
    if (!spilled.size) menu = null;
  });
  let closedAt = 0;
  function closeMenu() {
    menu = null;
    closedAt = performance.now();
  }
  function toggleMenu() {
    // 열린 메뉴는 단추를 누르는 순간(바깥 누름) 이미 닫혔다: 같은 클릭으로 다시 열지 않는다
    if (menu || performance.now() - closedAt < 300) {
      menu = null;
      return;
    }
    const r = moreEl?.getBoundingClientRect();
    if (r) menu = { x: r.left, y: r.bottom + 4 };
  }
  function pick(path: string[]) {
    menu = null;
    ACTS[path[0] as Act]?.run();
  }

  onMount(() => {
    if (!btnsEl) return;
    btnW = matchMedia('(pointer: coarse)').matches ? 40 : 32;
    const ro = new ResizeObserver(() => {
      if (btnsEl) avail = btnsEl.clientWidth;
    });
    ro.observe(btnsEl);
    return () => ro.disconnect();
  });
</script>

<div class="tools" class:inline role="toolbar" aria-label="선택한 쪽 조작">
  {#if count > 0}
    <button type="button" class="count" onclick={onclear} title="선택 해제 (Esc)" aria-label="{count}쪽 선택됨, 선택 해제">
      {count}쪽 선택
    </button>
  {:else}
    <span class="count">0쪽 선택</span>
  {/if}
  <div class="btns" bind:this={btnsEl}>
    {#if !spilled.has('rotate')}<IconButton icon="rotate-cw" label="선택한 쪽 시계 방향 90° 회전" onclick={onrotate} disabled={off} />{/if}
    {#if !spilled.has('copy')}<IconButton icon="copy" label="선택한 쪽 뒤에 복제" onclick={oncopy} disabled={off} />{/if}
    {@render extra?.()}
    {#if !spilled.has('extract')}<IconButton icon="extract" label="선택한 쪽만 새 PDF 로 저장" onclick={onextract} disabled={off} />{/if}
    {#if !spilled.has('print')}<IconButton icon="printer" label="선택한 쪽 인쇄" onclick={onprint} disabled={off} />{/if}
    {#if !spilled.has('trash')}<IconButton icon="trash" label="선택한 쪽 삭제 (Delete)" onclick={ondelete} disabled={off} />{/if}
    {#if spilled.size}
      <div class="more" bind:this={moreEl} data-testid="tools-more">
        <IconButton icon="more" label="선택한 쪽 조작 더 보기" haspopup="menu" expanded={!!menu} onclick={toggleMenu} disabled={count === 0} />
      </div>
    {/if}
  </div>
</div>
{#if menu}
  <ContextMenu x={menu.x} y={menu.y} label="{count}쪽" items={menuItems} onpick={pick} onclose={closeMenu} />
{/if}
{#if notice}
  <div class="n"><Notice kind={notice.kind} text={notice.text} reassure={notice.reassure} detail={notice.detail} onclose={onclosenotice} /></div>
{/if}

<style>
  .tools { padding: 6px 4px 4px 8px; border-bottom: 1px solid var(--border); display: grid; gap: 2px; }
  .count {
    justify-self: start;
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 0 6px;
    border-color: transparent;
    background: transparent;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-muted);
  }
  .btns { display: flex; flex-wrap: nowrap; gap: 0; min-width: 0; }
  .more { display: contents; }
  .tools.inline { display: flex; align-items: center; gap: 4px; border-bottom: 0; padding: 4px 8px; }
  .n { padding: 6px 6px 0; }
</style>
