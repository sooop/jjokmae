<script lang="ts">
  // 한 쪽 위의 주석 상호작용 레이어. 엔진 렌더가 주석을 이미 그리므로 이 레이어는 투명하고,
  // 호버 경계·선택 틀·핸들·드래그 미리보기와 입력창만 그린다. 목록은 쪽이 보일 때 읽는다.
  import { untrack } from 'svelte';
  import type { Annotation, PagePoint, Rect } from '../engine/adapter';
  import {
    aspectRect, BORDER_WIDTH, clampPoint, defaultStampRect, defaultTextBox, hasContents, hitRects, HANDLES, isEditable,
    isResizable, MIN_SIZE, memoRect, moveRect, normRect, quadsRect, rectQuad, resizeRect, shiftQuads, TYPE_LABEL, type Handle,
  } from './annot-geom';
  import type { AnnotApi, AnnotUi } from './annot-ui.svelte';
  import { releaseImage } from './stamp-image';

  let {
    index,
    page,
    k,
    visible,
    rev,
    ui,
    api,
  }: {
    index: number;
    /** 쪽 크기(pt) */
    page: { width: number; height: number };
    /** CSS px / pt */
    k: number;
    visible: boolean;
    /** 이 쪽의 무효화 키. 바뀌면 목록을 다시 읽는다 */
    rev: number;
    ui: AnnotUi;
    api: AnnotApi;
  } = $props();

  let el: HTMLDivElement;
  let annots = $state<Annotation[]>([]);
  let loadedKey = '';
  let token = 0;

  // ---------- 목록 지연 로드 ----------
  $effect(() => {
    const key = `${rev}:${ui.epoch}`;
    if (!visible) return;
    untrack(() => {
      if (key === loadedKey) return;
      void reload(key);
    });
  });

  async function reload(key = `${rev}:${ui.epoch}`) {
    const t = ++token;
    try {
      const list = await api.list(index);
      if (t !== token) return;
      annots = list;
      loadedKey = key;
      ui.syncSelection(index, list);
    } catch {
      if (t === token) loadedKey = '';
    }
  }

  // ---------- 좌표 ----------
  function pt(e: { clientX: number; clientY: number }): PagePoint {
    const r = el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * page.width, y: ((e.clientY - r.top) / r.height) * page.height };
  }
  const px = (v: number) => v * k;
  const rectStyle = (r: Rect) => `left:${px(r.x)}px;top:${px(r.y)}px;width:${px(r.width)}px;height:${px(r.height)}px`;

  // ---------- 포인터 추적(window 에 붙인다: 레이어 밖으로 나가도 이어진다) ----------
  let stopTrack: (() => void) | null = null;
  function track(e: PointerEvent, move: (ev: PointerEvent) => void, up: (ev: PointerEvent, cancelled: boolean) => void) {
    stopTrack?.();
    const id = e.pointerId;
    const mv = (ev: PointerEvent) => ev.pointerId === id && move(ev);
    const fin = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      stop();
      up(ev, ev.type === 'pointercancel');
    };
    const stop = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', fin);
      window.removeEventListener('pointercancel', fin);
      if (stopTrack === stop) stopTrack = null;
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', fin);
    window.addEventListener('pointercancel', fin);
    stopTrack = stop;
  }
  $effect(() => () => stopTrack?.());

  // ---------- 상태 ----------
  interface Draft {
    kind: 'shape' | 'area' | 'text' | 'stamp';
    rect: Rect;
  }
  let draft = $state<Draft | null>(null);
  let draftQuads = $state<number[][]>([]);
  /** 선택 주석을 끄는 중의 모습 */
  let drag = $state<{ id: string; rect: Rect; quads?: number[][] } | null>(null);
  let editor = $state<{ kind: 'memo' | 'freetext'; rect: Rect; text: string; openedAt: number } | null>(null);
  let editorEl: HTMLTextAreaElement | undefined = $state();

  $effect(() => {
    if (editor && editorEl) {
      const t = setTimeout(() => editorEl?.focus(), 0);
      return () => clearTimeout(t);
    }
  });

  const creating = $derived(ui.tool !== 'select');
  const selId = $derived(ui.sel && ui.sel.page === index ? ui.sel.annot.id : null);

  // ---------- 만들기 ----------
  function onCreateDown(e: PointerEvent) {
    if (e.button !== 0 || !creating) return;
    if ((e.target as Element).closest('[data-annot-editor]')) return; // 입력창 안을 누른 것은 캐럿 이동
    if (editor) {
      editorEl?.blur();
      return;
    }
    const tool = ui.tool;
    if (tool === 'stamp' && !ui.stamp) return;
    e.preventDefault();
    const start = clampPoint(pt(e), page);
    const startPx = { x: e.clientX, y: e.clientY };
    let moved = false;
    let cur = start;
    let previewBusy = false;
    let previewAgain = false;

    const updatePreview = () => {
      if (tool === 'square' || tool === 'circle') draft = { kind: 'shape', rect: normRect(start, cur) };
      else if (tool === 'freetext') draft = { kind: 'text', rect: normRect(start, cur) };
      else if (tool === 'stamp' && ui.stamp) draft = { kind: 'stamp', rect: aspectRect(start, cur, ui.stamp.width / ui.stamp.height, page) };
      else if (tool === 'highlight') {
        if (previewBusy) {
          previewAgain = true;
          return;
        }
        previewBusy = true;
        void api
          .quads(index, start, cur)
          .then((q) => {
            if (!stopTrack) return;
            draftQuads = q;
            draft = q.length ? null : { kind: 'area', rect: normRect(start, cur) };
          })
          .catch(() => {})
          .finally(() => {
            previewBusy = false;
            if (previewAgain) {
              previewAgain = false;
              updatePreview();
            }
          });
      }
    };

    track(
      e,
      (ev) => {
        cur = clampPoint(pt(ev), page);
        if (!moved && Math.hypot(ev.clientX - startPx.x, ev.clientY - startPx.y) < 4) return;
        moved = true;
        updatePreview();
      },
      (ev, cancelled) => {
        cur = clampPoint(pt(ev), page);
        const finalDraft = draft;
        draft = null;
        const quadsBefore = draftQuads;
        draftQuads = [];
        if (cancelled) return;
        void finishCreate(tool, start, cur, moved, finalDraft, quadsBefore);
      },
    );
  }

  async function finishCreate(tool: string, start: PagePoint, end: PagePoint, moved: boolean, _d: Draft | null, _q: number[][]) {
    if (tool === 'memo') {
      editor = { kind: 'memo', rect: memoRect(start, page), text: '', openedAt: Date.now() };
      return;
    }
    if (tool === 'freetext') {
      const r = moved ? normRect(start, end) : defaultTextBox(start, ui.fontSize, page);
      editor = {
        kind: 'freetext',
        rect: r.width >= MIN_SIZE * 4 && r.height >= MIN_SIZE * 2 ? r : defaultTextBox(start, ui.fontSize, page),
        text: '',
        openedAt: Date.now(),
      };
      return;
    }
    if (tool === 'square' || tool === 'circle') {
      if (!moved) return;
      const r = normRect(start, end);
      if (r.width < MIN_SIZE || r.height < MIN_SIZE) return;
      const created = await api.add(index, { type: tool, rect: r, color: ui.colors[tool], extra: { borderWidth: BORDER_WIDTH } });
      done(created, tool);
      return;
    }
    if (tool === 'stamp') {
      const img = ui.stamp;
      if (!img) return;
      const aspect = img.width / img.height;
      let r = moved ? aspectRect(start, end, aspect, page) : defaultStampRect(start, aspect, page);
      if (r.width < MIN_SIZE || r.height < MIN_SIZE) r = defaultStampRect(start, aspect, page);
      const created = await api.addStamp(index, r, img);
      if (created) {
        ui.stamp = null;
        releaseImage(img);
      }
      done(created, tool);
      return;
    }
    if (tool === 'highlight') {
      if (!moved) return;
      const quads = await api.quads(index, start, end);
      if (quads.length) {
        await api.add(index, { type: 'highlight', rect: quadsRect(quads), quadPoints: quads, color: ui.colors.highlight });
        return;
      }
      // 글자가 없는 쪽(스캔본)이면 영역 하이라이트로 폴백한다. 글자가 있는 쪽에서 빈 곳을 끈 것은 무시한다.
      if (await api.hasText(index)) return;
      const r = normRect(start, end);
      if (r.width < MIN_SIZE || r.height < MIN_SIZE) return;
      await api.add(index, { type: 'highlight', rect: r, quadPoints: [rectQuad(r)], color: ui.colors.highlight });
    }
  }

  /** 한 번에 하나만 만드는 도구는 만든 뒤 선택 도구로 돌아가 방금 만든 것을 선택한다 */
  function done(created: Annotation | null, tool: string) {
    if (!created) return;
    // 만드는 사이에 다른 도구를 골랐다면 그 선택을 존중한다
    if (ui.tool !== tool) return;
    ui.setTool('select');
    ui.select(index, created);
  }

  async function commitEditor() {
    const ed = editor;
    if (!ed) return;
    editor = null;
    const text = ed.text.trim();
    if (!text) return;
    const created =
      ed.kind === 'memo'
        ? await api.add(index, { type: 'text', rect: ed.rect, color: ui.colors.memo, contents: text })
        : await api.add(index, {
            type: 'freetext',
            rect: ed.rect,
            color: ui.colors.freetext,
            contents: text,
            extra: { fontSize: ui.fontSize },
          });
    done(created, ed.kind === 'memo' ? 'memo' : 'freetext');
  }

  function onEditorBlur() {
    if (!editor) return;
    // 방금 열린 입력창이 터치 뒤따르는 마우스 이벤트로 포커스를 잃은 경우는 되돌린다
    if (Date.now() - editor.openedAt < 250) {
      editorEl?.focus();
      return;
    }
    void commitEditor();
  }

  function onEditorKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      editor = null;
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void commitEditor();
    }
  }

  // ---------- 선택·이동·크기 조절 ----------
  function startMove(e: PointerEvent, a: Annotation) {
    if (e.button !== 0) return;
    ui.select(index, a);
    const origin = pt(e);
    const orig = a.rect;
    let moved = false;
    track(
      e,
      (ev) => {
        const p = pt(ev);
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        moved = true;
        const r = moveRect(orig, p.x - origin.x, p.y - origin.y, page);
        drag = {
          id: a.id,
          rect: r,
          quads: a.type === 'highlight' && a.quadPoints ? shiftQuads(a.quadPoints, r.x - orig.x, r.y - orig.y) : undefined,
        };
      },
      (_ev, cancelled) => {
        const d = drag;
        drag = null;
        if (!moved || cancelled || !d) return;
        void commitRect(a, d.rect, d.quads);
      },
    );
  }

  function startResize(e: PointerEvent, a: Annotation, h: Handle) {
    if (e.button !== 0) return;
    e.stopPropagation();
    ui.select(index, a);
    const origin = pt(e);
    const orig = a.rect;
    let moved = false;
    track(
      e,
      (ev) => {
        const p = pt(ev);
        moved = true;
        drag = { id: a.id, rect: resizeRect(orig, h, p.x - origin.x, p.y - origin.y, page, a.type === 'stamp') };
      },
      (_ev, cancelled) => {
        const d = drag;
        drag = null;
        if (!moved || cancelled || !d) return;
        void commitRect(a, d.rect);
      },
    );
  }

  async function commitRect(a: Annotation, rect: Rect, quads?: number[][]) {
    // 낙관적 표시: 목록을 다시 읽기 전까지 새 위치에 둔다
    annots = annots.map((x) => (x.id === a.id ? { ...x, rect, ...(quads ? { quadPoints: quads } : {}) } : x));
    const ok = await api.update(index, { ...a, rect, ...(quads ? { quadPoints: quads } : {}) });
    if (!ok) void reload('');
  }

  const pieces = (a: Annotation, drg: typeof drag) => {
    if (drg && drg.id === a.id) {
      if (a.type === 'highlight' && drg.quads) return hitRects({ type: a.type, rect: drg.rect, quadPoints: drg.quads });
      return [drg.rect];
    }
    return hitRects(a);
  };
  const boxOf = (a: Annotation, drg: typeof drag) => (drg && drg.id === a.id ? drg.rect : a.rect);

  const hpos: Record<Handle, string> = {
    nw: 'left:0;top:0',
    n: 'left:50%;top:0',
    ne: 'left:100%;top:0',
    e: 'left:100%;top:50%',
    se: 'left:100%;top:100%',
    s: 'left:50%;top:100%',
    sw: 'left:0;top:100%',
    w: 'left:0;top:50%',
  };
  const handleCursor: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
  const handlesFor = (a: Annotation, r: Rect): Handle[] => {
    if (!isResizable(a.type)) return [];
    if (a.type === 'stamp') return ['nw', 'ne', 'se', 'sw'];
    return r.width * k >= 90 && r.height * k >= 90 ? HANDLES : ['nw', 'ne', 'se', 'sw'];
  };

  const editorFont = $derived(ui.fontSize * k);
</script>

<div
  class="layer"
  class:creating
  class:stamping={ui.tool === 'stamp'}
  bind:this={el}
  onpointerdown={onCreateDown}
  data-annot-layer={index}
  role="presentation"
>
  {#if ui.tool === 'select'}
    {#each annots as a (a.id)}
      {#if isEditable(a.type)}
        {@const selected = selId === a.id}
        {#if a.type === 'highlight'}
          {#each pieces(a, drag) as r, n (n)}
            <div
              class="hit hl"
              class:selected
              data-selected={selected ? 'true' : 'false'}
              style={rectStyle(r)}
              data-annot-hit
              data-annot-id={a.id}
              data-annot-type={a.type}
              role="button"
              tabindex="-1"
              aria-label="{TYPE_LABEL[a.type]} 주석"
              onpointerdown={(e) => startMove(e, a)}
            ></div>
          {/each}
        {:else}
          {@const r = boxOf(a, drag)}
          <div
            class="hit"
            class:selected
            data-selected={selected ? 'true' : 'false'}
            style={rectStyle(r)}
            data-annot-hit
            data-annot-id={a.id}
            data-annot-type={a.type}
            role="button"
            tabindex="-1"
            aria-label="{TYPE_LABEL[a.type]} 주석"
            onpointerdown={(e) => startMove(e, a)}
            ondblclick={() => hasContents(a.type) && ui.focusContent++}
          >
            {#if selected}
              {#each handlesFor(a, r) as h (h)}
                <span
                  class="handle"
                  style="{hpos[h]};cursor:{handleCursor[h]}"
                  data-annot-handle={h}
                  role="presentation"
                  onpointerdown={(e) => startResize(e, a, h)}
                ></span>
              {/each}
            {/if}
          </div>
        {/if}
      {/if}
    {/each}
  {/if}

  <!-- 만드는 중 미리보기 -->
  {#each draftQuads as q, n (n)}
    <div class="pv-hl" style="{rectStyle(quadsRect([q]))};background:{ui.colors.highlight}"></div>
  {/each}
  {#if draft}
    {#if draft.kind === 'shape'}
      <div class="pv" class:round={ui.tool === 'circle'} style="{rectStyle(draft.rect)};border-color:{ui.tool === 'circle' ? ui.colors.circle : ui.colors.square}"></div>
    {:else if draft.kind === 'area'}
      <div class="pv-hl" style="{rectStyle(draft.rect)};background:{ui.colors.highlight}"></div>
    {:else if draft.kind === 'text'}
      <div class="pv dashed" style={rectStyle(draft.rect)}></div>
    {:else if ui.stamp}
      <img class="pv-img" src={ui.stamp.url} alt="" style={rectStyle(draft.rect)} />
    {/if}
  {/if}

  {#if editor}
    {#if editor.kind === 'freetext'}
      <textarea
        class="editor"
        bind:this={editorEl}
        bind:value={editor.text}
        style="{rectStyle(editor.rect)};font-size:{editorFont}px;color:{ui.colors.freetext}"
        aria-label="텍스트 상자 내용"
        data-keep-selection
        data-annot-editor
        onkeydown={onEditorKey}
        onblur={onEditorBlur}
      ></textarea>
    {:else}
      <textarea
        class="editor memo"
        bind:this={editorEl}
        bind:value={editor.text}
        style="left:{px(editor.rect.x)}px;top:{px(editor.rect.y)}px"
        placeholder="메모 내용"
        aria-label="메모 내용"
        data-keep-selection
        data-annot-editor
        onkeydown={onEditorKey}
        onblur={onEditorBlur}
      ></textarea>
    {/if}
  {/if}
</div>

<style>
  .layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .layer.creating {
    pointer-events: auto;
    cursor: crosshair;
    touch-action: none;
  }
  .hit {
    position: absolute;
    pointer-events: auto;
    cursor: pointer;
    touch-action: none;
    outline: 1.5px dashed transparent;
    outline-offset: 0;
  }
  .hit:hover { outline-color: rgb(23 23 23 / 0.6); }
  .hit.selected {
    outline: 2px solid #171717;
    box-shadow: 0 0 0 1px #fff;
    cursor: move;
    animation: sel-in var(--spring-bouncy-dur) var(--spring-bouncy);
  }
  @keyframes sel-in { from { outline-offset: 5px; outline-color: transparent; } }
  .hit.hl.selected { outline-offset: 0; }
  .handle {
    position: absolute;
    width: 28px;
    height: 28px;
    margin: -14px 0 0 -14px;
    display: grid;
    place-items: center;
    touch-action: none;
    animation: var(--kf-pop) var(--spring-bouncy-dur) var(--spring-bouncy) 60ms backwards;
  }
  .handle::before {
    content: '';
    width: 10px;
    height: 10px;
    background: #fff;
    border: 2px solid #171717;
    border-radius: 2px;
  }
  .pv, .pv-img, .pv-hl { position: absolute; pointer-events: none; }
  .pv { border: 2px solid; }
  .pv.round { border-radius: 50%; }
  .pv.dashed { border: 1.5px dashed #171717; }
  .pv-hl { opacity: 0.4; mix-blend-mode: multiply; }
  .pv-img { opacity: 0.7; object-fit: fill; outline: 1px dashed #171717; }
  .editor {
    position: absolute;
    pointer-events: auto;
    resize: none;
    margin: 0;
    padding: 2px 3px;
    background: #fff;
    border: 1.5px solid #171717;
    border-radius: 2px;
    line-height: 1.25;
    font-family: var(--font-sans);
    user-select: text;
    -webkit-user-select: text;
    z-index: 5;
  }
  .editor.memo {
    width: 220px;
    height: 92px;
    font-size: 14px;
    color: #171717;
    border-radius: var(--radius);
    padding: 6px 8px;
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
  }
  @media (pointer: coarse) {
    .editor.memo { font-size: 16px; }
  }
</style>
