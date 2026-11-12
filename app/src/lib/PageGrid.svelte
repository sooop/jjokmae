<script lang="ts" module>
  export interface CtxRequest {
    x: number;
    y: number;
    index: number;
    pages: number[];
    via: 'mouse' | 'touch' | 'key';
  }
  export type DropTarget = number | 'new';
</script>

<script lang="ts">
  // 정리 모드의 쪽 썸네일 격자. 보이는 줄(+앞뒤 한 줄)만 렌더하고, 선택(클릭·Ctrl·Shift·영역 끌기·키보드)과
  // 드래그(격자 안 재정렬 / 왼쪽 파일 목록으로 보내기), 우클릭·길게 누르기 메뉴 요청을 맡는다.
  // 선택은 부모(DocState.selected)와 공유한다. 이 컴포넌트는 선택을 직접 들고 있지 않는다.
  import { onMount, untrack, type Snippet } from 'svelte';
  import type { PageSize } from '../engine/adapter';
  import { bandHits, cellAt, cellRect, dropAt, GRID_ASPECT, gridGeom, moveFocus, renderBucket, visibleRows, type DropSpot } from './grid';
  import type { RenderScheduler } from './render-queue';
  import { clickSelect, span } from './selection';
  import { GRID_MAX, GRID_MIN } from './settings';
  import { settled } from './settle.svelte';
  import ThumbItem from './ThumbItem.svelte';

  let {
    sizes,
    scheduler,
    rev = [],
    gen,
    selected,
    anchor,
    thumb,
    initialScroll = 0,
    actions,
    onthumb,
    onscrollpos,
    onchange,
    onreorder,
    ontabdrop,
    ondragtab,
    onopen,
    oncontext,
    onremove,
  }: {
    sizes: PageSize[];
    scheduler: RenderScheduler;
    rev?: number[];
    /** 문서 화면이 다시 만들어질 때 올라가는 값: 칸(캔버스)만 새로 만들고 스크롤은 그대로 둔다 */
    gen: number;
    selected: number[];
    anchor: number | null;
    /** 썸네일 칸 폭(px). 연속으로 바뀌는 동안은 CSS 로만 보이고, 멈춘 뒤 해상도를 다시 그린다 */
    thumb: number;
    initialScroll?: number;
    actions?: Snippet<[number]>;
    onthumb: (v: number) => void;
    onscrollpos?: (top: number) => void;
    onchange: (selected: number[], anchor: number | null) => void;
    /** 격자 안에서 놓았을 때: moving 쪽들을 before 번 쪽 앞(n 이면 맨 끝)으로 */
    onreorder: (moving: number[], before: number) => void;
    /** 왼쪽 파일 목록의 항목이나 '새 파일' 칸 위에 놓았을 때(마우스) */
    ontabdrop: (moving: number[], target: DropTarget) => void;
    /** 끌기 상태 알림: 끌기 시작·이동 중에는 {over}, 끝나면 null */
    ondragtab: (state: { over: DropTarget | null } | null) => void;
    onopen: (index: number) => void;
    oncontext: (req: CtxRequest) => void;
    onremove: (pages: number[]) => void;
  } = $props();

  const MAX_LIVE = 120;
  const DRAG_THRESHOLD = 5;
  const EDGE = 36;

  let scroller: HTMLDivElement;
  let W = $state(800);
  let H = $state(600);
  let scrollTop = $state(0);
  let dpr = $state(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  let focusIdx = $state(0);
  let hasFocus = $state(false);

  const n = $derived(sizes.length);
  const geom = $derived(gridGeom(W, thumb, n));
  const vis = $derived(visibleRows(geom, scrollTop, H));
  const win = $derived.by(() => {
    const [a, b] = vis;
    if (b < a) return { rA: 0, rB: -1, dA: 0, dB: -1 };
    const cols = geom.cols;
    const span1 = (buf: number) => [Math.max(0, (a - buf) * cols), Math.min(n - 1, (b + buf + 1) * cols - 1)] as const;
    const [r1A, r1B] = span1(1);
    const [rA, rB] = r1B - r1A + 1 > MAX_LIVE ? span1(0) : [r1A, r1B];
    const [dA, dB] = span1(3);
    return { rA, rB, dA: Math.min(dA, rA), dB: Math.max(dB, rB) };
  });
  const cells = $derived.by(() => {
    const out: number[] = [];
    for (let i = win.dA; i <= win.dB; i++) out.push(i);
    return out;
  });
  const selSet = $derived(new Set(selected));

  // 렌더 해상도는 멈춘 뒤의 크기를 따른다. 화면 크기(thumb)는 바로 반영(CSS)한다.
  const settledThumb = settled(() => thumb, 240);
  const renderT = $derived(renderBucket(settledThumb.value));
  const boxH = $derived(Math.round(geom.cellW * GRID_ASPECT));
  const fitLive = (s: PageSize) => Math.min(geom.cellW / s.width, boxH / s.height);
  const renderScale = (s: PageSize) => Math.min(renderT / s.width, (renderT * GRID_ASPECT) / s.height) * dpr;
  const showActions = $derived(geom.cellW >= 112);

  let centerIdx = 0;
  let lastTopIdx = 0;
  let raf = 0;

  function update() {
    if (!scroller) return;
    dpr = devicePixelRatio || 1;
    W = scroller.clientWidth;
    H = scroller.clientHeight;
    scrollTop = scroller.scrollTop;
    onscrollpos?.(scrollTop);
    const g = untrack(() => geom);
    if (g.n) {
      const row = Math.floor((scrollTop + H / 2 - g.pad) / (g.cellH + g.gap));
      centerIdx = Math.min(g.n - 1, Math.max(0, row * g.cols));
      lastTopIdx = Math.min(g.n - 1, Math.max(0, Math.floor((scrollTop + 1 - g.pad) / (g.cellH + g.gap)) * g.cols));
    }
  }
  function onScroll() {
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    }
  }

  // 칸 크기·열 수가 바뀌면 맨 위에 보이던 쪽이 그대로 맨 위에 오게 스크롤을 맞춘다
  let lastGeomKey = '';
  $effect(() => {
    const g = geom;
    const key = `${g.cols}:${g.cellH}`;
    untrack(() => {
      if (lastGeomKey && key !== lastGeomKey && scroller && g.n) {
        scroller.scrollTop = Math.max(0, cellRect(g, lastTopIdx).y - g.pad);
        update();
      }
      lastGeomKey = key;
    });
  });

  /** 포커스 칸이 보이게 스크롤 */
  function reveal(i: number) {
    if (!scroller || !n) return;
    const r = cellRect(geom, i);
    if (r.y < scroller.scrollTop) scroller.scrollTop = Math.max(0, r.y - geom.pad);
    else if (r.y + r.h > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = r.y + r.h - scroller.clientHeight + geom.pad;
    update();
  }

  // ---------- 선택 ----------
  let justDragged = false;
  function suppressClick() {
    justDragged = true;
    setTimeout(() => (justDragged = false), 0);
  }
  const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((v, k) => v === b[k]);

  function pick(i: number, e: MouseEvent) {
    if (justDragged) return;
    const r = clickSelect(selected, anchor, i, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
    onchange(r.selected, r.anchor);
    focusIdx = i;
    scroller.focus({ preventScroll: true });
  }

  // ---------- 영역(러버밴드) 선택 ----------
  let band = $state<{ x: number; y: number; w: number; h: number } | null>(null);
  let bandSt: { id: number; x0: number; y0: number; add: boolean; base: number[]; active: boolean; baseAnchor: number | null } | null = null;
  let lastPt = { x: 0, y: 0 };
  let edgeV = 0;
  let edgeRaf = 0;

  function contentPt(cx: number, cy: number) {
    const r = scroller.getBoundingClientRect();
    return { x: cx - r.left + scroller.scrollLeft, y: cy - r.top + scroller.scrollTop };
  }

  function onBgDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const el = e.target as Element;
    if (el.closest('[data-thumb]')) return;
    const r = scroller.getBoundingClientRect();
    if (e.clientX > r.left + scroller.clientWidth) return; // 스크롤바
    scroller.focus({ preventScroll: true });
    if (e.pointerType !== 'mouse') return; // 터치는 빈 곳 끌기가 스크롤이다
    const p = contentPt(e.clientX, e.clientY);
    const add = e.ctrlKey || e.metaKey;
    bandSt = { id: e.pointerId, x0: p.x, y0: p.y, add, base: add ? [...selected] : [], active: false, baseAnchor: anchor };
    lastPt = { x: e.clientX, y: e.clientY };
    window.addEventListener('pointermove', onBandMove);
    window.addEventListener('pointerup', onBandUp);
    window.addEventListener('pointercancel', endBand);
    window.addEventListener('keydown', onBandKey, true);
  }

  function updateBand() {
    if (!bandSt) return;
    const p = contentPt(lastPt.x, lastPt.y);
    const x2 = Math.min(Math.max(p.x, 0), W);
    const y2 = Math.min(Math.max(p.y, 0), geom.height);
    const x1 = bandSt.x0;
    const y1 = bandSt.y0;
    band = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    const hits = bandHits(geom, x1, y1, x2, y2);
    const next = bandSt.add ? [...new Set([...bandSt.base, ...hits])].sort((a, b) => a - b) : hits;
    if (!sameList(next, selected)) onchange(next, next.length ? (bandSt.add ? bandSt.baseAnchor : next[0]) : null);
    const r = scroller.getBoundingClientRect();
    edgeV = lastPt.y < r.top + EDGE ? -1 : lastPt.y > r.bottom - EDGE ? 1 : 0;
  }

  function bandEdgeLoop() {
    if (edgeRaf) return;
    const tick = () => {
      edgeRaf = 0;
      if (!bandSt?.active) return;
      if (edgeV) {
        scroller.scrollTop += edgeV * 14;
        updateBand();
      }
      edgeRaf = requestAnimationFrame(tick);
    };
    edgeRaf = requestAnimationFrame(tick);
  }

  function onBandMove(e: PointerEvent) {
    if (!bandSt || e.pointerId !== bandSt.id) return;
    lastPt = { x: e.clientX, y: e.clientY };
    if (!bandSt.active) {
      const p = contentPt(e.clientX, e.clientY);
      if (Math.hypot(p.x - bandSt.x0, p.y - bandSt.y0) < 4) return;
      bandSt.active = true;
      bandEdgeLoop();
    }
    e.preventDefault();
    updateBand();
  }

  function onBandUp(e: PointerEvent) {
    if (!bandSt || e.pointerId !== bandSt.id) return;
    const st = bandSt;
    if (!st.active && !st.add) onchange([], null); // 빈 곳을 한 번 누르면 선택 해제
    if (st.active) suppressClick();
    endBand();
  }

  function onBandKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !bandSt) return;
    e.stopPropagation();
    const st = bandSt;
    endBand();
    if (st.active) onchange(st.base, st.baseAnchor);
  }

  function endBand() {
    window.removeEventListener('pointermove', onBandMove);
    window.removeEventListener('pointerup', onBandUp);
    window.removeEventListener('pointercancel', endBand);
    window.removeEventListener('keydown', onBandKey, true);
    if (edgeRaf) cancelAnimationFrame(edgeRaf);
    edgeRaf = 0;
    edgeV = 0;
    bandSt = null;
    band = null;
  }

  // ---------- 드래그: 격자 안 재정렬 / 파일 목록으로 보내기 ----------
  let drag = $state<{ moving: number[]; spot: DropSpot; x: number; y: number; target: DropTarget | null; targetName: string } | null>(null);
  let press: { x: number; y: number; index: number; handle: boolean; id: number; mouse: boolean } | null = null;

  function onPress(e: PointerEvent, index: number, handle: boolean) {
    if (press) return;
    if (e.pointerType === 'mouse' ? e.button !== 0 : !handle) return;
    press = { x: e.clientX, y: e.clientY, index, handle, id: e.pointerId, mouse: e.pointerType === 'mouse' };
    lastPt = { x: e.clientX, y: e.clientY };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('keydown', onDragKey, true);
  }

  function onMove(e: PointerEvent) {
    if (!press || e.pointerId !== press.id) return;
    lastPt = { x: e.clientX, y: e.clientY };
    if (!drag) {
      if (!press.handle && Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD) return;
      cancelLong();
      const idx = press.index;
      const moving = selSet.has(idx) && selected.length > 1 ? [...selected].sort((a, b) => a - b) : [idx];
      const p = contentPt(e.clientX, e.clientY);
      drag = { moving, spot: dropAt(geom, p.x, p.y), x: e.clientX, y: e.clientY, target: null, targetName: '' };
      ondragtab({ over: null });
      dragEdgeLoop();
    }
    e.preventDefault();
    updateDrag();
  }

  function updateDrag() {
    if (!drag) return;
    const r = scroller.getBoundingClientRect();
    drag.x = lastPt.x;
    drag.y = lastPt.y;
    const p = contentPt(lastPt.x, lastPt.y);
    drag.spot = dropAt(geom, p.x, p.y);
    // 파일 목록 항목 위면(마우스만) 재정렬이 아니라 그 파일로 복사하는 드래그다
    const el = press?.mouse ? (document.elementFromPoint(lastPt.x, lastPt.y)?.closest('[data-droppable]') as HTMLElement | null) : null;
    const target: DropTarget | null = el ? (el.dataset.newFile != null ? 'new' : Number(el.dataset.tabKey)) : null;
    if (target !== drag.target) {
      drag.target = target;
      drag.targetName = el?.dataset.tabName ?? '';
      ondragtab({ over: target });
    }
    edgeV = target != null ? 0 : lastPt.y < r.top + EDGE ? -1 : lastPt.y > r.bottom - EDGE ? 1 : 0;
  }

  function dragEdgeLoop() {
    if (edgeRaf) return;
    const tick = () => {
      edgeRaf = 0;
      if (!drag) return;
      if (edgeV) {
        scroller.scrollTop += edgeV * 14;
        updateDrag();
      }
      edgeRaf = requestAnimationFrame(tick);
    };
    edgeRaf = requestAnimationFrame(tick);
  }

  function endDrag() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', endDrag);
    window.removeEventListener('keydown', onDragKey, true);
    if (edgeRaf) cancelAnimationFrame(edgeRaf);
    edgeRaf = 0;
    edgeV = 0;
    press = null;
    if (drag) ondragtab(null);
    drag = null;
  }

  function onUp(e: PointerEvent) {
    if (!press || e.pointerId !== press.id) return;
    const d = drag;
    if (d) {
      updateDrag();
      suppressClick();
      const { before } = drag!.spot;
      const target = drag!.target;
      endDrag();
      if (target != null) ontabdrop(d.moving, target);
      else onreorder(d.moving, before);
    } else endDrag();
  }

  function onDragKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && drag) {
      e.stopPropagation();
      suppressClick();
      endDrag();
    }
  }

  // ---------- 길게 누르기(터치) = 우클릭 메뉴 ----------
  let longTimer = 0;
  let longStart: { x: number; y: number; id: number } | null = null;
  let longAt = 0;

  function cancelLong() {
    if (longTimer) clearTimeout(longTimer);
    longTimer = 0;
    longStart = null;
    window.removeEventListener('pointermove', onLongMove);
    window.removeEventListener('pointerup', cancelLong);
    window.removeEventListener('pointercancel', cancelLong);
  }
  function onLongMove(e: PointerEvent) {
    if (longStart && e.pointerId === longStart.id && Math.hypot(e.clientX - longStart.x, e.clientY - longStart.y) > 8) cancelLong();
  }
  function onScrollerDown(e: PointerEvent) {
    onBgDown(e);
    if (e.pointerType === 'mouse') return;
    const el = (e.target as Element).closest('[data-thumb]') as HTMLElement | null;
    if (!el || (e.target as Element).closest('.grip, .actions')) return;
    const i = Number(el.dataset.thumb);
    cancelLong();
    longStart = { x: e.clientX, y: e.clientY, id: e.pointerId };
    window.addEventListener('pointermove', onLongMove);
    window.addEventListener('pointerup', cancelLong);
    window.addEventListener('pointercancel', cancelLong);
    longTimer = window.setTimeout(() => {
      const s = longStart;
      cancelLong();
      if (!s) return;
      longAt = Date.now();
      suppressClick();
      openMenuAt(i, s.x, s.y, 'touch');
    }, 500);
  }

  function openMenuAt(i: number, x: number, y: number, via: CtxRequest['via']) {
    let pages = selected;
    if (!selSet.has(i)) {
      pages = [i];
      onchange([i], i);
    }
    focusIdx = i;
    oncontext({ x, y, index: i, pages: [...pages].sort((a, b) => a - b), via });
  }

  function onCtx(e: MouseEvent) {
    const el = (e.target as Element).closest('[data-thumb]') as HTMLElement | null;
    if (!el) return;
    e.preventDefault();
    if (Date.now() - longAt < 800) return; // 길게 누르기로 이미 연 메뉴
    openMenuAt(Number(el.dataset.thumb), e.clientX, e.clientY, 'mouse');
  }

  // ---------- 키보드 ----------
  const NAV = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
    if (!n) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k.toLowerCase() === 'a') {
      e.preventDefault();
      onchange(Array.from({ length: n }, (_, i) => i), anchor ?? 0);
      return;
    }
    if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const r = cellRect(geom, focusIdx);
      const sr = scroller.getBoundingClientRect();
      openMenuAt(focusIdx, sr.left + r.x + r.w / 2, sr.top + r.y - scroller.scrollTop + r.h / 2, 'key');
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (NAV.has(k)) {
      e.preventDefault();
      const rows = Math.max(1, Math.floor(H / (geom.cellH + geom.gap)) - 1);
      const from = focusIdx;
      const to = moveFocus(geom, from, k, rows);
      focusIdx = to;
      reveal(to);
      if (e.shiftKey) {
        const a = anchor ?? from;
        onchange(span(a, to), a);
      }
    } else if ((k === ' ' || k === 'Enter') && (t === scroller || t.classList.contains('face'))) {
      e.preventDefault();
      const r = clickSelect(selected, anchor, focusIdx, { shift: false, ctrl: true });
      onchange(r.selected, r.anchor);
    } else if (k === 'Delete' && selected.length) {
      e.preventDefault();
      onremove([...selected]);
    } else if (k === 'Escape' && selected.length) {
      e.preventDefault();
      onchange([], null);
    }
  }

  onMount(() => {
    const ro = new ResizeObserver(() => onScroll());
    ro.observe(scroller);
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 8 : -8;
      const v = Math.min(GRID_MAX, Math.max(GRID_MIN, thumb + step));
      if (v !== thumb) onthumb(v);
    };
    scroller.addEventListener('wheel', wheel, { passive: false });
    scroller.scrollTop = initialScroll;
    update();
    focusIdx = Math.min(Math.max(0, selected[0] ?? 0), Math.max(0, n - 1));
    scroller.focus({ preventScroll: true });
    return () => {
      ro.disconnect();
      scroller.removeEventListener('wheel', wheel);
      if (raf) cancelAnimationFrame(raf);
      endDrag();
      endBand();
      cancelLong();
    };
  });
</script>

<div
  class="grid"
  bind:this={scroller}
  role="listbox"
  aria-multiselectable="true"
  aria-label="쪽 썸네일"
  aria-activedescendant={hasFocus && focusIdx < n ? `gc-${focusIdx}` : undefined}
  tabindex="0"
  onscroll={onScroll}
  onpointerdown={onScrollerDown}
  oncontextmenu={onCtx}
  onkeydown={onKey}
  onfocusin={() => (hasFocus = true)}
  onfocusout={(e) => { if (!scroller.contains(e.relatedTarget as Node | null)) hasFocus = false; }}
  data-testid="grid"
  data-cols={geom.cols}
  data-thumb-size={geom.cellW}
>
  <div class="content" style:height="{geom.height}px">
    {#key gen}
      {#each cells as i (i)}
        {@const r = cellRect(geom, i)}
        {@const s = sizes[i]}
        {#if s}
          <div
            class="cell"
            role="option"
            id="gc-{i}"
            aria-selected={selSet.has(i)}
            aria-label="{i + 1}쪽{selSet.has(i) ? ' (선택됨)' : ''}"
            data-cell={i}
            style:left="{r.x}px"
            style:top="{r.y}px"
            style:width="{r.w}px"
            style:height="{r.h}px"
          >
            <ThumbItem
              index={i}
              width={s.width * fitLive(s)}
              height={s.height * fitLive(s)}
              selected={false}
              checked={selSet.has(i)}
              grid
              focused={hasFocus && focusIdx === i}
              moving={!!drag && drag.moving.includes(i)}
              visible={i >= win.rA && i <= win.rB}
              scale={renderScale(s)}
              {scheduler}
              rev={rev[i] ?? 0}
              priority={() => Math.abs(i - centerIdx)}
              onselect={pick}
              onpress={onPress}
              ondblopen={onopen}
              {showActions}
              {actions}
            />
          </div>
        {/if}
      {/each}
    {/key}
    {#if drag && drag.target == null}
      <div class="drop" style:left="{drag.spot.line.x - 1.5}px" style:top="{drag.spot.line.y}px" style:height="{drag.spot.line.h}px" data-testid="drop-line" data-before={drag.spot.before} aria-hidden="true"></div>
    {/if}
    {#if band}
      <div class="band" style:left="{band.x}px" style:top="{band.y}px" style:width="{band.w}px" style:height="{band.h}px" data-testid="band" aria-hidden="true"></div>
    {/if}
  </div>
</div>
{#if drag}
  <div class="ghost" style:left="{drag.x + 12}px" style:top="{drag.y + 12}px" aria-hidden="true">
    {drag.target === 'new'
      ? `${drag.moving.length}쪽을 새 파일로 복사`
      : drag.target != null
        ? `${drag.moving.length}쪽을 ‘${drag.targetName}’ 끝에 복사`
        : drag.moving.length > 1
          ? `${drag.moving.length}쪽 이동`
          : `${drag.moving[0] + 1}쪽 이동`}
  </div>
{/if}

<style>
  .grid {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    outline: none;
    user-select: none;
    -webkit-user-select: none;
    touch-action: pan-y;
  }
  .content { position: relative; width: 100%; }
  .cell {
    position: absolute;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }
  .drop {
    position: absolute;
    width: 3px;
    border-radius: 2px;
    background: var(--fg);
    pointer-events: none;
    z-index: 2;
  }
  .band {
    position: absolute;
    border: 1px dashed var(--fg);
    background: color-mix(in srgb, var(--fg) 12%, transparent);
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
</style>
