<script lang="ts">
  import { popIn, popOut, reduced, solveSpring, SPRING } from './motion';
  // 열린 파일 병합: 파일을 체크하고 끌어서(또는 행에서 Alt+↑/↓) 순서를 정해 새 탭 하나로 만든다. 원본 탭은 그대로 둔다.
  import { onDestroy, onMount, tick } from 'svelte';
  import { keyShift, posMsg, SortDrag } from './motion/sort-drag';
  import { moveItem, type MergeDoc } from './transfer';
  import { flip } from 'svelte/animate';
  import Icon from './ui/Icon.svelte';
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

  // 끄는 동안은 미리보기 순서로 그려 이웃이 비키고(FLIP), 끄는 행은 빈 슬롯이 된다
  let preview = $state<number[] | null>(null);
  let slotKey = $state<number | null>(null);
  let live = $state('');
  const flipSpring = solveSpring(SPRING.glide);
  let listEl: HTMLUListElement | undefined = $state();
  const byKey = (k: number) => docs.find((d) => d.key === k);
  const rows = $derived((preview ?? order).map(byKey).filter((d): d is MergeDoc => !!d));
  const picked = $derived(order.map(byKey).filter((d): d is MergeDoc => !!d && !!on[d.key]));
  const pages = $derived(picked.reduce((n, d) => n + d.total, 0));

  function moveTo(key: number, to: number) {
    const i = order.indexOf(key);
    if (i >= 0) order = moveItem(order, i, to);
  }
  const sort = new SortDrag({
    axis: 'y',
    scroller: () => listEl,
    itemEl: (k) => listEl?.querySelector<HTMLElement>(`[data-merge-row="${k}"]`) ?? null,
    keys: () => order,
    preview: (o) => (preview = o),
    slot: (k) => (slotKey = k),
    commit: moveTo,
    announce: (m) => (live = m),
    nameOf: (k) => byKey(k)?.name ?? '',
  });
  onDestroy(() => sort.dispose());
  function rowDown(e: PointerEvent, key: number) {
    if (busy || (e.target as Element).closest('input')) return;
    sort.start(e, key, !!(e.target as Element).closest('.grip'));
  }
  async function rowKey(e: KeyboardEvent, key: number) {
    const sh = keyShift(e, 'y');
    if (!sh || busy) return;
    e.preventDefault();
    const i = order.indexOf(key);
    const j = i + sh;
    if (i < 0 || j < 0 || j >= order.length) return;
    moveTo(key, j);
    live = posMsg(byKey(key)?.name ?? '', j, order.length);
    await tick();
  }
  function run() {
    onclearerror();
    onrun(picked.map((d) => d.key));
  }
</script>

<div class="pop stagger" bind:this={root} use:restoreFocus={{ fallback: ['[aria-label^="열린 파일 병합"]', '[data-testid=grid]'] }} in:popIn|global={{ origin: 'top left' }}
  out:popOut|global={{ origin: 'top left' }} role="dialog" aria-label="열린 파일 병합" data-testid="merge-pop" onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), onclose())} tabindex="-1">
  <p class="head">열린 파일 병합</p>
  <ul bind:this={listEl}>
    {#each rows as d (d.key)}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <li data-merge-row={d.key} class:slot={slotKey === d.key} animate:flip={{ duration: reduced() ? 0 : flipSpring.duration, easing: flipSpring.fn }} onpointerdown={(e) => rowDown(e, d.key)} onkeydown={(e) => void rowKey(e, d.key)}>
        <span class="grip" aria-hidden="true"><Icon name="grip" size={16} /></span>
        <label class="nm" title={d.name}>
          <input type="checkbox" bind:checked={on[d.key]} aria-label="{d.name} 포함" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" aria-describedby="merge-hint" />
          <span>{d.name}</span>
        </label>
        <span class="meta">{d.total}쪽</span>
      </li>
    {/each}
  </ul>
  <span id="merge-hint" class="hint">끌어서 순서를 바꿉니다. 키보드는 Alt+↑/↓</span>
  <span class="live" aria-live="polite" role="status">{live}</span>
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
  ul { position: relative; list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; max-height: 50vh; overflow-y: auto; }
  li { display: flex; align-items: center; gap: 2px; min-width: 0; border: 1px solid transparent; border-radius: var(--r-md); cursor: grab; }
  li.slot { background: color-mix(in srgb, var(--accent) 12%, transparent); border: 1px dashed var(--fg-muted); }
  li.slot > * { opacity: 0; }
  .grip { flex: none; display: grid; place-items: center; width: 24px; height: 32px; color: var(--fg-muted); touch-action: none; cursor: grab; }
  .hint { font-size: 12px; color: var(--fg-muted); }
  .live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .nm { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 32px; cursor: pointer; }

  .nm span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { flex: none; font-size: 12px; color: var(--fg-muted); font-variant-numeric: tabular-nums; margin-right: 4px; }
  .btns { display: flex; justify-content: flex-end; gap: 8px; }
</style>
