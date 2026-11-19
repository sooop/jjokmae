// e2e 공용 도우미. 선택자는 역할·이름을 우선하고, 이미 소스에 있는 data-testid·data-* 는 보조로 쓴다.
// UI 문구·요소가 바뀌면 이 파일의 한 곳만 고치면 되도록 화면 조작은 App 클래스에 모은다.
import { test as base, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { MupdfAdapter } from '../src/engine/mupdf-adapter.ts';
import { APP_ROOT } from './fixtures/paths.ts';
import { inspect, type PageInfo } from './fixtures/synth.ts';

export { expect };
export type { Locator, Page };

export type BuildKind = 'static' | 'single';

export interface DocSummary {
  key: number;
  name: string;
  kind: 'mupdf' | 'pdfium';
  pages: number;
  dirty: boolean;
  undo: number;
  redo: number;
  current: number;
  zoom: number;
  selected: number[];
}
export interface WsSummary {
  active: number | null;
  mode: 'view' | 'organize';
  engines: string[];
  docs: DocSummary[];
}

// ------------------------------------------------------------------ 저장 PDF 검증

export interface SavedFile {
  /** 브라우저가 제안한 파일 이름(한글 포함) */
  name: string;
  /** 디스크에 둔 ASCII 사본 경로(qpdf 용) */
  path: string;
  bytes: Uint8Array;
}

/** qpdf --check 와 쪽 수. 통과하지 못하면 out 에 사유가 있다 */
export function qpdfCheck(path: string): { ok: boolean; pages: number; out: string } {
  const c = spawnSync('qpdf', ['--check', path], { encoding: 'utf8' });
  const n = spawnSync('qpdf', ['--show-npages', path], { encoding: 'utf8' });
  const out = `${c.stdout}${c.stderr}`
    .split('\n')
    .filter((l) => /No syntax|error|WARN/i.test(l))
    .join(' | ');
  return { ok: c.status === 0, pages: parseInt(n.stdout, 10), out };
}

let adapter: MupdfAdapter | null = null;
async function mupdfAdapter(): Promise<MupdfAdapter> {
  if (!adapter) {
    adapter = new MupdfAdapter();
    await adapter.init();
  }
  return adapter;
}

/** 저장 PDF 를 mupdf 어댑터로 다시 열어 주석·양식을 읽는다 */
export async function reloadPdf(bytes: Uint8Array) {
  const A = await mupdfAdapter();
  const id = await A.open(bytes);
  const n = await A.pageCount(id);
  const pages = [];
  for (let i = 0; i < n; i++) pages.push(await A.listAnnotations(id, i));
  return {
    n,
    pages,
    size: (i: number) => A.pageSize(id, i),
    fields: () => A.listFormFields(id),
    close: () => A.close(id),
  };
}

/** 저장 PDF 의 한 쪽을 렌더한다(RGBA) */
export async function renderPdf(bytes: Uint8Array, pageIndex: number, scale: number) {
  const A = await mupdfAdapter();
  const id = await A.open(bytes);
  const r = await A.renderPage(id, pageIndex, scale);
  await A.close(id);
  return { w: r.width, h: r.height, data: new Uint8Array(r.data) };
}

export type ColorKind = 'red' | 'redish' | 'blue' | 'yellowish' | 'dark';
export const COLOR: Record<ColorKind, (r: number, g: number, b: number) => boolean> = {
  red: (r, g, b) => r > 190 && g < 70 && b < 70,
  redish: (r, g, b) => r > 200 && g < 110 && b < 110, // 주석 기본 빨강(#e5484d)
  blue: (r, g, b) => b > 190 && r < 70 && g < 70,
  yellowish: (r, g, b) => r > 200 && g > 170 && b < 140,
  dark: (r, g, b) => r < 90 && g < 90 && b < 90,
};
export interface BBox { x0: number; y0: number; x1: number; y1: number; n: number }

/** 색 판정을 만족하는 픽셀의 경계 상자(저장 PDF 렌더용) */
export function colorBBox(img: { w: number; h: number; data: Uint8Array }, kind: ColorKind, within?: [number, number, number, number]): BBox | null {
  const pred = COLOR[kind];
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  const [wx0, wy0, wx1, wy1] = within ?? [0, 0, img.w, img.h];
  for (let y = Math.max(0, wy0 | 0); y < Math.min(img.h, wy1); y++)
    for (let x = Math.max(0, wx0 | 0); x < Math.min(img.w, wx1); x++) {
      const o = (y * img.w + x) * 4;
      if (pred(img.data[o], img.data[o + 1], img.data[o + 2])) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  return n ? { x0, y0, x1, y1, n } : null;
}

/** 최소 ZIP 읽기(store·deflate, CRC 검증). 앱이 만든 분할 ZIP 의 무결성을 확인한다 */
export function readZip(buf: Uint8Array): { name: string; data: Uint8Array }[] {
  const b = Buffer.from(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP 끝 레코드가 없다');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('중앙 디렉터리 서명 불일치');
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28), elen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32);
    const off = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = b.readUInt16LE(off + 26), lelen = b.readUInt16LE(off + 28);
    const raw = b.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    if (zlib.crc32(data) !== crc) throw new Error(`CRC 불일치: ${name}`);
    out.push({ name, data: new Uint8Array(data) });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/** "PAGE-1:0" 같은 쪽 요약 문자열(식별 글자:회전) */
export const brief = (info: PageInfo[]) => info.map((p) => `${p.text}:${p.rotate}`).join(',');
export const texts = (info: PageInfo[]) => info.map((p) => p.text);

// ------------------------------------------------------------------ 화면 조작

export interface Pt { x: number; y: number }

export class App {
  /** 페이지에서 난 처리되지 않은 예외(테스트 끝에서 비어 있어야 한다) */
  readonly pageErrors: string[] = [];
  private seq = 0;

  constructor(
    readonly page: Page,
    readonly kind: BuildKind,
    readonly testInfo: TestInfo,
  ) {
    page.on('pageerror', (e) => this.pageErrors.push(e.message));
  }

  // ---- 시작 ----
  async goto(settings?: Record<string, unknown>) {
    if (settings) {
      // 첫 문서가 열리기 전에 설정을 심는다(새 컨텍스트라 저장소가 비어 있다)
      await this.page.addInitScript((s) => {
        if (!localStorage.getItem('pdf-edit:settings')) localStorage.setItem('pdf-edit:settings', JSON.stringify(s));
      }, settings);
    }
    // single 은 globalSetup 이 떠 둔 dist-single 사본을 연다(다른 작업의 빌드가 도중에 파일을 바꿔도 영향이 없다)
    const single = process.env.E2E_SINGLE_HTML ?? join(APP_ROOT, 'dist-single', 'index.html');
    const url = this.kind === 'static' ? `http://127.0.0.1:${process.env.E2E_PORT}/index.html` : pathToFileURL(single).href;
    await this.page.goto(url);
    await this.page.locator('[data-testid=file-input]').waitFor({ state: 'attached' });
  }

  // ---- 상태(워크스페이스 디버그 훅) ----
  summary(): Promise<WsSummary> {
    return this.page.evaluate(() => (globalThis as unknown as { __pdfeditWs: { summary(): WsSummary } }).__pdfeditWs.summary());
  }
  async doc(name: string): Promise<DocSummary> {
    const d = (await this.summary()).docs.find((x) => x.name === name);
    if (!d) throw new Error(`열린 문서에 ${name} 없음`);
    return d;
  }
  async docNames(): Promise<string[]> {
    return (await this.summary()).docs.map((d) => d.name);
  }
  async pageCounts(): Promise<number[]> {
    return (await this.summary()).docs.map((d) => d.pages);
  }
  async active(): Promise<DocSummary | undefined> {
    const s = await this.summary();
    return s.docs.find((d) => d.key === s.active);
  }
  async total(): Promise<number> {
    return (await this.active())?.pages ?? 0;
  }
  async selectedPages(): Promise<number[]> {
    return (await this.active())?.selected ?? [];
  }

  // ---- 파일 열기 ----
  /** 파일 선택 창 대신 input 에 직접 파일을 넣는다. 첫 실행 안내(single)는 자동으로 수락한다 */
  async open(files: string | string[], opts: { n?: number; expectError?: boolean } = {}) {
    const list = Array.isArray(files) ? files : [files];
    const before = (await this.summary()).docs.length;
    await this.page.locator('[data-testid=file-input]').setInputFiles(list);
    if (opts.expectError) return;
    await this.settleOpen(before + (opts.n ?? list.length));
  }

  /** 드롭으로 연다(DataTransfer 에 파일을 실어 drop 이벤트를 보낸다) */
  async drop(files: { name: string; mime: string; bytes: Uint8Array }[], opts: { n?: number; expectError?: boolean } = {}) {
    const before = (await this.summary()).docs.length;
    const payload = files.map((f) => ({ name: f.name, mime: f.mime, data: Buffer.from(f.bytes).toString('base64') }));
    const dt = await this.page.evaluateHandle((fs) => {
      const d = new DataTransfer();
      for (const f of fs) {
        const bin = atob(f.data);
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        d.items.add(new File([u], f.name, { type: f.mime }));
      }
      return d;
    }, payload);
    const body = this.page.getByRole('region', { name: '작업 영역' });
    await body.dispatchEvent('dragenter', { dataTransfer: dt });
    await body.dispatchEvent('dragover', { dataTransfer: dt });
    await body.dispatchEvent('drop', { dataTransfer: dt });
    if (opts.expectError) return;
    await this.settleOpen(before + (opts.n ?? files.length));
  }

  /** 열기가 끝날 때까지 조건으로 기다린다. 엔진 내려받기 확인 카드가 뜨면 수락한다 */
  async settleOpen(expectedDocs: number) {
    await expect
      .poll(
        async () => {
          const phase = await this.page.evaluate(() => (document.querySelector('[data-phase]') as HTMLElement | null)?.dataset.phase ?? null);
          if (phase === 'confirm') {
            await this.page.locator('[data-phase=confirm]').getByRole('button', { name: '내려받기' }).click({ timeout: 3000 }).catch(() => {});
          } else if (phase === 'error') {
            const msg = await this.page.evaluate(() => (document.querySelector('[data-phase=error]') as HTMLElement | null)?.innerText ?? '');
            throw new Error('열기 오류: ' + msg);
          }
          const s = await this.summary();
          return s.docs.length >= expectedDocs && phase === null;
        },
        { timeout: 120_000, intervals: [100, 200, 400] },
      )
      .toBe(true);
    await this.firstPageDrawn();
  }

  /** 활성 문서가 화면에 그려질 때까지(보기 모드: 본문 1쪽, 정리 모드: 격자 1칸) */
  async firstPageDrawn() {
    const mode = (await this.summary()).mode;
    const sel = mode === 'organize' ? '[data-cell="0"] canvas' : '[data-page="0"] canvas';
    await this.canvasDrawn(this.page.locator(sel).first());
  }

  async canvasDrawn(canvas: Locator, timeout = 60_000) {
    await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width > 0).catch(() => false), { timeout, intervals: [50, 100, 200] }).toBe(true);
  }
  async pageDrawn(i: number, timeout = 60_000) {
    await this.canvasDrawn(this.page.locator(`[data-page="${i}"] canvas`), timeout);
  }
  async cellDrawn(i: number) {
    await this.canvasDrawn(this.page.locator(`[data-cell="${i}"] canvas`));
  }

  /** 편집·저장이 끝나 한가해질 때까지(busy 가 꺼진 상태가 두 프레임 이어질 때까지) */
  async idle() {
    for (let k = 0; k < 2; k++) {
      await expect(this.page.locator('[data-busy="false"]')).toBeAttached({ timeout: 60_000 });
      await this.page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    }
  }
  /** 문서 상태 서명(쪽 수·되돌리기·다시하기·변경됨). 조작이 반영됐는지 판정하는 데 쓴다 */
  async sig(): Promise<string> {
    return JSON.stringify((await this.summary()).docs.map((d) => [d.key, d.pages, d.undo, d.redo, d.dirty]));
  }
  /** 조작을 하고 문서 상태가 실제로 바뀌어 한가해질 때까지 기다린다(임의 대기 없음) */
  async change(action: () => Promise<unknown>) {
    const before = await this.sig();
    await action();
    await expect.poll(() => this.sig(), { timeout: 60_000, intervals: [50, 100, 200] }).not.toBe(before);
    await this.idle();
  }

  // ---- 툴바·모드 ----
  header() {
    return this.page.locator('header');
  }
  topButton(name: string | RegExp) {
    return this.header().getByRole('button', typeof name === 'string' ? { name, exact: true } : { name });
  }
  async setMode(mode: 'view' | 'organize') {
    if ((await this.summary()).mode !== mode) await this.topButton(/^정리 모드/).click();
    if (mode === 'organize') await expect(this.page.getByTestId('grid')).toBeVisible();
    else await expect(this.page.getByTestId('scroller')).toBeVisible();
  }
  async openSettings() {
    await this.topButton('설정').click();
    const drawer = this.page.getByRole('dialog', { name: '설정' });
    await expect(drawer).toBeVisible();
    return drawer;
  }
  async closeSettings() {
    await this.page.getByRole('button', { name: '설정 닫기' }).click();
    await expect(this.page.getByRole('dialog', { name: '설정' })).toHaveCount(0);
  }
  async settingsInStorage(): Promise<Record<string, unknown>> {
    return this.page.evaluate(() => JSON.parse(localStorage.getItem('pdf-edit:settings') ?? '{}'));
  }

  async setEngine(kind: 'mupdf' | 'pdfium') {
    const drawer = await this.openSettings();
    await drawer.getByLabel('엔진').selectOption(kind);
    await this.closeSettings();
  }

  // ---- 쪽 보내기·병합 ----
  async openSend() {
    await this.dismissNotices(); // 떠 있는 안내가 단추를 가릴 수 있다
    await this.page.getByRole('button', { name: /^선택한 쪽 보내기/ }).click();
    const dlg = this.page.getByRole('dialog', { name: '쪽 보내기' });
    await expect(dlg).toBeVisible();
    return dlg;
  }
  /** 보내기 팝오버를 채워 실행한다. pos 는 'start' | 'end' | 쪽 번호(그 쪽 뒤) */
  async send(opts: { mode?: 'copy' | 'move'; target?: 'new' | string; pos?: 'start' | 'end' | number } = {}) {
    const { mode = 'copy', target = 'new', pos = 'end' } = opts;
    const dlg = await this.openSend();
    await dlg.getByRole('radio', { name: mode === 'move' ? '이동' : '복사', exact: true }).check({ force: true });
    if (target === 'new') await dlg.getByRole('radio', { name: '새 파일' }).check({ force: true });
    else {
      await dlg.getByRole('group', { name: '대상' }).locator('label', { hasText: target }).getByRole('radio').check({ force: true });
      if (pos === 'start') await dlg.getByRole('radio', { name: '맨 앞' }).check({ force: true });
      else if (pos === 'end') await dlg.getByRole('radio', { name: '맨 뒤' }).check({ force: true });
      else await dlg.getByRole('textbox', { name: '쪽 번호' }).fill(String(pos));
    }
    await this.change(() => dlg.getByTestId('send-run').click());
  }
  async openMerge() {
    await this.topButton('열린 파일 병합').click();
    const dlg = this.page.getByRole('dialog', { name: '열린 파일 병합' });
    await expect(dlg).toBeVisible();
    return dlg;
  }

  // ---- 확대 ----
  zoomSelect() {
    return this.header().getByRole('combobox', { name: '확대 배율' });
  }
  async setZoom(z: number) {
    await this.zoomSelect().selectOption(String(z));
  }
  async zoomValue(): Promise<number> {
    return Number(await this.zoomSelect().inputValue());
  }
  currentPageInput() {
    return this.page.getByRole('textbox', { name: '현재 쪽' });
  }
  async gotoPage(n: number) {
    const input = this.currentPageInput();
    await input.click();
    await input.fill(String(n));
    await input.press('Enter');
  }

  // ---- 탭 ----
  tabs() {
    return this.page.getByRole('tab');
  }
  tabNames(): Promise<string[]> {
    return this.tabs().evaluateAll((els) => els.map((e) => (e.closest('[data-tab-name]') as HTMLElement).dataset.tabName ?? ''));
  }
  async activeTabName(): Promise<string | null> {
    return this.page.locator('[role=tab][aria-selected=true]').evaluate((e) => (e.closest('[data-tab-name]') as HTMLElement).dataset.tabName ?? null).catch(() => null);
  }
  tab(name: string) {
    return this.page.locator(`[data-tab-name="${name}"]`).getByRole('tab');
  }
  async switchTab(name: string) {
    await this.tab(name).click();
    await expect(this.tab(name)).toHaveAttribute('aria-selected', 'true');
    await this.settleView();
  }
  /** 문서 전환 뒤 화면이 새 문서로 바뀌길 기다린다 */
  async settleView() {
    await expect.poll(async () => (await this.active())?.name ?? null).toBe(await this.activeTabName());
    const mode = (await this.summary()).mode;
    if (mode === 'view') await this.pageDrawn((await this.active())?.current ?? 0);
  }
  tabNotice() {
    return this.page.getByTestId('tab-notice');
  }

  // ---- 썸네일(보기 모드) / 격자(정리 모드) ----
  thumb(i: number) {
    return this.page.locator(`[data-thumb="${i}"]`);
  }
  /**
   * 썸네일 패널·본문 뷰어는 보이는 쪽 근처만 DOM 에 둔다. 멀리 있는 쪽을 다루기 전에 그 쪽이 만들어지도록 스크롤한다
   * (이미 있으면 아무것도 하지 않는다).
   */
  async reveal(where: 'thumbs' | 'scroller', i: number) {
    const attr = where === 'thumbs' ? 'thumb' : 'page';
    // 그 화면이 없으면(정리 모드의 격자 등) 할 일이 없다
    if (!(await this.page.locator(`[data-testid=${where}]`).count())) return;
    if (await this.page.locator(`[data-testid=${where}] [data-${attr}="${i}"]`).count()) return;
    await this.page.evaluate(
      async ([id, at, idx]) => {
        const sc = document.querySelector(`[data-testid=${id}]`) as HTMLElement | null;
        if (!sc) return;
        const n = Number(sc.dataset.pages) || 1;
        const present = () => !!sc.querySelector(`[data-${at}="${idx}"]`);
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        sc.scrollTop = (sc.scrollHeight * Number(idx)) / n;
        await frame();
        for (let k = 0; k < 80 && !present(); k++) {
          const have = [...sc.querySelectorAll<HTMLElement>(`[data-${at}]`)].map((e) => Number(e.dataset[at as string]));
          const lo = have.length ? Math.min(...have) : 0;
          sc.scrollTop += (Number(idx) < lo ? -1 : 1) * sc.clientHeight * 0.8;
          await frame();
        }
      },
      [where, attr, i] as const,
    );
    await this.page.locator(`[data-testid=${where}] [data-${attr}="${i}"]`).waitFor({ state: 'attached' });
  }
  thumbFace(i: number) {
    return this.page.getByRole('button', { name: new RegExp(`^${i + 1}쪽으로 이동`) });
  }
  /** 선택이 하나라도 있으면(선택 모드) Esc 로 풀어 일반 클릭이 '이동'이 되게 한다 */
  async clearSelectionByEsc() {
    if ((await this.selectedPages()).length) {
      await this.page.keyboard.press('Escape');
      await expect.poll(() => this.selectedPages()).toEqual([]);
    }
  }
  /**
   * 썸네일 클릭. 수정자 없이 부르면 '그 쪽으로 이동하고 그 쪽만 선택'(예전 일반 클릭의 결과)을 한다:
   * 선택 모드면 Esc 로 풀고, 얼굴을 눌러 이동한 뒤, 체크박스로 그 쪽을 고른다.
   * 일반 클릭 자체(이동만, 선택 안 함)를 시험할 때는 thumbFace(i).click() 을 직접 쓴다.
   */
  async clickThumb(i: number, modifiers: ('Control' | 'Shift')[] = []) {
    await this.reveal('thumbs', i);
    await this.thumb(i).scrollIntoViewIfNeeded();
    if (modifiers.length) {
      await this.thumbFace(i).click({ modifiers });
      return;
    }
    await this.clearSelectionByEsc();
    await this.thumbFace(i).click();
    await this.pageCheckbox(i).click();
  }
  /** 썸네일을 우클릭해 쪽 메뉴를 연다(선택이 있는 칸이면 선택 전체가 대상) */
  async openThumbMenu(i: number) {
    await this.reveal('thumbs', i);
    await this.thumb(i).scrollIntoViewIfNeeded();
    await this.thumbFace(i).click({ button: 'right' });
    await expect(this.contextMenu()).toBeVisible();
  }
  /** 쪽 메뉴 항목(회전·복제·삭제). 호버 단추 줄은 없어지고 우클릭 메뉴로 통합됐다 */
  thumbMenuItem(what: 'rotate' | 'rotate-left' | 'copy' | 'delete') {
    const label = { rotate: /오른쪽으로 회전$/, 'rotate-left': /왼쪽으로 회전$/, copy: /쪽 복제$/, delete: /쪽 삭제$/ }[what];
    return this.contextMenu().getByRole('menuitem', { name: label });
  }
  /** 썸네일을 우클릭해 메뉴에서 회전(시계 방향)·복제·삭제를 고른다 */
  async thumbAction(i: number, what: 'rotate' | 'rotate-left' | 'copy' | 'delete') {
    await this.openThumbMenu(i);
    await this.thumbMenuItem(what).click();
  }
  /** 썸네일 메뉴를 연 채 항목을 돌려준다(열려 있는 메뉴는 호출한 쪽이 Esc 로 닫는다) */
  async thumbActionItem(i: number, what: 'rotate' | 'rotate-left' | 'copy' | 'delete') {
    await this.openThumbMenu(i);
    return this.thumbMenuItem(what);
  }
  /** 쪽 체크박스(썸네일 패널·격자 공통) */
  pageCheckbox(i: number) {
    return this.page.getByRole('checkbox', { name: `${i + 1}쪽 선택`, exact: true });
  }
  cell(i: number) {
    return this.page.locator(`[data-cell="${i}"]`);
  }
  cellFace(i: number) {
    return this.cell(i).getByRole('button', { name: /쪽으로 이동/ });
  }
  /** 격자 칸 클릭. 수정자 없는 클릭은 선택 모드에서 '토글'이므로, 예전처럼 '그 칸만 선택'이 되도록 먼저 Esc 로 선택을 푼다 */
  async clickCell(i: number, modifiers: ('Control' | 'Shift')[] = [], clickCount = 1) {
    await this.cell(i).scrollIntoViewIfNeeded();
    if (!modifiers.length) {
      await this.page.getByTestId('grid').focus();
      await this.clearSelectionByEsc();
    }
    await this.cellFace(i).click({ modifiers, clickCount });
  }
  /** 정리 모드 왼쪽 파일 목록 */
  fileRow(name: string) {
    return this.page.locator(`[data-file-key][data-tab-name="${name}"]`);
  }
  fileOption(name: string) {
    return this.fileRow(name).getByRole('option');
  }
  async fileNames(): Promise<string[]> {
    return this.page.getByRole('listbox', { name: '열린 파일' }).locator('[data-file-key]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tabName ?? ''));
  }
  async activeFileName(): Promise<string | null> {
    return this.page.locator('[role=option][aria-selected=true][data-testid=file]').evaluate((e) => (e.closest('[data-tab-name]') as HTMLElement).dataset.tabName ?? null).catch(() => null);
  }
  /** 파일 목록에서 문서를 고르고 격자가 새 문서로 바뀌길 기다린다 */
  async selectFile(name: string) {
    await this.fileOption(name).click();
    await expect(this.fileOption(name)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await this.active())?.name).toBe(name);
    await this.cellDrawn(0);
  }
  async fileBadges(): Promise<number[]> {
    return this.page.getByTestId('file').evaluateAll((els) => els.map((e) => Number(e.querySelector('[data-testid=file-sel]')?.textContent ?? 0)));
  }
  async gridState() {
    return this.page.getByTestId('grid').evaluate((g) => ({ cols: Number((g as HTMLElement).dataset.cols), size: Number((g as HTMLElement).dataset.thumbSize), sw: g.scrollWidth, cw: g.clientWidth, sh: g.scrollHeight, ch: g.clientHeight }));
  }
  contextMenu() {
    return this.page.getByTestId('context-menu');
  }
  async menuItems(): Promise<string[]> {
    return this.contextMenu().getByRole('menuitem').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.trim()));
  }
  async openCellMenu(i: number) {
    await this.cell(i).scrollIntoViewIfNeeded();
    await this.cellFace(i).click({ button: 'right' });
    await expect(this.contextMenu()).toBeVisible();
  }
  async openFileMenu(name: string) {
    await this.fileOption(name).click({ button: 'right' });
    await expect(this.contextMenu()).toBeVisible();
  }
  menuItem(name: string | RegExp) {
    return this.contextMenu().getByRole('menuitem', { name });
  }
  /** 렌더 호출이 더는 늘지 않고 진행 중인 것도 없을 때까지(조건 대기) */
  async renderQuiet(): Promise<number> {
    let last = -1;
    let same = 0;
    await expect
      .poll(
        async () => {
          const s = await this.page.evaluate(() => {
            const S = (globalThis as unknown as { __pdfeditStats: { calls: number; inFlight: number } }).__pdfeditStats;
            return { calls: S.calls, inFlight: S.inFlight };
          });
          same = s.inFlight === 0 && s.calls === last ? same + 1 : 0;
          last = s.calls;
          return same;
        },
        { timeout: 30_000, intervals: [150] },
      )
      .toBeGreaterThanOrEqual(3);
    return last;
  }
  /** 정리 모드 격자 칸을 화면 안으로 가져온다(가장자리 맞춤: 다른 칸도 최대한 보이게) */
  async scrollCell(i: number) {
    await this.cell(i).evaluate((e) => e.scrollIntoView({ block: 'nearest' }));
  }
  /** 스크롤 중 동시 캔버스 수·진행 중 렌더 수 최댓값을 표집한다 */
  async startSampler(cellSelector = 'canvas') {
    await this.page.evaluate((sel) => {
      const S = (globalThis as unknown as { __pdfeditStats: { inFlight: number } }).__pdfeditStats;
      const m = ((globalThis as unknown as { __m: unknown }).__m = { live: 0, inFlight: 0, dom: 0, timer: 0 }) as { live: number; inFlight: number; dom: number; timer: number };
      m.timer = window.setInterval(() => {
        const live = [...document.querySelectorAll(sel)].filter((c) => (c as HTMLCanvasElement).width > 0).length;
        m.live = Math.max(m.live, live);
        m.dom = Math.max(m.dom, document.querySelectorAll('[data-cell]').length);
        m.inFlight = Math.max(m.inFlight, S.inFlight);
      }, 25);
    }, cellSelector);
  }
  async stopSampler() {
    return this.page.evaluate(() => {
      const m = (globalThis as unknown as { __m: { live: number; inFlight: number; dom: number; timer: number } }).__m;
      clearInterval(m.timer);
      const S = (globalThis as unknown as { __pdfeditStats: { errors: number } }).__pdfeditStats;
      return { live: m.live, inFlight: m.inFlight, dom: m.dom, errors: S.errors };
    });
  }
  /** 지정한 속도(px/s)로 프레임마다 스크롤을 밀어 끝날 때까지 기다린다 */
  async smoothScroll(testid: string, from: number, pxPerSec: number, seconds: number) {
    return this.page.evaluate(
      ([id, base, pps, sec]) =>
        new Promise<number>((res) => {
          const sc = document.querySelector(`[data-testid=${id}]`) as HTMLElement;
          sc.scrollTop = base;
          const t0 = performance.now();
          const tick = (t: number) => {
            const e = (t - t0) / 1000;
            sc.scrollTop = base + e * pps;
            if (e < sec) requestAnimationFrame(tick);
            else res(sc.scrollTop);
          };
          requestAnimationFrame(tick);
        }),
      [testid, from, pxPerSec, seconds] as const,
    );
  }
  async renderCalls(): Promise<number> {
    return this.page.evaluate(() => (globalThis as unknown as { __pdfeditStats: { calls: number } }).__pdfeditStats.calls);
  }
  /** "선택한 쪽" 도구 모음 버튼 */
  pageTool(name: string | RegExp) {
    return this.page.getByRole('toolbar', { name: '선택한 쪽 조작' }).getByRole('button', { name });
  }
  /** 좁은 썸네일 패널에서 '더 보기' 메뉴로 옮겨진 쪽 도구 항목(메뉴를 열고 항목을 돌려준다) */
  async pageToolMore(name: string | RegExp) {
    await this.pageTool('선택한 쪽 조작 더 보기').click();
    await expect(this.contextMenu()).toBeVisible();
    return this.menuItem(name);
  }
  selectionCountText() {
    return this.page.getByRole('toolbar', { name: '선택한 쪽 조작' }).getByRole('button', { name: /쪽 선택됨/ });
  }

  // ---- 키보드 ----
  async undo() {
    await this.change(() => this.page.keyboard.press('Control+z'));
  }
  async redo() {
    await this.change(() => this.page.keyboard.press('Control+Shift+Z'));
  }

  // ---- 마우스 ----
  async center(loc: Locator): Promise<Pt> {
    const b = await loc.boundingBox();
    if (!b) throw new Error('요소가 보이지 않아 좌표를 얻지 못함');
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  /** 실제 마우스 드래그. release:false 면 버튼을 누른 채로 멈춘다(끄는 도중 상태 확인용) */
  async dragMouse(from: Pt, to: Pt, opts: { steps?: number; release?: boolean; modifiers?: ('Control' | 'Shift')[] } = {}) {
    const m = this.page.mouse;
    for (const k of opts.modifiers ?? []) await this.page.keyboard.down(k);
    await m.move(from.x, from.y);
    await m.down();
    await m.move(to.x, to.y, { steps: opts.steps ?? 12 });
    if (opts.release !== false) {
      await m.up();
      for (const k of opts.modifiers ?? []) await this.page.keyboard.up(k);
    }
  }
  async releaseMouse() {
    await this.page.mouse.up();
  }

  // ---- 다운로드 ----
  /** 트리거 동작 뒤 내려받은 파일을 읽는다(디스크 사본은 ASCII 이름) */
  async download(trigger: () => Promise<unknown>, ext = '.pdf'): Promise<SavedFile> {
    const [dl] = await Promise.all([this.page.waitForEvent('download', { timeout: 60_000 }), trigger()]);
    const path = this.testInfo.outputPath(`dl-${++this.seq}${ext}`);
    await dl.saveAs(path);
    return { name: dl.suggestedFilename(), path, bytes: new Uint8Array(readFileSync(path)) };
  }
  /** 저장 파일 이름 확인 대화상자 */
  saveDialog() {
    return this.page.getByRole('dialog', { name: '저장 파일 이름' });
  }
  /** 저장 단추(또는 Ctrl+S)를 눌러 이름 확인 대화상자를 연다 */
  async openSaveDialog(via: 'button' | 'ctrlS' = 'button') {
    if (via === 'ctrlS') await this.page.keyboard.press('Control+s');
    else await this.page.getByTestId('save').click();
    const dlg = this.saveDialog();
    await expect(dlg).toBeVisible();
    return dlg;
  }
  /** 열려 있는 대화상자의 이름을 (name 이 있으면 바꿔) Enter 로 확정한다 */
  async confirmSaveDialog(name?: string) {
    const input = this.saveDialog().getByRole('textbox');
    if (name != null) await input.fill(name);
    await input.press('Enter');
  }
  /** 저장 단추(또는 Ctrl+S) → 이름 확인 대화상자에서 Enter 로 확정해 현재 문서를 받는다 */
  async save(via: 'button' | 'ctrlS' = 'button', name?: string): Promise<SavedFile> {
    return this.download(async () => {
      await this.openSaveDialog(via);
      await this.confirmSaveDialog(name);
    });
  }
  /** 탭 이름을 더블클릭(또는 F2)으로 바꾸기 시작한다. 입력칸을 돌려준다 */
  async startRenameTab(name: string, via: 'dblclick' | 'f2' = 'dblclick') {
    const tab = this.tab(name);
    if (via === 'f2') {
      await tab.focus();
      await this.page.keyboard.press('F2');
    } else {
      await tab.dblclick();
    }
    const input = this.page.getByTestId('rename-input');
    await expect(input).toBeFocused();
    return input;
  }
  /** 저장해 qpdf 검사 + mupdf 로 쪽 요약까지 */
  async saveAndInspect(via: 'button' | 'ctrlS' = 'button') {
    const file = await this.save(via);
    const q = qpdfCheck(file.path);
    expect(q.ok, `qpdf --check: ${q.out}`).toBe(true);
    return { file, q, info: inspect(file.bytes) };
  }
  async saveOptions() {
    await this.page.getByRole('button', { name: '저장 옵션' }).click();
    const pop = this.page.getByRole('dialog', { name: '저장 옵션' });
    await expect(pop).toBeVisible();
    return pop;
  }
  async closeSaveOptions() {
    await this.page.getByTestId('save').focus();
    await this.page.keyboard.press('Escape');
    await expect(this.page.getByTestId('save-options')).toHaveCount(0);
  }
  notices() {
    return this.page.locator('[data-notice]');
  }
  /** 떠 있는 안내(저장 옵션 등을 가릴 수 있다)를 모두 닫는다 */
  async dismissNotices() {
    const close = this.notices().getByRole('button', { name: '안내 닫기' });
    // 안내는 스스로 사라지기도 하고(퇴장 모션 중에도 남아 있다) 눌러도 같은 순간에 사라질 수 있어, 못 누르면 다시 센다
    for (let i = 0; i < 12 && (await close.count()) > 0; i++) await close.first().click({ timeout: 2000 }).catch(() => {});
    await expect(this.notices()).toHaveCount(0);
  }
  async noticeTexts(): Promise<string[]> {
    return this.notices().evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\n/g, ' ').trim()));
  }

  // ---- 주석 쪽 좌표 ----
  slot(i: number) {
    return this.page.locator(`[data-page="${i}"]`);
  }
  /** 쪽 공간(pt) → 화면 좌표. pw = 쪽 너비(pt) */
  async toClient(i: number, pw: number, x: number, y: number): Promise<Pt & { k: number }> {
    await this.reveal('scroller', i);
    await this.slot(i).evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await this.pageDrawn(i);
    const r = await this.slot(i).boundingBox();
    if (!r) throw new Error('쪽 슬롯이 보이지 않음');
    const k = r.width / pw;
    return { x: r.x + x * k, y: r.y + y * k, k };
  }
  annotTool(name: string) {
    return this.page.getByRole('toolbar', { name: '주석 도구' }).getByRole('button', { name: new RegExp(`^${name}`) });
  }
  /** 주석 도구 모음은 평소 접혀 있다: 접혀 있으면 상단 툴바의 토글로 펼친다 */
  async openAnnotToolbar() {
    const t = this.header().getByRole('button', { name: '주석 도구 모음' });
    if ((await t.getAttribute('aria-pressed')) !== 'true') await t.click();
    await expect(this.page.getByRole('toolbar', { name: '주석 도구' })).toBeVisible();
  }
  async pickTool(name: string) {
    await this.openAnnotToolbar();
    await this.annotTool(name).click();
    await expect(this.annotTool(name)).toHaveAttribute('aria-pressed', 'true');
  }
  /** 쪽 위에서 끌어 주석을 만든다(pt 좌표) */
  async dragOnPage(pw: number, p0: [number, number], p1: [number, number], pageIndex = 0, steps = 8) {
    const a = await this.toClient(pageIndex, pw, p0[0], p0[1]);
    const z = await this.toClient(pageIndex, pw, p1[0], p1[1]);
    await this.dragMouse(a, z, { steps });
  }
  async clickOnPage(pw: number, p: [number, number], pageIndex = 0) {
    const a = await this.toClient(pageIndex, pw, p[0], p[1]);
    await this.page.mouse.click(a.x, a.y);
  }
  selectedAnnot() {
    return this.page.locator('[data-annot-hit].selected').first();
  }
  async selectedAnnotType(): Promise<string | null> {
    const h = this.page.locator('[data-annot-hit].selected');
    if ((await h.count()) === 0) return null;
    return h.first().getAttribute('data-annot-type');
  }
  async annotCount(i = 0): Promise<number> {
    return this.page.evaluate((idx) => new Set([...document.querySelectorAll(`[data-annot-layer="${idx}"] [data-annot-hit]`)].map((h) => (h as HTMLElement).dataset.annotId)).size, i);
  }
  /** 쪽 캔버스의 색 경계 상자(화면 캔버스 픽셀 기준) */
  async canvasBBox(i: number, kind: ColorKind, within?: [number, number, number, number]): Promise<BBox | null> {
    return this.page.evaluate(
      ([idx, k, w]) => {
        const preds: Record<string, (r: number, g: number, b: number) => boolean> = {
          red: (r, g, b) => r > 190 && g < 70 && b < 70,
          redish: (r, g, b) => r > 200 && g < 110 && b < 110,
          blue: (r, g, b) => b > 190 && r < 70 && g < 70,
          yellowish: (r, g, b) => r > 200 && g > 170 && b < 140,
          dark: (r, g, b) => r < 90 && g < 90 && b < 90,
        };
        const pred = preds[k as string];
        const c = document.querySelector(`[data-page="${idx}"] canvas`) as HTMLCanvasElement;
        const W = c.width, H = c.height;
        const d = c.getContext('2d')!.getImageData(0, 0, W, H).data;
        const win = (w as number[] | null) ?? [0, 0, W, H];
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
        for (let y = Math.max(0, win[1] | 0); y < Math.min(H, win[3]); y++)
          for (let x = Math.max(0, win[0] | 0); x < Math.min(W, win[2]); x++) {
            const o = (y * W + x) * 4;
            if (pred(d[o], d[o + 1], d[o + 2])) {
              n++;
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
        return n ? { x0, y0, x1, y1, n } : null;
      },
      [i, kind, within ?? null] as const,
    );
  }
  /** 텍스트 편집기(메모·텍스트 상자 입력 칸)에 글자를 넣고 확정한다 */
  async typeInAnnotEditor(text: string) {
    const ed = this.page.locator('[data-annot-editor]');
    await expect(ed).toBeVisible();
    await ed.focus();
    await this.page.keyboard.insertText(text);
    // Ctrl+Enter 로 확정한다(방금 열린 입력창은 250ms 동안 blur 를 무시하므로 blur 는 시간에 의존한다)
    await this.page.keyboard.press('Control+Enter');
    await expect(ed).toHaveCount(0);
    await this.idle();
  }
}

// ------------------------------------------------------------------ single 빌드: WASM 을 로컬에서 응답

const CDN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/(.+?)@([^/]+)\/(.+)$/;

/** jsDelivr 요청을 app/node_modules 의 같은 파일로 응답한다. 앱의 SHA-256 검증은 그대로 통과해야 한다 */
async function routeCdn(page: Page) {
  await page.route(CDN, async (route) => {
    const m = CDN.exec(route.request().url());
    if (!m) return route.abort();
    const file = join(APP_ROOT, 'node_modules', m[1], m[3]);
    try {
      const body = readFileSync(file);
      await route.fulfill({ status: 200, body, contentType: file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } });
    } catch {
      await route.fulfill({ status: 404, body: 'not found: ' + file });
    }
  });
}

export const test = base.extend<{ app: App; mkApp: (opts?: { viewport?: { width: number; height: number } }) => Promise<App> }>({
  app: async ({ page }, use, testInfo) => {
    const kind = testInfo.project.name as BuildKind;
    if (kind === 'single') await routeCdn(page);
    const app = new App(page, kind, testInfo);
    await use(app);
    expect(app.pageErrors, '페이지에서 처리되지 않은 예외가 났다').toEqual([]);
  },
  // 같은 테스트 안에서 컨텍스트를 하나 더 만들어야 할 때(저장소 분리 확인 등)
  mkApp: async ({ browser }, use, testInfo) => {
    const made: { close(): Promise<void> }[] = [];
    await use(async (opts) => {
      const ctx = await browser.newContext({ acceptDownloads: true, viewport: opts?.viewport ?? { width: 1400, height: 900 }, reducedMotion: 'reduce' });
      made.push(ctx);
      const page = await ctx.newPage();
      const kind = testInfo.project.name as BuildKind;
      if (kind === 'single') await routeCdn(page);
      return new App(page, kind, testInfo);
    });
    for (const c of made) await c.close();
  },
});

/** 파일 바이트를 읽는다(전송용) */
export const readBytes = (p: string) => new Uint8Array(readFileSync(p));
export { writeFileSync };
