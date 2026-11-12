<script lang="ts">
  // 썸네일 패널 위쪽: 선택한 쪽에 대한 일괄 조작(회전·복제·삭제·추출). 안내는 이 줄 아래에 붙는다.
  import type { Snippet } from 'svelte';
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
</script>

<div class="tools" class:inline role="toolbar" aria-label="선택한 쪽 조작">
  <button type="button" class="count" onclick={onclear} disabled={count === 0} title="선택 해제 (Esc)" aria-label="{count}쪽 선택됨, 선택 해제">
    {count}쪽 선택
  </button>
  <div class="btns">
    <IconButton icon="rotate-cw" label="선택한 쪽 시계 방향 90° 회전" onclick={onrotate} disabled={off} />
    <IconButton icon="copy" label="선택한 쪽 뒤에 복제" onclick={oncopy} disabled={off} />
    {@render extra?.()}
    <IconButton icon="extract" label="선택한 쪽만 새 PDF 로 저장" onclick={onextract} disabled={off} />
    <IconButton icon="printer" label="선택한 쪽 인쇄" onclick={onprint} disabled={off} />
    <IconButton icon="trash" label="선택한 쪽 삭제 (Delete)" onclick={ondelete} disabled={off} />
  </div>
</div>
{#if notice}
  <div class="n"><Notice kind={notice.kind} text={notice.text} reassure={notice.reassure} detail={notice.detail} onclose={onclosenotice} /></div>
{/if}

<style>
  .tools { padding: 6px 4px 4px 8px; border-bottom: 1px solid var(--border); display: grid; gap: 2px; }
  .count {
    justify-self: start;
    min-height: 24px;
    padding: 0 6px;
    border-color: transparent;
    background: transparent;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-muted);
  }
  .btns { display: flex; flex-wrap: wrap; gap: 0; }
  .tools.inline { display: flex; align-items: center; gap: 4px; border-bottom: 0; padding: 4px 8px; }
  .n { padding: 6px 6px 0; }
</style>
