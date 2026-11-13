<script lang="ts">
  // 문서 안에서 찾기 줄. 뷰어 오른쪽 위에 뜬다. Enter 다음, Shift+Enter 이전, Esc 닫기.
  import { tick } from 'svelte';
  import type { FindState } from './find.svelte';
  import { noticeIn, noticeOut } from './motion';
  import IconButton from './ui/IconButton.svelte';

  let { find, onstep, onclose }: { find: FindState; onstep: (dir: 1 | -1) => void; onclose: () => void } = $props();

  let input: HTMLInputElement | undefined = $state();
  $effect(() => {
    void find.focusSeq;
    void tick().then(() => {
      input?.focus({ preventScroll: true });
      input?.select();
    });
  });

  const asked = $derived(find.query.trim().length > 0);
  const status = $derived(
    !asked ? '' : find.count ? `${find.index || '–'} / ${find.count}${find.busy ? '+' : ''}` : find.busy ? '찾는 중' : '없음',
  );

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      onstep(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="find" role="search" aria-label="문서에서 찾기" data-keep-selection data-testid="find-bar" onkeydown={onKey} in:noticeIn|global={{ y: -10 }} out:noticeOut|global>
  <input
    bind:this={input}
    bind:value={find.query}
    type="text"
    placeholder="문서에서 찾기"
    aria-label="찾을 말"
    spellcheck="false"
    autocomplete="off"
    data-testid="find-input"
  />
  <span class="status" class:none={asked && !find.count && !find.busy} role="status" aria-live="polite" data-testid="find-status">{status}</span>
  <button
    type="button"
    class="case"
    aria-pressed={find.matchCase}
    aria-label="대소문자 구분"
    title="대소문자 구분"
    onclick={() => (find.matchCase = !find.matchCase)}
  >Aa</button>
  <IconButton icon="arrow-up" label="이전 (Shift+Enter)" onclick={() => onstep(-1)} disabled={!find.count} />
  <IconButton icon="arrow-down" label="다음 (Enter)" onclick={() => onstep(1)} disabled={!find.count} />
  <IconButton icon="close" label="찾기 닫기 (Esc)" onclick={onclose} />
</div>

<style>
  .find {
    position: absolute;
    top: 10px;
    right: 22px;
    z-index: 9;
    display: flex;
    align-items: center;
    gap: 2px;
    max-width: calc(100% - 32px);
    padding: 4px 4px 4px 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-3), var(--edge);
    transform-origin: top right;
  }
  input {
    width: 200px;
    min-width: 60px;
    flex: 1 1 auto;
    padding: 4px 6px;
  }
  .status {
    flex: none;
    min-width: 64px;
    padding: 0 6px;
    text-align: center;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--fg-muted);
    white-space: nowrap;
  }
  .status.none { color: var(--danger); }
  .case {
    flex: none;
    width: 32px;
    height: 32px;
    padding: 0;
    border-color: transparent;
    background: transparent;
    box-shadow: none;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg-muted);
  }
  .case:hover { background: var(--hover); }
  .case[aria-pressed='true'] { background: var(--press); color: var(--fg); }
</style>
