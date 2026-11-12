<script lang="ts">
  import { untrack } from 'svelte';
  import type { Annotation, FormField, NewAnnotation, PagePoint, Rect } from './engine/adapter';
  import AnnotToolbar from './lib/AnnotToolbar.svelte';
  import { hasHangul, type Tool } from './lib/annot-geom';
  import { AnnotUi, type AnnotApi } from './lib/annot-ui.svelte';
  import EngineStatus from './lib/EngineStatus.svelte';
  import MergePopover from './lib/MergePopover.svelte';
  import Organize from './lib/Organize.svelte';
  import PageOverlay from './lib/PageOverlay.svelte';
  import PageTools from './lib/PageTools.svelte';
  import { PrintJob } from './lib/print-job.svelte';
  import { defaultScope, type PrintScope } from './lib/print';
  import PrintPopover from './lib/PrintPopover.svelte';
  import { detectRotation } from './lib/page-ops';
  import { stats } from './lib/render-queue';
  import SaveControl from './lib/SaveControl.svelte';
  import { clickSelect } from './lib/selection';
  import SendPopover from './lib/SendPopover.svelte';
  import { clampGrid, clampSide, clampZoom, loadSettings, saveSettings, SIDE_MAX, SIDE_MIN, defaultSettings, type Settings } from './lib/settings';
  import SettingsDrawer from './lib/SettingsDrawer.svelte';
  import SplitPopover from './lib/SplitPopover.svelte';
  import { prepareImage, releaseImage, StampFileError, stampFor, type PreparedImage } from './lib/stamp-image';
  import { applyTheme } from './lib/theme';
  import TabBar from './lib/TabBar.svelte';
  import Thumbnails from './lib/Thumbnails.svelte';
  import type { SendPos } from './lib/transfer';
  import IconButton from './lib/ui/IconButton.svelte';
  import Notice from './lib/ui/Notice.svelte';
  import Viewer from './lib/Viewer.svelte';
  import { Workspace } from './lib/workspace.svelte';
  import { stepZoom, ZOOM_PRESETS } from './lib/zoom';

  let settings = $state<Settings>(loadSettings());
  let drawerOpen = $state(false);
  let dragging = $state(false);
  let viewer: ReturnType<typeof Viewer> | undefined = $state();
  let input: HTMLInputElement;

  // 팝오버
  let splitOpen = $state(false);
  let sendOpen = $state(false);
  let mergeOpen = $state(false);
  let printOpen = $state(false);
  let printScope = $state<PrintScope>('all');
  /** 대화상자를 다시 만들 때 올린다(처음 고를 범위가 바뀌는 진입점에서) */
  let printSeq = $state(0);
  let printJustOpened = false;
  let splitRoot: HTMLDivElement | undefined = $state();
  let printRoot: HTMLDivElement | undefined = $state();
  let sendRoot: HTMLDivElement | undefined = $state();
  let mergeRoot: HTMLDivElement | undefined = $state();
  /** 썸네일을 끌고 있을 때 탭 막대에 알리는 상태 */
  let dragTab = $state<{ over: number | null } | null>(null);

  // 주석·양식 편집 상태(활성 문서 하나에 대한 것. 문서를 바꾸면 초기화한다)
  const ui = new AnnotUi();
  let forms = $state<FormField[]>([]);
  let stampInput: HTMLInputElement;
  let koWarned = false;
  let formSeq = 0;
  let lastFormEl: HTMLElement | null = null;

  const ws = new Workspace({
    settings: () => settings,
    beforeLeave: (d) => {
      const s = viewer?.getScroll();
      if (s) d.scroll = s;
    },
    afterInstall: () => {
      resetEditing();
      void loadForms();
    },
    afterSwap: () => {
      ui.clearSelection();
      void loadForms();
    },
    afterSave: (d) => {
      if (d.key === ws.activeKey) ui.epoch++;
    },
    afterMode: (m) => {
      if (m === 'organize') resetEditing();
      if (settings.mode !== m) patchSettings({ mode: m });
    },
  });
  ws.mode = untrack(() => settings.mode);
  (globalThis as { __pdfeditWs?: Workspace }).__pdfeditWs = ws;

  const doc = $derived(ws.active);
  const total = $derived(doc?.total ?? 0);
  const current = $derived(doc?.current ?? 0);
  const selected = $derived(doc?.selected ?? []);
  const curZoom = $derived(doc?.zoom ?? settings.zoom);
  const zoomOptions = $derived(ZOOM_PRESETS.includes(curZoom) ? ZOOM_PRESETS : [...ZOOM_PRESETS, curZoom].sort((a, b) => a - b));
  const tabs = $derived(ws.docs.map((d) => ({ key: d.key, name: d.name, dirty: d.dirty })));

  function patchSettings(p: Partial<Settings>) {
    const next = { ...settings, ...p };
    next.zoom = clampZoom(next.zoom);
    next.gridThumb = clampGrid(next.gridThumb);
    next.sideWidth = clampSide(next.sideWidth);
    settings = next;
    saveSettings($state.snapshot(settings));
    if (p.theme) applyTheme(settings.theme);
  }

  /** 확대 배율은 문서마다 따로 보관하고, 마지막 값은 다음에 여는 파일의 시작 배율로 저장한다 */
  function setZoom(z: number) {
    const nz = clampZoom(z);
    if (doc) doc.zoom = nz;
    patchSettings({ zoom: nz });
  }
  function onSettingsChange(p: Partial<Settings>) {
    const { zoom, ...rest } = p;
    if (zoom != null) setZoom(zoom);
    if (Object.keys(rest).length) patchSettings(rest);
  }

  // ---------- 파일 열기 ----------
  // 확장자 .pdf 또는 MIME application/pdf 중 하나만 맞으면 시도한다. 최종 판정은 엔진이 연다.
  const isPdfLike = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

  /** 고른 파일은 모두 새 탭으로 연다(현재 문서는 그대로) */
  function accept(list: FileList | null | undefined) {
    if (!list || !list.length) return;
    const all = Array.from(list);
    void ws.openFiles(all.filter(isPdfLike), all.filter((f) => !isPdfLike(f)));
  }

  function onPick() {
    accept(input.files);
    input.value = '';
  }

  // ---------- 드롭 ----------
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  function onDragEnter(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dragging = true;
  }
  function onDragOver(e: DragEvent) {
    if (hasFiles(e)) e.preventDefault();
  }
  function onDragLeave(e: DragEvent) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dragging = false;
  }
  function onDrop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dragging = false;
    accept(e.dataTransfer?.files);
  }

  // ---------- 탐색 ----------
  function goto(i: number) {
    viewer?.scrollToPage(i);
  }

  let editing = $state(false);
  let pageText = $state('1');
  $effect(() => {
    if (!editing) pageText = String(current + 1);
  });
  function commitPage() {
    editing = false;
    const n = parseInt(pageText, 10);
    if (Number.isFinite(n)) goto(n - 1);
    else pageText = String(current + 1);
  }

  // ---------- 쪽 선택 ----------
  function onPick2(i: number, e: MouseEvent) {
    const d = doc;
    if (!d) return;
    const mod = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    const hadAnchor = d.anchor != null;
    const r = clickSelect(d.selected, d.anchor, i, mod);
    d.selected = r.selected;
    d.anchor = r.anchor;
    if ((mod.shift && hadAnchor) || mod.ctrl) return;
    ui.clearSelection();
    goto(i);
  }

  // ---------- 주석·양식 편집 ----------
  function resetEditing() {
    releaseImage(ui.stamp);
    ui.stamp = null;
    ui.tool = 'select';
    ui.reset();
    ws.editNotice = null;
  }

  /** 양식 칸 목록(쪽 번호 포함). 실패하면 한 번 더 시도한다 */
  async function loadForms(retry = true) {
    const d = ws.active;
    const t = ++formSeq;
    if (!d) {
      forms = [];
      return;
    }
    try {
      const f = await ws.clientOf(d).listFormFields(d.id);
      if (t === formSeq) forms = f;
    } catch {
      if (t !== formSeq) return;
      if (retry) setTimeout(() => t === formSeq && void loadForms(false), 400);
      else forms = [];
    }
  }

  /** 입력 중인 칸을 확정하고 줄 서 있는 편집이 끝나길 기다린다(Ctrl+S·저장 버튼 앞에서) */
  async function flushEdits() {
    const el = document.activeElement as HTMLElement | null;
    if (el && el !== document.body && el.closest('[data-form-input],[data-annot-editor],[data-testid=annot-props]')) el.blur();
    await new Promise((r) => setTimeout(r, 0));
    await ws.settleEdits();
  }

  async function requestSave() {
    const d = doc;
    if (!d) return;
    await flushEdits();
    await ws.save(d);
  }

  // ---------- 인쇄 ----------
  const printJob = new PrintJob(ws, flushEdits);
  const printDocs = $derived(ws.docs.map((d) => ({ key: d.key, name: d.name, total: d.total, current: d.current, selected: d.selected })));

  /** 인쇄 대화상자를 연다. 진입점(Ctrl+P·툴바·메뉴·쪽 도구)은 모두 툴바 인쇄 버튼에 붙는 이 대화상자를 쓴다 */
  function openPrint(scope?: PrintScope) {
    if (!doc) return;
    if (printOpen && scope == null) {
      document.querySelector<HTMLElement>('[data-testid=print-pop] input')?.focus();
      return;
    }
    if (!printJob.busy) printJob.reset();
    printScope = scope ?? defaultScope(printDocs, ws.activeKey, ws.mode);
    printSeq++;
    printOpen = true;
    splitOpen = sendOpen = mergeOpen = false;
    // 대화상자를 연 그 클릭(다른 영역의 버튼·메뉴 항목)이 바깥 클릭으로 읽혀 바로 닫히지 않게 한다
    printJustOpened = true;
    setTimeout(() => (printJustOpened = false), 0);
  }

  function togglePrint() {
    if (!printOpen) openPrint();
    else if (!printJob.busy) printOpen = false;
  }

  /** PDFium 은 한글 텍스트 상자의 글자를 그리지 못한다. 그런 상자를 만들거나 고치면 한 번 알린다 */
  function warnKoreanOnce(a: { type: string; contents?: string }) {
    if (koWarned || doc?.kind !== 'pdfium' || a.type !== 'freetext' || !hasHangul(a.contents ?? '')) return;
    koWarned = true;
    ws.editNotice = {
      kind: 'info',
      text: 'PDFium 엔진은 한글 텍스트 상자의 글자를 그리지 못하고 상자만 보입니다. 설정에서 엔진을 MuPDF 로 바꾼 뒤 다시 열면 한글이 보입니다.',
    };
  }

  const annotApi: AnnotApi = {
    engine: () => doc?.kind ?? null,
    async list(page) {
      const d = doc;
      if (!d) return [];
      stats.annotLists++;
      return ws.clientOf(d).listAnnotations(d.id, page);
    },
    async add(page: number, a0: NewAnnotation) {
      const a = $state.snapshot(a0) as NewAnnotation; // 상태 프록시는 워커로 복제되지 않는다
      const r = await ws.editOp('주석 추가', [page], (c, d) => c.addAnnotation(d.id, page, a));
      if (!r.ok) return null;
      warnKoreanOnce(a);
      return r.value;
    },
    async addStamp(page: number, rect0: Rect, img: PreparedImage) {
      const rect = $state.snapshot(rect0) as Rect;
      const r = await ws.editOp('이미지 넣기', [page], async (c, d) => {
        let rot = d.rot[page];
        if (rot == null) {
          rot = await detectRotation(c, d.id, page);
          d.rot[page] = rot;
        }
        const image = await stampFor(img, rot);
        return c.addAnnotation(d.id, page, { type: 'stamp', rect, contents: '', extra: { image } });
      });
      return r.ok ? r.value : null;
    },
    async update(page: number, a0: Annotation) {
      const a = $state.snapshot(a0) as Annotation;
      const r = await ws.editOp('주석 수정', [page], (c, d) => c.updateAnnotation(d.id, page, a));
      if (r.ok) warnKoreanOnce(a);
      return r.ok;
    },
    async remove(page: number, id: string) {
      const r = await ws.editOp('주석 삭제', [page], (c, d) => c.deleteAnnotation(d.id, page, id));
      return r.ok;
    },
    async quads(page: number, from: PagePoint, to: PagePoint) {
      const d = doc;
      if (!d) return [];
      return ws.clientOf(d).textQuads(d.id, page, from, to);
    },
    async hasText(page: number) {
      const d = doc;
      if (!d) return false;
      return (await ws.clientOf(d).pageText(d.id, page)).trim().length > 0;
    },
    async setForm(field: FormField, value: FormField['value']) {
      const pages = [...new Set(forms.filter((f) => f.name === field.name).map((f) => f.pageIndex))];
      const r = await ws.editOp('양식 입력', pages.length ? pages : [field.pageIndex], async (c, d) => {
        await c.setFormFieldValue(d.id, field.name, value);
        forms = await c.listFormFields(d.id);
      });
      return r.ok;
    },
  };

  async function onStampFile() {
    const f = stampInput.files?.[0];
    stampInput.value = '';
    if (!f) return;
    try {
      const img = await prepareImage(f);
      releaseImage(ui.stamp);
      ui.stamp = img;
      ui.tool = 'stamp';
      ui.clearSelection();
      ws.editNotice = null;
    } catch (e) {
      ws.editNotice = {
        kind: 'error',
        text: e instanceof StampFileError ? e.message : '이미지를 읽지 못했습니다. 다른 파일을 선택해 주세요.',
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }

  function deleteSelectedAnnot() {
    const s = ui.sel;
    if (!s) return;
    void annotApi.remove(s.page, s.annot.id).then((ok) => ok && ui.clearSelection());
  }

  const formCount = $derived(new Set(forms.filter((f) => f.kind !== 'signature' && f.kind !== 'button').map((f) => f.name)).size);
  const formsByPage = $derived.by(() => {
    const m: FormField[][] = Array.from({ length: total }, () => []);
    for (const f of forms) if (f.pageIndex >= 0 && f.pageIndex < total && f.kind !== 'button') m[f.pageIndex].push(f);
    return m;
  });

  /** 다음 양식 칸으로: 마지막에 있던 칸 다음, 없으면 지금 쪽부터 첫 칸 */
  function nextField() {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-form-input]')).filter((el) => !(el as HTMLInputElement).disabled);
    if (!els.length) return;
    const pageOf = (el: HTMLElement) => Number(el.closest<HTMLElement>('[data-page]')?.dataset.page ?? 0);
    const i = lastFormEl ? els.indexOf(lastFormEl) : -1;
    const target = i >= 0 ? els[(i + 1) % els.length] : (els.find((el) => pageOf(el) >= current) ?? els[0]);
    target.focus();
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  function onHostFocusIn(e: FocusEvent) {
    const t = e.target as HTMLElement;
    if (t?.hasAttribute?.('data-form-input')) lastFormEl = t;
  }

  /** 주석·양식 밖을 누르면 주석 선택을 푼다(속성 패널은 도구 모음 쪽이라 해당 없음) */
  function onHostDown(e: PointerEvent) {
    if (!ui.sel) return;
    const t = e.target as Element | null;
    if (t?.closest('[data-annot-hit],[data-annot-handle],[data-keep-selection],[data-form-input]')) return;
    ui.clearSelection();
  }

  // ---------- 탭 ----------
  async function onConfirmClose(choice: 'save' | 'discard' | 'cancel') {
    const c = ws.confirmClose;
    if (!c) return;
    if (choice === 'cancel') {
      ws.confirmClose = null;
      return;
    }
    if (choice === 'discard') {
      await ws.close(c.key, true);
      return;
    }
    const d = ws.docOf(c.key);
    if (!d) {
      ws.confirmClose = null;
      return;
    }
    ws.confirmClose = { key: c.key, busy: true };
    if (d.key === ws.activeKey) await flushEdits();
    const ok = await ws.save(d);
    if (ok) await ws.close(c.key, true);
    else {
      ws.confirmClose = null;
      ws.tabNotice = { key: c.key, kind: 'error', text: `‘${d.name}’을(를) 저장하지 못해 닫지 않았습니다. 다시 시도해 주세요.`, reassure: '편집한 내용은 그대로 열려 있습니다.' };
    }
  }

  // ---------- 보내기·병합 ----------
  function onSend(mode: 'copy' | 'move', target: { type: 'new' } | { type: 'doc'; key: number; pos: SendPos }) {
    const d = doc;
    if (!d) return;
    sendOpen = false;
    void ws.send({ from: d, pages: [...d.selected], mode, target });
  }

  function onTabDrop(moving: number[], key: number) {
    const d = doc;
    if (!d) return;
    void ws.send({ from: d, pages: moving, mode: 'copy', target: { type: 'doc', key, pos: 'end' } });
  }

  async function onMerge(keys: number[]) {
    if (await ws.mergeOpen(keys)) mergeOpen = false;
  }

  async function onSplit(groups: number[][]) {
    if (await ws.split(groups)) splitOpen = false;
  }

  // ---------- 보기 모드 썸네일 패널 폭(분할선) ----------
  let sideEl: HTMLElement | undefined = $state();
  let splitDrag = false;
  function onSplitDown(e: PointerEvent) {
    if (e.button !== 0) return;
    splitDrag = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onSplitMove(e: PointerEvent) {
    if (!splitDrag || !sideEl) return;
    patchSettings({ sideWidth: e.clientX - sideEl.getBoundingClientRect().left });
  }
  function onSplitUp(e: PointerEvent) {
    splitDrag = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }
  function onSplitKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const step = e.shiftKey ? 32 : 8;
    const w = settings.sideWidth;
    const next = e.key === 'ArrowLeft' ? w - step : e.key === 'ArrowRight' ? w + step : e.key === 'Home' ? SIDE_MIN : e.key === 'End' ? SIDE_MAX : null;
    if (next == null) return;
    e.preventDefault();
    patchSettings({ sideWidth: next });
  }

  // ---------- 키 ----------
  const TOOL_KEYS: Record<string, Tool> = { v: 'select', h: 'highlight', r: 'square', o: 'circle', n: 'memo', t: 'freetext' };
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        void requestSave();
      } else if (k === 'p') {
        // 브라우저 기본 인쇄(화면 그대로 찍힘)를 막고 인쇄 대화상자를 연다
        e.preventDefault();
        openPrint();
      } else if (k === 'o') {
        e.preventDefault();
        input.click();
      } else if (k === 'tab') {
        e.preventDefault();
        ws.cycle(e.shiftKey ? -1 : 1);
      } else if (k === 'w' && doc) {
        e.preventDefault();
        void ws.close(doc.key);
      } else if (!typing && doc && k === 'z') {
        e.preventDefault();
        void ws.stepHistory(e.shiftKey ? 'redo' : 'undo');
      } else if (!typing && doc && k === 'y') {
        e.preventDefault();
        void ws.stepHistory('redo');
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (typing || !doc) return;
    if (!e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); ws.toggleMode(); return; }
    if (ws.mode === 'organize') return; // 아래는 보기 모드 전용(도구·쪽 이동·확대). 정리 모드의 쪽 키는 격자가 맡는다
    const tool = e.shiftKey ? undefined : TOOL_KEYS[e.key.toLowerCase()];
    if (tool) { e.preventDefault(); ui.setTool(tool); return; }
    if (!e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); if (!ws.opBusy) stampInput.click(); return; }
    if (e.key === 'Delete' && ui.sel) { e.preventDefault(); deleteSelectedAnnot(); return; }
    if (e.key === 'Escape' && (ui.sel || ui.tool !== 'select')) { ui.clearSelection(); ui.tool = 'select'; return; }
    if (e.key === 'PageDown') { e.preventDefault(); goto(current + 1); }
    else if (e.key === 'PageUp') { e.preventDefault(); goto(current - 1); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(stepZoom(curZoom, 1)); }
    else if (e.key === '-') { e.preventDefault(); setZoom(stepZoom(curZoom, -1)); }
    else if (e.key === 'Delete' && selected.length) { e.preventDefault(); ws.remove(selected); }
    else if (e.key === 'Escape' && selected.length) { doc.selected = []; }
  }

  function onWindowClick(e: MouseEvent) {
    const t = e.target as Node;
    if (splitOpen && splitRoot && !splitRoot.contains(t)) splitOpen = false;
    if (sendOpen && sendRoot && !sendRoot.contains(t)) sendOpen = false;
    if (mergeOpen && mergeRoot && !mergeRoot.contains(t)) mergeOpen = false;
    if (printOpen && !printJustOpened && printRoot && !printRoot.contains(t) && !printJob.busy) printOpen = false;
  }
</script>

<svelte:window
  onkeydown={onKey}
  onclick={onWindowClick}
  ondragover={(e) => e.preventDefault()}
  ondrop={(e) => e.preventDefault()}
/>

{#snippet actions(i: number)}
  <IconButton icon="rotate-cw" label="{i + 1}쪽 시계 방향 90° 회전" onclick={() => ws.rotate([i])} disabled={ws.opBusy} />
  <IconButton icon="copy" label="{i + 1}쪽 뒤에 복제" onclick={() => ws.duplicate([i])} disabled={ws.opBusy} />
  <IconButton icon="trash" label="{i + 1}쪽 삭제" onclick={() => ws.remove([i])} disabled={ws.opBusy || total <= 1} />
{/snippet}

{#snippet pageOverlay(i: number, visible: boolean)}
  {#if doc && doc.sizes[i]}
    <PageOverlay
      index={i}
      page={doc.sizes[i]}
      k={(doc.zoom * 96) / 72}
      {visible}
      rev={doc.rev[i] ?? 0}
      fields={formsByPage[i] ?? []}
      {ui}
      api={annotApi}
    />
  {/if}
{/snippet}

{#snippet sendButton()}
  <div class="anchor" bind:this={sendRoot}>
    <IconButton
      icon="send"
      label="선택한 쪽 보내기 (복사·이동)"
      haspopup
      expanded={sendOpen}
      onclick={() => { sendOpen = !sendOpen; }}
      disabled={ws.opBusy || selected.length === 0}
    />
    {#if sendOpen && doc}
      <SendPopover
        count={selected.length}
        docs={ws.docs.map((d) => ({ key: d.key, name: d.name, total: d.total, self: d.key === doc.key }))}
        busy={ws.opBusy}
        onrun={onSend}
        onclose={() => (sendOpen = false)}
      />
    {/if}
  </div>
{/snippet}

<div class="app" data-busy={ws.opBusy || ws.editPending > 0}>
  <header class="toolbar">
    {#if doc}
      {#if ws.mode === 'view'}
        <IconButton icon="folder" label="파일 열기 (Ctrl+O)" onclick={() => input.click()} />
      {/if}
      <IconButton icon="grid" label="정리 모드 (G)" pressed={ws.mode === 'organize'} onclick={() => ws.toggleMode()} />
      <div class="anchor" bind:this={mergeRoot}>
        <IconButton
          icon="merge"
          label={ws.docs.length < 2 ? '열린 파일 병합 (파일이 2개 이상 열려 있어야 합니다)' : '열린 파일 병합'}
          haspopup
          expanded={mergeOpen}
          onclick={() => { mergeOpen = !mergeOpen; ws.mergeError = null; }}
          disabled={ws.docs.length < 2 || (ws.opBusy && !ws.mergeBusy)}
        />
        {#if mergeOpen}
          <MergePopover
            docs={ws.docs.map((d) => ({ key: d.key, name: d.name, total: d.total }))}
            busy={ws.mergeBusy}
            error={ws.mergeError}
            onrun={(keys) => void onMerge(keys)}
            onclose={() => (mergeOpen = false)}
            onclearerror={() => (ws.mergeError = null)}
          />
        {/if}
      </div>
 {#if ws.mode === 'view'}
      <div class="nav">
        <IconButton icon="chevron-left" label="이전 쪽" onclick={() => goto(current - 1)} disabled={current <= 0} />
        <input
          class="page-input"
          type="text"
          inputmode="numeric"
          aria-label="현재 쪽"
          bind:value={pageText}
          onfocus={(e) => { editing = true; e.currentTarget.select(); }}
          onblur={commitPage}
          onkeydown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') { pageText = String(current + 1); e.currentTarget.blur(); }
          }}
        />
        <span class="total">/ {total}</span>
        <IconButton icon="chevron-right" label="다음 쪽" onclick={() => goto(current + 1)} disabled={current >= total - 1} />
      </div>
      <div class="zoom">
        <IconButton icon="minus" label="축소" onclick={() => setZoom(stepZoom(curZoom, -1))} disabled={curZoom <= 0.25} />
        <select aria-label="확대 배율" title="확대 배율" value={curZoom} onchange={(e) => setZoom(Number(e.currentTarget.value))}>
          {#each zoomOptions as z (z)}<option value={z}>{Math.round(z * 100)}%</option>{/each}
        </select>
        <IconButton icon="plus" label="확대" onclick={() => setZoom(stepZoom(curZoom, 1))} disabled={curZoom >= 4} />
      </div>
      {/if}
    {/if}
    <span class="spacer"></span>
    {#if doc}
      <div class="hist">
        <IconButton icon="undo" label="되돌리기 (Ctrl+Z)" onclick={() => void ws.stepHistory('undo')} disabled={ws.opBusy || doc.undoCount === 0} />
        <IconButton icon="redo" label="다시하기 (Ctrl+Shift+Z)" onclick={() => void ws.stepHistory('redo')} disabled={ws.opBusy || doc.redoCount === 0} />
      </div>
      <div class="anchor" bind:this={printRoot}>
        <IconButton
          icon="printer"
          label="인쇄 (Ctrl+P)"
          haspopup
          expanded={printOpen}
          onclick={togglePrint}
          disabled={!doc}
        />
        {#if printOpen}
          {#key printSeq}
            <PrintPopover
              docs={printDocs}
              activeKey={ws.activeKey}
              mode={ws.mode}
              initialScope={printScope}
              method={settings.printMethod}
              dpi={settings.printDpi}
              job={printJob}
              busy={ws.opBusy}
              onchange={patchSettings}
              onclose={() => (printOpen = false)}
            />
          {/key}
        {:else if printJob.note}
          <Notice floating kind={printJob.note.kind} text={printJob.note.text} detail={printJob.note.detail} onclose={() => (printJob.note = null)} />
        {:else if printJob.error}
          <Notice floating kind="error" text={printJob.error.text} reassure={printJob.error.reassure} detail={printJob.error.detail} onclose={() => (printJob.error = null)} />
        {/if}
      </div>
      <div class="anchor" bind:this={splitRoot}>
        <IconButton icon="scissors" label="나누기" haspopup expanded={splitOpen} onclick={() => { splitOpen = !splitOpen; ws.splitNotice = null; ws.splitError = null; }} disabled={ws.opBusy && !ws.splitBusy} />
        {#if splitOpen}
          <SplitPopover {total} busy={ws.splitBusy} error={ws.splitError} onrun={(g) => void onSplit(g)} onclose={() => (splitOpen = false)} onclearerror={() => (ws.splitError = null)} />
        {/if}
        {#if ws.splitNotice && !splitOpen}
          <Notice floating kind={ws.splitNotice.kind} text={ws.splitNotice.text} onclose={() => (ws.splitNotice = null)} />
        {/if}
      </div>
      <SaveControl
        {settings}
        busy={ws.saving || (ws.opBusy && ws.editPending === 0)}
        saving={ws.saving}
        notice={ws.saveNotice}
        onsave={() => void requestSave()}
        onchange={patchSettings}
        onclosenotice={() => (ws.saveNotice = null)}
      />
    {/if}
    <IconButton icon="settings" label="설정" pressed={drawerOpen} onclick={() => (drawerOpen = !drawerOpen)} />
  </header>

  {#if ws.docs.length && ws.mode === 'view'}
    <TabBar
      {tabs}
      activeKey={ws.activeKey}
      dragging={dragTab != null}
      dragOver={dragTab?.over ?? null}
      notice={ws.tabNotice}
      confirm={ws.confirmClose}
      onactivate={(k) => ws.activate(k)}
      onclose={(k) => void ws.close(k)}
      onclosenotice={() => (ws.tabNotice = null)}
      onconfirm={(c) => void onConfirmClose(c)}
    />
  {/if}

  <div
    class="body"
    class:dragging
    role="region"
    aria-label="작업 영역"
    ondragenter={onDragEnter}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    {#if doc && ws.mode === 'organize'}
      <Organize
        {ws}
        thumb={settings.gridThumb}
        {actions}
        {sendButton}
        onthumb={(v) => patchSettings({ gridThumb: v })}
        onopenfile={() => input.click()}
        onconfirm={(c) => void onConfirmClose(c)}
        onsave={(d) => void (d.key === ws.activeKey ? requestSave() : ws.save(d))}
        onsplit={() => setTimeout(() => { splitOpen = true; ws.splitNotice = null; ws.splitError = null; }, 0)}
        onprint={openPrint}
      />
      {#if ws.status}
        <EngineStatus status={ws.status} ondismiss={() => (ws.status = null)} />
      {/if}
    {:else}
    {#if doc}
      <aside class="side" aria-label="페이지 목록" style:width="{settings.sideWidth}px" bind:this={sideEl}>
        <PageTools
          count={selected.length}
          busy={ws.opBusy}
          notice={ws.pagesNotice}
          onrotate={() => ws.rotate(selected)}
          oncopy={() => ws.duplicate(selected)}
          ondelete={() => ws.remove(selected)}
          onextract={() => void ws.extract(selected)}
          onprint={() => openPrint('selected')}
          onclear={() => (doc.selected = [])}
          onclosenotice={() => (ws.pagesNotice = null)}
          extra={sendButton}
        />
        <div class="thumbs-host">
          {#each [doc] as d (`${d.key}:${d.gen}`)}
            <Thumbnails
              sizes={d.sizes}
              current={d.current}
              scheduler={d.scheduler}
              rev={d.rev}
              checked={d.selected}
              onselect={onPick2}
              onreorder={(m, b) => ws.reorder(m, b)}
              ontabdrop={onTabDrop}
              ondragtab={(s) => (dragTab = s)}
              boxW={settings.sideWidth - 56}
              {actions}
            />
          {/each}
        </div>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <div
          class="split"
          role="separator"
          aria-orientation="vertical"
          aria-label="썸네일 패널 폭 조절"
          title="끌어서 폭 조절 (방향키로도 조절, 더블클릭하면 기본 폭)"
          aria-valuemin={SIDE_MIN}
          aria-valuemax={SIDE_MAX}
          aria-valuenow={settings.sideWidth}
          tabindex="0"
          onpointerdown={onSplitDown}
          onpointermove={onSplitMove}
          onpointerup={onSplitUp}
          onpointercancel={onSplitUp}
          onkeydown={onSplitKey}
          ondblclick={() => patchSettings({ sideWidth: defaultSettings.sideWidth })}
          data-testid="side-split"
        ></div>
      </aside>
    {/if}

    <main class="viewer-area" aria-label="뷰어">
      {#if doc}
        <AnnotToolbar
          {ui}
          busy={ws.opBusy}
          {formCount}
          notice={ws.editNotice}
          onrequestimage={() => stampInput.click()}
          onupdate={(a) => annotApi.update(ui.sel?.page ?? current, a)}
          ondelete={deleteSelectedAnnot}
          onnextfield={nextField}
          onclosenotice={() => (ws.editNotice = null)}
        />
      {/if}
      <div class="viewer-host" role="presentation" onpointerdown={onHostDown} onfocusin={onHostFocusIn}>
        {#if doc}
          {#each [doc] as d (`${d.key}:${d.gen}`)}
            <Viewer
              bind:this={viewer}
              bind:current={() => d.current, (v) => (d.current = v)}
              sizes={d.sizes}
              zoom={d.zoom}
              scheduler={d.scheduler}
              initialPage={d.current}
              initialScroll={d.scroll}
              rev={d.rev}
              overlay={pageOverlay}
              ondraw={(i, r) => (ui.drawn[i] = r)}
            />
          {/each}
        {:else}
          <div class="empty">
            <button type="button" class="primary" onclick={() => input.click()}>파일 열기</button>
          </div>
        {/if}
        {#if ws.status}
          <EngineStatus status={ws.status} ondismiss={() => (ws.status = null)} />
        {/if}
      </div>
    </main>
    {/if}

    {#if drawerOpen}
      <SettingsDrawer settings={{ ...settings, zoom: curZoom }} docOpen={!!doc} onchange={onSettingsChange} onclose={() => (drawerOpen = false)} />
    {/if}
  </div>

  <input bind:this={input} type="file" accept=".pdf,application/pdf" multiple hidden onchange={onPick} data-testid="file-input" />
  <input bind:this={stampInput} type="file" accept="image/png,image/jpeg" hidden onchange={() => void onStampFile()} data-testid="stamp-input" />
</div>

<style>
  .app { height: 100%; display: flex; flex-direction: column; }
  .toolbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    min-height: 44px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .spacer { flex: 1; }
  .nav, .zoom, .hist { display: flex; align-items: center; gap: 2px; }
  .anchor { position: relative; }
  .page-input { width: 4.5ch; min-width: 40px; text-align: center; padding: 4px 2px; }
  .total { color: var(--fg-muted); font-variant-numeric: tabular-nums; margin: 0 4px 0 2px; }
  .zoom select { width: 84px; }

  .body { position: relative; flex: 1; display: flex; min-height: 0; background: var(--bg); }
  .body.dragging { background: var(--drop-bg); outline: 2px dashed var(--fg-muted); outline-offset: -8px; }
  .side {
    position: relative;
    flex: none;
    width: 176px;
    display: flex;
    flex-direction: column;
    background: var(--surface-2);
    border-right: 1px solid var(--border);
    min-height: 0;
  }
  .thumbs-host { position: relative; flex: 1; min-height: 0; }
  .split {
    position: absolute;
    top: 0;
    bottom: 0;
    right: -4px;
    width: 8px;
    z-index: 5;
    cursor: col-resize;
    touch-action: none;
    outline: none;
  }
  .split:hover, .split:focus-visible, .split:active { background: var(--fg-muted); opacity: 0.5; }
  .split:focus-visible { opacity: 1; background: var(--fg); }
  @media (pointer: coarse) {
    .split { right: -14px; width: 28px; }
  }
  .viewer-area { position: relative; flex: 1; min-width: 0; overflow: hidden; display: flex; flex-direction: column; }
  .viewer-host { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  .empty { position: absolute; inset: 0; display: grid; place-items: center; }
</style>
