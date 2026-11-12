<script lang="ts">
  import { popIn, popOut } from './motion';
  // 분할 팝오버: 쪽 범위('1-3,5,8-') 또는 'N쪽마다'. 결과는 ZIP 하나로 내려받는다.
  import { onMount } from 'svelte';
  import { chunkEvery, parseRanges } from './ranges';
  import Notice from './ui/Notice.svelte';
  import { restoreFocus } from './ui/restore-focus';

  let {
    total,
    busy,
    error,
    onrun,
    onclose,
    onclearerror,
  }: {
    total: number;
    busy: boolean;
    /** 실행 중 생긴 오류(입력 오류는 이 컴포넌트가 입력칸 아래에 직접 보인다) */
    error: string | null;
    onrun: (groups: number[][]) => void;
    onclose: () => void;
    onclearerror: () => void;
  } = $props();

  let mode = $state<'ranges' | 'every'>('ranges');
  let ranges = $state('');
  let every = $state('1');
  let inputError = $state<string | null>(null);
  let first: HTMLInputElement | undefined = $state();

  onMount(() => first?.focus());

  function run() {
    onclearerror();
    const r = mode === 'ranges' ? parseRanges(ranges, total) : chunkEvery(Number(every), total);
    if (!r.ok) {
      inputError = r.error;
      return;
    }
    inputError = null;
    onrun(r.groups);
  }
</script>

<div class="pop stagger" use:restoreFocus={{ fallback: ['button[aria-label="나누기"]', '[data-testid=grid]'] }} in:popIn|global={{ origin: 'top right' }}
  out:popOut|global={{ origin: 'top right' }} role="dialog" aria-label="나누기" data-testid="split-pop" onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), onclose())} tabindex="-1">
  <label class="row">
    <input type="radio" name="split-mode" value="ranges" bind:group={mode} />
    <span>쪽 범위로 나누기</span>
  </label>
  <input
    bind:this={first}
    class="field"
    type="text"
    placeholder="1-3,5,8-"
    aria-label="쪽 범위"
    title="쉼표 하나가 파일 하나입니다. 예: 1-3,5,8-"
    bind:value={ranges}
    disabled={mode !== 'ranges'}
    onkeydown={(e) => e.key === 'Enter' && run()}
    data-testid="split-ranges"
  />
  <label class="row">
    <input type="radio" name="split-mode" value="every" bind:group={mode} />
    <span>N쪽마다 나누기</span>
  </label>
  <input
    class="field"
    type="number"
    min="1"
    max={total}
    inputmode="numeric"
    aria-label="나눌 쪽 수"
    bind:value={every}
    disabled={mode !== 'every'}
    onkeydown={(e) => e.key === 'Enter' && run()}
    data-testid="split-every"
  />
  {#if inputError}<p class="err" role="alert">{inputError}</p>{/if}
  {#if error}<Notice kind="error" text={error} onclose={onclearerror} />{/if}
  <div class="btns">
    <button type="button" onclick={onclose}>닫기</button>
    <button type="button" class="primary" disabled={busy} onclick={run} data-testid="split-run">{busy ? '나누는 중…' : '나누고 ZIP 으로 받기'}</button>
  </div>
</div>

<style>
  .pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    width: 300px;
    display: grid;
    gap: 6px;
    padding: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-2), var(--edge);
    outline: none;
  }
  .row { display: flex; align-items: center; gap: 8px; min-height: 28px; }

  .field { width: 100%; }
  .field:disabled { opacity: 0.5; }
  .err { margin: 0; font-size: 13px; color: var(--danger); line-height: 1.5; word-break: keep-all; }
  .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
</style>
