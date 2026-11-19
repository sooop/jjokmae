<script lang="ts">
  // 좌측 썸네일 패널. 보이는 썸네일(+앞뒤 3칸)만 낮은 배율로 렌더하고, 벗어나면 비트맵을 버린다.
  // 다중 선택 표시와 드래그 재정렬(포인터 이벤트: 마우스·터치 공통)도 여기서 맡는다.
  import { onMount, untrack } from 'svelte';
  import type { PageSize } from '../engine/adapter';
  import { renderBucket } from './grid';
  import { DragSession, gestureActive } from './drag-session';
  import type { CtxRequest } from './PageGrid.svelte';
  import { TouchHold } from './touch-hold';
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
    oncontext,
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
    /** 쪽을 눌렀다. shift·ctrl 이 모두 꺼져 있으면 '그 쪽으로 이동'(선택 모드에서는 부르는 쪽에 ctrl 로 바뀌어 온다), 체크박스는 ctrl 로 온다 */
    onselect: (index: number, mod: { shift: boolean; ctrl: boolean }) => void;
    /** 드래그로 놓았을 때: moving 쪽들을 before 번 쪽 앞(n 이면 맨 끝)으로 */
    onreorder?: (moving: number[], before: number, starts?: Map<number, ScreenRect>) => void;
    /** 위쪽 탭 위에 놓았을 때(마우스 전용): moving 쪽들을 그 탭의 문서로 복사한다(move 면 이동: Shift 를 누른 채 놓음). rects 는 놓은 순간 고스트의 카드 자리 */
    ontabdrop?: (moving: number[], tabKey: number, rects?: ScreenRect[], move?: boolean) => void;
    /** 드래그 상태 알림: 끌기 시작·이동 중에는 {over: 탭 key 또는 null}, 끝나면 null */
    ondragtab?: (state: { over: number | null } | null) => void;
    /** 우클릭·길게 누르기·메뉴 키: 쪽 메뉴를 열어 달라는 요청(pages 는 누른 칸이 선택에 있으면 선택 전체, 없으면 그 칸만) */
    oncontext?: (req: CtxRequest) => void;
  } = $props();

  const BOX_H = $derived(Math.round((boxW * 170) / 120));
  const LABEL = 20;
  const GAP = 10;
  const PAD = 10;
  const BUFFER = 3;
  /** DOM 에 두는 칸: 렌더 창보다 앞뒤로 더 넉넉히(스크롤할 때 칸을 만드는 일이 눈에 띄지 않게) */
  const DOM_BUFFER = 8;

  let scroller: HTMLDivElement;
  let dpr = $state(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  let winA = $state(0);
  let winB = $state(-1);
  let domA = $state(0);
  let domB = $state(-1);
  /** 키보드 포커스가 있는 칸: 창 밖으로 스크롤해도 DOM 에 남긴다 */
  let focusPin = $state(-1);
  const rows = $derived.by(() => {
    const n = sizes.length;
    const out: number[] = [];
    for (let i = Math.max(0, domA); i <= Math.min(n - 1, domB); i++) out.push(i);
    if (focusPin >= 0 && focusPin < n && (focusPin < domA || focusPin > domB)) {
      if (focusPin < domA) out.unshift(focusPin);
      else out.push(focusPin);
    }
    return out;
  });
  function onFocusIn(e: FocusEvent) {
    const el = (e.target as Element | null)?.closest?.('[data-thumb]') as HTMLElement | null;
    focusPin = el ? Number(el.dataset.thumb) : -1;
  }
  function onFocusOut(e: FocusEvent) {
    const to = e.relatedTarget as Element | null;
    if (!to || !scroller?.contains(to)) focusPin = -1;
  }

  const fit = $derived(sizes.map((s) => Math.min(boxW / s.width, BOX_H / s.height)));
  const settledW = settled(() => boxW, 240);
  const renderW = $derived(renderBucket(settledW.value));
  const fitR = $derived(sizes.map((s) => Math.min(renderW / s.width, (renderW * 170) / 120 / s.height)));
  const itemH = $derived(sizes.map((s, i) => s.height * fit[i] + LABEL));
  const layout = $derived(computeLayout(itemH, GAP, PAD));
  const checkedSet = $derived(new Set(checked));
  /** 선택이 하나라도 있다: 모든 칸에 체크박스를 보이고 본체 클릭이 선택을 토글한다 */
  const selectMode = $derived(checked.length > 0);

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
    const da = Math.max(0, first - DOM_BUFFER);
    const db = Math.min(sizes.length - 1, last + DOM_BUFFER);
    if (da !== domA) domA = da;
    if (db !== domB) domB = db;
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

  const session: DragSession<{ before: number; tab: number | null; move: boolean }> = new DragSession({
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
    snapshot: () => ({ before: drag!.before, tab: drag!.tab, move: session.shift }),
    drop: (moving, grabbed, rects, { before, tab, move }) => {
      if (tab != null) ontabdrop?.(moving, tab, rects, move);
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
  // 터치·펜: 길게 누르면 칸이 떠오르고(준비), 움직이면 끌기, 가만히 떼면 메뉴(touch-hold.ts)
  let armedIdx = $state(-1);
  const hold = new TouchHold({
    arm: (i) => (armedIdx = i),
    menu: (i, x, y) => openMenuAt(i, x, y, 'touch'),
    drag: (e, i) => {
      if (onreorder) session.start(e, i, true);
    },
    suppressClick: () => session.suppressClick(),
  });
  const onPress = (e: PointerEvent, index: number) => {
    if (e.pointerType !== 'mouse') hold.press(e, index);
    else if (onreorder) session.start(e, index, false);
  };
  // 끄는 사이 문서 화면이 바뀌면(되돌리기·다시하기 등) 집었던 번호가 낡았으므로 끌기를 버린다
  $effect(() => {
    void `${gen}:${stateId}`;
    untrack(() => session.tokenChanged());
  });

  function ghostLabel(): string {
    const d = drag;
    if (!d) return '';
    return d.tab != null ? `${d.moving.length}쪽을 ‘${d.tabName}’ 끝에 ${session.shift ? '이동' : '복사 · Shift 이동'}` : d.moving.length > 1 ? `${d.moving.length}쪽 이동` : `${d.moving[0] + 1}쪽 이동`;
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
    const mod = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    // 선택 모드에서는 일반 클릭도 선택 토글(이동은 선택 모드가 아닐 때만)
    if (selectMode && !mod.shift && !mod.ctrl) mod.ctrl = true;
    onselect(i, mod);
  }
  const check = (i: number, shift: boolean) => onselect(i, { shift, ctrl: true });

  // ---------- 쪽 메뉴: 우클릭·길게 누르기·메뉴 키 ----------
  function openMenuAt(i: number, x: number, y: number, via: CtxRequest['via']) {
    const pages = checkedSet.has(i) ? [...checked].sort((a, b) => a - b) : [i];
    oncontext?.({ x, y, index: i, pages, via });
  }
  const thumbOf = (t: EventTarget | null) => (t as Element | null)?.closest?.('[data-thumb]') as HTMLElement | null;
  function onCtx(e: MouseEvent) {
    const el = thumbOf(e.target);
    if (!el) return;
    e.preventDefault();
    if (hold.recent()) return; // 길게 누르기로 이미 연 메뉴
    openMenuAt(Number(el.dataset.thumb), e.clientX, e.clientY, 'mouse');
  }
  function onKeyDown(e: KeyboardEvent) {
    if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) || gestureActive()) return;
    const el = thumbOf(e.target);
    if (!el) return;
    e.preventDefault();
    const r = el.querySelector('.frame')?.getBoundingClientRect() ?? el.getBoundingClientRect();
    openMenuAt(Number(el.dataset.thumb), r.left + r.width / 2, r.top + r.height / 2, 'key');
  }
  const dropTop = $derived.by(() => {
    if (!drag || !sizes.length) return 0;
    const b = drag.before;
    return b >= sizes.length ? layout.tops[sizes.length - 1] + itemH[sizes.length - 1] + GAP / 2 : layout.tops[b] - GAP / 2;
  });

  // ---------- 쪽 이동 연출(FLIP) 호스트 ----------
  let flyLayer: HTMLDivElement | undefined = $state();
  let holding = $state(false);
  // 연출이 조작 전·후 배열로 번갈아 물으므로 배열별로 기억해 둔다(하나만 기억하면 물을 때마다 전체 배치를 다시 계산한다)
  const lays = new WeakMap<PageSize[], { box: number; tops: number[] }>();
  function layoutOf(sz: PageSize[]) {
    const lay = lays.get(sz);
    if (lay && lay.box === boxW) return lay.tops;
    const bh = Math.round((boxW * 170) / 120);
    const hs = sz.map((s) => s.height * Math.min(boxW / s.width, bh / s.height) + LABEL);
    const tops = computeLayout(hs, GAP, PAD).tops;
    lays.set(sz, { box: boxW, tops });
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
      hold.cancel();
    };
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="thumbs" class:holding class:dragging={!!drag} bind:this={scroller} onscroll={onScroll} onfocusin={onFocusIn} onfocusout={onFocusOut} oncontextmenu={onCtx} onkeydown={onKeyDown} role="list" aria-label="페이지 썸네일" data-testid="thumbs" data-pages={sizes.length}>
  <div class="content" style:height="{layout.total}px">
    {#key gen}
    {#each rows as i (i)}
      {@const s = sizes[i]}
      <div class="row" class:shifting={!!drag} role="listitem" aria-setsize={sizes.length} aria-posinset={i + 1} style:top="{layout.tops[i]}px" style:height="{itemH[i]}px" style:transform={drag && drag.tab == null && (i === drag.before || i === drag.before - 1) ? `translateY(${i === drag.before ? 10 : -10}px)` : undefined}>
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
          onpress={onPress}
          oncheck={check}
          {selectMode}
          armed={armedIdx === i}
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
  .fly { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
</style>
