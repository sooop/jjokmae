<script lang="ts">
  import { popIn, popOut } from './motion';
  // 열린 파일 병합: 파일을 체크하고 위/아래 버튼으로 순서를 정해 새 탭 하나로 만든다. 원본 탭은 그대로 둔다.
  import { onMount } from 'svelte';
  import type { MergeDoc } from './transfer';
  import IconButton from './ui/IconButton.svelte';
  import { restoreFocus } from './ui/restore-focus';
  import Notice from './ui/Notice.svelte';

  let {
    docs,
    busy,
    error,
    onrun,
    onclose,
    onclearerror,
  }: {
    docs: MergeDoc[];
    busy: boolean;
    error: string | null;
    onrun: (keys: number[]) => void;
    onclose: () => void;
    onclearerror: () => void;
  } = $props();

  // 순서와 체크 상태. 처음에는 탭 순서 그대로 모두 체크한다.
  // svelte-ignore state_referenced_locally
  let order = $state<number[]>(docs.map((d) => d.key));
  // svelte-ignore state_referenced_locally
  let on = $state<Record<number, boolean>>(Object.fromEntries(docs.map((d) => [d.key, true])));
  let root: HTMLDivElement | undefined = $state();

  onMount(() => root?.querySelector<HTMLElement>('input')?.focus());

  const rows = $derived(order.map((k) => docs.find((d) => d.key === k)).filter((d): d is MergeDoc => !!d));
  const picked = $derived(rows.filter((d) => on[d.key]));
  const pages = $derived(picked.reduce((n, d) => n + d.total, 0));

  function move(i: number, delta: -1 | 1) {
    const j = i + delta;
    if (j < 0 || j >= order.length) return;
    const o = [...order];
    [o[i], o[j]] = [o[j], o[i]];
    order = o;
  }
  function run() {
    onclearerror();
    onrun(picked.map((d) => d.key));
  }
</script>

<div class="pop stagger" bind:this={root} use:restoreFocus={{ fallback: ['[aria-label^="열린 파일 병합"]', '[data-testid=grid]'] }} in:popIn|global={{ origin: 'top left' }}
  out:popOut|global={{ origin: 'top left' }} role="dialog" aria-label="열린 파일 병합" data-testid="merge-pop" onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), onclose())} tabindex="-1">
  <p class="head">열린 파일 병합</p>
  <ul>
    {#each rows as d, i (d.key)}
      <li data-merge-row={d.key}>
        <label class="nm" title={d.name}>
          <input type="checkbox" bind:checked={on[d.key]} aria-label="{d.name} 포함" />
          <span>{d.name}</span>
        </label>
        <span class="meta">{d.total}쪽</span>
        <IconButton icon="arrow-up" label="{d.name} 위로" onclick={() => move(i, -1)} disabled={i === 0 || busy} />
        <IconButton icon="arrow-down" label="{d.name} 아래로" onclick={() => move(i, 1)} disabled={i === rows.length - 1 || busy} />
      </li>
    {/each}
  </ul>
  {#if error}<Notice kind="error" text={error} onclose={onclearerror} />{/if}
  <div class="btns">
    <button type="button" onclick={onclose}>닫기</button>
    <button
      type="button"
      class="primary"
      disabled={busy || picked.length < 2}
      onclick={run}
      title={picked.length < 2 ? '두 파일 이상 체크하세요' : `${picked.length}개 파일, ${pages}쪽을 위에서 아래 순서로 이어 붙입니다`}
      data-testid="merge-run"
    >
      {busy ? '병합 중…' : '병합'}
    </button>
  </div>
</div>

<style>
  .pop {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 30;
    width: 340px;
    display: grid;
    gap: 8px;
    padding: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-2), var(--edge);
    outline: none;
  }
  .head { margin: 0; font-weight: 600; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; max-height: 50vh; overflow-y: auto; }
  li { display: flex; align-items: center; gap: 2px; min-width: 0; }
  .nm { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 32px; cursor: pointer; }

  .nm span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { flex: none; font-size: 12px; color: var(--fg-muted); font-variant-numeric: tabular-nums; margin-right: 4px; }
  .btns { display: flex; justify-content: flex-end; gap: 8px; }
</style>
