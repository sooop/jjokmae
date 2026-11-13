// 다중 문서 작업 공간 저장소. 열린 문서 목록·활성 문서·엔진 인스턴스와, 문서 단위로 일반화한 조작 함수를 가진다.
//
// 규칙(기존 App 의 규칙을 문서 단위로 옮긴 것):
// - 라이브 문서를 save 한 뒤에는 그 문서를 편집하지 않고 저장 결과로 다시 연 문서로 갈아탄다(rebase).
// - 구조 조작(순서·회전·삭제·복제·보내기)은 applyOp/runOp: 문서 화면을 다시 만든다. 주석·양식은 editOp: 바뀐 쪽만 다시 그린다.
// - 엔진 인스턴스는 사용한 엔진 종류마다 하나. 같은 엔진의 문서끼리는 importPages 로 직접 옮기고,
//   다른 엔진 사이는 선택 쪽을 임시 문서로 추출한 바이트를 대상 엔진에서 열어 가져온다.
import type { DocId, PageSize, Rotation } from '../engine/adapter';
import type { EngineKind } from '../engine/protocol';
import type { EngineClient } from '../engine/worker-client';
import { baseName, downloadBytes, editedName } from './download';
import { freshCids, newCid } from './bitmap-cache';
import { bootEngine, bootErrorMessage, ENGINE_LABEL } from './engine-boot';
import { EnginePool } from './engine-pool';
import { GhostStore, HistoryPool, UndoHistory, type HasBytes } from './history';
import { addRotation, applyOrder, currentAfterDelete, detectRotation, dropOrder, isIdentity } from './page-ops';
import { splitNames } from './ranges';
import { RenderScheduler } from './render-queue';
import type { Settings } from './settings';
import type { NoticeData, TabNotice, ViewerStatus } from './status';
import { findBundlePartners, insertIndex, MAX_DOCS, newDocName, posLabel, quoteNames, range, uniqueName, type SendPos } from './transfer';
import { makeZip } from './zip';

/** 쪽마다 알고 있는 /Rotate 값. null 은 아직 모름(처음 회전할 때 알아낸다) */
export type RotState = (Rotation | null)[];

/** 되돌리기용 스냅샷: 조작 전 문서 바이트와 화면 상태 */
export interface Snap extends HasBytes {
  rot: RotState;
  /** 쪽별 내용 id(비트맵 캐시 열쇠). 되돌리면 그때의 id 로 돌아가 캐시에 남은 그림을 다시 쓴다 */
  cids?: number[];
  current: number;
  selected: number[];
  name: string;
  /** 주석·양식 편집의 스냅샷이면 바뀐 쪽. 되돌릴 때 화면을 다시 만들지 않고 이 쪽만 다시 그린다 */
  pages?: number[];
  /** 이 스냅샷이 찍은 상태의 번호(저장한 상태와 같은지로 '변경됨'을 판단한다) */
  stateId: number;
  /** 새 파일 만들기의 시작 지점. 되돌리면 그 탭을 닫는다 */
  create?: boolean;
}

export interface OpResult {
  rot: RotState;
  /** 조작 뒤 쪽별 내용 id. 그림이 그대로인 쪽은 옛 id 를 물려준다(없으면 모두 새 id: 전부 다시 그린다) */
  cids?: number[];
  current: number;
  selected: number[];
}

export type SendTarget = { type: 'new' } | { type: 'doc'; key: number; pos: SendPos };
export interface SendSpec {
  from: DocState;
  pages: number[];
  mode: 'copy' | 'move';
  target: SendTarget;
}

class OpenError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** 엔진 워커가 죽어서 실패했다(파일이 손상된 것이 아니다) */
class EngineStoppedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** 열린 파일이 MAX_DOCS 개라 더 늘릴 수 없다 */
class DocLimitError extends Error {}

/** 엔진 클라이언트(워커)가 죽었는가: worker-client 의 읽기 전용 dead */
const clientDead = (c: EngineClient): boolean => c.dead;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sorted = (pages: number[]) => [...new Set(pages)].sort((a, b) => a - b);

/** 열린 문서 하나의 상태 */
export class DocState {
  readonly key: number;
  /** 이 문서를 연 엔진. 설정을 바꿔도 이 문서는 그대로 쓴다 */
  readonly kind: EngineKind;
  /** 이 문서를 연 엔진 인스턴스. 엔진이 죽어 같은 종류로 다시 띄워도 이 문서는 옛(죽은) 인스턴스로만 다룬다 — 새 워커에 옛 id 를 보내지 않게 */
  client!: EngineClient;
  /** 엔진 문서 ID. rebase 할 때마다 바뀐다 */
  id: DocId = '';
  name = $state('');
  sizes = $state.raw<PageSize[]>([]);
  /** 쪽별 무효화 키. 주석·양식을 고치면 그 쪽만 올려 그 쪽 비트맵만 다시 그린다 */
  rev = $state<number[]>([]);
  scheduler!: RenderScheduler;
  /** 화면(뷰어·썸네일)을 다시 만들 때 올린다 */
  gen = $state(0);
  /** 화면이 만들어질 때 보여 줄 쪽 */
  start = 0;
  current = $state(0);
  zoom = $state(1);
  selected = $state.raw<number[]>([]);
  anchor: number | null = null;
  /** 탭을 떠날 때의 본문 스크롤 위치 */
  scroll: { top: number; left: number } | null = null;
  /** 정리 모드 격자의 스크롤 위치 */
  gridScroll = 0;
  rot: RotState = [];
  /** 쪽별 내용 id(비트맵 캐시 열쇠). 쪽 그림이 바뀌면 그 쪽만 새 id 를 받는다 */
  cids: number[] = [];
  stateId = $state(0);
  savedStateId = $state(0);
  /** 이 문서를 연 뒤 쪽을 삭제한 적이 있는가(저장 안내 문구용) */
  deletedAny = false;
  history: UndoHistory<Snap>;
  undoCount = $state(0);
  redoCount = $state(0);

  constructor(key: number, kind: EngineKind, pool: HistoryPool) {
    this.key = key;
    this.kind = kind;
    this.history = new UndoHistory<Snap>(undefined, undefined, pool);
  }

  get dirty() {
    return this.stateId !== this.savedStateId;
  }
  get total() {
    return this.sizes.length;
  }
  syncHistory() {
    this.undoCount = this.history.undoStack.length;
    this.redoCount = this.history.redoStack.length;
  }
}

export interface WorkspaceHooks {
  settings(): Settings;
  /** 활성 문서가 바뀌기 직전: 본문 스크롤 위치 등 화면 상태를 문서에 적어 둔다 */
  beforeLeave?(d: DocState): void;
  /** 활성 문서의 화면이 새로 만들어졌거나 활성이 바뀐 뒤(문서가 없어지면 null) */
  afterInstall?(d: DocState | null): void;
  /** 빠른 되돌리기(문서 화면을 다시 만들지 않고 바뀐 쪽만 다시 그림) 직후 */
  afterSwap?(d: DocState): void;
  afterSave?(d: DocState): void;
  /** 화면 모드가 바뀐 직후 */
  afterMode?(m: ViewMode): void;
}

/** 보기: 탭+썸네일+본문 / 정리: 파일 목록+썸네일 격자 */
export type ViewMode = 'view' | 'organize';

export class Workspace {
  docs = $state.raw<DocState[]>([]);
  activeKey = $state<number | null>(null);
  status = $state<ViewerStatus | null>(null);
  /** 화면 모드. 문서 목록·활성 문서·쪽 선택·되돌리기 기록은 모드와 무관하게 하나다 */
  mode = $state<ViewMode>('view');

  opBusy = $state(false);
  saving = $state(false);
  /** 줄 서 있거나 진행 중인 주석·양식 편집 수. 저장 버튼은 이 동안에도 눌린다(저장이 편집 뒤로 기다린다) */
  editPending = $state(0);
  splitBusy = $state(false);
  splitDone = $state(0);
  splitError = $state<string | null>(null);
  mergeBusy = $state(false);
  mergeError = $state<string | null>(null);

  pagesNotice = $state<NoticeData | null>(null);
  editNotice = $state<NoticeData | null>(null);
  saveNotice = $state<NoticeData | null>(null);
  splitNotice = $state<NoticeData | null>(null);
  /** 탭 옆에 붙는 안내(다른 문서가 함께 바뀌었을 때, 보내기 결과 등) */
  tabNotice = $state<TabNotice | null>(null);
  /** 닫기 확인을 기다리는 탭 */
  confirmClose = $state<{ key: number; busy: boolean } | null>(null);

  hooks: WorkspaceHooks;
  readonly pool = new HistoryPool();

  /** 엔진 종류별 인스턴스·동시 기동 합치기·사용 중(열기·되살리기·인쇄 임시 문서) 표시 */
  private enginePool: EnginePool<EngineKind, EngineClient>;
  private keySeq = 0;
  private genSeq = 0;
  private stateSeq = 0;
  private bundleSeq = 0;
  private newSeq = 1;
  private openChain: Promise<unknown> = Promise.resolve();
  private editChain: Promise<unknown> = Promise.resolve();
  /** 이동 묶음 번호 → 되돌리기로 닫힌 새 탭의 내용(다시하기로 되살리기 위해) */
  private ghosts = new GhostStore<{ name: string; kind: EngineKind; bytes: Uint8Array; rot: RotState; zoom: number }>();

  constructor(hooks: WorkspaceHooks) {
    this.hooks = hooks;
    this.enginePool = new EnginePool<EngineKind, EngineClient>((kind) => this.bootKind(kind), clientDead);
    // 상한(128MB)으로 버려진 새 탭은 다시하기로 되살릴 수 없으므로, 그 묶음의 다시하기 단계도 함께 없앤다
    this.ghosts.onEvict = (bundle) => this.invalidateRedo(bundle);
  }

  /** 묶음 번호 bundle 의 다시하기 단계를 모든 문서에서 없앤다(그 단계와 그보다 나중 단계는 더 이을 수 없다) */
  private invalidateRedo(bundle: number) {
    for (const d of this.docs) {
      const i = d.history.redoStack.findIndex((s) => s.bundle === bundle);
      if (i >= 0) {
        d.history.dropRedoThrough(i);
        d.syncHistory();
      }
    }
  }

  get active(): DocState | null {
    return this.docs.find((d) => d.key === this.activeKey) ?? null;
  }
  docOf(key: number): DocState | undefined {
    return this.docs.find((d) => d.key === key);
  }
  clientOf(d: DocState): EngineClient {
    return d.client;
  }
  /** 같은 엔진 인스턴스에서 연 문서끼리인가(엔진이 죽어 다시 뜬 경우 종류가 같아도 다른 인스턴스다) */
  private sameEngine(a: DocState, b: DocState): boolean {
    return a.client === b.client;
  }
  /** 지금 떠 있는 엔진 종류(시험·진단용) */
  get engineKinds(): EngineKind[] {
    return this.enginePool.kinds();
  }

  // ---------- 엔진 ----------
  private bootKind(kind: EngineKind): Promise<EngineClient> {
    return bootEngine(kind, {
      confirmDownload: (ref) =>
        new Promise<boolean>((resolve) => {
          this.status = { phase: 'confirm', engine: kind, ref, decide: (ok) => { this.status = null; resolve(ok); } };
        }),
      onProgress: (p) => {
        this.status =
          p.loaded >= p.total
            ? { phase: 'start', engine: kind }
            : { phase: 'download', engine: kind, loaded: p.loaded, total: p.total };
      },
    });
  }

  /** 엔진을 얻는다. 같은 종류의 동시 기동은 합쳐지고, 죽은 엔진은 폐기하고 새로 띄운다 */
  private acquire(kind: EngineKind): Promise<EngineClient> {
    return this.enginePool.acquire(kind);
  }

  /** 열린 문서가 없고 쓰는 중(열기·되살리기·인쇄 임시 문서)도 아닌 엔진은 해제한다 */
  private releaseUnusedEngines() {
    this.enginePool.releaseUnused((kind) => this.docs.some((d) => d.kind === kind));
  }

  private async readSizes(c: EngineClient, id: DocId): Promise<PageSize[]> {
    const n = await c.pageCount(id);
    return Promise.all(Array.from({ length: n }, (_, i) => c.pageSize(id, i)));
  }

  private clearNotices() {
    this.pagesNotice = this.saveNotice = this.splitNotice = this.editNotice = null;
  }

  /** 조작이 끝나길 기다린다(최대 60초). 끝났으면 true, 시간이 지나도 조작 중이면 false */
  private async waitIdle(): Promise<boolean> {
    const t0 = Date.now();
    while (this.opBusy && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 30));
    return !this.opBusy;
  }

  // ---------- 문서 목록 ----------
  private makeDoc(client: EngineClient, kind: EngineKind, id: DocId, name: string, sizes: PageSize[], rot: RotState, zoom: number): DocState {
    const d = new DocState(++this.keySeq, kind, this.pool);
    d.client = client;
    d.id = id;
    d.name = name;
    d.sizes = sizes;
    d.rev = sizes.map(() => 0);
    d.rot = Array.from({ length: sizes.length }, (_, i) => rot[i] ?? null);
    d.zoom = zoom;
    d.gen = ++this.genSeq;
    d.cids = freshCids(sizes.length);
    d.scheduler = new RenderScheduler(client, id, 2, undefined, (i) => d.cids[i]);
    d.history.ondrop = (st) => {
      d.syncHistory();
      if (st.bundle != null) this.ghosts.delete(st.bundle);
    };
    return d;
  }

  /** 문서를 목록에 넣는다. 열린 파일이 MAX_DOCS 개면 넣지 않고 false(호출자가 엔진 문서·기록을 정리한다) */
  private addDoc(d: DocState): boolean {
    if (this.docs.length >= MAX_DOCS) return false;
    this.docs = [...this.docs, d];
    return true;
  }

  /** 목록에 넣지 못한(또는 넣기 전에 버리는) 문서의 엔진 문서·기록·스케줄러를 정리한다 */
  private async discardDoc(d: DocState) {
    d.scheduler.dispose();
    d.history.dispose();
    await d.client.close(d.id).catch(() => {});
  }

  activate(key: number) {
    if (key === this.activeKey) return;
    const next = this.docOf(key);
    if (!next) return;
    const prev = this.active;
    if (prev) this.hooks.beforeLeave?.(prev);
    this.activeKey = key;
    this.clearNotices();
    if (this.tabNotice?.key === key) this.tabNotice = null;
    this.hooks.afterInstall?.(next);
  }

  /** 탭 순서대로 한 칸 이동(방향 ±1, 처음과 끝은 이어진다) */
  cycle(dir: 1 | -1) {
    const n = this.docs.length;
    if (n < 2) return;
    const i = this.docs.findIndex((d) => d.key === this.activeKey);
    this.activate(this.docs[(i + dir + n) % n].key);
  }

  // ---------- 화면 모드 ----------
  setMode(m: ViewMode) {
    if (m === this.mode) return;
    const a = this.active;
    if (a && m === 'organize') this.hooks.beforeLeave?.(a);
    this.mode = m;
    this.hooks.afterMode?.(m);
  }

  toggleMode() {
    this.setMode(this.mode === 'view' ? 'organize' : 'view');
  }

  /** 정리 모드에서 쪽을 더블클릭: 보기 모드로 바꾸고 그 쪽을 연다 */
  openPage(i: number) {
    const d = this.active;
    if (!d || i < 0 || i >= d.total) return;
    d.current = i;
    d.start = i;
    d.scroll = null;
    this.setMode('view');
  }

  // ---------- 열기 ----------
  /** 파일들을 모두 새 탭으로 연다. 마지막으로 연 파일이 활성이 된다. 실패한 파일은 탭 없이 파일명을 짚어 안내한다 */
  openFiles(files: File[], skipped: File[] = []): Promise<void> {
    const run = () => this.openFilesNow(files, skipped);
    const p = this.openChain.then(run, run);
    this.openChain = p.catch(() => {});
    return p;
  }

  private async openFilesNow(files: File[], skipped: File[]) {
    if (this.status?.phase === 'error') this.status = null;
    const broken: { name: string; detail: string }[] = [];
    const encrypted: string[] = [];
    const refused: string[] = [];
    let opened = 0;
    let last: DocState | null = null;
    let aborted = false;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (this.docs.length >= MAX_DOCS) {
        refused.push(f.name);
        continue;
      }
      try {
        last = await this.openOne(f);
        opened++;
      } catch (e) {
        if (e instanceof DocLimitError) {
          refused.push(f.name);
        } else if (e instanceof OpenError) {
          if (/비밀번호|password|암호/i.test(e.message)) encrypted.push(f.name);
          else broken.push({ name: f.name, detail: e.message });
        } else if (e instanceof EngineStoppedError) {
          // 워커가 죽어서 실패한 것: 파일 탓이 아니다. 이 종류로 열려 있던 문서는 죽은 엔진에 매여 있어 더는 쓸 수 없다
          const kind = this.hooks.settings().engine;
          const rest = files.slice(i);
          const stale = this.docs.some((x) => x.kind === kind);
          this.status = {
            phase: 'error',
            message: `${ENGINE_LABEL[kind]} 엔진이 멈춰서 파일을 열지 못했습니다. 다시 시도해 주세요.${stale ? ' 이미 열려 있던 파일은 작업할 수 없으니 닫고 다시 열어 주세요.' : ''}`,
            detail: e.message,
            retry: () => void this.openFiles(rest),
          };
          aborted = true;
          break;
        } else {
          const kind = this.hooks.settings().engine;
          const m = bootErrorMessage(e, kind);
          const rest = files.slice(i);
          this.status = m ? { phase: 'error', message: m.message, detail: m.detail, retry: () => void this.openFiles(rest) } : null;
          aborted = true;
          break;
        }
      }
    }
    if (last) this.activate(last.key);
    if (aborted) return;
    const parts: string[] = [];
    if (skipped.length) parts.push(`${quoteNames(skipped.map((f) => f.name))}은(는) PDF 파일이 아니어서 열지 않았습니다.`);
    if (encrypted.length) parts.push(`${quoteNames(encrypted)}에 암호가 걸려 있어 열 수 없습니다. 암호를 푼 파일을 열어 주세요.`);
    if (broken.length) parts.push(`${quoteNames(broken.map((b) => b.name))}을(를) 열지 못했습니다. PDF 파일이 아니거나 손상되었을 수 있습니다.`);
    if (refused.length) parts.push(`열린 파일이 ${MAX_DOCS}개라 ${quoteNames(refused)}은(는) 열지 못했습니다. 탭을 닫고 다시 열어 주세요.`);
    if (!parts.length) {
      this.status = null;
      return;
    }
    if (!files.length && skipped.length) {
      this.status = { phase: 'error', message: 'PDF 파일만 열 수 있습니다. PDF 파일을 선택해 주세요.' };
      return;
    }
    if (opened) parts.push(`나머지 ${opened}개 파일은 열었습니다.`);
    this.status = { phase: 'error', message: parts.join(' '), detail: broken.map((b) => `${b.name}: ${b.detail}`).join(' / ') || undefined };
  }

  private async openOne(file: File): Promise<DocState> {
    const kind = this.hooks.settings().engine;
    this.enginePool.pin(kind);
    try {
      const c = await this.acquire(kind);
      this.status = { phase: 'opening', name: file.name };
      const buf = await file.arrayBuffer();
      // 워커 사망으로 실패한 것은 '손상된 PDF' 가 아니다
      const fail = (e: unknown) => (clientDead(c) ? new EngineStoppedError(e) : new OpenError(e));
      let id: DocId;
      try {
        id = await c.open(buf);
      } catch (e) {
        throw fail(e);
      }
      let sizes: PageSize[];
      try {
        sizes = await this.readSizes(c, id);
      } catch (e) {
        await c.close(id).catch(() => {});
        throw fail(e);
      }
      const d = this.makeDoc(c, kind, id, uniqueName(this.docs.map((x) => x.name), file.name), sizes, [], this.hooks.settings().zoom);
      if (!this.addDoc(d)) {
        await this.discardDoc(d);
        throw new DocLimitError();
      }
      return d;
    } finally {
      this.enginePool.unpin(kind);
      this.releaseUnusedEngines();
    }
  }

  // ---------- 닫기 ----------
  /** 변경된 탭은 확인을 거친다(force 면 바로 닫는다) */
  async close(key: number, force = false): Promise<void> {
    const d = this.docOf(key);
    if (!d) return;
    if (d.dirty && !force) {
      this.confirmClose = { key, busy: false };
      return;
    }
    if (!(await this.waitIdle())) {
      // 60초가 지나도 다른 조작이 끝나지 않았다: 조작 중인 문서를 지우지 않고 알린다
      if (this.confirmClose?.key === key) this.confirmClose = null;
      this.tabNotice = {
        key,
        kind: 'error',
        text: `‘${d.name}’을(를) 닫지 못했습니다. 다른 작업이 아직 끝나지 않았으니 끝난 뒤 다시 닫아 주세요.`,
        reassure: '파일은 그대로 열려 있습니다.',
      };
      return;
    }
    await this.removeDoc(d);
  }

  private async removeDoc(d: DocState) {
    if (!this.docs.includes(d)) return;
    const idx = this.docs.indexOf(d);
    const wasActive = d.key === this.activeKey;
    d.scheduler.dispose();
    this.docs = this.docs.filter((x) => x !== d);
    for (const st of d.history.redoStack) if (st.bundle != null) this.ghosts.delete(st.bundle);
    d.history.dispose();
    if (this.confirmClose?.key === d.key) this.confirmClose = null;
    if (this.tabNotice?.key === d.key) this.tabNotice = null;
    if (wasActive) {
      const next = this.docs[Math.min(idx, this.docs.length - 1)] ?? null;
      this.activeKey = next?.key ?? null;
      this.clearNotices();
      this.hooks.afterInstall?.(next);
    }
    await d.client.close(d.id).catch(() => {});
    this.releaseUnusedEngines();
  }

  // ---------- 조작 공통: 스냅샷 → 실행 → 문서 갱신 ----------
  /**
   * 라이브 문서를 증분 저장하고, 그 바이트로 다시 연 문서로 갈아탄다(화면은 그대로).
   * 엔진 어댑터(MuPDF)는 저장할 때마다 문서의 변경 추적을 초기화한다. 저장한 문서를 계속 편집하면 다음 증분 저장이
   * 앞선 변경을 빠뜨리거나 xref 가 깨진 파일을 만든다. 그래서 저장한 문서는 다시 쓰지 않고
   * 저장 결과를 새 기준(원본 ⊂ 저장본 사슬)으로 삼는다. 증분이 안 되면 전체 저장본이 기준이 된다.
   */
  private async rebase(c: EngineClient, d: DocState): Promise<{ bytes: Uint8Array; fullFallback: boolean }> {
    const r = await c.save(d.id, { incremental: true });
    const id2 = await c.open(r.bytes.slice());
    const oldId = d.id;
    d.id = id2;
    // 스케줄러는 새로 만들지 않는다(화면 재생성 gen 이 오르지 않아 대기·진행 중이던 렌더가 빈 칸으로 남는다). 문서 id 만 바꾼다
    d.scheduler.rebind(id2);
    await c.close(oldId).catch(() => {});
    return r;
  }

  /** rebase 한 라이브 문서를 같은 바이트로 다시 열어 갈아탄다(화면은 그대로 두고 id 만 바꾼다) */
  private async swapLive(c: EngineClient, d: DocState, bytes: Uint8Array) {
    const id2 = await c.open(bytes.slice());
    const oldId = d.id;
    d.id = id2;
    d.scheduler.rebind(id2);
    await c.close(oldId).catch(() => {});
  }

  private async takeSnap(c: EngineClient, d: DocState): Promise<Snap> {
    const r = await this.rebase(c, d);
    return { bytes: r.bytes, rot: [...d.rot], cids: [...d.cids], current: d.current, selected: [...d.selected], name: d.name, stateId: d.stateId };
  }

  private pushHistory(d: DocState, snap: Snap, bundle?: number) {
    d.stateId = ++this.stateSeq;
    d.history.push(bundle != null ? { ...snap, bundle } : snap);
    d.syncHistory();
  }

  /** 엔진 문서 id 를 화면 상태로 만든다. 이전 문서는 닫는다(id 가 다를 때) */
  private async installDoc(d: DocState, id: DocId, rot: RotState, cur: number, sel: number[], cids?: number[]) {
    const c = this.clientOf(d);
    const sizes = await this.readSizes(c, id);
    const n = sizes.length;
    const oldId = d.id;
    d.scheduler.dispose();
    const start = Math.max(0, Math.min(n - 1, cur));
    d.id = id;
    d.sizes = sizes;
    d.rot = Array.from({ length: n }, (_, i) => rot[i] ?? null);
    d.start = start;
    d.current = start;
    d.selected = sel.filter((s) => s >= 0 && s < n);
    // 순서 변경·되돌리기로 쪽 번호가 가리키는 쪽이 바뀌므로 옛 기준점은 쓸 수 없다: 새 선택의 첫 쪽으로 다시 잡는다
    d.anchor = d.selected.length ? d.selected[0] : null;
    d.scroll = null;
    d.rev = sizes.map(() => 0);
    d.cids = cids && cids.length === n ? [...cids] : freshCids(n);
    d.scheduler = new RenderScheduler(c, id, 2, undefined, (i) => d.cids[i]);
    d.gen = ++this.genSeq;
    if (oldId !== id) await c.close(oldId).catch(() => {});
    if (d.key === this.activeKey) {
      try {
        this.hooks.afterInstall?.(d);
      } catch (e) {
        // 문서는 이미 갈아탔다. 화면 훅의 오류로 조작 전체를 실패로 만들지 않는다
        console.error(e);
      }
    }
  }

  /**
   * 바이트를 새로 열어 화면 상태로 만든다. 설치에 실패하면 방금 연 엔진 문서를 닫는다(누수 방지).
   * 설치에 실패해도 d.id 는 그대로다.
   */
  private async installFresh(d: DocState, bytes: Uint8Array, rot: RotState, cur: number, sel: number[], cids?: number[]) {
    const c = this.clientOf(d);
    const id = await c.open(bytes.slice());
    try {
      await this.installDoc(d, id, rot, cur, sel, cids);
    } catch (e) {
      if (d.id !== id) await c.close(id).catch(() => {});
      throw e;
    }
  }

  private async restoreSnap(d: DocState, snap: Snap) {
    await this.installFresh(d, snap.bytes, snap.rot, snap.current, snap.selected, snap.cids);
  }

  /**
   * 구조 조작 한 번(opBusy 를 이미 잡고 있어야 한다). 성공하면 되돌리기 기록에 남기고 문서를 갱신한다.
   * 실패하면 조작 전 스냅샷으로 되돌려 놓는다.
   */
  private async applyOp(
    d: DocState,
    what: string,
    fn: (c: EngineClient, d: DocState, snap: Snap) => Promise<OpResult>,
    bundle?: number,
  ): Promise<boolean> {
    const c = this.clientOf(d);
    let snap: Snap;
    try {
      snap = await this.takeSnap(c, d);
    } catch (e) {
      this.pagesNotice = { kind: 'error', text: `${what}에 실패했습니다. 다시 시도해 주세요.`, reassure: '문서는 그대로입니다.', detail: errText(e) };
      return false;
    }
    d.scheduler.dispose();
    try {
      const res = await fn(c, d, snap);
      // 설치가 끝난 뒤에 기록한다(설치가 실패하면 아래에서 조작 전 상태로 복구하므로, 먼저 기록하면 기록만 남는다)
      await this.installDoc(d, d.id, res.rot, res.current, res.selected, res.cids);
      this.pushHistory(d, snap, bundle);
      return true;
    } catch (e) {
      try {
        await this.restoreSnap(d, snap);
        this.pagesNotice = { kind: 'error', text: `${what}에 실패했습니다. 다시 시도해 주세요.`, reassure: '문서는 조작 전 상태 그대로입니다.', detail: errText(e) };
      } catch (e2) {
        this.pagesNotice = { kind: 'error', text: `${what}에 실패했고 문서를 되돌리지 못했습니다. 파일을 다시 열어 주세요.`, detail: `${errText(e)} / ${errText(e2)}` };
      }
      return false;
    } finally {
      d.syncHistory();
    }
  }

  /** 활성 문서에 대한 구조 조작 */
  async runOp(what: string, fn: (c: EngineClient, d: DocState, snap: Snap) => Promise<OpResult>): Promise<boolean> {
    const d = this.active;
    if (!d || this.opBusy) return false;
    this.opBusy = true;
    this.pagesNotice = null;
    try {
      return await this.applyOp(d, what, fn);
    } finally {
      this.opBusy = false;
    }
  }

  // ---------- 되돌리기·다시하기 ----------
  /** 문서 하나를 한 단계 되돌리거나 다시한다(opBusy 를 이미 잡고 있어야 한다). 새 파일의 시작 지점은 호출자가 다룬다 */
  private async stepDoc(d: DocState, dir: 'undo' | 'redo'): Promise<boolean> {
    const c = this.clientOf(d);
    const h = d.history;
    const label = dir === 'undo' ? '되돌리기' : '다시하기';
    try {
      const cur = await this.takeSnap(c, d);
      const target = (dir === 'undo' ? h.popUndo() : h.popRedo())!;
      cur.bundle = target.bundle;
      const put = (s: Snap) => (dir === 'undo' ? h.pushRedo(s) : h.pushUndo(s));
      const putBack = () => (dir === 'undo' ? h.pushUndo(target) : h.pushRedo(target));
      // 주석·양식 편집은 문서를 그대로 두고 바뀐 쪽만 다시 그린다(쪽 구성이 같을 때)
      const fast = !!target.pages && target.pages.every((p) => p >= 0 && p < d.rev.length);
      if (fast) {
        try {
          // 갈아타는 사이에 끝나는 렌더가 옛 id 로 캐시에 들어가지 않게, 바뀌는 쪽의 id 를 먼저 바꿔 둔다
          for (const p of target.pages!) d.cids[p] = newCid();
          await this.swapLive(c, d, target.bytes);
          cur.pages = target.pages;
          put(cur);
          d.stateId = target.stateId;
          for (const p of target.pages!) {
            d.cids[p] = target.cids?.[p] ?? newCid();
            d.rev[p]++;
          }
          if (d.key === this.activeKey) this.hooks.afterSwap?.(d);
          return true;
        } catch (e) {
          putBack();
          this.pagesNotice = { kind: 'error', text: `${label}에 실패했습니다.`, reassure: '문서는 그대로입니다.', detail: errText(e) };
          return false;
        }
      }
      d.scheduler.dispose();
      try {
        // 열기·설치가 모두 성공한 뒤에 기록·stateId 를 바꾼다(실패하면 설치하다 만 id 는 installFresh 가 닫는다)
        await this.installFresh(d, target.bytes, target.rot, target.current, target.selected, target.cids);
        put(cur);
        d.stateId = target.stateId;
        return true;
      } catch (e) {
        putBack();
        await this.installDoc(d, d.id, [...d.rot], cur.current, cur.selected, cur.cids).catch(() => {});
        this.pagesNotice = { kind: 'error', text: `${label}에 실패했습니다.`, reassure: '문서는 그대로입니다.', detail: errText(e) };
        return false;
      }
    } catch (e) {
      this.pagesNotice = { kind: 'error', text: `${label}에 실패했습니다.`, reassure: '문서는 그대로입니다.', detail: errText(e) };
      return false;
    } finally {
      d.syncHistory();
    }
  }

  /**
   * 활성 문서를 되돌리거나 다시한다. 쪽 이동(두 문서에 같은 묶음 번호)이면 짝이 되는 문서도 함께 되돌리고,
   * 새 파일로 보낸 것을 되돌리면 그 새 탭을 닫는다.
   */
  async stepHistory(dir: 'undo' | 'redo'): Promise<void> {
    const d = this.active;
    if (!d || this.opBusy) return;
    const h = d.history;
    if (!(dir === 'undo' ? h.canUndo : h.canRedo)) return;
    this.opBusy = true;
    this.pagesNotice = null;
    this.tabNotice = null;
    const verb = dir === 'undo' ? '되돌렸습니다' : '다시 적용했습니다';
    try {
      const top = (dir === 'undo' ? h.undoStack : h.redoStack).at(-1)!;
      const bundle = top.bundle;
      // 복사·병합으로 만든 새 파일(짝 문서 없음)은 시작 지점에서 탭을 닫지 않는다. 닫으면 다시하기로 되살릴 곳이 없어 내용을 잃는다
      if (dir === 'undo' && top.create && bundle == null) {
        this.tabNotice = { key: d.key, kind: 'info', text: `‘${d.name}’을(를) 만든 시점까지 되돌렸습니다. 더 되돌릴 단계가 없습니다.` };
        return;
      }
      let partners: DocState[] = [];
      if (bundle != null) {
        const probe = this.docs.map((x) => ({ key: x.key, stack: dir === 'undo' ? x.history.undoStack : x.history.redoStack }));
        const r = findBundlePartners(bundle, d.key, probe);
        if (r.blocked.length) {
          const other = this.docOf(r.blocked[0])!;
          this.tabNotice = {
            key: other.key,
            kind: 'error',
            text: `‘${d.name}’의 이 단계는 ‘${other.name}’과(와) 이어져 있어, ‘${other.name}’에서 이후에 한 편집을 먼저 ${dir === 'undo' ? '되돌려' : '되돌린 뒤 다시'} 주세요.`,
            reassure: '두 파일 모두 그대로입니다.',
          };
          return;
        }
        partners = r.partners.map((k) => this.docOf(k)!);
      }

      // 다시하기로 닫았던 새 탭을 되살려야 하는데 이미 열린 파일이 가득이면, 아무것도 바꾸기 전에 막는다
      // (먼저 원본 쪽을 다시 적용한 뒤에야 탭을 못 여는 어긋남을 피한다)
      if (dir === 'redo' && bundle != null && this.ghosts.has(bundle) && this.docs.length >= MAX_DOCS) {
        this.pagesNotice = {
          kind: 'error',
          text: `열린 파일이 ${MAX_DOCS}개라 닫았던 새 파일을 다시 열 수 없어 다시하기를 하지 못했습니다. 탭을 하나 닫은 뒤 다시하기를 눌러 주세요.`,
          reassure: '문서는 그대로입니다.',
        };
        return;
      }

      // 새 파일의 시작 지점을 되돌리면 그 탭은 닫는다(내용은 다시하기를 위해 따로 남긴다)
      const all = [d, ...partners];
      const closing: DocState[] = [];
      const done: DocState[] = [];
      for (const x of all) {
        const topx = (dir === 'undo' ? x.history.undoStack : x.history.redoStack).at(-1)!;
        let ok = true;
        if (dir === 'undo' && topx.create) {
          // 새 탭이 닫히기 전에 내용을 남긴다. 이 저장이 실패해도 아래 롤백과 같은 경로로 처리한다
          if (bundle != null) {
            try {
              const cur = await this.takeSnap(this.clientOf(x), x);
              this.ghosts.set(bundle, { name: x.name, kind: x.kind, bytes: cur.bytes, rot: cur.rot, zoom: x.zoom });
            } catch (e) {
              this.pagesNotice = { kind: 'error', text: '되돌리기에 실패했습니다.', reassure: '문서는 그대로입니다.', detail: errText(e) };
              ok = false;
            }
          }
          if (ok) {
            closing.push(x);
            continue;
          }
        } else {
          ok = await this.stepDoc(x, dir);
          if (ok) {
            done.push(x);
            continue;
          }
        }
        // 한쪽이 실패하면 먼저 바꾼 문서를 원래대로 돌려 두 문서의 어긋남을 막는다
        for (const q of done) await this.stepDoc(q, dir === 'undo' ? 'redo' : 'undo');
        if (bundle != null) this.ghosts.delete(bundle);
        return;
      }
      const survivors = partners.filter((p) => !closing.includes(p));
      const initiatorClosed = closing.includes(d);
      for (const x of closing) await this.removeDoc(x);
      if (initiatorClosed && survivors[0]) this.activate(survivors[0].key);

      // 다시하기: 되돌리며 닫힌 새 탭을 되살린다
      let revived: DocState | null = null;
      if (dir === 'redo' && bundle != null && this.ghosts.has(bundle) && !this.docs.some((x) => x.history.undoStack.some((s) => s.bundle === bundle && s.create))) {
        revived = await this.reviveGhost(bundle);
      }
      const msgs: string[] = [];
      if (closing.length) msgs.push(`새 파일 ${quoteNames(closing.map((x) => x.name))} 탭을 닫았습니다.`);
      if (survivors.length) msgs.push(`${quoteNames(survivors.map((x) => x.name))}도 함께 ${verb}.`);
      if (revived) {
        this.activate(revived.key);
        msgs.push(`새 파일 ‘${revived.name}’ 탭을 다시 열었습니다.`);
      }
      const anchor = revived ?? survivors[0] ?? (initiatorClosed ? null : d);
      if (anchor && msgs.length) this.tabNotice = { key: anchor.key, kind: 'info', text: msgs.join(' ') };
    } finally {
      this.opBusy = false;
    }
  }

  private async reviveGhost(bundle: number): Promise<DocState | null> {
    const g = this.ghosts.get(bundle);
    if (!g) return null;
    this.ghosts.delete(bundle);
    this.enginePool.pin(g.kind);
    try {
      const c = await this.acquire(g.kind);
      const id = await c.open(g.bytes.slice());
      try {
        const sizes = await this.readSizes(c, id);
        const d = this.makeDoc(c, g.kind, id, uniqueName(this.docs.map((x) => x.name), g.name), sizes, g.rot, g.zoom);
        this.markNew(d, bundle);
        if (!this.addDoc(d)) {
          await this.discardDoc(d);
          this.pagesNotice = { kind: 'error', text: `열린 파일이 ${MAX_DOCS}개라 닫았던 새 파일을 다시 열지 못했습니다. 이 새 파일의 내용은 되살릴 수 없습니다.` };
          return null;
        }
        return d;
      } catch (e) {
        await c.close(id).catch(() => {});
        throw e;
      }
    } catch (e) {
      this.pagesNotice = { kind: 'error', text: '닫았던 새 파일을 다시 열지 못했습니다.', detail: errText(e) };
      return null;
    } finally {
      this.enginePool.unpin(g.kind);
      this.releaseUnusedEngines();
    }
  }

  /** 새 파일 탭: 저장 전까지 변경됨 상태이고, 시작 지점을 되돌리기 기록 맨 아래에 둔다 */
  private markNew(d: DocState, bundle?: number) {
    d.savedStateId = -1;
    d.stateId = 0;
    d.history.push({ bytes: new Uint8Array(0), rot: [], current: 0, selected: [], name: d.name, stateId: -2, create: true, bundle });
    d.syncHistory();
  }

  // ---------- 주석·양식 편집 ----------
  /**
   * 주석·양식 한 번의 편집. applyOp 와 같이 직전 상태를 되돌리기 기록에 남기지만, 문서 화면을 다시 만들지 않는다:
   * 바뀐 쪽의 무효화 키(rev)만 올려 그 쪽 비트맵만 다시 그린다(300쪽 문서에서도 한 쪽만 다시 그림).
   * 요청은 순서대로 하나씩 처리한다(입력칸을 빠르게 옮겨도 앞 값이 사라지지 않게).
   */
  editOp<T>(what: string, pages: number[], fn: (c: EngineClient, d: DocState) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    type R = { ok: true; value: T } | { ok: false };
    const d0 = this.active;
    const gen0 = d0?.gen;
    this.editPending++;
    const run = async (): Promise<R> => {
      const t0 = Date.now();
      while (this.opBusy && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 30));
      const d = d0;
      if (!d) return { ok: false };
      // 대기하는 동안 조건이 바뀌어 편집을 반영하지 못하면 알린다(알림 없이 버리지 않는다)
      const dropped = (why: string, todo: string) => {
        this.editNotice = { kind: 'error', text: `${what} 내용을 반영하지 못했습니다. ${why}`, reassure: todo };
        return { ok: false } as R;
      };
      if (!this.docs.includes(d)) return dropped('편집하던 파일이 그 사이 닫혔습니다.', '필요하면 파일을 다시 열어 편집해 주세요.');
      if (this.opBusy) return dropped('다른 작업이 오래 끝나지 않았습니다.', '그 작업이 끝난 뒤 다시 입력해 주세요.');
      if (d.gen !== gen0) return dropped('그 사이 쪽 구성이 바뀌어 편집이 취소되었습니다.', '바뀐 화면에서 다시 입력해 주세요.');
      this.opBusy = true;
      this.editNotice = null;
      const c = this.clientOf(d);
      let snap: Snap;
      try {
        snap = await this.takeSnap(c, d);
      } catch (e) {
        this.editNotice = { kind: 'error', text: `${what}에 실패했습니다. 다시 시도해 주세요.`, reassure: '문서는 그대로입니다.', detail: errText(e) };
        this.opBusy = false;
        return { ok: false };
      }
      // 바뀌는 쪽의 내용 id 를 편집 앞뒤로 새로 준다: 편집 도중에 끝난 렌더가 옛 id(되돌리기 스냅샷이 가리킨다)나
      // 편집 뒤의 id 로 캐시에 들어가 다른 내용의 그림이 재사용되는 일이 없게 한다
      const bump = () => {
        for (const p of pages) if (p >= 0 && p < d.rev.length) d.cids[p] = newCid();
      };
      bump();
      try {
        const value = await fn(c, d);
        this.pushHistory(d, { ...snap, pages: [...pages] });
        bump();
        for (const p of pages) if (p >= 0 && p < d.rev.length) d.rev[p]++;
        return { ok: true, value };
      } catch (e) {
        try {
          await this.swapLive(c, d, snap.bytes);
          bump();
          for (const p of pages) if (p >= 0 && p < d.rev.length) d.rev[p]++;
          this.editNotice = { kind: 'error', text: `${what}에 실패했습니다. 다시 시도해 주세요.`, reassure: '문서는 편집 전 상태 그대로입니다.', detail: errText(e) };
        } catch (e2) {
          this.editNotice = { kind: 'error', text: `${what}에 실패했고 문서를 되돌리지 못했습니다. 파일을 다시 열어 주세요.`, detail: `${errText(e)} / ${errText(e2)}` };
        }
        return { ok: false };
      } finally {
        this.opBusy = false;
        d.syncHistory();
      }
    };
    const p = this.editChain.then(run, run);
    this.editChain = p.catch(() => {});
    void p.finally(() => this.editPending--);
    return p;
  }

  /** 줄 서 있는 편집이 끝나길 기다린다(저장 앞에서) */
  async settleEdits() {
    await this.editChain;
  }

  // ---------- 쪽 조작(활성 문서) ----------
  reorder(moving: number[], before: number) {
    const d = this.active;
    if (!d) return;
    const order = dropOrder(d.total, moving, before);
    if (isIdentity(order)) return;
    const cur = d.current;
    const sel = [...d.selected];
    void this.runOp('쪽 순서 바꾸기', async (c, dd) => {
      await applyOrder(c, dd.id, order);
      const inv = new Map(order.map((o, p) => [o, p]));
      return {
        rot: order.map((o) => dd.rot[o]),
        cids: order.map((o) => dd.cids[o]),
        current: inv.get(cur) ?? cur,
        selected: sel.map((s) => inv.get(s)!).sort((a, b) => a - b),
      };
    });
  }

  rotate(pages: number[]) {
    const d = this.active;
    const list = sorted(pages);
    if (!d || !list.length) return;
    const cur = d.current;
    const sel = [...d.selected];
    void this.runOp('쪽 회전', async (c, dd) => {
      const rot = [...dd.rot];
      const cids = [...dd.cids];
      for (const i of list) cids[i] = newCid();
      for (const i of list) {
        const base = rot[i] ?? (await detectRotation(c, dd.id, i));
        const next = addRotation(base);
        await c.rotatePage(dd.id, i, next);
        rot[i] = next;
      }
      return { rot, cids, current: cur, selected: sel };
    });
  }

  remove(pages: number[]) {
    const d = this.active;
    if (!d) return;
    const total = d.total;
    const list = sorted(pages).filter((i) => i >= 0 && i < total);
    if (!list.length) return;
    if (list.length >= total) {
      this.pagesNotice = { kind: 'error', text: '모든 쪽을 삭제할 수 없습니다. 한 쪽 이상 남겨 주세요.' };
      return;
    }
    const cur = d.current;
    const gone = new Set(list);
    const sel = d.selected.filter((s) => !gone.has(s)).map((s) => s - list.filter((x) => x < s).length);
    void this.runOp('쪽 삭제', async (c, dd) => {
      await c.deletePages(dd.id, list);
      dd.deletedAny = true;
      return {
        rot: dd.rot.filter((_, i) => !gone.has(i)),
        cids: dd.cids.filter((_, i) => !gone.has(i)),
        current: currentAfterDelete(cur, list, total - list.length),
        selected: sel,
      };
    });
  }

  /** 같은 문서 안에서 쪽을 at 위치(기본: 마지막 쪽 바로 뒤)에 복제한다 */
  duplicate(pages: number[], at?: number) {
    const d = this.active;
    const list = sorted(pages);
    if (!d || !list.length) return;
    void this.runOp('쪽 복제', (c, dd, snap) => this.copyWithin(c, dd, snap, list, at ?? list[list.length - 1] + 1));
  }

  /** 같은 문서끼리는 가져올 수 없는 엔진이 있어, 조작 전 상태를 임시로 열어 거기서 가져온다 */
  private async copyWithin(c: EngineClient, d: DocState, snap: Snap, list: number[], at: number): Promise<OpResult> {
    const cur = d.current;
    const tmp = await c.open(snap.bytes.slice());
    try {
      await c.importPages(d.id, tmp, list, at);
    } finally {
      await c.close(tmp).catch(() => {});
    }
    const rot = [...d.rot];
    rot.splice(at, 0, ...list.map((i) => rot[i]));
    // 복제한 쪽은 원본과 그림이 같으므로 같은 내용 id 를 쓴다
    const cids = [...d.cids];
    cids.splice(at, 0, ...list.map((i) => cids[i]));
    return { rot, cids, current: cur >= at ? cur + list.length : cur, selected: range(at, list.length) };
  }

  // ---------- 추출·분할 ----------
  /** 문서에서 쪽 묶음마다 새 PDF 바이트를 만든다(라이브 문서는 건드리지 않는다) */
  private async buildSubsets(c: EngineClient, d: DocState, groups: number[][], flatten: boolean, progress?: (done: number) => void): Promise<Uint8Array[]> {
    const base = await this.rebase(c, d);
    const n = d.total;
    const out: Uint8Array[] = [];
    for (const g of groups) {
      const keep = new Set(g);
      const del: number[] = [];
      for (let i = 0; i < n; i++) if (!keep.has(i)) del.push(i);
      const id = await c.open(base.bytes.slice());
      try {
        if (del.length) await c.deletePages(id, del);
        const r = await c.save(id, { incremental: false, garbageCollect: true, flatten });
        out.push(r.bytes);
      } finally {
        await c.close(id).catch(() => {});
      }
      progress?.(out.length);
    }
    return out;
  }

  async extract(pages: number[]) {
    const d = this.active;
    const list = sorted(pages);
    if (!d || this.opBusy || !list.length) return;
    this.opBusy = true;
    this.pagesNotice = null;
    try {
      const [bytes] = await this.buildSubsets(this.clientOf(d), d, [list], this.hooks.settings().flatten);
      downloadBytes(bytes, `${baseName(d.name)}-추출.pdf`);
    } catch (e) {
      this.pagesNotice = { kind: 'error', text: '선택한 쪽을 저장하지 못했습니다. 다시 시도해 주세요.', reassure: '열려 있는 문서는 그대로입니다.', detail: errText(e) };
    } finally {
      this.opBusy = false;
    }
  }

  async split(groups: number[][]): Promise<boolean> {
    const d = this.active;
    if (!d || this.opBusy) return false;
    this.opBusy = true;
    this.splitBusy = true;
    this.splitError = null;
    this.splitNotice = null;
    this.splitDone = 0;
    try {
      const files = await this.buildSubsets(this.clientOf(d), d, groups, this.hooks.settings().flatten, (k) => (this.splitDone = k));
      const base = baseName(d.name);
      const names = splitNames(base, groups);
      if (files.length === 1) downloadBytes(files[0], names[0]);
      else downloadBytes(makeZip(files.map((data, i) => ({ name: names[i], data }))), `${base}-분할.zip`, 'application/zip');
      this.splitNotice = { kind: 'info', text: files.length === 1 ? '1개 파일을 내려받았습니다.' : `${files.length}개 파일을 ZIP 하나로 내려받았습니다.` };
      return true;
    } catch (e) {
      this.splitError = '나누지 못했습니다. 다시 시도해 주세요. 열려 있는 문서는 그대로입니다.';
      console.error(e);
      return false;
    } finally {
      this.opBusy = false;
      this.splitBusy = false;
    }
  }

  // ---------- 쪽 보내기 ----------
  /** 새 파일 탭을 만든다: 바이트를 엔진에서 열어 변경됨 상태로 둔다 */
  private async createNewDoc(c: EngineClient, kind: EngineKind, bytes: Uint8Array, rot: RotState, bundle?: number): Promise<DocState> {
    const id = await c.open(bytes.slice());
    try {
      const sizes = await this.readSizes(c, id);
      const { name, n } = newDocName(this.docs.map((x) => x.name), this.newSeq);
      this.newSeq = n + 1;
      const d = this.makeDoc(c, kind, id, name, sizes, rot, this.hooks.settings().zoom);
      this.markNew(d, bundle);
      return d;
    } catch (e) {
      await c.close(id).catch(() => {});
      throw e;
    }
  }

  /**
   * 선택한 쪽을 새 파일이나 열린 다른 문서로 복사·이동한다.
   * 복사는 대상에만 기록하고, 이동은 두 문서에 같은 묶음 번호로 기록해 한 번에 되돌린다.
   */
  async send(spec: SendSpec): Promise<boolean> {
    const S = spec.from;
    const pages = sorted(spec.pages).filter((i) => i >= 0 && i < S.total);
    if (this.opBusy || !pages.length || !this.docs.includes(S)) return false;
    const move = spec.mode === 'move';
    if (move && pages.length >= S.total && spec.target.type === 'new') {
      this.pagesNotice = { kind: 'error', text: '모든 쪽을 옮기면 원본이 빈 문서가 됩니다.', reassure: '복사를 쓰거나 한 쪽 이상 남겨 주세요.' };
      return false;
    }
    const T = spec.target.type === 'doc' ? this.docOf(spec.target.key) : null;
    if (spec.target.type === 'doc' && !T) {
      this.pagesNotice = { kind: 'error', text: '대상 파일이 이미 닫혔습니다. 보내기 메뉴를 다시 열어 주세요.' };
      return false;
    }
    if (move && T && T !== S && pages.length >= S.total) {
      this.pagesNotice = { kind: 'error', text: '모든 쪽을 옮기면 원본이 빈 문서가 됩니다.', reassure: '복사를 쓰거나 한 쪽 이상 남겨 주세요.' };
      return false;
    }
    if (spec.target.type === 'new' && this.docs.length >= MAX_DOCS) {
      this.pagesNotice = { kind: 'error', text: `열린 파일이 ${MAX_DOCS}개라 새 파일을 만들 수 없습니다. 탭을 닫고 다시 시도해 주세요.` };
      return false;
    }
    this.opBusy = true;
    this.pagesNotice = null;
    this.tabNotice = null;
    const bundle = move ? ++this.bundleSeq : undefined;
    const verb = move ? '이동' : '복사';
    const cs = this.clientOf(S);
    try {
      // ----- 새 파일 -----
      if (spec.target.type === 'new') {
        let created: DocState;
        try {
          const [bytes] = await this.buildSubsets(cs, S, [pages], false);
          created = await this.createNewDoc(cs, S.kind, bytes, pages.map((i) => S.rot[i]), bundle);
        } catch (e) {
          this.pagesNotice = { kind: 'error', text: '새 파일을 만들지 못했습니다. 다시 시도해 주세요.', reassure: '열려 있는 문서는 그대로입니다.', detail: errText(e) };
          return false;
        }
        if (move && !(await this.deleteAfterMove(S, pages, bundle!))) {
          await this.discardDoc(created);
          return false;
        }
        if (!this.addDoc(created)) {
          // 이동 도중 다른 경로로 파일이 늘어 가득 찼다: 원본에서 지운 것을 되돌려 쪽이 사라지지 않게 한다
          await this.discardDoc(created);
          if (move) await this.undoMoveHalf(S);
          this.pagesNotice = { kind: 'error', text: `열린 파일이 ${MAX_DOCS}개라 새 파일을 만들 수 없습니다. 탭을 닫고 다시 시도해 주세요.`, reassure: '열려 있는 문서는 그대로입니다.' };
          return false;
        }
        this.activate(created.key);
        return true;
      }

      // ----- 같은 문서 안 -----
      const t = T!;
      const tgt = spec.target;
      if (t === S) {
        let at: number;
        try {
          at = insertIndex(tgt.pos, S.total);
        } catch {
          this.pagesNotice = { kind: 'error', text: `‘${S.name}’은(는) ${S.total}쪽까지 있습니다. 쪽 번호를 확인해 주세요.` };
          return false;
        }
        if (move) {
          const order = dropOrder(S.total, pages, at);
          if (isIdentity(order)) {
            this.pagesNotice = { kind: 'info', text: '이미 그 위치에 있는 쪽입니다.' };
            return false;
          }
          const cur = S.current;
          const sel = [...S.selected];
          return await this.applyOp(S, '쪽 옮기기', async (c, dd) => {
            await applyOrder(c, dd.id, order);
            const inv = new Map(order.map((o, p) => [o, p]));
            return { rot: order.map((o) => dd.rot[o]), cids: order.map((o) => dd.cids[o]), current: inv.get(cur) ?? cur, selected: sel.map((s) => inv.get(s)!).sort((a, b) => a - b) };
          });
        }
        const ok = await this.applyOp(S, '쪽 복제', (c, dd, snap) => this.copyWithin(c, dd, snap, pages, at));
        if (ok) this.tabNotice = { key: S.key, kind: 'info', text: `${pages.length}쪽을 이 파일 ${posLabel(tgt.pos)}에 복사했습니다.` };
        return ok;
      }

      // ----- 다른 열린 문서 -----
      let at: number;
      try {
        at = insertIndex(tgt.pos, t.total);
      } catch {
        this.pagesNotice = { kind: 'error', text: `‘${t.name}’은(는) ${t.total}쪽까지 있습니다. 쪽 번호를 확인해 주세요.` };
        return false;
      }
      let bytes: Uint8Array | null = null;
      if (!this.sameEngine(S, t)) {
        try {
          [bytes] = await this.buildSubsets(cs, S, [pages], false);
        } catch (e) {
          this.pagesNotice = { kind: 'error', text: '쪽을 다른 엔진 문서로 옮길 준비에 실패했습니다. 다시 시도해 주세요.', reassure: '열려 있는 문서는 그대로입니다.', detail: errText(e) };
          return false;
        }
      }
      const srcRot = pages.map((i) => S.rot[i]);
      const curT = t.current;
      const ok = await this.applyOp(
        t,
        `쪽 ${verb}`,
        async (c, dd) => {
          if (bytes) {
            const tmp = await c.open(bytes.slice());
            try {
              await c.importPages(dd.id, tmp, range(0, pages.length), at);
            } finally {
              await c.close(tmp).catch(() => {});
            }
          } else {
            await c.importPages(dd.id, S.id, pages, at);
          }
          const rot = [...dd.rot];
          rot.splice(at, 0, ...srcRot);
          const cids = [...dd.cids];
          cids.splice(at, 0, ...freshCids(pages.length));
          return { rot, cids, current: curT >= at ? curT + pages.length : curT, selected: range(at, pages.length) };
        },
        bundle,
      );
      if (!ok) return false;
      if (move && !(await this.deleteAfterMove(S, pages, bundle!))) {
        // 원본에서 지우지 못했으면 대상도 되돌려 두 문서가 어긋나지 않게 한다
        await this.undoMoveHalf(t);
        return false;
      }
      this.tabNotice = {
        key: t.key,
        kind: 'info',
        text: `‘${S.name}’의 ${pages.length}쪽을 ‘${t.name}’ ${posLabel(tgt.pos)}에 ${verb}했습니다.${move ? ' 되돌리기(Ctrl+Z)는 두 파일에 함께 적용됩니다.' : ''}`,
      };
      return true;
    } finally {
      this.opBusy = false;
    }
  }

  /**
   * 여러 파일에서 고른 쪽을 (주어진 순서대로) 이어 붙인 새 PDF 바이트. 첫 파일의 기준 사본에서 고른 쪽만 남기고
   * 나머지 파일의 쪽을 차례로 가져온다. 라이브 문서는 건드리지 않는다(opBusy 를 이미 잡고 있어야 한다).
   */
  private async mergeParts(parts: { from: DocState; pages: number[] }[], flatten: boolean): Promise<Uint8Array> {
    const first = parts[0].from;
    const c = this.clientOf(first);
    let destId: DocId | null = null;
    try {
      const r0 = await this.rebase(c, first);
      destId = await c.open(r0.bytes.slice());
      const keep = new Set(parts[0].pages);
      const del = range(0, first.total).filter((i) => !keep.has(i));
      if (del.length) await c.deletePages(destId, del);
      for (const p of parts.slice(1)) {
        if (this.sameEngine(p.from, first)) {
          await c.importPages(destId, p.from.id, p.pages);
        } else {
          const [bytes] = await this.buildSubsets(this.clientOf(p.from), p.from, [p.pages], false);
          const tmp = await c.open(bytes.slice());
          try {
            await c.importPages(destId, tmp, range(0, p.pages.length));
          } finally {
            await c.close(tmp).catch(() => {});
          }
        }
      }
      const out = await c.save(destId, { incremental: false, garbageCollect: true, flatten });
      return out.bytes;
    } finally {
      if (destId) await c.close(destId).catch(() => {});
    }
  }

  // ---------- 인쇄 ----------
  /** 인쇄 대상 정리: 닫힌 파일은 빼고, 쪽 범위를 걸러 DocState 와 묶는다 */
  private printParts(parts: { key: number; pages: number[] }[]): { from: DocState; pages: number[] }[] {
    return parts
      .map((p) => {
        const d = this.docOf(p.key);
        return d ? { from: d, pages: sorted(p.pages).filter((i) => i >= 0 && i < d.total) } : null;
      })
      .filter((p): p is { from: DocState; pages: number[] } => !!p && p.pages.length > 0);
  }

  private async beginPrint(): Promise<void> {
    await this.waitIdle();
    if (this.opBusy) throw new Error('다른 작업이 아직 끝나지 않았다');
    this.opBusy = true;
  }

  /**
   * 방식 A: 인쇄용 사본 PDF 바이트. 대상 쪽만 남기고 주석·양식 값을 내용에 굽는다(save flatten).
   * 기준 바이트 사본에서 만들어 라이브 문서·되돌리기 기록·변경됨 표시는 그대로다.
   */
  async printCopy(parts: { key: number; pages: number[] }[]): Promise<Uint8Array> {
    await this.beginPrint();
    try {
      const list = this.printParts(parts);
      if (!list.length) throw new Error('인쇄할 쪽이 없다');
      if (list.length === 1) {
        const [bytes] = await this.buildSubsets(this.clientOf(list[0].from), list[0].from, [list[0].pages], true);
        return bytes;
      }
      return await this.mergeParts(list, true);
    } finally {
      this.opBusy = false;
    }
  }

  /**
   * 방식 B 의 원본: 파일마다 기준 바이트 사본을 임시 문서로 열고 쪽 크기를 읽어 돌려준다. 렌더 중에는 라이브 문서를
   * 쓰지 않으므로 그동안 편집해도 된다. 다 쓰면 close() 로 임시 문서를 닫는다.
   */
  async openPrintSources(parts: { key: number; pages: number[] }[]): Promise<{ sources: { client: EngineClient; id: DocId; pages: number[]; sizes: PageSize[] }[]; close: () => Promise<void> }> {
    await this.beginPrint();
    const opened: { client: EngineClient; id: DocId; pages: number[]; sizes: PageSize[] }[] = [];
    // 임시 문서가 열려 있는 동안 그 엔진을 내리지 않는다(원본 탭을 닫아도 인쇄 렌더가 이어진다)
    const pinned: EngineKind[] = [];
    let released = false;
    const close = async () => {
      for (const s of opened.splice(0)) await s.client.close(s.id).catch(() => {});
      if (released) return;
      released = true;
      for (const k of pinned.splice(0)) this.enginePool.unpin(k);
      this.releaseUnusedEngines();
    };
    try {
      const list = this.printParts(parts);
      if (!list.length) throw new Error('인쇄할 쪽이 없다');
      for (const p of list) {
        this.enginePool.pin(p.from.kind);
        pinned.push(p.from.kind);
      }
      for (const p of list) {
        const c = this.clientOf(p.from);
        const base = await this.rebase(c, p.from);
        const id = await c.open(base.bytes.slice());
        const entry = { client: c, id, pages: p.pages, sizes: [] as PageSize[] };
        opened.push(entry);
        entry.sizes = await Promise.all(p.pages.map((i) => c.pageSize(id, i)));
      }
      return { sources: [...opened], close };
    } catch (e) {
      await close();
      throw e;
    } finally {
      this.opBusy = false;
    }
  }

  /** 파일마다 골라 둔 쪽을 (탭 순서, 쪽 순서)대로 모은 목록 */
  selectionParts(): { from: DocState; pages: number[] }[] {
    return this.docs
      .map((d) => ({ from: d, pages: sorted(d.selected).filter((i) => i >= 0 && i < d.total) }))
      .filter((p) => p.pages.length > 0);
  }

  /** 모든 파일에서 골라 둔 쪽 수의 합계 */
  get selectionTotal(): number {
    return this.docs.reduce((n, d) => n + d.selected.length, 0);
  }

  /**
   * 여러 파일에서 골라 둔 쪽을 모두 한 새 파일로 합친다(파일 순서대로, 파일 안에서는 쪽 순서대로).
   * 이동이면 원본들에서 지우고, 같은 묶음 번호로 기록해 한 번의 되돌리기로 원본들과 새 탭이 함께 복귀한다.
   */
  async sendSelectionToNew(mode: 'copy' | 'move'): Promise<boolean> {
    const parts = this.selectionParts();
    if (this.opBusy || !parts.length) return false;
    if (parts.length === 1) return this.send({ from: parts[0].from, pages: parts[0].pages, mode, target: { type: 'new' } });
    const move = mode === 'move';
    const whole = move ? parts.find((p) => p.pages.length >= p.from.total) : undefined;
    if (whole) {
      this.pagesNotice = { kind: 'error', text: `‘${whole.from.name}’의 모든 쪽을 옮기면 그 파일이 빈 문서가 됩니다.`, reassure: '복사를 쓰거나 한 쪽 이상 남겨 주세요.' };
      return false;
    }
    if (this.docs.length >= MAX_DOCS) {
      this.pagesNotice = { kind: 'error', text: `열린 파일이 ${MAX_DOCS}개라 새 파일을 만들 수 없습니다. 파일을 닫고 다시 시도해 주세요.` };
      return false;
    }
    this.opBusy = true;
    this.pagesNotice = null;
    this.tabNotice = null;
    const bundle = move ? ++this.bundleSeq : undefined;
    const kind = parts[0].from.kind;
    try {
      let created: DocState;
      try {
        const bytes = await this.mergeParts(parts, false);
        created = await this.createNewDoc(this.clientOf(parts[0].from), kind, bytes, parts.flatMap((p) => p.pages.map((i) => p.from.rot[i])), bundle);
      } catch (e) {
        this.pagesNotice = { kind: 'error', text: '새 파일을 만들지 못했습니다. 다시 시도해 주세요.', reassure: '열려 있는 문서는 그대로입니다.', detail: errText(e) };
        return false;
      }
      const done: DocState[] = [];
      if (move) {
        for (const p of parts) {
          if (!(await this.deleteAfterMove(p.from, p.pages, bundle!))) {
            // 한 파일에서 지우지 못했으면 먼저 지운 파일도 되돌려 어긋남을 막는다
            for (const q of done) await this.undoMoveHalf(q);
            await this.discardDoc(created);
            return false;
          }
          done.push(p.from);
        }
      }
      if (!this.addDoc(created)) {
        for (const q of done) await this.undoMoveHalf(q);
        await this.discardDoc(created);
        this.pagesNotice = { kind: 'error', text: `열린 파일이 ${MAX_DOCS}개라 새 파일을 만들 수 없습니다. 파일을 닫고 다시 시도해 주세요.`, reassure: '열려 있는 문서는 그대로입니다.' };
        return false;
      }
      this.activate(created.key);
      if (move) {
        this.tabNotice = { key: created.key, kind: 'info', text: `${parts.length}개 파일에서 ${this.sumPages(parts)}쪽을 옮겼습니다. 되돌리기(Ctrl+Z)는 원본 파일들에 함께 적용됩니다.` };
      }
      return true;
    } finally {
      this.opBusy = false;
    }
  }

  /** 이동의 앞 절반(또는 뒤 절반)만 끝난 문서를 되돌리고 다시하기 기록을 남기지 않는다 */
  private async undoMoveHalf(d: DocState) {
    await this.stepDoc(d, 'undo');
    d.history.popRedo();
    d.syncHistory();
  }

  private sumPages(parts: { pages: number[] }[]) {
    return parts.reduce((n, p) => n + p.pages.length, 0);
  }

  /** 이동의 두 번째 절반: 원본에서 쪽을 지운다(같은 묶음 번호로 기록) */
  private async deleteAfterMove(S: DocState, pages: number[], bundle: number): Promise<boolean> {
    const total = S.total;
    const cur = S.current;
    const gone = new Set(pages);
    return this.applyOp(
      S,
      '원본에서 쪽 지우기',
      async (c, dd) => {
        await c.deletePages(dd.id, pages);
        dd.deletedAny = true;
        return { rot: dd.rot.filter((_, i) => !gone.has(i)), cids: dd.cids.filter((_, i) => !gone.has(i)), current: currentAfterDelete(cur, pages, total - pages.length), selected: [] };
      },
      bundle,
    );
  }

  // ---------- 열린 파일 병합 ----------
  /** 고른 열린 문서들을 순서대로 이어 붙여 새 탭으로 만든다(원본 탭은 그대로) */
  async mergeOpen(keys: number[]): Promise<boolean> {
    const list = keys.map((k) => this.docOf(k)).filter((d): d is DocState => !!d);
    if (this.opBusy || list.length < 2) return false;
    if (this.docs.length >= MAX_DOCS) {
      this.mergeError = `열린 파일이 ${MAX_DOCS}개라 새 파일을 만들 수 없습니다. 탭을 닫고 다시 시도해 주세요.`;
      return false;
    }
    this.opBusy = true;
    this.mergeBusy = true;
    this.mergeError = null;
    const first = list[0];
    const kind = first.kind;
    const c = this.clientOf(first);
    let destId: DocId | null = null;
    try {
      // 첫 문서의 사본을 바탕으로 나머지를 이어 붙인다
      const r0 = await this.rebase(c, first);
      destId = await c.open(r0.bytes.slice());
      for (const other of list.slice(1)) {
        const n = other.total;
        if (this.sameEngine(other, first)) {
          await c.importPages(destId, other.id, range(0, n));
        } else {
          const bytes = (await this.rebase(this.clientOf(other), other)).bytes;
          const tmp = await c.open(bytes.slice());
          try {
            await c.importPages(destId, tmp, range(0, n));
          } finally {
            await c.close(tmp).catch(() => {});
          }
        }
      }
      const sizes = await this.readSizes(c, destId);
      const rot: RotState = list.flatMap((d) => d.rot);
      const name = uniqueName(this.docs.map((x) => x.name), `${baseName(first.name)}-병합.pdf`);
      const d = this.makeDoc(c, kind, destId, name, sizes, rot, this.hooks.settings().zoom);
      destId = null;
      this.markNew(d);
      if (!this.addDoc(d)) {
        await this.discardDoc(d);
        this.mergeError = `열린 파일이 ${MAX_DOCS}개라 새 파일을 만들 수 없습니다. 탭을 닫고 다시 시도해 주세요.`;
        return false;
      }
      this.activate(d.key);
      return true;
    } catch (e) {
      if (destId) await c.close(destId).catch(() => {});
      this.mergeError = '병합하지 못했습니다. 다시 시도해 주세요. 열려 있는 파일은 그대로입니다.';
      console.error(e);
      return false;
    } finally {
      this.mergeBusy = false;
      this.opBusy = false;
    }
  }

  // ---------- 저장 ----------
  async save(d: DocState): Promise<boolean> {
    if (this.opBusy || this.saving || !this.docs.includes(d)) return false;
    const c = this.clientOf(d);
    this.saving = true;
    this.opBusy = true;
    this.saveNotice = null;
    try {
      const s = this.hooks.settings();
      const o = { incremental: s.incremental, garbageCollect: s.garbageCollect, flatten: s.flatten };
      // 라이브 문서는 rebase 로 한 번 저장되고 갈아타므로, 사용자 옵션은 같은 내용의 사본에 적용한다
      const base = await this.rebase(c, d);
      let r: { bytes: Uint8Array; fullFallback: boolean; notes?: string[] };
      if (o.incremental && !o.garbageCollect && !o.flatten) {
        r = base;
      } else {
        const tmp = await c.open(base.bytes.slice());
        try {
          r = await c.save(tmp, o);
        } finally {
          await c.close(tmp).catch(() => {});
        }
        if (o.incremental && base.fullFallback) r = { ...r, fullFallback: true };
      }
      downloadBytes(r.bytes, editedName(d.name));
      d.savedStateId = d.stateId;
      const notes: string[] = [];
      if (r.fullFallback) {
        notes.push(
          o.flatten
            ? '주석·양식을 내용에 굽는 저장은 전체를 다시 써야 해서 변경분만 덧붙이지 못했습니다. 전자서명이 있던 문서라면 서명이 무효가 될 수 있습니다.'
            : '변경분만 덧붙여 저장할 수 없어 전체를 다시 썼습니다. 전자서명이 있던 문서라면 서명이 무효가 될 수 있습니다.',
        );
      } else if (o.incremental && o.garbageCollect && d.deletedAny) {
        notes.push('변경분만 덧붙여 저장해서 삭제한 쪽의 데이터가 파일에 남아 있습니다. 용량을 줄이려면 저장 옵션에서 ‘변경분만 덧붙여 저장’을 끄세요.');
      }
      if (r.notes?.length) notes.push(...r.notes);
      if (notes.length && d.key === this.activeKey) this.saveNotice = { kind: 'info', text: notes.join(' ') };
      return true;
    } catch (e) {
      this.saveNotice = { kind: 'error', text: '저장하지 못했습니다. 다시 시도해 주세요.', reassure: '편집한 내용은 그대로 열려 있습니다.', detail: errText(e) };
      return false;
    } finally {
      this.saving = false;
      this.opBusy = false;
      // 저장(특히 정리 저장) 뒤에는 주석 id 가 바뀔 수 있다
      this.hooks.afterSave?.(d);
    }
  }

  // ---------- 진단 ----------
  /** 시험·진단용 요약 */
  summary() {
    return {
      active: this.activeKey,
      mode: this.mode,
      engines: this.engineKinds,
      poolBytes: this.pool.bytes,
      docs: this.docs.map((d) => ({
        key: d.key,
        name: d.name,
        kind: d.kind,
        pages: d.total,
        dirty: d.dirty,
        undo: d.undoCount,
        redo: d.redoCount,
        current: d.current,
        zoom: d.zoom,
        selected: [...d.selected],
        histBytes: d.history.bytes,
      })),
    };
  }
}
