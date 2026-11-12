// 인쇄 시험. 헤드리스에서 실제 window.print() 를 부르면 페이지가 '인쇄 중'에 갇히므로 호출만 기록하는 대역으로 바꾼다.
// - 방식 A(static 만): 인쇄용 PDF 를 숨은 iframe 에 넣어 인쇄한다. iframe 의 blob URL 을 읽어 인쇄 사본의 바이트를 검사한다.
// - 방식 B(이미지): #print-root 에 쪽 이미지를 깔고 window.print(). single(file://)은 처음부터 이 방식이다.
// 쪽 식별: 방식 A 는 쪽 글자, 방식 B 는 이미지 폭(docA 300..340pt 10 간격, docB 320+7i pt 로 쪽마다 다르다).
import { test, expect, texts, reloadPdf, renderPdf, colorBBox, type App, type Page } from './helpers.ts';
import { GENERATED as G } from './fixtures/paths.ts';
import { inspect, makePdf } from './fixtures/synth.ts';
import { writeFileSync } from 'node:fs';

type W = { __printCalls: number; __pdfeditPrintInject?: unknown; __pdfeditPrint?: { events: { e: string }[] } };

async function stubPrint(page: Page, inject?: Record<string, unknown>) {
  await page.addInitScript((inj) => {
    const w = window as unknown as W;
    w.__printCalls = 0;
    window.print = () => {
      w.__printCalls++;
    };
    if (inj) w.__pdfeditPrintInject = inj;
  }, inject ?? null);
}
const printCalls = (page: Page) => page.evaluate(() => (window as unknown as W).__printCalls);
const printEvents = (page: Page) => page.evaluate(() => ((globalThis as unknown as W).__pdfeditPrint?.events ?? []).map((e) => e.e));
const clearEvents = (page: Page) => page.evaluate(() => void ((globalThis as unknown as W).__pdfeditPrint!.events.length = 0));

async function start(app: App, files: string | string[], inject?: Record<string, unknown>) {
  await stubPrint(app.page, inject);
  await app.goto();
  await app.open(files);
}

const dlg = (page: Page) => page.getByRole('dialog', { name: '인쇄' });
const radio = (page: Page, name: string) => dlg(page).getByRole('radio', { name, exact: true });
const summary = (page: Page) => page.getByTestId('print-summary');
const runBtn = (page: Page) => dlg(page).getByRole('button', { name: '인쇄', exact: true });

async function openDialog(app: App) {
  await app.page.keyboard.press('Control+p');
  await expect(dlg(app.page)).toBeVisible();
}
async function runPrint(app: App) {
  await runBtn(app.page).click();
  await expect(dlg(app.page)).toHaveCount(0);
}
/** afterprint 를 흉내 내 인쇄 자원(#print-root·iframe)을 정리시킨다 */
async function afterPrint(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('#print-root')).toHaveCount(0);
  await expect(page.locator('#print-page-css')).toHaveCount(0);
  await expect(page.locator('iframe[data-print-frame]')).toHaveCount(0);
}
/** 방식 B 의 이미지가 모두 깔린 뒤(window.print 호출) 이미지 폭을 pt 로 */
async function imagePts(page: Page, prevCalls: number, dpi = 200): Promise<number[]> {
  await expect.poll(() => printCalls(page), { timeout: 60_000 }).toBeGreaterThan(prevCalls);
  return page.locator('#print-root img').evaluateAll((els, d) => els.map((e) => Math.round(((e as HTMLImageElement).naturalWidth * 72) / d)), dpi);
}
const LABEL: Record<number, string> = { 300: 'A-1', 310: 'A-2', 320: 'A-3', 330: 'A-4', 340: 'A-5', 327: 'B-2', 334: 'B-3' };
const labels = (pts: number[]) => pts.map((p) => LABEL[p] ?? `?${p}`);

/** iframe 의 blob URL 에서 인쇄 사본의 바이트를 읽는다 */
async function frameBytes(page: Page): Promise<Uint8Array> {
  const b64 = await page.evaluate(async () => {
    const f = document.querySelector('iframe[data-print-frame]') as HTMLIFrameElement | null;
    if (!f) return null;
    const buf = new Uint8Array(await (await fetch(f.src)).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192));
    return btoa(s);
  });
  if (!b64) throw new Error('인쇄용 iframe 이 없다');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// =============================================================================================================
test.describe('인쇄: 진입점', () => {
  test('Ctrl+P 는 브라우저 기본 인쇄를 막는다: 문서가 없으면 대화상자 없음, 있으면 대화상자(요약·초기 포커스)', async ({ app, page }) => {
    await stubPrint(page);
    await app.goto();
    await page.evaluate(() => {
      const w = window as unknown as { __kp: { k: string; dp: boolean }[]; __bp: number };
      w.__kp = [];
      w.__bp = 0;
      window.addEventListener('keydown', (e) => w.__kp.push({ k: e.key, dp: e.defaultPrevented }));
      window.addEventListener('beforeprint', () => w.__bp++);
    });
    const last = () => page.evaluate(() => (window as unknown as { __kp: { k: string; dp: boolean }[] }).__kp.at(-1));
    await page.keyboard.press('Control+p');
    expect(await last()).toEqual({ k: 'p', dp: true });
    await expect(dlg(page)).toHaveCount(0);
    await expect(app.topButton(/^인쇄/)).toHaveCount(0); // 문서가 없으면 인쇄 버튼도 없다

    await app.open(G.docA);
    await page.keyboard.press('Control+p');
    expect(await last()).toEqual({ k: 'p', dp: true });
    await expect(dlg(page)).toBeVisible();
    await expect(summary(page)).toHaveText('docA.pdf 5쪽');
    await expect(radio(page, '전체')).toBeChecked();
    await expect(radio(page, '전체')).toBeFocused(); // 지금 고른 범위의 라디오로 포커스가 간다
    expect(await page.evaluate(() => (window as unknown as { __bp: number }).__bp)).toBe(0); // 브라우저 인쇄는 뜨지 않았다
    expect(await printCalls(page)).toBe(0);
    // 서랍의 단축키 목록에도 있다
    await page.keyboard.press('Escape');
    const drawer = await app.openSettings();
    await expect(drawer.locator('dt', { hasText: 'Ctrl' }).filter({ hasText: 'P' }).first().locator('xpath=following-sibling::dd[1]')).toHaveText('인쇄');
  });

  test('툴바 버튼으로 열고 Esc·취소 단추로 닫는다', async ({ app, page }) => {
    await start(app, G.docA);
    const btn = app.topButton('인쇄 (Ctrl+P)');
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await btn.click();
    await expect(dlg(page)).toBeVisible();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    await expect(app.header().getByRole('dialog', { name: '인쇄' })).toHaveCount(1); // 툴바 버튼에 붙는다
    await page.keyboard.press('Escape');
    await expect(dlg(page)).toHaveCount(0);
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    // 취소 단추도 같다
    await btn.click();
    await dlg(page).getByRole('button', { name: '취소' }).click();
    await expect(dlg(page)).toHaveCount(0);
    expect(await printCalls(page)).toBe(0);
  });

  test('보기 모드 쪽 도구의 인쇄 단추: 선택이 없으면 꺼지고, 선택하면 같은 대화상자가 선택한 쪽으로 열린다', async ({ app, page }) => {
    await start(app, G.docA);
    const tool = page.getByRole('button', { name: '선택한 쪽 인쇄' });
    await expect(tool).toBeDisabled();
    await app.clickThumb(0);
    await app.clickThumb(2, ['Control']);
    await expect(tool).toBeEnabled();
    await tool.click();
    await expect(dlg(page)).toHaveCount(1);
    await expect(summary(page)).toHaveText('선택한 2쪽');
    await expect(radio(page, '선택한 쪽')).toBeChecked();
  });

  test('정리 모드: 쪽 우클릭 메뉴·파일 우클릭 메뉴·쪽 도구의 인쇄가 모두 같은 대화상자를 연다', async ({ app, page }) => {
    await start(app, [G.docA, G.docB]);
    await app.setMode('organize');
    await app.selectFile('docA.pdf');
    await app.clickCell(1);
    await app.clickCell(3, ['Control']);
    // 쪽 메뉴: 선택에 속한 쪽을 우클릭하면 선택 전체
    await app.openCellMenu(1);
    await app.menuItem('인쇄…').click();
    await expect(dlg(page)).toHaveCount(1);
    await expect(summary(page)).toHaveText('선택한 2쪽');
    await expect(app.header().getByRole('dialog', { name: '인쇄' })).toHaveCount(1);
    await dlg(page).getByRole('button', { name: '취소' }).click();
    await expect(dlg(page)).toHaveCount(0);
    // 파일 메뉴: 그 파일 전체
    await app.openFileMenu('docB.pdf');
    await app.menuItem('인쇄…').click();
    await expect(dlg(page)).toHaveCount(1);
    await expect(summary(page)).toHaveText('docB.pdf 4쪽');
    expect(await app.activeFileName()).toBe('docB.pdf');
    await dlg(page).getByRole('button', { name: '취소' }).click();
    // 쪽 도구(정리 모드): 두 파일에 걸친 선택
    await app.clickCell(0);
    await page.getByRole('button', { name: '선택한 쪽 인쇄' }).click();
    await expect(dlg(page)).toHaveCount(1);
    await expect(summary(page)).toHaveText('2개 파일에서 선택한 3쪽');
    // Ctrl+P 도 같다(이미 열려 있으면 하나만 있다)
    await page.keyboard.press('Control+p');
    await expect(dlg(page)).toHaveCount(1);
  });
});

test.describe('인쇄: 포커스 복귀', () => {
  test('Esc 로 닫으면 포커스가 인쇄 버튼으로 돌아온다', async ({ app, page }) => {
    await start(app, G.docA);
    const btn = app.topButton('인쇄 (Ctrl+P)');
    await btn.click();
    await expect(dlg(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg(page)).toHaveCount(0);
    await expect(btn).toBeFocused({ timeout: 3000 });
  });
});

// =============================================================================================================
test.describe('인쇄: 범위', () => {
  test('전체·현재 쪽·선택한 쪽·범위 입력: 요약 문구와 실제로 인쇄되는 쪽(이미지 방식)', async ({ app, page }) => {
    await start(app, G.docA);
    await app.gotoPage(3);
    await expect.poll(async () => (await app.active())?.current).toBe(2);
    await openDialog(app);
    await expect(summary(page)).toHaveText('docA.pdf 5쪽');
    await expect(radio(page, '선택한 쪽')).toBeDisabled(); // 선택이 없으면 고를 수 없다
    await radio(page, '이미지로 인쇄').check();
    // 현재 쪽
    await radio(page, '현재 쪽').check();
    await expect(summary(page)).toHaveText('docA.pdf 3쪽');
    let calls = await printCalls(page);
    await runPrint(app);
    expect(labels(await imagePts(page, calls))).toEqual(['A-3']);
    await afterPrint(page);

    // 선택한 쪽(선택이 있으면 처음부터 '선택한 쪽')
    await app.clickThumb(3);
    await app.clickThumb(1, ['Control']);
    await openDialog(app);
    await expect(radio(page, '선택한 쪽')).toBeChecked();
    await expect(summary(page)).toHaveText('선택한 2쪽');
    calls = await printCalls(page);
    await runPrint(app);
    expect(labels(await imagePts(page, calls))).toEqual(['A-2', 'A-4']); // 쪽 번호 순서
    await afterPrint(page);

    // 범위 입력
    await openDialog(app);
    await radio(page, '쪽 범위').check();
    await dlg(page).getByRole('textbox', { name: '인쇄할 쪽 범위' }).fill('4, 2-3');
    await expect(summary(page)).toHaveText('docA.pdf 3쪽 (2-4)');
    calls = await printCalls(page);
    await runPrint(app);
    expect(labels(await imagePts(page, calls))).toEqual(['A-2', 'A-3', 'A-4']);
    await afterPrint(page);

    // 전체
    await openDialog(app);
    await radio(page, '전체').check();
    calls = await printCalls(page);
    await runPrint(app);
    expect(labels(await imagePts(page, calls))).toEqual(['A-1', 'A-2', 'A-3', 'A-4', 'A-5']);
    await afterPrint(page);
  });

  test('범위 입력 오류: 안내가 뜨고 인쇄 버튼이 꺼지며, 고치면 되살아난다', async ({ app, page }) => {
    await start(app, G.docA);
    await openDialog(app);
    const box = dlg(page).getByRole('textbox', { name: '인쇄할 쪽 범위' });
    await box.fill('9');
    await expect(dlg(page).getByRole('alert')).toContainText('벗어났');
    await expect(runBtn(page)).toBeDisabled();
    await expect(summary(page)).toHaveText('인쇄할 쪽이 없습니다');
    await box.fill('abc');
    await expect(dlg(page).getByRole('alert')).toBeVisible();
    await expect(runBtn(page)).toBeDisabled();
    await box.fill('2-3');
    await expect(dlg(page).getByRole('alert')).toHaveCount(0);
    await expect(runBtn(page)).toBeEnabled();
    await expect(summary(page)).toHaveText('docA.pdf 2쪽 (2-3)');
    await box.fill('');
    expect(await printCalls(page)).toBe(0);
  });

  test('보기 모드: 활성 문서에 선택이 없으면 다른 파일의 선택은 무시하고 전체가 기본이다', async ({ app, page }) => {
    await start(app, [G.docA, G.docB]);
    await app.switchTab('docA.pdf');
    await app.clickThumb(0);
    await app.switchTab('docB.pdf');
    expect(await app.selectedPages()).toEqual([]);
    await openDialog(app);
    await expect(summary(page)).toHaveText('docB.pdf 4쪽');
    await expect(radio(page, '선택한 쪽')).toBeDisabled();
  });
});

// =============================================================================================================
test.describe('인쇄: PDF 방식(static)', () => {
  test('인쇄 사본은 대상 쪽만 순서대로 담고 주석이 평탄화되며, 라이브 문서(쪽 수·변경됨·되돌리기)는 그대로다', async ({ app, page }) => {
    test.skip(app.kind === 'single', 'file:// 에서는 방식 A 를 쓸 수 없다');
    await start(app, G.docA);
    // 2쪽(310pt 폭)에 사각형 주석
    await app.pickTool('사각형');
    await app.change(() => app.dragOnPage(310, [100, 100], [200, 200], 1));
    await page.keyboard.press('Escape'); // 도구를 선택으로
    await app.clickThumb(3);
    await app.clickThumb(0, ['Control']);
    await app.clickThumb(1, ['Control']);
    const before = await app.sig();
    const docBefore = await app.active();
    expect([docBefore?.pages, docBefore?.dirty, docBefore?.undo]).toEqual([5, true, 1]);

    await openDialog(app);
    await expect(radio(page, '선택한 쪽')).toBeChecked();
    await expect(radio(page, '자동')).toBeChecked();
    await clearEvents(page);
    await runPrint(app);
    await expect.poll(() => printEvents(page), { timeout: 30_000 }).toContain('iframe-print-called');
    const evs = await printEvents(page);
    expect(evs).toContain('iframe-loaded');
    expect(evs).not.toContain('window-print-called');
    expect(await printCalls(page)).toBe(0); // window.print 는 쓰지 않는다
    await expect(dlg(page)).toHaveCount(0); // 인쇄 창을 띄운 뒤 대화상자가 닫힌다

    const bytes = await frameBytes(page);
    expect(texts(inspect(bytes))).toEqual(['A-1', 'A-2', 'A-4']); // 대상 쪽만, 쪽 번호 순서
    const r = await reloadPdf(bytes);
    expect(r.pages.map((a) => a.length)).toEqual([0, 0, 0]); // 주석은 내용으로 구워져 표준 주석이 없다
    await r.close();
    const p1 = await renderPdf(bytes, 1, 2);
    const red = colorBBox(p1, 'redish');
    expect(red?.n ?? 0, '평탄화된 사본에 사각형이 그려져 있다').toBeGreaterThan(150);
    expect(colorBBox(await renderPdf(bytes, 0, 2), 'redish')).toBeNull();

    // 라이브 문서는 그대로
    expect(await app.sig()).toBe(before);
    const live = await app.active();
    expect([live?.pages, live?.dirty, live?.undo, live?.redo]).toEqual([5, true, 1, 0]);
    await afterPrint(page);
    expect(await printEvents(page)).toContain('cleanup');
    // 라이브 문서의 주석은 표준 주석 그대로 저장된다
    const saved = await reloadPdf((await app.save()).bytes);
    expect(saved.n).toBe(5);
    expect(saved.pages[1].map((a) => a.type)).toEqual(['square']);
    await saved.close();
  });

  test('깨끗한 문서를 인쇄해도 변경됨 표시·되돌리기 기록이 생기지 않는다', async ({ app, page }) => {
    test.skip(app.kind === 'single', 'file:// 에서는 방식 A 를 쓸 수 없다');
    await start(app, G.docB);
    await openDialog(app);
    await runPrint(app);
    await expect.poll(() => printEvents(page), { timeout: 30_000 }).toContain('iframe-print-called');
    const d = await app.active();
    expect([d?.pages, d?.dirty, d?.undo, d?.redo]).toEqual([4, false, 0, 0]);
    expect(texts(inspect(await frameBytes(page)))).toEqual(['B-1', 'B-2', 'B-3', 'B-4']);
    await afterPrint(page);
  });

  test('정리 모드: 두 파일에 걸친 선택을 파일 순서·쪽 순서대로 한 번에 인쇄한다(PDF 방식)', async ({ app, page }) => {
    test.skip(app.kind === 'single', 'file:// 에서는 방식 A 를 쓸 수 없다');
    await start(app, [G.docA, G.docB]);
    await app.setMode('organize');
    await app.selectFile('docB.pdf');
    await app.clickCell(2);
    await app.clickCell(1, ['Control']);
    await app.selectFile('docA.pdf');
    await app.clickCell(3);
    await app.clickCell(0, ['Control']);
    await app.clickCell(2, ['Control']);
    expect(await summaryAfterOpen(app)).toBe('2개 파일에서 선택한 5쪽');
    await runPrint(app);
    await expect.poll(() => printEvents(page), { timeout: 30_000 }).toContain('iframe-print-called');
    expect(texts(inspect(await frameBytes(page)))).toEqual(['A-1', 'A-3', 'A-4', 'B-2', 'B-3']);
    const s = (await app.summary()).docs;
    expect(s.map((d) => [d.pages, d.dirty, d.undo])).toEqual([[5, false, 0], [4, false, 0]]);
    await afterPrint(page);
  });
});

async function summaryAfterOpen(app: App) {
  await openDialog(app);
  await expect(radio(app.page, '선택한 쪽')).toBeChecked();
  return summary(app.page).innerText();
}

// =============================================================================================================
test.describe('인쇄: 이미지 방식', () => {
  test('이미지 수 = 대상 쪽 수, 인쇄 미디어에서는 #print-root 만 보이고, afterprint 뒤 정리된다', async ({ app, page }) => {
    await start(app, G.docA);
    await app.clickThumb(0);
    await app.clickThumb(1, ['Control']);
    await app.clickThumb(3, ['Control']);
    const before = await app.sig();
    await openDialog(app);
    await radio(page, '이미지로 인쇄').check();
    await expect(radio(page, '200dpi')).toBeChecked(); // 기본 200dpi
    await expect(dlg(page).getByRole('radiogroup', { name: '이미지 품질' }).getByRole('radio')).toHaveCount(3);
    await clearEvents(page);
    await runPrint(app);
    await expect.poll(() => printCalls(page), { timeout: 60_000 }).toBe(1);
    const evs = await printEvents(page);
    expect(evs).toContain('image-ready');
    expect(evs).toContain('window-print-called');
    expect(evs).not.toContain('iframe-start');
    await expect(page.locator('#print-root img')).toHaveCount(3);
    await expect(page.locator('#print-root')).toBeHidden(); // 화면에서는 숨김
    const sizes = await page.locator('#print-root img').evaluateAll((els) => els.map((e) => [(e as HTMLImageElement).naturalWidth, (e as HTMLImageElement).naturalHeight]));
    expect(sizes[0]).toEqual([834, 1112]); // 300x400pt @200dpi
    expect(labels(await imagePts(page, 0))).toEqual(['A-1', 'A-2', 'A-4']);

    await page.emulateMedia({ media: 'print' });
    try {
      await expect(page.locator('#print-root')).toBeVisible();
      await expect(app.header()).toBeHidden();
      await expect(page.getByTestId('scroller')).toBeHidden();
      await expect(page.getByRole('complementary', { name: '페이지 목록' })).toBeHidden();
      // 실제 인쇄 결과(쪽 수·UI 글자 없음)
      const pdf = inspect(new Uint8Array(await page.pdf({ preferCSSPageSize: true, printBackground: true })));
      expect(pdf).toHaveLength(3);
      expect(pdf.map((p) => p.text)).toEqual(['', '', '']);
      expect([pdf[0].w, pdf[0].h]).toEqual([300, 400]);
    } finally {
      await page.emulateMedia({ media: null });
    }
    expect(await app.sig()).toBe(before); // 라이브 문서 불변
    await afterPrint(page);
    await expect(page.locator('#print-root')).toHaveCount(0);
  });

  test('가로·세로가 섞인 문서: 가로 쪽은 flip 쪽으로 방향만 바뀐다', async ({ app, page }, testInfo) => {
    const f = testInfo.outputPath('mixed.pdf');
    writeFileSync(
      f,
      makePdf([
        { w: 300, h: 400, text: 'M-1' },
        { w: 400, h: 300, text: 'M-2' },
        { w: 300, h: 400, text: 'M-3' },
        { w: 400, h: 300, text: 'M-4' },
        { w: 300, h: 400, text: 'M-5' },
      ]),
    );
    await start(app, f);
    await openDialog(app);
    await radio(page, '이미지로 인쇄').check();
    await radio(page, '150dpi').check({ force: true });
    await runPrint(app);
    await expect.poll(() => printCalls(page), { timeout: 60_000 }).toBe(1);
    await expect(page.locator('#print-root img')).toHaveCount(5);
    expect(await page.locator('#print-root .pp').evaluateAll((els) => els.map((e) => e.classList.contains('flip')))).toEqual([false, true, false, true, false]);
    const css = await page.locator('#print-page-css').evaluate((e) => e.textContent ?? '');
    expect(css).toContain('@page flip');
    await page.emulateMedia({ media: 'print' });
    try {
      const pdf = inspect(new Uint8Array(await page.pdf({ preferCSSPageSize: true, printBackground: true })));
      expect(pdf.map((p) => [p.w, p.h])).toEqual([[300, 400], [400, 300], [300, 400], [400, 300], [300, 400]]);
    } finally {
      await page.emulateMedia({ media: null });
    }
    await afterPrint(page);
  });

  test('정리 모드: 두 파일에 걸친 선택을 합쳐 파일 순서·쪽 순서대로 인쇄한다', async ({ app, page }) => {
    await start(app, [G.docA, G.docB]);
    await app.setMode('organize');
    await app.selectFile('docB.pdf');
    await app.clickCell(2);
    await app.clickCell(1, ['Control']);
    await app.selectFile('docA.pdf');
    await app.clickCell(3);
    await app.clickCell(0, ['Control']);
    await app.clickCell(2, ['Control']);
    expect(await summaryAfterOpen(app)).toBe('2개 파일에서 선택한 5쪽');
    await radio(page, '이미지로 인쇄').check();
    await runPrint(app);
    expect(labels(await imagePts(page, 0))).toEqual(['A-1', 'A-3', 'A-4', 'B-2', 'B-3']);
    expect((await app.summary()).docs.map((d) => [d.pages, d.dirty, d.undo])).toEqual([[5, false, 0], [4, false, 0]]);
    await afterPrint(page);
  });
});

// =============================================================================================================
test.describe('인쇄: 자동 전환', () => {
  test('방식 A 가 실패하면(iframe 불러오기 실패·접근 차단) 이미지 방식으로 넘어가고 안내가 뜬다', async ({ app, page }) => {
    test.skip(app.kind === 'single', 'single 은 처음부터 이미지 방식(별도 시험)');
    await start(app, G.docA);
    for (const inj of [{ iframe: 'noload', timeoutMs: 1500 }, { iframe: 'throw' }]) {
      await page.evaluate((i) => ((window as unknown as W).__pdfeditPrintInject = i), inj);
      await clearEvents(page);
      const calls = await printCalls(page);
      await openDialog(app);
      await radio(page, '자동').check();
      await radio(page, '전체').check();
      await runPrint(app);
      await expect.poll(() => printCalls(page), { timeout: 30_000 }).toBeGreaterThan(calls);
      const evs = await printEvents(page);
      expect(evs, inj.iframe).toEqual(expect.arrayContaining(['iframe-fail', 'image-ready', 'window-print-called']));
      await expect(page.locator('#print-root img')).toHaveCount(5);
      await expect(page.locator('iframe[data-print-frame]')).toHaveCount(0); // 실패한 iframe 은 남지 않는다
      await expect.poll(() => app.noticeTexts(), { message: '전환 안내' }).toEqual([expect.stringContaining('이미지 방식으로 인쇄')]);
      await afterPrint(page);
      await app.dismissNotices();
    }
  });

  test('single(file://)는 처음부터 이미지 방식이고 대화상자와 알림에 안내가 있다', async ({ app, page }) => {
    test.skip(app.kind === 'static', 'static 은 방식 A 가 기본(별도 시험)');
    await start(app, G.docA);
    // 실제로 막히는지: blob iframe 의 print 접근은 교차 출처 오류
    const realErr = await page.evaluate(async () => {
      const u = URL.createObjectURL(new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' }));
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-9999px;width:50px;height:50px';
      document.body.appendChild(f);
      await new Promise<void>((r) => {
        f.onload = () => r();
        f.src = u;
        setTimeout(r, 4000);
      });
      try {
        void f.contentWindow!.print;
        return 'no error';
      } catch (e) {
        return (e as Error).name;
      } finally {
        f.remove();
      }
    });
    expect(realErr).toBe('SecurityError');
    await openDialog(app);
    await expect(page.getByTestId('print-direct-hint')).toBeVisible();
    await expect(radio(page, '자동')).toBeChecked();
    await clearEvents(page);
    await runPrint(app);
    await expect.poll(() => printCalls(page), { timeout: 60_000 }).toBe(1);
    const evs = await printEvents(page);
    expect(evs).toContain('image-ready');
    expect(evs).not.toContain('iframe-start'); // iframe 은 시도조차 하지 않는다
    await expect(page.locator('#print-root img')).toHaveCount(5);
    await expect.poll(() => app.noticeTexts()).toEqual([expect.stringContaining('이미지 방식으로 인쇄')]);
    await afterPrint(page);
  });
});

// =============================================================================================================
test.describe('인쇄: 취소', () => {
  test('여러 쪽을 준비하는 중 취소하면 #print-root 가 정리되고 인쇄 호출이 없으며 앱이 한가해진다(버튼·Esc)', async ({ app, page }) => {
    await start(app, G.big300);
    await openDialog(app);
    await radio(page, '이미지로 인쇄').check();
    await radio(page, '300dpi').check({ force: true });
    for (const how of ['button', 'escape'] as const) {
      await clearEvents(page);
      await radio(page, '전체').check();
      await runBtn(page).click();
      await expect(page.getByTestId('print-progress')).toHaveText(/\d+\/300쪽 준비 중/);
      await expect(dlg(page)).toBeVisible(); // 준비 중에는 대화상자가 남는다
      if (how === 'button') await dlg(page).getByRole('button', { name: '취소' }).click();
      else {
        await dlg(page).focus();
        await page.keyboard.press('Escape');
      }
      await expect(dlg(page)).toHaveCount(0);
      await expect.poll(() => printEvents(page), { timeout: 30_000 }).toContain('image-fail');
      await expect(page.locator('#print-root')).toHaveCount(0);
      await expect(page.locator('#print-page-css')).toHaveCount(0);
      expect(await printCalls(page)).toBe(0);
      expect(await printEvents(page)).not.toContain('window-print-called');
      await app.idle();
      // 다시 열면 멈춘 상태가 아니다
      await openDialog(app);
      await expect(runBtn(page)).toBeEnabled();
      await expect(page.getByTestId('print-progress')).toHaveCount(0);
    }
    expect((await app.active())?.dirty).toBe(false);
  });
});

// =============================================================================================================
test.describe('인쇄: 설정 저장', () => {
  test('인쇄 방식·dpi 는 새로고침 뒤에도 유지된다', async ({ app, page }) => {
    await start(app, G.docA);
    await openDialog(app);
    await radio(page, '이미지로 인쇄').check();
    await radio(page, '300dpi').check({ force: true });
    await expect.poll(() => app.settingsInStorage()).toMatchObject({ printMethod: 'image', printDpi: 300 });
    await page.reload();
    await page.locator('[data-testid=file-input]').waitFor({ state: 'attached' });
    await app.open(G.docA);
    await openDialog(app);
    await expect(radio(page, '이미지로 인쇄')).toBeChecked();
    await expect(radio(page, '300dpi')).toBeChecked();
    // 되돌려 저장
    await radio(page, '자동').check();
    await expect.poll(() => app.settingsInStorage()).toMatchObject({ printMethod: 'auto', printDpi: 300 });
  });
});
