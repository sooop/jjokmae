<script lang="ts">
  // 좌측 썸네일 패널. 보이는 썸네일(+앞뒤 3칸)만 낮은 배율로 렌더하고, 벗어나면 비트맵을 버린다.
  // 다중 선택 표시와 드래그 재정렬(포인터 이벤트: 마우스·터치 공통)도 여기서 맡는다.
  import { onMount, untrack, type Snippet } from 'svelte';
  import type { PageSize } from '../engine/adapter';
  import { renderBucket } from './grid';
  import { DragSession } from './drag-session';
  import type { ScreenRect } from './motion/drag-ghost';
  import { notifyUpdated, registerHost, type PageHost } from './motion/page-flip';
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
    gen = 0,
    stateId = 0,
  }: {
    /** 문서 구조가 바뀔 때마다 오르는 값: 끄는 동안 바뀌면 끌기를 버린다 */
    stateId?: number;
    /** 문서 화면이 다시 만들어질 때 올라가는 값: 칸(캔버스)만 새로 만들고 스크롤·연출은 이어 간다 */
    gen?: number;
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
    onreorder?: (moving: number[], before: number, starts?: Map<number, ScreenRect>) => void;
    /** 위쪽 탭 위에 놓았을 때(마우스 전용): moving 쪽들을 그 탭의 문서로. rects 는 놓은 순간 고스트의 카드 자리 */
    ontabdrop?: (moving: number[], tabKey: number, rects?: ScreenRect[]) => void;
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
  // 누름·문턱·고스트·가장자리 스크롤·취소는 DragSession 이 맡고, 여기서는 삽입 자리와 대상 계산만 한다.
  const EDGE = 36;
  let drag = $state<{ moving: number[]; before: number; x: number; y: number; tab: number | null; tabName: string } | null>(null);
  let returning = $state<number[]>([]);
  const isMoving = (i: number) => (!!drag && drag.moving.includes(i)) || returning.includes(i);

  function beforeAt(clientY: number): number {
    const r = scroller.getBoundingClientRect();
    const y = clientY - r.top + scroller.scrollTop;
    for (let k = 0; k < sizes.length; k++) if (y < layout.tops[k] + itemH[k] / 2) return k;
    return sizes.length;
  }

  const session = new DragSession<{ before: number; tab: number | null }>({
    scroller: () => scroller,
    token: () => `${gen}:${stateId}`,
    edgeStep: 12,
    begin: (press, pt) => {
      const idx = press.index;
      const moving = checkedSet.has(idx) && checked.length > 1 ? [...checked].sort((a, b) => a - b) : [idx];
      drag = { moving, before: beforeAt(pt.y), x: pt.x, y: pt.y, tab: null, tabName: '' };
      ondragtab?.({ over: null });
      return moving;
    },
    label: () => ghostLabel(),
    update: () => updateDrag(),
    snapshot: () => ({ before: drag!.before, tab: drag!.tab }),
    drop: (moving, grabbed, rects, { before, tab }) => {
      if (tab != null) ontabdrop?.(moving, tab, rects);
      else {
        const starts = new Map<number, ScreenRect>();
        const ord = [grabbed, ...moving.filter((m) => m !== grabbed)];
        ord.forEach((m, k) => {
          const r = rects[Math.min(k, rects.length - 1)];
          if (r) starts.set(m, r);
        });
        onreorder?.(moving, before, starts);
      }
    },
    ended: () => ondragtab?.(null),
    clear: () => (drag = null),
    returning: (m) => (returning = m),
  });
  const onPress = (e: PointerEvent, index: number, handle: boolean) => {
    if (onreorder) session.start(e, index, handle);
  };
  // 끄는 사이 문서 화면이 바뀌면(되돌리기·다시하기 등) 집었던 번호가 낡았으므로 끌기를 버린다
  $effect(() => {
    void `${gen}:${stateId}`;
    untrack(() => session.tokenChanged());
  });

  function ghostLabel(): string {
    const d = drag;
    if (!d) return '';
    return d.tab != null ? `${d.moving.length}쪽을 ‘${d.tabName}’ 끝에 복사` : d.moving.length > 1 ? `${d.moving.length}쪽 이동` : `${d.moving[0] + 1}쪽 이동`;
  }

  function updateDrag() {
    if (!drag) return;
    const r = scroller.getBoundingClientRect();
    const pt = session.pt;
    drag.before = beforeAt(pt.y);
    // 탭 위에 있으면(마우스만) 재정렬이 아니라 그 탭의 문서로 복사하는 드래그다
    const el = session.dropElement();
    const tab = el ? Number(el.dataset.tabKey) : null;
    if (tab !== drag.tab) {
      drag.tab = tab;
      drag.tabName = el?.dataset.tabName ?? '';
      ondragtab?.({ over: tab });
    }
    session.edgeV = tab != null ? 0 : pt.y < r.top + EDGE ? -1 : pt.y > r.bottom - EDGE ? 1 : 0;
    session.ghost?.move(pt.x, pt.y);
    session.ghost?.setLabel(ghostLabel());
    session.ghost?.setTabMode(tab != null);
  }

  const canvasOf = (i: number) => scroller.querySelector<HTMLCanvasElement>(`[data-thumb="${i}"] canvas`);
  function pick(i: number, e: MouseEvent) {
    if (session.justDragged) return;
    onselect(i, e);
  }
  const dropTop = $derived.by(() => {
    if (!drag || !sizes.length) return 0;
    const b = drag.before;
    return b >= sizes.length ? layout.tops[sizes.length - 1] + itemH[sizes.length - 1] + GAP / 2 : layout.tops[b] - GAP / 2;
  });

  // ---------- 쪽 이동 연출(FLIP) 호스트 ----------
  let flyLayer: HTMLDivElement | undefined = $state();
  let holding = $state(false);
  let lay: { sizes: PageSize[]; box: number; tops: number[] } | null = null;
  function layoutOf(sz: PageSize[]) {
    if (lay && lay.sizes === sz && lay.box === boxW) return lay.tops;
    const bh = Math.round((boxW * 170) / 120);
    const hs = sz.map((s) => s.height * Math.min(boxW / s.width, bh / s.height) + LABEL);
    const tops = computeLayout(hs, GAP, PAD).tops;
    lay = { sizes: sz, box: boxW, tops };
    return tops;
  }
  const host: PageHost = {
    layer: () => flyLayer ?? null,
    sizes: () => sizes,
    frameRect: (idx, sz) => {
      const s = sz[idx];
      const f = Math.min(boxW / s.width, BOX_H / s.height);
      const fw = s.width * f;
      return { x: (scroller.clientWidth - fw) / 2, y: layoutOf(sz)[idx], w: fw, h: s.height * f };
    },
    viewport: () => ({ top: scroller.scrollTop, bottom: scroller.scrollTop + scroller.clientHeight }),
    canvas: (i) => canvasOf(i),
    checked: (i) => checkedSet.has(i),
    setHolding: (on) => (holding = on),
  };
  let lastGen = untrack(() => gen);
  $effect(() => {
    const g = gen;
    if (g !== lastGen) {
      lastGen = g;
      untrack(() => notifyUpdated());
    }
  });

  onMount(() => {
    const unreg = registerHost(host);
    const ro = new ResizeObserver(() => onScroll());
    ro.observe(scroller);
    update();
    return () => {
      unreg();
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      session.dispose();
    };
  });
</script>

<div class="thumbs" class:holding class:dragging={!!drag} bind:this={scroller} onscroll={onScroll} role="list" aria-label="페이지 썸네일" data-testid="thumbs">
  <div class="content" style:height="{layout.total}px">
    {#key gen}
    {#each sizes as s, i (i)}
      <div class="row" class:shifting={!!drag} role="listitem" style:top="{layout.tops[i]}px" style:height="{itemH[i]}px" style:transform={drag && drag.tab == null && (i === drag.before || i === drag.before - 1) ? `translateY(${i === drag.before ? 10 : -10}px)` : undefined}>
        <ThumbItem
          index={i}
          width={s.width * fit[i]}
          height={s.height * fit[i]}
          selected={i === current}
          checked={checkedSet.has(i)}
          moving={isMoving(i)}
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
    {/key}
    <div class="fly" bind:this={flyLayer} aria-hidden="true"></div>
    {#if drag && drag.tab == null}<div class="drop" style:transform="translateY({dropTop - 1.5}px)" data-testid="drop-line" data-before={drag.before} aria-hidden="true"></div>{/if}
  </div>
</div>

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
    top: 0;
    left: 6px;
    right: 6px;
    height: 3px;
    border-radius: 2px;
    background: var(--fg);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--bg) 70%, transparent), 0 0 12px color-mix(in srgb, var(--fg) 40%, transparent);
    pointer-events: none;
    z-index: 2;
    transition: transform var(--spring-pop-dur) var(--spring-pop);
    animation: kf-fade var(--dur-base) var(--ease-out);
  }
  .row {
    position: absolute;
    left: 0;
    right: 0;
  }
  .row.shifting { transition: transform var(--spring-glide-dur) var(--spring-glide); }
  .holding .row { visibility: hidden; }
  .thumbs.dragging :global(.actions), .thumbs.dragging :global(.grip) { opacity: 0 !important; visibility: hidden !important; }
  .fly { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
</style>
