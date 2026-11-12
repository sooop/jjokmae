<script lang="ts">
  // 본문 가상 스크롤 뷰어. 페이지 자리(높이)는 pageSize 로 미리 잡고, 보이는 쪽 + 앞뒤 1~2쪽만 렌더한다.
  // 화면에서 멀어진 쪽은 PageCanvas 가 요청을 취소하고 캔버스 크기를 0 으로 만들어 비트맵을 버린다.
  import { onMount, untrack, type Snippet } from 'svelte';
  import type { PageSize } from '../engine/adapter';
  import PageCanvas from './PageCanvas.svelte';
  import type { RenderScheduler } from './render-queue';
  import { computeLayout, indexAt } from './virtual';

  let {
    sizes,
    zoom,
    scheduler,
    current = $bindable(0),
    initialPage = 0,
    initialScroll = null,
    rev = [],
    overlay,
    ondraw,
  }: {
    sizes: PageSize[];
    zoom: number;
    scheduler: RenderScheduler;
    current?: number;
    initialPage?: number;
    /** 탭으로 돌아올 때 복원할 스크롤 위치(없으면 initialPage 로 간다) */
    initialScroll?: { top: number; left: number } | null;
    /** 쪽별 무효화 키. 바뀐 쪽만 다시 그린다 */
    rev?: number[];
    /** 쪽 위에 겹치는 레이어(쪽 번호, 렌더 창 안인지) */
    overlay?: Snippet<[number, boolean]>;
    /** 쪽 비트맵을 그린 직후(쪽 번호, 그 때의 rev) */
    ondraw?: (index: number, rev: number) => void;
  } = $props();

  // 시작 위치는 만들어질 때의 값으로 고정한다. current 와 같은 상태에 묶여 있어도, 마운트 직후 첫 레이아웃 계산이 current 를 0 으로
  // 쓴 값에 영향받지 않게 한다.
  const startPage = untrack(() => initialPage);
  const startScroll = untrack(() => initialScroll);

  const CSS_PER_PT = 96 / 72; // 100% = 96dpi
  const GAP = 12;
  const PAD = 16;
  /** 한 페이지 비트맵 상한(픽셀). 초과하면 배율을 낮추고 CSS 로 늘려 보여 준다 */
  const MAX_BITMAP_PX = 16_000_000;
  /** 렌더 창 전체 비트맵 상한(픽셀). 확대 시 앞뒤 여유 쪽을 먼저 줄인다 */
  const WINDOW_BUDGET_PX = 48_000_000;

  let scroller: HTMLDivElement;
  let dpr = $state(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  let winA = $state(0);
  let winB = $state(-1);

  const cssScale = $derived(zoom * CSS_PER_PT);
  const widths = $derived(sizes.map((s) => s.width * cssScale));
  const heights = $derived(sizes.map((s) => s.height * cssScale));
  const layout = $derived(computeLayout(heights, GAP, PAD));
  const maxW = $derived(widths.reduce((m, w) => Math.max(m, w), 0));

  function renderScale(i: number): number {
    const want = cssScale * dpr;
    const px = sizes[i].width * sizes[i].height * want * want;
    return px > MAX_BITMAP_PX ? want * Math.sqrt(MAX_BITMAP_PX / px) : want;
  }

  let lastTop = 0;
  let lockUntil = 0;
  let raf = 0;
  let pendingAnchor: { page: number; frac: number; xRatio: number } | null = null;
  let snap = { zoom: 0, tops: [] as number[], heights: [] as number[] };

  function update() {
    if (!scroller) return;
    const n = sizes.length;
    if (!n) return;
    dpr = devicePixelRatio || 1;
    const st = scroller.scrollTop;
    const h = scroller.clientHeight;
    const dir = st === lastTop ? 1 : st > lastTop ? 1 : -1;
    lastTop = st;
    const { tops } = layout;

    if (performance.now() >= lockUntil) {
      const atBottom = st + h >= scroller.scrollHeight - 1 && st > 0;
      const cur = atBottom ? n - 1 : indexAt(tops, st + h * 0.35);
      if (cur !== current) current = cur;
    }

    const first = indexAt(tops, st);
    const last = indexAt(tops, st + h);
    let a = Math.max(0, first - (dir > 0 ? 1 : 2));
    let b = Math.min(n - 1, last + (dir > 0 ? 2 : 1));
    const px = (i: number) => {
      const s = renderScale(i);
      return sizes[i].width * s * sizes[i].height * s;
    };
    let total = 0;
    for (let i = a; i <= b; i++) total += px(i);
    while (total > WINDOW_BUDGET_PX && (a < first || b > last)) {
      if (b - last >= first - a && b > last) total -= px(b--);
      else total -= px(a++);
    }
    if (a !== winA) winA = a;
    if (b !== winB) winB = b;
  }

  function onScroll() {
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    }
  }

  /** 지금 스크롤 위치(탭을 떠날 때 저장한다) */
  export function getScroll(): { top: number; left: number } {
    return { top: scroller?.scrollTop ?? 0, left: scroller?.scrollLeft ?? 0 };
  }

  export function scrollToPage(i: number) {
    if (!scroller || !sizes.length) return;
    const idx = Math.min(sizes.length - 1, Math.max(0, Math.round(i)));
    lockUntil = performance.now() + 300;
    current = idx;
    scroller.scrollTop = Math.max(0, layout.tops[idx] - 8);
    update();
  }

  // 확대 배율이 바뀌면 화면 중앙에 있던 지점을 그대로 유지한다.
  // DOM 갱신 전에 이전 배치로 기준점을 잡고(pre), 갱신 뒤에 새 배치로 스크롤을 복원한다.
  $effect.pre(() => {
    const z = zoom;
    if (scroller && z !== snap.zoom && snap.tops.length) {
      const y = scroller.scrollTop + scroller.clientHeight / 2;
      const page = indexAt(snap.tops, y);
      pendingAnchor = {
        page,
        frac: (y - snap.tops[page]) / (snap.heights[page] || 1),
        xRatio: (scroller.scrollLeft + scroller.clientWidth / 2) / (scroller.scrollWidth || 1),
      };
    }
  });

  $effect(() => {
    const lay = layout;
    const z = zoom;
    const hs = heights;
    if (pendingAnchor && scroller) {
      const a = pendingAnchor;
      pendingAnchor = null;
      lockUntil = performance.now() + 150;
      const y = lay.tops[a.page] + a.frac * hs[a.page];
      scroller.scrollTop = Math.max(0, y - scroller.clientHeight / 2);
      scroller.scrollLeft = Math.max(0, a.xRatio * scroller.scrollWidth - scroller.clientWidth / 2);
    }
    snap = { zoom: z, tops: lay.tops, heights: hs };
    untrack(update);
  });

  onMount(() => {
    const ro = new ResizeObserver(() => onScroll());
    ro.observe(scroller);
    // 조작 뒤 다시 만들어질 때 보던 쪽으로 곧바로 간다
    if (startScroll) {
      lockUntil = performance.now() + 300;
      scroller.scrollTop = startScroll.top;
      scroller.scrollLeft = startScroll.left;
      if (startPage > 0 && startPage < sizes.length) current = startPage;
    } else if (startPage > 0 && startPage < sizes.length) {
      lockUntil = performance.now() + 300;
      current = startPage;
      scroller.scrollTop = Math.max(0, layout.tops[startPage] - 8);
    }
    update();
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  });
</script>

<div class="scroller" bind:this={scroller} onscroll={onScroll} data-testid="scroller">
  <div class="content" style:height="{layout.total}px" style:min-width="{maxW + PAD * 2}px">
    {#each sizes as _, i (i)}
      <div
        class="slot"
        data-page={i}
        data-win={i >= winA && i <= winB ? '' : undefined}
        style:top="{layout.tops[i]}px"
        style:width="{widths[i]}px"
        style:height="{heights[i]}px"
        style:margin-left="{-widths[i] / 2}px"
      >
        <PageCanvas
          index={i}
          visible={i >= winA && i <= winB}
          scale={renderScale(i)}
          {scheduler}
          priority={() => Math.abs(i - current)}
          rev={rev[i] ?? 0}
          ondraw={(r) => ondraw?.(i, r)}
        />
        {@render overlay?.(i, i >= winA && i <= winB)}
      </div>
    {/each}
  </div>
</div>

<style>
  .scroller {
    position: absolute;
    inset: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .content {
    position: relative;
    width: 100%;
  }
  .slot {
    position: absolute;
    left: 50%;
    background: var(--page-bg);
    box-shadow: var(--page-shadow);
  }
</style>
