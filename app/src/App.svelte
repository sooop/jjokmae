<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { panelIn, panelOut, popIn, popOut, rangeFill, reduced, scrimFade, softOut } from './lib/motion';
  import { noteState } from './lib/motion/page-flip';
  import { gestureActive } from './lib/drag-session';
  import type { Annotation, FormField, NewAnnotation, PagePoint, Rect } from './engine/adapter';
  import AnnotToolbar from './lib/AnnotToolbar.svelte';
  import { hasHangul, type Tool } from './lib/annot-geom';
  import { AnnotUi, type AnnotApi } from './lib/annot-ui.svelte';
  import EngineStatus from './lib/EngineStatus.svelte';
  import { FindState } from './lib/find.svelte';
  import FindBar from './lib/FindBar.svelte';
  import FindMarks from './lib/FindMarks.svelte';
  import MergePopover from './lib/MergePopover.svelte';
  import Organize from './lib/Organize.svelte';
  import PageOverlay from './lib/PageOverlay.svelte';
  import PageTools from './lib/PageTools.svelte';
  import * as pa from './lib/page-actions';
  import type { ScreenRect } from './lib/motion/drag-ghost';
  import { PrintJob } from './lib/print-job.svelte';
  import { defaultScope, type PrintScope } from './lib/print';
  import PrintPopover from './lib/PrintPopover.svelte';
  import { detectRotation } from './lib/page-ops';
  import { stats } from './lib/render-queue';
  import SaveControl from './lib/SaveControl.svelte';
  import SaveNameDialog from './lib/SaveNameDialog.svelte';
  import { clickSelect } from './lib/selection';
  import SendPopover from './lib/SendPopover.svelte';
  import { editedName } from './lib/download';
  import { clampGrid, clampSide, clampZoom, loadSettings, saveSettings, SIDE_MAX, SIDE_MIN, defaultSettings, type Settings } from './lib/settings';
  import SettingsDrawer from './lib/SettingsDrawer.svelte';
  import SplitPopover from './lib/SplitPopover.svelte';
  import { prepareImage, releaseImage, StampFileError, stampFor, type PreparedImage } from './lib/stamp-image';
  import { applyTheme } from './lib/theme';
  import TabBar from './lib/TabBar.svelte';
  import PageMenu, { type PageMenuReq } from './lib/PageMenu.svelte';
  import Thumbnails from './lib/Thumbnails.svelte';
  import type { SendPos } from './lib/transfer';
  import Icon from './lib/ui/Icon.svelte';
  import IconButton from './lib/ui/IconButton.svelte';
  import Notice from './lib/ui/Notice.svelte';
  import Viewer from './lib/Viewer.svelte';
  import { Workspace, type DocState } from './lib/workspace.svelte';
  import { stepZoom, ZOOM_PRESETS } from './lib/zoom';
  import { sliderToZoom, ZOOM_SLIDER_MAX, zoomToSlider } from './lib/zoom-scale';

  let settings = $state<Settings>(loadSettings());
  let drawerOpen = $state(false);
  let dragging = $state(false);
  let viewer: ReturnType<typeof Viewer> | undefined = $state();
  let input: HTMLInputElement;

  // 팝오버
  let splitOpen = $state(false);
  /** 썸네일 패널의 쪽 메뉴(우클릭·길게 누르기·메뉴 키) */
  let pageMenu = $state<PageMenuReq | null>(null);
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
  // 끌던 썸네일 패널이 사라지면(문서·모드 전환) 탭 막대의 끌기 표시도 지운다
  $effect(() => {
    void ws.activeKey;
    void ws.mode;
    untrack(() => (dragTab = null));
  });

  // 주석·양식 편집 상태(활성 문서 하나에 대한 것. 문서를 바꾸면 초기화한다)
  const ui = new AnnotUi();
  // 주석을 고르거나 선택 외의 도구가 되면(도구 단축키·이미지 넣기) 도구 모음을 펼친다
  $effect(() => {
    if (ui.sel || ui.tool !== 'select') ui.open = true;
  });
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
  /** 슬라이더를 끄는 동안의 배율(확정 전). 본문은 CSS 변환으로 즉시 따라가고, 멈추면 확정해 다시 그린다 */
  let dragZoom = $state<number | null>(null);
  /** 포인터로 슬라이더를 끄는 중인가(100% 근처 자석은 끌 때만: 키보드 한 칸씩 움직임은 그대로 둔다) */
  let sliding = false;
  let zoomTimer = 0;
  const shownZoom = $derived(dragZoom ?? curZoom);
  const zoomOptions = $derived(ZOOM_PRESETS.includes(shownZoom) ? ZOOM_PRESETS : [...ZOOM_PRESETS, shownZoom].sort((a, b) => a - b));
  function onZoomSlide(e: Event & { currentTarget: HTMLInputElement }) {
    let z = sliderToZoom(Number(e.currentTarget.value));
    if (sliding && Math.abs(z - 1) < 0.025) z = 1; // 100% 근처에서 달라붙는다
    dragZoom = z;
    clearTimeout(zoomTimer);
    zoomTimer = window.setTimeout(commitZoom, 220);
  }
  /** 뷰어의 Ctrl+휠·핀치: 슬라이더를 끄는 것과 같은 길(즉시 변환 → 멈추면 확정) */
  function onWheelZoom(z: number) {
    dragZoom = z;
    clearTimeout(zoomTimer);
    zoomTimer = window.setTimeout(commitZoom, 220);
  }
  function commitZoom() {
    clearTimeout(zoomTimer);
    const z = dragZoom;
    if (z == null) return;
    setZoom(z);
    dragZoom = null;
  }
  // 문서가 바뀌면 끌던 배율은 버린다
  $effect(() => {
    void ws.activeKey;
    untrack(() => {
      clearTimeout(zoomTimer);
      dragZoom = null;
    });
  });
  // 되돌리기가 같은 연출을 찾도록 조작 뒤의 문서 상태를 알린다
  $effect(() => {
    const d = ws.active;
    if (d) noteState(d.key, d.stateId);
  });

  /** 보기 ↔ 정리 전환: 왼쪽 패널이 미끄러져 나가거나 들어오고, 본체는 흐려졌다 나타난다 */
  async function switchMode() {
    ws.toggleMode();
  }
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
  // 쪽 얼굴을 눌렀다. Shift·Ctrl(체크박스는 Ctrl)은 선택만 바꾸고, 수정자 없는 일반 클릭은 선택을 풀고 그 쪽으로 간다
  // (선택이 있는 선택 모드에서는 썸네일 패널이 일반 클릭을 Ctrl 로 바꿔 보내므로 이동하지 않는다).
  function onPick2(i: number, mod: { shift: boolean; ctrl: boolean }) {
    const d = doc;
    if (!d) return;
    if (!mod.shift && !mod.ctrl) {
      d.selected = [];
      d.anchor = i;
      ui.clearSelection();
      goto(i);
      return;
    }
    const r = clickSelect(d.selected, d.anchor ?? d.current, i, mod);
    d.selected = r.selected;
    d.anchor = r.anchor;
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

  // 저장 파일 이름 확인: 저장 버튼·Ctrl+S·정리 모드의 파일 저장은 모두 이 대화상자를 먼저 거친다
  let saveAsk = $state<{ key: number } | null>(null);
  /** 대화상자 입력칸의 처음 값. 닫히는 동안에도 내용이 바뀌지 않게 열 때 한 번만 정한다 */
  let saveAskName = $state('');
  async function askSave(target?: DocState) {
    const d = target ?? doc;
    if (!d || saveAsk || ws.saving) return;
    if (d === doc) await flushEdits(); // 입력 중인 칸을 확정하고 줄 서 있는 편집을 기다린다
    if (saveAsk || !ws.docs.includes(d) || ws.saving || ws.opBusy) return;
    saveAskName = d.saveName || editedName(d.name);
    saveAsk = { key: d.key };
  }
  async function confirmSaveName(name: string) {
    const a = saveAsk;
    saveAsk = null;
    const d = a ? ws.docOf(a.key) : undefined;
    if (!d) return;
    d.saveName = name === editedName(d.name) ? '' : name;
    if (d === doc) await requestSave();
    else await ws.save(d);
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

  /** 화면 밖이어도 DOM 에 남겨 둘 쪽: 양식 칸이 있는 쪽(Tab 이동·다음 칸 찾기)과 주석을 고른 쪽(편집 중인 상태) */
  const pinnedPages = $derived.by(() => {
    const s = new Set<number>();
    formsByPage.forEach((f, i) => {
      if (f.length) s.add(i);
    });
    if (ui.sel) s.add(ui.sel.page);
    return [...s];
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

  // ---------- 문서에서 찾기 ----------
  const find = new FindState();
  let findTimer = 0;
  function openFind() {
    if (!doc) return;
    if (ws.mode !== 'view') ws.toggleMode();
    find.show();
  }
  function closeFind() {
    clearTimeout(findTimer);
    find.close();
  }
  // 찾는 말·옵션·문서·문서 내용이 바뀌면 다시 찾는다(입력 중에는 잠깐 기다린다)
  $effect(() => {
    const d = ws.active;
    const on = find.open && ws.mode === 'view';
    void find.query;
    void find.matchCase;
    void d?.stateId;
    void d?.gen;
    if (!on || !d) return;
    untrack(() => {
      clearTimeout(findTimer);
      findTimer = window.setTimeout(() => {
        const q = find.query;
        const matchCase = find.matchCase;
        void find.run({
          scope: `${d.key}:${d.gen}`,
          total: d.total,
          start: d.current,
          search: (page) => ws.clientOf(d).searchPage(d.id, page, q, { matchCase }),
        });
      }, 160);
    });
    return () => clearTimeout(findTimer);
  });
  // 문서가 없어지거나 정리 모드로 가면 찾기를 닫는다
  $effect(() => {
    if (find.open && (!ws.active || ws.mode !== 'view')) untrack(closeFind);
  });
  // 현재 항목이 바뀌면 그 자리가 보이게 한다
  $effect(() => {
    const a = find.active;
    if (!a) return;
    untrack(() => {
      const q = find.byPage.get(a.page)?.[a.k]?.[0];
      if (!q) return;
      const xs = [q[0], q[2], q[4], q[6]];
      const ys = [q[1], q[3], q[5], q[7]];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      viewer?.revealRect(a.page, { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
    });
  });

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
    void pa.send(ws, { from: d, pages: [...d.selected], mode, target });
  }

  function onTabDrop(moving: number[], key: number, rects?: ScreenRect[], move = false) {
    const d = doc;
    if (!d) return;
    void pa.send(ws, { from: d, pages: moving, mode: move ? 'move' : 'copy', target: { type: 'doc', key, pos: 'end' } }, rects);
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
    // 저장 이름 대화상자가 떠 있는 동안 뒤 화면의 단축키는 받지 않는다(Esc·Enter 는 대화상자가 처리한다)
    if (saveAsk) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') e.preventDefault();
      return;
    }
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    // 쪽을 누르거나 끄는 중에는 구조를 바꾸는 단축키(되돌리기·탭 닫기·모드 전환·삭제 등)를 받지 않는다. Esc 는 끌기 쪽이 먼저 받아 취소한다
    if (gestureActive() && e.key !== 'Escape') {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && ['s', 'p', 'o', 'w', 'z', 'y', 'f', 'tab'].includes(e.key.toLowerCase())) e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        void askSave();
      } else if (k === 'p') {
        // 브라우저 기본 인쇄(화면 그대로 찍힘)를 막고 인쇄 대화상자를 연다
        e.preventDefault();
        openPrint();
      } else if (k === 'f' && doc) {
        // 브라우저 기본 찾기는 캔버스에 그린 글자를 찾지 못한다: 문서 찾기 줄을 연다
        e.preventDefault();
        openFind();
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
        void pa.step(ws, e.shiftKey ? 'redo' : 'undo');
      } else if (!typing && doc && k === 'y') {
        e.preventDefault();
        void pa.step(ws, 'redo');
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'F3' && find.open) { e.preventDefault(); find.step(e.shiftKey ? -1 : 1); return; }
    if (typing || !doc) return;
    if (!e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); void switchMode(); return; }
    if (ws.mode === 'organize') return; // 아래는 보기 모드 전용(도구·쪽 이동·확대). 정리 모드의 쪽 키는 격자가 맡는다
    const tool = e.shiftKey ? undefined : TOOL_KEYS[e.key.toLowerCase()];
    if (tool) { e.preventDefault(); ui.open = true; ui.setTool(tool); return; }
    if (!e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); ui.open = true; if (!ws.opBusy) stampInput.click(); return; }
    if (e.key === 'Delete' && ui.sel) { e.preventDefault(); deleteSelectedAnnot(); return; }
    if (e.key === 'Escape' && (ui.sel || ui.tool !== 'select')) { ui.clearSelection(); ui.tool = 'select'; return; }
    if (e.key === 'PageDown') { e.preventDefault(); goto(current + 1); }
    else if (e.key === 'PageUp') { e.preventDefault(); goto(current - 1); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(stepZoom(curZoom, 1)); }
    else if (e.key === '-') { e.preventDefault(); setZoom(stepZoom(curZoom, -1)); }
    else if (e.key === 'Delete' && selected.length) { e.preventDefault(); pa.remove(ws, selected); }
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
  onbeforeunload={(e) => {
    // 저장하지 않은 문서가 있으면 새로고침·창 닫기 전에 브라우저가 한 번 묻게 한다
    if (ws.docs.some((d) => d.dirty)) e.preventDefault();
  }}
  ondragover={(e) => e.preventDefault()}
  ondrop={(e) => e.preventDefault()}
/>

{#if pageMenu && doc && ws.mode !== 'organize'}
  <PageMenu
    {ws}
    req={pageMenu}
    onsplit={() => setTimeout(() => { splitOpen = true; ws.splitNotice = null; ws.splitError = null; }, 0)}
    onprint={() => openPrint('selected')}
    onclose={() => (pageMenu = null)}
  />
{/if}

{#snippet pageOverlay(i: number, visible: boolean)}
  {#if doc && doc.sizes[i]}
    {@const fh = find.open ? find.byPage.get(i) : undefined}
    {#if fh}<FindMarks hits={fh} k={(doc.zoom * 96) / 72} active={find.active?.page === i ? find.active.k : -1} />{/if}
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
      <IconButton icon="folder" label="파일 열기 (Ctrl+O)" onclick={() => input.click()} />
      <IconButton icon="grid" label="정리 모드 (G)" pressed={ws.mode === 'organize'} onclick={() => void switchMode()} />
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
      {/if}
    {/if}
    <span class="spacer"></span>
    {#if doc}
      {#if ws.mode === 'view'}
        <div class="zoom">
          <input
            class="zoom-slider"
            type="range"
            min="0"
            max={ZOOM_SLIDER_MAX}
            step="1"
            value={zoomToSlider(shownZoom)}
            use:rangeFill={zoomToSlider(shownZoom)}
            aria-label="확대 배율 슬라이더"
            aria-valuetext="{Math.round(shownZoom * 100)}%"
            title="확대 배율 (25–400%)"
            oninput={onZoomSlide}
            onchange={commitZoom}
            onpointerdown={() => (sliding = true)}
            onpointerup={() => (sliding = false)}
            onpointercancel={() => (sliding = false)}
            data-testid="zoom-slider"
          />
          <select aria-label="확대 배율" title="확대 배율" value={shownZoom} onchange={(e) => { dragZoom = null; setZoom(Number(e.currentTarget.value)); }}>
            {#each zoomOptions as z (z)}<option value={z}>{Math.round(z * 100)}%</option>{/each}
          </select>
        </div>
        <IconButton icon="highlighter" label="주석 도구 모음" pressed={ui.open} onclick={() => ui.toggleOpen()} />
      {/if}
      <div class="hist">
        <IconButton icon="undo" label="되돌리기 (Ctrl+Z)" onclick={() => void pa.step(ws, 'undo')} disabled={ws.opBusy || doc.undoCount === 0} />
        <IconButton icon="redo" label="다시하기 (Ctrl+Shift+Z)" onclick={() => void pa.step(ws, 'redo')} disabled={ws.opBusy || doc.redoCount === 0} />
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
        onsave={() => void askSave()}
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
      onmove={(k, i) => ws.moveDoc(k, i)}
      onrename={(k, n) => ws.renameDoc(k, n)}
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
    {#if dragging}
      <div class="veil" aria-hidden="true" in:popIn|global={{ origin: '50% 50%', from: 0.96, y: 0 }} out:popOut|global={{ origin: '50% 50%', from: 0.98, y: 0 }}>
        <span class="veil-ico"><Icon name="upload" size={28} /></span>
      </div>
    {/if}
    {#if doc && ws.mode === 'organize'}
      <div class="mode-wrap" out:softOut|global>
      <Organize
        {ws}
        thumb={settings.gridThumb}
        {sendButton}
        onthumb={(v) => patchSettings({ gridThumb: v })}
        onopenfile={() => input.click()}
        onconfirm={(c) => void onConfirmClose(c)}
        onsave={(d) => void askSave(d)}
        onsplit={() => setTimeout(() => { splitOpen = true; ws.splitNotice = null; ws.splitError = null; }, 0)}
        onprint={openPrint}
      />
      </div>
      {#if ws.status}
        <EngineStatus status={ws.status} ondismiss={() => (ws.status = null)} />
      {/if}
    {:else}
    {#if doc}
      <aside class="side" aria-label="페이지 목록" in:panelIn|global out:panelOut|global style:width="{settings.sideWidth}px" bind:this={sideEl}>
        <PageTools
          count={selected.length}
          busy={ws.opBusy}
          notice={ws.pagesNotice}
          onrotate={() => pa.rotate(ws, selected)}
          oncopy={() => pa.duplicate(ws, selected)}
          ondelete={() => pa.remove(ws, selected)}
          onextract={() => void ws.extract(selected)}
          onprint={() => openPrint('selected')}
          onclear={() => (doc.selected = [])}
          onclosenotice={() => (ws.pagesNotice = null)}
          extra={sendButton}
        />
        <div class="thumbs-host">
          {#each [doc] as d (d.key)}
            <Thumbnails
              gen={d.gen}
              stateId={d.stateId}
              sizes={d.sizes}
              current={d.current}
              scheduler={d.scheduler}
              rev={d.rev}
              checked={d.selected}
              onselect={onPick2}
              onreorder={(m, b, s) => pa.reorder(ws, m, b, s)}
              ontabdrop={onTabDrop}
              ondragtab={(s) => (dragTab = s)}
              oncontext={(r) => (pageMenu = { x: r.x, y: r.y, fromKey: d.key, pages: r.pages })}
              boxW={settings.sideWidth - 56}
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

    <main class="viewer-area" aria-label="뷰어" out:softOut|global>
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
              liveZoom={dragZoom ?? d.zoom}
              scheduler={d.scheduler}
              initialPage={d.current}
              initialScroll={d.scroll}
              rev={d.rev}
              pinned={pinnedPages}
              overlay={pageOverlay}
              ondraw={(i, r) => (ui.drawn[i] = r)}
              onwheelzoom={onWheelZoom}
            />
          {/each}
        {:else}
          <div class="empty" class:hot={dragging}>
            <div class="stack" aria-hidden="true">
              <span class="sheet s3"></span>
              <span class="sheet s2"></span>
              <span class="sheet s1"><i></i><i></i><i></i><i class="short"></i></span>
            </div>
            <button type="button" class="primary open" onclick={() => input.click()}>파일 열기</button>
          </div>
        {/if}
        {#if doc && find.open}
          <FindBar {find} onstep={(dir) => find.step(dir)} onclose={closeFind} />
        {/if}
        {#if ws.status}
          <EngineStatus status={ws.status} ondismiss={() => (ws.status = null)} />
        {/if}
      </div>
    </main>
    {/if}

    {#if drawerOpen}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="scrim" aria-hidden="true" onclick={() => (drawerOpen = false)} in:scrimFade out:scrimFade={{ out: true }}></div>
      <SettingsDrawer settings={{ ...settings, zoom: curZoom }} docOpen={!!doc} onchange={onSettingsChange} onclose={() => (drawerOpen = false)} />
    {/if}
  </div>

  <SaveNameDialog open={saveAsk != null} defaultName={saveAskName} onconfirm={(n) => void confirmSaveName(n)} oncancel={() => (saveAsk = null)} />

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
  .zoom { gap: 8px; padding-left: 4px; }
  .zoom-slider { width: 132px; min-width: 0; flex: 0 1 132px; }
  .zoom select { width: 88px; }
  @media (max-width: 860px) { .zoom-slider { flex-basis: 84px; width: 84px; } }
  @media (max-width: 680px) { .zoom-slider { display: none; } .zoom select { width: 76px; } }
  .toolbar > .anchor + .nav, .nav, .zoom, .hist { position: relative; }
  .nav::before, .zoom::before, .hist::before { content: ''; position: absolute; left: -5px; top: 8px; bottom: 8px; width: 1px; background: var(--border-soft); }

  .body { position: relative; flex: 1; display: flex; min-height: 0; background: var(--bg); transition: background-color var(--dur-base) var(--ease-out); }
  .body.dragging { background: var(--drop-bg); }
  /* 파일을 끌어 오면 작업 영역 둘레에 틀이 번지고 아이콘이 떠오른다 */
  .veil {
    position: absolute;
    inset: 10px;
    z-index: 40;
    display: grid;
    place-items: center;
    border: 2px dashed color-mix(in srgb, var(--fg) 45%, var(--border));
    border-radius: var(--r-lg);
    background: color-mix(in srgb, var(--bg) 55%, transparent);
    pointer-events: none;
  }
  .veil-ico {
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-fg);
    box-shadow: var(--shadow-3);
    animation: bob 1.1s var(--ease-in-out) infinite alternate;
  }
  @keyframes bob { from { transform: translateY(5px) scale(0.96); } to { transform: translateY(-5px) scale(1.04); } }
  .scrim { position: absolute; inset: 0; z-index: 15; background: var(--scrim); opacity: 0.5; }
  @media (prefers-reduced-motion: reduce) { .veil-ico { animation: none; } }
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
  .viewer-area { animation: kf-fade var(--dur-base) var(--ease-out); }
  .mode-wrap { flex: 1; min-width: 0; min-height: 0; display: flex; }
  .viewer-area { position: relative; flex: 1; min-width: 0; overflow: hidden; display: flex; flex-direction: column; }
  .viewer-host { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  /* 첫 화면: 종이 석 장이 부채꼴로 펼쳐지고 버튼이 뒤따라 떠오른다. 파일을 끌어 오면 종이가 들썩인다 */
  .empty { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 36px; }
  .stack { position: relative; width: 132px; height: 176px; }
  .sheet {
    position: absolute;
    inset: 0;
    border-radius: 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-2);
    transform-origin: 50% 100%;
    animation: fan var(--spring-bouncy-dur) var(--spring-bouncy) backwards;
  }
  .sheet i { display: block; height: 6px; margin: 14px 16px 0; border-radius: 3px; background: var(--border-soft); }
  .sheet i:first-child { margin-top: 26px; width: 55%; background: var(--border); }
  .sheet i.short { width: 40%; }
  .s1 { transform: rotate(0deg); animation-delay: 220ms; }
  .s2 { transform: rotate(-7deg) translateX(-12px); animation-delay: 120ms; }
  .s3 { transform: rotate(8deg) translateX(14px); animation-delay: 40ms; }
  .empty.hot .s1 { transform: translateY(-14px) rotate(-1deg) scale(1.04); }
  .empty.hot .s2 { transform: rotate(-13deg) translateX(-30px); }
  .empty.hot .s3 { transform: rotate(14deg) translateX(32px); }
  .sheet { transition: transform var(--spring-bouncy-dur) var(--spring-bouncy); }
  @keyframes fan { from { opacity: 0; transform: translateY(26px) rotate(0deg) scale(0.9); } }
  .open { padding: 6px 22px; animation: var(--kf-rise) var(--dur-slow) var(--ease-out) 380ms backwards; }
  @media (prefers-reduced-motion: reduce) { .sheet { animation: kf-fade var(--dur-fast) backwards; } .empty.hot .sheet { transform: none; } }
</style>
