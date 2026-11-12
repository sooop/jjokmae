import { test, expect, type App } from './helpers.ts';
import { GENERATED as G } from './fixtures/paths.ts';

/** 화면에 비트맵이 살아 있는(너비>0) 캔버스 수 */
const liveCanvases = (app: App) => app.page.evaluate(() => [...document.querySelectorAll('canvas')].filter((c) => c.width > 0).length);

test.describe('보기: 확대·쪽 이동·단축키', () => {
  test('확대 배율: 선택 상자·+/- 키·범위 제한, 쪽 크기가 배율에 비례하고 설정에 저장된다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const w = async () => (await app.slot(0).boundingBox())!.width;
    expect(await app.zoomValue()).toBe(1);
    const w100 = await w();
    await app.setZoom(2);
    await expect.poll(w).toBeGreaterThan(w100 * 1.9);
    expect(await app.zoomValue()).toBe(2);
    await app.setZoom(0.5);
    await expect.poll(w).toBeLessThan(w100 * 0.6);
    // 단축키 + / -
    await page.keyboard.press('+');
    await expect.poll(() => app.zoomValue()).toBe(0.75);
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    await expect.poll(() => app.zoomValue()).toBe(0.25);
    await page.keyboard.press('-'); // 하한에서 더 줄지 않는다
    await expect.poll(() => app.zoomValue()).toBe(0.25);
    await app.setZoom(4);
    await page.keyboard.press('+'); // 상한
    await expect.poll(() => app.zoomValue()).toBe(4);
    // 마지막 값은 설정에 저장된다
    await expect.poll(async () => (await app.settingsInStorage()).zoom).toBe(4);
    // 새로 여는 파일은 마지막 배율로 시작한다
    await app.open(G.docB);
    expect(await app.zoomValue()).toBe(4);
  });

  test('쪽 이동: 입력·PageUp/PageDown·썸네일·이전/다음 단추, 현재 쪽 표시는 스크롤을 따라간다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const cur = app.currentPageInput();
    await app.gotoPage(3);
    await expect(cur).toHaveValue('3');
    await app.pageDrawn(2);
    await page.keyboard.press('PageDown');
    await expect(cur).toHaveValue('4');
    await page.keyboard.press('PageUp');
    await page.keyboard.press('PageUp');
    await expect(cur).toHaveValue('2');
    await page.getByRole('button', { name: '다음 쪽' }).click();
    await expect(cur).toHaveValue('3');
    await page.getByRole('button', { name: '이전 쪽' }).click();
    await expect(cur).toHaveValue('2');
    await app.clickThumb(4);
    await expect(cur).toHaveValue('5');
    await expect(page.getByRole('button', { name: '다음 쪽' })).toBeDisabled();
    // 범위를 넘는 입력은 끝 쪽으로 맞춘다
    await app.gotoPage(99);
    await expect(cur).toHaveValue('5');
    await app.gotoPage(1);
    await expect(page.getByRole('button', { name: '이전 쪽' })).toBeDisabled();
    // 숫자가 아닌 입력은 원래 값으로 돌아간다
    await cur.click();
    await cur.fill('abc');
    await cur.press('Enter');
    await expect(cur).toHaveValue('1');
    // 마우스 휠로 내리면 현재 쪽이 따라 바뀐다
    await page.getByTestId('scroller').hover();
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, 600);
        return Number(await cur.inputValue());
      })
      .toBeGreaterThan(1);
    // 현재 쪽 썸네일이 표시된다
    await expect(page.locator('[data-thumb] button[aria-current=page]')).toHaveCount(1);
  });

  test('글자를 입력하는 중에는 문자 키 단축키가 동작하지 않는다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const cur = app.currentPageInput();
    await cur.click();
    await page.keyboard.press('g');
    await page.keyboard.press('+');
    expect((await app.summary()).mode).toBe('view');
    expect(await app.zoomValue()).toBe(1);
    await cur.press('Escape');
    // 입력에서 벗어나면 G 로 정리 모드로 간다
    await page.keyboard.press('g');
    await expect.poll(async () => (await app.summary()).mode).toBe('organize');
    await page.keyboard.press('g');
    await expect.poll(async () => (await app.summary()).mode).toBe('view');
  });

  test('쪽 크기가 서로 다른 문서도 모든 쪽이 겹치지 않고 위에서 아래로 놓인다', async ({ app }) => {
    await app.goto();
    await app.open(G.five);
    const boxes = await app.page.locator('[data-page]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom, w: r.width })));
    expect(boxes).toHaveLength(5);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom - 1);
  });
});

test.describe('보기: 300쪽 문서(가상화)', () => {
  test.setTimeout(180_000);

  test('쪽 자리는 300개를 모두 잡지만 비트맵은 보이는 근처만 들고, 멀어진 쪽은 버린다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.big300);
    expect(await app.total()).toBe(300);
    await expect(page.locator('[data-page]')).toHaveCount(300);
    await app.pageDrawn(0);
    expect(await liveCanvases(app)).toBeLessThanOrEqual(60);
    await app.gotoPage(200);
    await app.pageDrawn(199);
    // 처음 쪽의 비트맵은 버려진다
    await expect.poll(() => page.locator('[data-page="0"] canvas').evaluate((c: HTMLCanvasElement) => c.width)).toBe(0);
    expect(await liveCanvases(app)).toBeLessThanOrEqual(60);
  });

  test('빠른 스크롤에서도 동시 캔버스 수·진행 중 렌더 수에 상한이 있고 오류가 없다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.big300);
    await app.pageDrawn(0);
    await app.startSampler();
    await app.smoothScroll('scroller', 0, 1500, 4);
    await app.smoothScroll('scroller', 0, 8000, 5);
    await app.smoothScroll('scroller', 0, 40000, 3);
    // 멈추면 보이는 쪽이 그려진다
    const cur = Number(await app.currentPageInput().inputValue()) - 1;
    await app.pageDrawn(cur);
    const r = await app.stopSampler();
    expect(r.live).toBeLessThanOrEqual(60);
    expect(r.inFlight).toBeLessThanOrEqual(2);
    expect(r.errors).toBe(0);
    // 빨리 지나간 쪽의 요청은 취소·폐기된다
    const s = await page.evaluate(() => (globalThis as unknown as { __pdfeditStats: { canceledQueued: number; discarded: number } }).__pdfeditStats);
    expect(s.canceledQueued + s.discarded).toBeGreaterThan(0);
    test.info().annotations.push({ type: 'canvas-peak', description: `live=${r.live} inFlight=${r.inFlight}` });
  });

  test('쪽 번호로 멀리 뛰어도 그 쪽이 그려지고, 맨 끝·맨 처음도 된다', async ({ app }) => {
    await app.goto();
    await app.open(G.big300);
    for (const n of [150, 300, 1]) {
      await app.gotoPage(n);
      await app.pageDrawn(n - 1);
      await expect(app.currentPageInput()).toHaveValue(String(n));
    }
    await app.page.keyboard.press('PageDown');
    await expect(app.currentPageInput()).toHaveValue('2');
  });

  test('배율을 25%·400% 로 바꿔도 동시 캔버스 수가 늘지 않는다', async ({ app }) => {
    await app.goto();
    await app.open(G.big300);
    await app.gotoPage(100);
    await app.pageDrawn(99);
    for (const z of [0.25, 4, 1]) {
      await app.setZoom(z);
      await expect.poll(() => app.zoomValue()).toBe(z);
      await app.pageDrawn(Number(await app.currentPageInput().inputValue()) - 1);
      expect(await liveCanvases(app)).toBeLessThanOrEqual(120);
    }
    expect(await app.page.evaluate(() => (globalThis as unknown as { __pdfeditStats: { errors: number } }).__pdfeditStats.errors)).toBe(0);
  });
});
