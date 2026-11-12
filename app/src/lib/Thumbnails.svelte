<script lang="ts">
  // 좌측 썸네일 패널. 보이는 썸네일(+앞뒤 3칸)만 낮은 배율로 렌더하고, 벗어나면 비트맵을 버린다.
  // 다중 선택 표시와 드래그 재정렬(포인터 이벤트: 마우스·터치 공통)도 여기서 맡는다.
  import { onMount, untrack, type Snippet } from 'svelte';
  import type { PageSize } from '../engine/adapter';
  import { renderBucket } from './grid';
  import { settled } from './settle.svelte';
  import ThumbItem from './ThumbItem.svelte';
  import type { RenderScheduler } from './render-queue';
  import { computeLayout, indexAt } from './virtual';

  let {
    sizes,
    current,
    scheduler,
    rev = [],
    checked = [],
    onselect,
    onreorder,
    ontabdrop,
    ondragtab,
    actions,
    boxW = 120,
  }: {
    /** 썸네일 칸 폭(px). 패널 폭을 끌어 바꾸면 연속으로 바뀌고, 멈춘 뒤에 해상도를 다시 그린다 */
    boxW?: number;
    sizes: PageSize[];
    current: number;
    scheduler: RenderScheduler;
    /** 쪽별 무효화 키(바뀐 쪽만 다시 그린다) */
    rev?: number[];
    /** 다중 선택된 쪽(0부터) */
    checked?: number[];
    onselect: (index: number, e: MouseEvent) => void;
    /** 드래그로 놓았을 때: moving 쪽들을 before 번 쪽 앞(n 이면 맨 끝)으로 */
    onreorder?: (moving: number[], before: number) => void;
    /** 위쪽 탭 위에 놓았을 때(마우스 전용): moving 쪽들을 그 탭의 문서로 */
    ontabdrop?: (moving: number[], tabKey: number) => void;
    /** 드래그 상태 알림: 끌기 시작·이동 중에는 {over: 탭 key 또는 null}, 끝나면 null */
    ondragtab?: (state: { over: number | null } | null) => void;
    /** 항목별 아이콘 버튼 슬롯(ThumbItem 으로 전달) */
    actions?: Snippet<[number]>;
  } = $props();

  const BOX_H = $derived(Math.round((boxW * 170) / 120));
  const LABEL = 20;
  const GAP = 10;
  const PAD = 10;
  const BUFFER = 3;

  let scroller: HTMLDivElement;
  let dpr = $state(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  let winA = $state(0);
  let winB = $state(-1);

  const fit = $derived(sizes.map((s) => Math.min(boxW / s.width, BOX_H / s.height)));
  const settledW = settled(() => boxW, 240);
  const renderW = $derived(renderBucket(settledW.value));
  const fitR = $derived(sizes.map((s) => Math.min(renderW / s.width, (renderW * 170) / 120 / s.height)));
  const itemH = $derived(sizes.map((s, i) => s.height * fit[i] + LABEL));
  const layout = $derived(computeLayout(itemH, GAP, PAD));
  const checkedSet = $derived(new Set(checked));

  function update() {
    if (!scroller || !sizes.length) return;
    dpr = devicePixelRatio || 1;
    const st = scroller.scrollTop;
    const first = indexAt(layout.tops, st);
    const last = indexAt(layout.tops, st + scroller.clientHeight);
    const a = Math.max(0, first - BUFFER);
    const b = Math.min(sizes.length - 1, last + BUFFER);
    if (a !== winA) winA = a;
    if (b !== winB) winB = b;
  }

  let raf = 0;
  function onScroll() {
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    }
  }

  // 현재 쪽이 바뀌면 그 썸네일이 보이도록 맞춘다.
  $effect(() => {
    const c = current;
    untrack(() => {
      if (!scroller || c < 0 || c >= sizes.length) return;
      const top = layout.tops[c];
      const bottom = top + itemH[c];
      const st = scroller.scrollTop;
      const h = scroller.clientHeight;
      if (top < st || bottom > st + h) scroller.scrollTop = Math.max(0, top - (h - itemH[c]) / 2);
    });
  });

  $effect(() => {
    void layout;
    untrack(update);
  });

  // ---------- 드래그 재정렬 ----------
  const DRAG_THRESHOLD = 5;
  const EDGE = 36;
  let drag = $state<{ moving: number[]; before: number; x: number; y: number; tab: number | null; tabName: string } | null>(null);
  let press: { x: number; y: number; index: number; handle: boolean; id: number; mouse: boolean } | null = null;
  let justDragged = false;
  let edgeV = 0;
  let edgeRaf = 0;
  let lastPt = { x: 0, y: 0 };

  function beforeAt(clientY: number): number {
    const r = scroller.getBoundingClientRect();
    const y = clientY - r.top + scroller.scrollTop;
    for (let k = 0; k < sizes.length; k++) if (y < layout.tops[k] + itemH[k] / 2) return k;
    return sizes.length;
  }

  function onPress(e: PointerEvent, index: number, handle: boolean) {
    if (!onreorder || press) return;
    if (e.pointerType === 'mouse' ? e.button !== 0 : !handle) return;
    press = { x: e.clientX, y: e.clientY, index, handle, id: e.pointerId, mouse: e.pointerType === 'mouse' };
    lastPt = { x: e.clientX, y: e.clientY };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onDragKey, true);
  }

  function onMove(e: PointerEvent) {
    if (!press || e.pointerId !== press.id) return;
    lastPt = { x: e.clientX, y: e.clientY };
    if (!drag) {
      if (!press.handle && Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD) return;
      const idx = press.index;
      const moving = checkedSet.has(idx) && checked.length > 1 ? [...checked].sort((a, b) => a - b) : [idx];
      drag = { moving, before: beforeAt(e.clientY), x: e.clientX, y: e.clientY, tab: null, tabName: '' };
      ondragtab?.({ over: null });
      edgeLoop();
    }
    e.preventDefault();
    updateDrag();
  }

  function updateDrag() {
    if (!drag) return;
    const r = scroller.getBoundingClientRect();
    drag.x = lastPt.x;
    drag.y = lastPt.y;
    drag.before = beforeAt(lastPt.y);
    // 탭 위에 있으면(마우스만) 재정렬이 아니라 그 탭의 문서로 복사하는 드래그다
    const el = press?.mouse ? (document.elementFromPoint(lastPt.x, lastPt.y)?.closest('[data-droppable]') as HTMLElement | null) : null;
    const tab = el ? Number(el.dataset.tabKey) : null;
    if (tab !== drag.tab) {
      drag.tab = tab;
      drag.tabName = el?.dataset.tabName ?? '';
      ondragtab?.({ over: tab });
    }
    edgeV = tab != null ? 0 : lastPt.y < r.top + EDGE ? -1 : lastPt.y > r.bottom - EDGE ? 1 : 0;
  }

  function edgeLoop() {
    if (edgeRaf) return;
    const tick = () => {
      edgeRaf = 0;
      if (!drag) return;
      if (edgeV) {
        scroller.scrollTop += edgeV * 12;
        updateDrag();
      }
      edgeRaf = requestAnimationFrame(tick);
    };
    edgeRaf = requestAnimationFrame(tick);
  }

  function endDrag() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onDragKey, true);
    if (edgeRaf) cancelAnimationFrame(edgeRaf);
    edgeRaf = 0;
    edgeV = 0;
    press = null;
    if (drag) ondragtab?.(null);
    drag = null;
  }

  function suppressClick() {
    justDragged = true; // 이어지는 click 이 쪽 선택으로 처리되지 않게 한다
    setTimeout(() => (justDragged = false), 0);
  }

  function onUp(e: PointerEvent) {
    if (!press || e.pointerId !== press.id) return;
    const d = drag;
    if (d) {
      updateDrag();
      suppressClick();
      const before = drag!.before;
      const tab = drag!.tab;
      endDrag();
      if (tab != null) ontabdrop?.(d.moving, tab);
      else onreorder?.(d.moving, before);
    } else endDrag();
  }
  const onCancel = () => endDrag();
  function onDragKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && drag) {
      e.stopPropagation();
      suppressClick();
      endDrag();
    }
  }
  function pick(i: number, e: MouseEvent) {
    if (justDragged) return;
    onselect(i, e);
  }
  const dropTop = $derived.by(() => {
    if (!drag || !sizes.length) return 0;
    const b = drag.before;
    return b >= sizes.length ? layout.tops[sizes.length - 1] + itemH[sizes.length - 1] + GAP / 2 : layout.tops[b] - GAP / 2;
  });

  onMount(() => {
    const ro = new ResizeObserver(() => onScroll());
    ro.observe(scroller);
    update();
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      endDrag();
    };
  });
</script>

<div class="thumbs" bind:this={scroller} onscroll={onScroll} role="list" aria-label="페이지 썸네일" data-testid="thumbs">
  <div class="content" style:height="{layout.total}px">
    {#each sizes as s, i (i)}
      <div class="row" role="listitem" style:top="{layout.tops[i]}px" style:height="{itemH[i]}px">
        <ThumbItem
          index={i}
          width={s.width * fit[i]}
          height={s.height * fit[i]}
          selected={i === current}
          checked={checkedSet.has(i)}
          moving={!!drag && drag.moving.includes(i)}
          visible={i >= winA && i <= winB}
          scale={fitR[i] * dpr}
          {scheduler}
          rev={rev[i] ?? 0}
          priority={() => 100 + Math.abs(i - current)}
          onselect={pick}
          onpress={onreorder ? onPress : undefined}
          showActions={boxW >= 112}
          {actions}
        />
      </div>
    {/each}
    {#if drag && drag.tab == null}<div class="drop" style:top="{dropTop - 1.5}px" data-testid="drop-line" data-before={drag.before} aria-hidden="true"></div>{/if}
  </div>
</div>
{#if drag}
  <div class="ghost" style:left="{drag.x + 12}px" style:top="{drag.y + 12}px" aria-hidden="true">
    {drag.tab != null
      ? `${drag.moving.length}쪽을 ‘${drag.tabName}’ 끝에 복사`
      : drag.moving.length > 1
        ? `${drag.moving.length}쪽 이동`
        : `${drag.moving[0] + 1}쪽 이동`}
  </div>
{/if}

<style>
  .thumbs {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .content {
    position: relative;
  }
  .drop {
    position: absolute;
    left: 6px;
    right: 6px;
    height: 3px;
    border-radius: 2px;
    background: var(--fg);
    pointer-events: none;
    z-index: 2;
  }
  .ghost {
    position: fixed;
    z-index: 50;
    padding: 2px 8px;
    border-radius: var(--radius);
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 12px;
    pointer-events: none;
  }
  .row {
    position: absolute;
    left: 0;
    right: 0;
  }
</style>
