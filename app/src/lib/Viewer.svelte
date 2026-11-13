<script lang="ts">
  // 본문 가상 스크롤 뷰어. 페이지 자리(높이)는 pageSize 로 미리 잡고, 보이는 쪽 + 앞뒤 1~2쪽만 렌더한다.
  // 화면에서 멀어진 쪽은 PageCanvas 가 요청을 취소하고 캔버스 크기를 0 으로 만들어 비트맵을 버린다.
  import { onMount, untrack, type Snippet } from 'svelte';
  import type { PageSize } from '../engine/adapter';
  import { animate, reduced } from './motion';
  import PageCanvas from './PageCanvas.svelte';
  import type { RenderScheduler } from './render-queue';
  import { clampZoom } from './settings';
  import { computeLayout, indexAt } from './virtual';

  let {
    sizes,
    zoom,
    liveZoom,
    scheduler,
    current = $bindable(0),
    initialPage = 0,
    initialScroll = null,
    rev = [],
    pinned = [],
    overlay,
    ondraw,
    onwheelzoom,
  }: {
    sizes: PageSize[];
    /** 배치·해상도를 정하는 확정 배율 */
    zoom: number;
    /** 슬라이더를 끄는 동안의 화면 배율: 배치는 그대로 두고 CSS 변환으로만 즉시 따라간다(멈추면 zoom 이 따라와 다시 그린다) */
    liveZoom?: number;
    scheduler: RenderScheduler;
    current?: number;
    initialPage?: number;
    /** 탭으로 돌아올 때 복원할 스크롤 위치(없으면 initialPage 로 간다) */
    initialScroll?: { top: number; left: number } | null;
    /** 쪽별 무효화 키. 바뀐 쪽만 다시 그린다 */
    rev?: number[];
    /**
     * 화면 밖이어도 DOM 에 남겨 둘 쪽(양식 칸이 있는 쪽·주석을 고른 쪽). 그 밖의 쪽은 렌더 창을 벗어나면 DOM 에서 뺀다
     * (쪽이 수백 장이어도 칸·레이어 수가 일정하다). 남겨 둔 쪽도 비트맵은 창 안에서만 그린다.
     */
    pinned?: number[];
    /** 쪽 위에 겹치는 레이어(쪽 번호, 렌더 창 안인지) */
    overlay?: Snippet<[number, boolean]>;
    /** 쪽 비트맵을 그린 직후(쪽 번호, 그 때의 rev) */
    ondraw?: (index: number, rev: number) => void;
    /** Ctrl+휠·트랙패드 핀치로 바꾸려는 화면 배율(25~400% 로 보정된 값). 부모가 liveZoom 으로 돌려주고 멈추면 확정한다 */
    onwheelzoom?: (zoom: number) => void;
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
  let contentEl: HTMLDivElement;
  /** 지금 화면에 보이는 실제 배율(확정 배율 × 변환) */
  let shownZoom = untrack(() => zoom);
  let zoomAnim: Animation | null = null;
  /** 휠 확대 중 포인터 아래에 고정할 지점(스크롤 영역 안 오프셋). 한 번의 연속 입력 동안 처음 값을 쓴다 */
  let anchorPt: { x: number; y: number } | null = null;
  const centerOrigin = () =>
    anchorPt
      ? `${scroller.scrollLeft + anchorPt.x}px ${scroller.scrollTop + anchorPt.y}px`
      : `${scroller.scrollLeft + scroller.clientWidth / 2}px ${scroller.scrollTop + scroller.clientHeight / 2}px`;

  function onWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault(); // 브라우저 기본 페이지 확대를 막는다
    if (!onwheelzoom || !sizes.length) return;
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    if (!dy) return;
    const cur = liveZoom ?? zoom;
    const next = clampZoom(cur * Math.exp(-dy * 0.0022));
    if (Math.abs(next - cur) < 1e-6) return;
    if (!anchorPt) {
      const r = scroller.getBoundingClientRect();
      anchorPt = { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    onwheelzoom(next);
  }

  // 끄는 동안: CSS 변환으로 즉시 반응한다(화면 가운데 지점을 기준으로)
  $effect(() => {
    const lz = liveZoom ?? zoom;
    const z = zoom;
    untrack(() => {
      if (!contentEl || !scroller) return;
      if (Math.abs(lz - z) < 1e-4) {
        if (!zoomAnim) contentEl.style.transform = '';
        return;
      }
      zoomAnim?.cancel();
      zoomAnim = null;
      if (!contentEl.style.transform) contentEl.style.transformOrigin = centerOrigin();
      contentEl.style.transform = `scale(${lz / z})`;
      shownZoom = lz;
    });
  });

  /** 확정 배율이 바뀐 직후: 보이던 배율에서 새 배치로 스프링으로 이어 준다 */
  function glideZoom(z: number) {
    const from = shownZoom / z;
    shownZoom = z;
    if (!contentEl) return;
    zoomAnim?.cancel();
    zoomAnim = null;
    contentEl.style.transform = '';
    if (reduced() || Math.abs(from - 1) < 0.003) return;
    contentEl.style.transformOrigin = centerOrigin();
    const a = animate(contentEl, [{ transform: `scale(${from})` }, { transform: 'scale(1)' }], { spring: 'heavy', fill: 'none' });
    zoomAnim = a;
    if (a) a.onfinish = a.oncancel = () => { if (zoomAnim === a) zoomAnim = null; };
  }
  let dpr = $state(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  let winA = $state(0);
  let winB = $state(-1);
  /** 비트맵이 그려진 쪽(창 밖으로 나가면 지운다). 그려지기 전의 자리표시 배경에 쓴다 */
  let drawnPages = $state<Record<number, boolean>>({});
  $effect(() => {
    const a = winA;
    const b = winB;
    untrack(() => {
      for (const k of Object.keys(drawnPages)) {
        const i = Number(k);
        if (i < a || i > b) delete drawnPages[i];
      }
    });
  });

  /** 입력 포커스가 있는 쪽: 창 밖으로 스크롤해도 DOM 에 남긴다(입력 중인 내용·포커스가 사라지지 않게) */
  let focusPin = $state(-1);
  const domPages = $derived.by(() => {
    const n = sizes.length;
    const out: number[] = [];
    for (let i = Math.max(0, winA); i <= Math.min(n - 1, winB); i++) out.push(i);
    const extra = focusPin >= 0 ? [...pinned, focusPin] : pinned;
    let add = false;
    for (const i of extra) {
      if (i >= 0 && i < n && (i < winA || i > winB) && !out.includes(i)) {
        out.push(i);
        add = true;
      }
    }
    return add ? out.sort((a, b) => a - b) : out;
  });
  function onFocusIn(e: FocusEvent) {
    const el = (e.target as Element | null)?.closest?.('[data-page]') as HTMLElement | null;
    focusPin = el ? Number(el.dataset.page) : -1;
  }
  function onFocusOut(e: FocusEvent) {
    const to = e.relatedTarget as Element | null;
    if (!to || !scroller?.contains(to)) focusPin = -1;
  }

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
  let pendingAnchor: { page: number; frac: number; xRatio: number; ax: number; ay: number } | null = null;
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

  let scrollIdle = 0;
  function onScroll() {
    const el = scroller;
    if (el) {
      el.dataset.scrolling = '';
      clearTimeout(scrollIdle);
      scrollIdle = window.setTimeout(() => delete el.dataset.scrolling, 160);
    }
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

  /**
   * 쪽 안의 사각형(쪽 공간 pt)이 보이게 한다. 이미 여유 있게 보이면 스크롤하지 않는다(찾기 결과로 이동할 때).
   * 쪽이 DOM 에 없어도 배치 계산만으로 간다.
   */
  export function revealRect(i: number, r: { x: number; y: number; w: number; h: number }) {
    if (!scroller || i < 0 || i >= sizes.length) return;
    const M = 48;
    const top = layout.tops[i] + r.y * cssScale;
    const bottom = top + r.h * cssScale;
    const st = scroller.scrollTop;
    const vh = scroller.clientHeight;
    if (top < st + M || bottom > st + vh - M) {
      lockUntil = performance.now() + 150;
      current = i;
      scroller.scrollTop = Math.max(0, top - vh * 0.35);
    }
    const vw = scroller.clientWidth;
    const contentW = Math.max(vw, maxW + PAD * 2);
    const left = (contentW - widths[i]) / 2 + r.x * cssScale;
    const right = left + r.w * cssScale;
    const sl = scroller.scrollLeft;
    if (left < sl + 16 || right > sl + vw - 16) scroller.scrollLeft = Math.max(0, left - Math.min(vw * 0.3, 120));
    update();
  }

  // 확대 배율이 바뀌면 화면 중앙에 있던 지점을 그대로 유지한다.
  // DOM 갱신 전에 이전 배치로 기준점을 잡고(pre), 갱신 뒤에 새 배치로 스크롤을 복원한다.
  $effect.pre(() => {
    const z = zoom;
    if (scroller && z !== snap.zoom && snap.tops.length) {
      const ax = anchorPt?.x ?? scroller.clientWidth / 2;
      const ay = anchorPt?.y ?? scroller.clientHeight / 2;
      const y = scroller.scrollTop + ay;
      const page = indexAt(snap.tops, y);
      pendingAnchor = {
        page,
        frac: (y - snap.tops[page]) / (snap.heights[page] || 1),
        xRatio: (scroller.scrollLeft + ax) / (scroller.scrollWidth || 1),
        ax,
        ay,
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
      scroller.scrollTop = Math.max(0, y - a.ay);
      scroller.scrollLeft = Math.max(0, a.xRatio * scroller.scrollWidth - a.ax);
      glideZoom(z);
      anchorPt = null;
    }
    snap = { zoom: z, tops: lay.tops, heights: hs };
    untrack(update);
  });

  onMount(() => {
    const ro = new ResizeObserver(() => onScroll());
    ro.observe(scroller);
    scroller.addEventListener('wheel', onWheel, { passive: false });
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
      scroller.removeEventListener('wheel', onWheel);
      if (raf) cancelAnimationFrame(raf);
    };
  });
</script>

<div class="scroller" bind:this={scroller} onscroll={onScroll} onfocusin={onFocusIn} onfocusout={onFocusOut} data-testid="scroller" data-pages={sizes.length}>
  <div class="content" bind:this={contentEl} style:height="{layout.total}px" style:min-width="{maxW + PAD * 2}px">
    {#each domPages as i (i)}
      <div
        class="slot"
        data-page={i}
        class:blank={i >= winA && i <= winB && !drawnPages[i]}
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
          ondraw={(r) => {
            drawnPages[i] = true;
            ondraw?.(i, r);
          }}
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
    /* 쪽 사이 빈 곳을 끌 때 브라우저의 기본 선택(쪽 전체가 파랗게 칠해짐)이 생기지 않게 한다. 입력 칸·글상자는 각자 선택을 허용한다 */
    user-select: none;
    -webkit-user-select: none;
  }
  .scroller :global(input), .scroller :global(textarea), .scroller :global(select) { user-select: text; -webkit-user-select: text; }
  .content {
    position: relative;
    width: 100%;
    will-change: auto;
  }
  .slot {
    position: absolute;
    left: 50%;
    background: var(--page-bg);
    box-shadow: var(--page-shadow);
  }
  /* 아직 그려지지 않은 쪽은 정적인 자리표시(그려지면 캔버스가 부드럽게 나타난다) */
  .slot.blank { background: color-mix(in srgb, var(--page-bg) 95%, var(--fg)); }
  @media print { .slot { background: #fff !important; } }
</style>
