// 확대 배율: 슬라이더(25~400%, 로그 눈금 0..1000)와 '확대 배율' 선택 상자는 같은 값을 보여 주고, 쪽 크기와 캔버스 해상도가 그 배율을 따라간다.
// 정리 모드 썸네일 크기 최대(640px)의 칸 폭·캔버스 해상도·유지도 여기서 본다.
import { test, expect, type App, type Page } from './helpers.ts';
import { GENERATED as G } from './fixtures/paths.ts';
import { sliderToZoom, zoomToSlider, ZOOM_SLIDER_MAX } from '../src/lib/zoom-scale.ts';

const K = 96 / 72; // 100% 에서 pt → css px
const PW = 300; // five.pdf 1쪽 폭(pt)

const slider = (page: Page) => page.getByRole('slider', { name: '확대 배율 슬라이더' });
const sliderValue = async (page: Page) => Number(await slider(page).inputValue());
/** 선택 상자 옵션 값들 */
const options = (app: App) => app.zoomSelect().locator('option').evaluateAll((os) => os.map((o) => Number((o as HTMLOptionElement).value)));
/** five.pdf 의 쪽 폭(pt, 회전 반영: 3쪽은 /Rotate 90 이라 420) */
const PTW = [300, 310, 420, 330, 340];
/** 화면에 가장 많이 보이는 쪽의 번호·화면 폭(css px)·캔버스 픽셀 폭(확대하면 보이는 쪽이 바뀌므로 첫 쪽 고정으로 재지 않는다) */
async function visiblePage(page: Page) {
  return page.evaluate(() => {
    const sc = (document.querySelector('[data-testid=scroller]') as HTMLElement).getBoundingClientRect();
    let best: { i: number; css: number; px: number; pxH: number; ov: number } | null = null;
    for (const s of document.querySelectorAll('[data-page]')) {
      const r = s.getBoundingClientRect();
      const ov = Math.min(r.bottom, sc.bottom) - Math.max(r.top, sc.top);
      const c = s.querySelector('canvas') as HTMLCanvasElement | null;
      if (ov > 0 && (!best || ov > best.ov)) best = { i: Number((s as HTMLElement).dataset.page), css: r.width, px: c?.width ?? 0, pxH: c?.height ?? 0, ov };
    }
    return best;
  });
}
/** 배율이 확정되어(디바운스·재렌더 끝) 보이는 쪽의 캔버스가 화면 폭을 채울 때까지 */
async function expectSharp(app: App, z: number) {
  await expect
    .poll(
      async () => {
        const v = await visiblePage(app.page);
        if (!v) return false;
        const want = PTW[v.i] * K * z;
        return Math.abs(v.css - want) <= 1.5 && v.px >= v.css - 1 && v.px <= v.css * 1.06 + 2;
      },
      { timeout: 20_000, intervals: [50, 100, 200], message: `${Math.round(z * 100)}%: 쪽 폭이 배율을 따르고 캔버스가 그 폭을 채워야 한다` },
    )
    .toBe(true);
  return (await visiblePage(app.page))!;
}
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
/** 슬라이더 조작이 확정되어 문서 배율과 선택 상자가 같아질 때까지 기다려 그 값을 돌려준다 */
async function settledZoom(app: App): Promise<number> {
  await expect.poll(async () => ((await app.summary()).docs[0].zoom === (await app.zoomValue()) ? (await app.summary()).docs[0].zoom : -1), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(() => storedZoom(app)).toBe((await app.summary()).docs[0].zoom);
  return (await app.summary()).docs[0].zoom;
}
const storedZoom = async (app: App) => (await app.settingsInStorage()).zoom as number;

test.describe('확대: 슬라이더와 선택 상자', () => {
  test('눈금 0..1000(로그), 100% 가 가운데이고, 선택 상자 값이 슬라이더를 따라간다(그 반대도)', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const s = slider(page);
    await expect(s).toHaveAttribute('min', '0');
    await expect(s).toHaveAttribute('max', String(ZOOM_SLIDER_MAX));
    await expect(s).toHaveValue('500');
    await expect(s).toHaveAttribute('aria-valuetext', '100%');
    expect(await app.zoomValue()).toBe(1);
    expect(await options(app)).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]);
    // 선택 상자 → 슬라이더
    for (const z of [0.25, 0.5, 2, 4, 1.5, 1]) {
      await app.setZoom(z);
      await expect(s).toHaveValue(String(zoomToSlider(z)));
      await expect(s).toHaveAttribute('aria-valuetext', `${Math.round(z * 100)}%`);
      await expect.poll(async () => (await app.summary()).docs[0].zoom).toBe(z);
    }
    expect([zoomToSlider(0.25), zoomToSlider(0.5), zoomToSlider(1), zoomToSlider(2), zoomToSlider(4)]).toEqual([0, 250, 500, 750, 1000]);
  });

  test('키보드: 화살표는 한 칸씩, Home 은 25%, End 는 400%이고 선택 상자·문서 배율·저장값이 함께 따라간다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const s = slider(page);
    await s.focus();
    // 화살표로 올리기: 눈금 값에서 계산한 배율과 선택 상자가 같다
    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowRight');
    await expect.poll(async () => sliderValue(page)).toBeGreaterThan(520);
    const up = await settledZoom(app);
    expect(up).toBeGreaterThan(1);
    expect(up).toBe(sliderToZoom(await sliderValue(page)));
    await expect.poll(() => app.zoomValue()).toBe(up);
    await expect.poll(async () => (await app.summary()).docs[0].zoom).toBe(up); // 멈추면 확정
    await expect.poll(() => storedZoom(app)).toBe(up);
    // 선택 상자에는 프리셋에 없는 값이 따로 끼어 있다
    expect(await options(app)).toContain(up);
    await expectSharp(app, up);
    for (let i = 0; i < 80; i++) await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => sliderValue(page)).toBeLessThan(500);
    const down = await settledZoom(app);
    expect(down).toBeLessThan(1);
    expect(down).toBe(sliderToZoom(await sliderValue(page)));
    await expect.poll(() => app.zoomValue()).toBe(down);
    await expect.poll(async () => (await app.summary()).docs[0].zoom).toBe(down);
    // Home / End
    await page.keyboard.press('Home');
    await expect(s).toHaveValue('0');
    await expect(s).toHaveAttribute('aria-valuetext', '25%');
    await expect.poll(() => app.zoomValue()).toBe(0.25);
    await expect.poll(async () => (await app.summary()).docs[0].zoom).toBe(0.25);
    await expectSharp(app, 0.25);
    await page.keyboard.press('End');
    await expect(s).toHaveValue(String(ZOOM_SLIDER_MAX));
    await expect(s).toHaveAttribute('aria-valuetext', '400%');
    await expect.poll(() => app.zoomValue()).toBe(4);
    await expect.poll(async () => (await app.summary()).docs[0].zoom).toBe(4);
    await expect.poll(() => storedZoom(app)).toBe(4);
    // 큰 단계(PageUp/PageDown)도 같은 눈금 위에서 움직인다
    await page.keyboard.press('PageDown');
    await expect.poll(async () => sliderValue(page)).toBeLessThan(ZOOM_SLIDER_MAX);
    const v = await sliderValue(page);
    await expect.poll(() => app.zoomValue()).toBe(sliderToZoom(v));
  });

  test('쪽 캔버스: 화면 크기가 배율을 따르고 캔버스 픽셀 폭도 따라가 흐려지지 않는다(25%~400%)', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const seen: number[] = [];
    for (const z of [1, 0.5, 2, 4, 0.25, 1.25]) {
      await app.setZoom(z);
      const w = await expectSharp(app, z);
      expect(w.pxH / w.px, '가로세로 비').toBeCloseTo(w.i === 2 ? 320 / 420 : [400 / 300, 410 / 310, 0, 430 / 330, 440 / 340][w.i], 1);
      seen.push(w.px / (PTW[w.i] * K)); // 캔버스 픽셀이 쪽 폭(pt·96/72)의 몇 배인가 = 배율
    }
    // 보이는 쪽이 달라도 캔버스 픽셀 폭은 배율에 비례한다
    [1, 0.5, 2, 4, 0.25, 1.25].forEach((z, k) => expect(seen[k]).toBeCloseTo(z, 1));
    // 슬라이더로 바꿔도 같다
    await slider(page).focus();
    await page.keyboard.press('End');
    await expectSharp(app, 4);
    await page.keyboard.press('Home');
    await expectSharp(app, 0.25);
    // 올릴 때만 다시 그린다: 줄이기는 같은 비트맵 재사용이 아니라 새 배율로 그려도 폭은 맞는다
    const calls = await app.renderCalls();
    await app.setZoom(2);
    await expectSharp(app, 2);
    expect(await app.renderCalls()).toBeGreaterThan(calls);
  });

  test('+ · - 키는 프리셋을 한 단계씩 오가며 25%·400% 를 넘지 않는다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    await blur(page);
    await page.keyboard.press('+');
    await expect.poll(() => app.zoomValue()).toBe(1.25);
    await page.keyboard.press('=');
    await expect.poll(() => app.zoomValue()).toBe(1.5);
    for (let i = 0; i < 8; i++) await page.keyboard.press('+');
    await expect.poll(() => app.zoomValue()).toBe(4);
    await page.keyboard.press('+');
    await expect(slider(page)).toHaveValue(String(ZOOM_SLIDER_MAX));
    expect(await app.zoomValue()).toBe(4);
    for (let i = 0; i < 12; i++) await page.keyboard.press('-');
    await expect.poll(() => app.zoomValue()).toBe(0.25);
    await page.keyboard.press('-');
    await expect(slider(page)).toHaveValue('0');
    expect(await app.zoomValue()).toBe(0.25);
    await expect.poll(() => storedZoom(app)).toBe(0.25);
  });
});

test.describe('확대: 한계값과 유지', () => {
  test('슬라이더·키는 25%~400% 밖으로 나가지 않는다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const s = slider(page);
    await s.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('PageUp');
    await expect(s).toHaveValue(String(ZOOM_SLIDER_MAX));
    await expect.poll(() => app.zoomValue()).toBe(4);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('PageDown');
    await expect(s).toHaveValue('0');
    await expect.poll(() => app.zoomValue()).toBe(0.25);
    await expect.poll(async () => (await app.summary()).docs[0].zoom).toBe(0.25);
  });

  test('저장된 배율은 새로고침 뒤 새로 연 파일의 시작 배율이 되고, 범위를 벗어난 저장값은 한계로 고정된다', async ({ app, page, mkApp }) => {
    await app.goto();
    await app.open(G.five);
    await app.setZoom(1.5);
    await expect.poll(() => storedZoom(app)).toBe(1.5);
    await page.reload();
    await page.locator('[data-testid=file-input]').waitFor({ state: 'attached' });
    await app.open(G.five);
    expect(await app.zoomValue()).toBe(1.5);
    await expect(slider(page)).toHaveValue(String(zoomToSlider(1.5)));
    await expectSharp(app, 1.5);
    // 슬라이더로 정한 프리셋 밖의 값도 유지된다
    await slider(page).focus();
    for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft');
    const z = await settledZoom(app);
    expect(z).toBeLessThan(1.5);
    await expect.poll(() => storedZoom(app)).toBe(z);
    await page.reload();
    await page.locator('[data-testid=file-input]').waitFor({ state: 'attached' });
    await app.open(G.five);
    expect(await app.zoomValue()).toBe(z);
    await expectSharp(app, z);

    // 저장값이 범위 밖이면(손으로 고친 저장소) 한계로 고정된다
    const hi = await mkApp();
    await hi.goto({ zoom: 9 });
    await hi.open(G.five);
    expect(await hi.zoomValue()).toBe(4);
    await expectSharp(hi, 4);
    const lo = await mkApp();
    await lo.goto({ zoom: 0.01 });
    await lo.open(G.five);
    expect(await lo.zoomValue()).toBe(0.25);
    await expectSharp(lo, 0.25);
  });

  test('배율은 문서마다 따로 보관된다', async ({ app }) => {
    await app.goto();
    await app.open([G.docA, G.docB]);
    await app.switchTab('docA.pdf');
    await app.setZoom(2);
    await app.switchTab('docB.pdf');
    await app.setZoom(0.5);
    await app.switchTab('docA.pdf');
    await expect.poll(() => app.zoomValue()).toBe(2);
    await app.switchTab('docB.pdf');
    await expect.poll(() => app.zoomValue()).toBe(0.5);
  });
});

test.describe('정리 모드 썸네일 640px(최대)', () => {
  test('칸 폭과 캔버스 해상도(흐리지 않음), Ctrl+휠, 새로고침 뒤 유지', async ({ app, page }) => {
    await app.goto();
    await app.open(G.docA);
    await app.setMode('organize');
    await app.cellDrawn(0);
    const sl = page.getByRole('slider', { name: '썸네일 크기' });
    await expect(sl).toHaveAttribute('max', '640');
    await sl.fill('640');
    await expect.poll(async () => (await app.gridState()).size).toBe(640);
    await app.renderQuiet();
    const gs = await app.gridState();
    expect(gs.sw, '가로 넘침 없음').toBeLessThanOrEqual(gs.cw);
    // 칸마다 화면에 가져와 그림이 칸 안 썸네일 폭을 채우는 해상도인지 본다(CSS 로 늘려 흐려지지 않음)
    const measure = (i: number) =>
      page.evaluate((idx) => {
        const c = document.querySelector(`[data-cell="${idx}"]`) as HTMLElement;
        const cv = c.querySelector('canvas') as HTMLCanvasElement;
        return { cellW: c.getBoundingClientRect().width, cssW: cv.getBoundingClientRect().width, px: cv.width };
      }, i);
    for (let i = 0; i < 5; i++) {
      await app.scrollCell(i);
      await app.cellDrawn(i);
      await expect.poll(async () => { const m = await measure(i); return m.px >= Math.floor(m.cssW) - 2; }, { message: `칸 ${i} 캔버스가 화면 폭을 채워야 한다`, timeout: 20_000 }).toBe(true);
      const m = await measure(i);
      expect(m.cellW, `칸 ${i} 폭`).toBeGreaterThanOrEqual(600);
      expect(m.cellW, `칸 ${i} 폭`).toBeLessThanOrEqual(660);
      expect(m.cssW, `칸 ${i} 썸네일 폭`).toBeGreaterThanOrEqual(500);
    }
    await app.renderQuiet();
    // 렌더 기록: 마지막 요청들이 표시 폭을 채우는 배율이다
    const log = await page.evaluate(() => (globalThis as unknown as { __pdfeditStats: { log: [number, number][] } }).__pdfeditStats.log.slice(-5));
    const pw = [300, 310, 320, 330, 340];
    expect(log.length).toBeGreaterThan(0);
    for (const [p, sc] of log) expect(sc * pw[p], `${p + 1}쪽 렌더 배율 ${sc}`).toBeGreaterThanOrEqual(500);

    // Ctrl+휠: 위로 올리면 커지고 아래로 내리면 작아진다(최대에서는 더 커지지 않는다)
    const grid = page.getByTestId('grid');
    await grid.hover();
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 100);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await app.gridState()).size).toBeLessThan(640);
    const smaller = (await app.gridState()).size;
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.mouse.wheel(0, -100);
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await app.gridState()).size).toBe(640);
    expect(smaller).toBeLessThan(640);
    // 슬라이더 키보드: End 는 최대
    await sl.focus();
    await page.keyboard.press('Home');
    await expect.poll(async () => (await app.gridState()).size).toBe(80);
    await page.keyboard.press('End');
    await expect.poll(async () => (await app.gridState()).size).toBe(640);

    // 새로고침 뒤 유지
    await expect.poll(() => app.settingsInStorage()).toMatchObject({ gridThumb: 640 });
    await page.reload();
    await page.locator('[data-testid=file-input]').waitFor({ state: 'attached' });
    await app.open(G.docA);
    await app.setMode('organize');
    await expect.poll(async () => (await app.gridState()).size).toBe(640);
    await expect(page.getByRole('slider', { name: '썸네일 크기' })).toHaveValue('640');
    await app.cellDrawn(0);
  });
});

test.describe('확대: Ctrl+휠·핀치', () => {
  test('뷰어에서 Ctrl+휠로 배율이 바뀌고 슬라이더·선택 상자·문서 배율이 따라가며, 25~400% 를 넘지 않는다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const box = (await page.getByTestId('scroller').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100); // 위로 = 확대
    await page.keyboard.up('Control');
    const up = await settledZoom(app);
    expect(up).toBeGreaterThan(1);
    expect(up).toBeLessThanOrEqual(4);
    await expect(slider(page)).toHaveValue(String(zoomToSlider(up)));
    await expect.poll(() => app.zoomValue()).toBe(up);
    await expectSharp(app, up);
    // 아래로 많이 돌리면 25% 에서 멈춘다
    await page.keyboard.down('Control');
    for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 100);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await app.summary()).docs[0].zoom, { timeout: 15_000 }).toBe(0.25);
    await expect(slider(page)).toHaveValue('0');
    // 위로 많이 돌리면 400% 에서 멈춘다
    await page.keyboard.down('Control');
    for (let i = 0; i < 80; i++) await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await app.summary()).docs[0].zoom, { timeout: 15_000 }).toBe(4);
    await expect(slider(page)).toHaveValue(String(ZOOM_SLIDER_MAX));
  });

  test('Ctrl 없는 휠은 스크롤만 하고 배율은 그대로이며, 확대해도 포인터 아래 쪽 지점이 화면에 남는다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    await app.setZoom(2);
    await expectSharp(app, 2);
    const box = (await page.getByTestId('scroller').boundingBox())!;
    const px = box.x + box.width / 2;
    const py = box.y + 200;
    await page.mouse.move(px, py);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => page.getByTestId('scroller').evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
    expect((await app.summary()).docs[0].zoom).toBe(2);
    // 포인터 아래의 쪽과 그 안의 상대 위치(세로)를 기억한다
    const probe = () =>
      page.evaluate(([x, y]) => {
        const el = document.elementsFromPoint(x, y).find((e) => (e as HTMLElement).dataset?.page != null) as HTMLElement | undefined;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { page: Number(el.dataset.page), fy: (y - r.top) / r.height };
      }, [px, py]);
    const before = await probe();
    expect(before).not.toBeNull();
    await page.keyboard.down('Control');
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    const z = await settledZoom(app);
    expect(z).toBeGreaterThan(2);
    await expectSharp(app, z);
    const after = await probe();
    expect(after?.page).toBe(before!.page);
    expect(Math.abs(after!.fy - before!.fy)).toBeLessThan(0.03);
  });
});
