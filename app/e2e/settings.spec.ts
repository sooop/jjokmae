import { test, expect, type App } from './helpers.ts';
import { GENERATED as G } from './fixtures/paths.ts';

const sidePanel = (app: App) => app.page.getByRole('complementary', { name: '페이지 목록' });
const sideWidth = async (app: App) => Math.round((await sidePanel(app).boundingBox())!.width);

test.describe('설정: 저장과 복원', () => {
  test('테마·엔진·배율·썸네일 크기를 바꾸면 설정에 저장되고 새로고침 뒤에도 복원된다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const drawer = await app.openSettings();
    await expect(drawer.getByText('열려 있는 문서는 그대로이고')).toBeVisible();
    await drawer.getByLabel('테마').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await drawer.getByLabel('엔진').selectOption('pdfium');
    await drawer.getByLabel('확대 배율').selectOption('1.5');
    await drawer.getByRole('slider', { name: /정리 모드 썸네일 크기/ }).fill('200');
    await drawer.getByRole('slider', { name: /보기 모드 썸네일 패널 폭/ }).fill('240');
    await expect.poll(() => app.settingsInStorage()).toMatchObject({ theme: 'dark', engine: 'pdfium', zoom: 1.5, gridThumb: 200, sideWidth: 240 });
    await app.closeSettings();
    // 열려 있는 문서는 원래 엔진을 유지한다
    expect((await app.summary()).docs[0].kind).toBe('mupdf');
    expect(await sideWidth(app)).toBe(240);
    // 새로고침 → 복원
    await page.reload();
    await page.locator('[data-testid=file-input]').waitFor({ state: 'attached' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await app.open(G.five);
    expect((await app.summary()).docs[0].kind).toBe('pdfium'); // 새로 여는 파일부터 새 엔진
    expect(await app.zoomValue()).toBe(1.5);
    expect(await sideWidth(app)).toBe(240);
    const d2 = await app.openSettings();
    await expect(d2.getByLabel('테마')).toHaveValue('dark');
    await expect(d2.getByLabel('엔진')).toHaveValue('pdfium');
    await expect(d2.getByRole('slider', { name: /정리 모드 썸네일 크기/ })).toHaveValue('200');
  });

  test('서랍은 설정 단추·닫기 단추·Esc 로 열고 닫으며, 단축키 목록을 보여 준다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const drawer = await app.openSettings();
    await expect(app.topButton('설정')).toHaveAttribute('aria-pressed', 'true');
    // 단축키 목록(G 는 모드 전환)
    expect(await drawer.locator('dt').evaluateAll((dts) => dts.some((dt) => (dt as HTMLElement).innerText.trim() === 'G' && (dt.nextElementSibling as HTMLElement).innerText.includes('모드')))).toBe(true);
    await app.closeSettings();
    await app.openSettings();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '설정' })).toHaveCount(0);
    // 설정 단추를 다시 눌러도 닫힌다
    await app.topButton('설정').click();
    await expect(page.getByRole('dialog', { name: '설정' })).toBeVisible();
    await app.topButton('설정').click();
    await expect(page.getByRole('dialog', { name: '설정' })).toHaveCount(0);
  });

  test('손상됐거나 범위를 벗어난 저장값은 기본값·허용 범위로 보정된다', async ({ app, page }) => {
    await page.addInitScript(() => localStorage.setItem('pdf-edit:settings', '{not json'));
    await app.goto();
    await app.open(G.five);
    expect(await app.zoomValue()).toBe(1);
    expect(await sideWidth(app)).toBe(208);
  });

  test('범위를 벗어난 값은 허용 범위로 맞춘다', async ({ app }) => {
    await app.goto({ zoom: 99, gridThumb: 5, sideWidth: 9999, theme: 'nonsense', engine: 'nonsense', mode: 'nonsense' });
    await app.open(G.five);
    expect(await app.zoomValue()).toBe(4);
    expect(await sideWidth(app)).toBe(280);
    const s = await app.summary();
    expect(s.mode).toBe('view');
    expect(s.docs[0].kind).toBe('mupdf');
  });

  test('컨텍스트마다 저장소가 분리되어 한 테스트의 설정이 다른 곳으로 새지 않는다', async ({ app, mkApp }) => {
    await app.goto();
    await app.open(G.five);
    await app.setEngine('pdfium');
    await app.page.locator('html').evaluate(() => 0);
    await expect.poll(async () => (await app.settingsInStorage()).engine).toBe('pdfium');
    const other = await mkApp();
    await other.goto();
    expect(await other.settingsInStorage()).toEqual({});
    await other.open(G.five);
    expect((await other.summary()).docs[0].kind).toBe('mupdf');
  });
});

test.describe('설정: 테마', () => {
  test('시스템 설정은 OS 의 라이트·다크를 따르고, 라이트·다크를 고르면 OS 설정을 무시한다', async ({ app, page }) => {
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: 'light' });
    await app.goto();
    await app.open(G.five);
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    const light = await bg();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(bg).not.toBe(light); // 시스템 → 다크
    const dark = await bg();
    const drawer = await app.openSettings();
    await drawer.getByLabel('테마').selectOption('light');
    await expect.poll(bg).toBe(light); // OS 가 다크여도 라이트 고정
    await drawer.getByLabel('테마').selectOption('dark');
    await expect.poll(bg).toBe(dark);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(bg).toBe(dark); // OS 가 라이트여도 다크 고정
    await drawer.getByLabel('테마').selectOption('system');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    await expect.poll(bg).toBe(light);
  });
});

test.describe('설정: 보기 모드 썸네일 패널 폭', () => {
  test('분할선: 속성·끌기·상한/하한·키보드·더블클릭·서랍 슬라이더·설정 저장', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const sep = page.getByRole('separator', { name: '썸네일 패널 폭 조절' });
    expect(await sideWidth(app)).toBe(208);
    expect(await sep.evaluate((s) => [s.getAttribute('aria-orientation'), s.getAttribute('aria-valuenow'), s.getAttribute('aria-valuemin'), s.getAttribute('aria-valuemax'), (s as HTMLElement).tabIndex])).toEqual(['vertical', '208', '100', '280', 0]);
    const f0 = (await app.thumbFace(0).boundingBox())!.width;
    // 끌어서 +50
    const c = await app.center(sep);
    await app.dragMouse(c, { x: c.x + 50, y: c.y }, { steps: 10 });
    await expect.poll(() => sideWidth(app)).toBeGreaterThanOrEqual(256);
    expect(await sideWidth(app)).toBeLessThanOrEqual(260);
    expect((await app.thumbFace(0).boundingBox())!.width).toBeGreaterThan(f0 + 30); // 썸네일이 폭에 맞춰 커짐
    // 상한·하한
    let p = await app.center(sep);
    await app.dragMouse(p, { x: 900, y: p.y }, { steps: 6 });
    await expect.poll(() => sideWidth(app)).toBe(280);
    p = await app.center(sep);
    await app.dragMouse(p, { x: 2, y: p.y }, { steps: 6 });
    await expect.poll(() => sideWidth(app)).toBe(100);
    // 100px 에서도 썸네일·도구 줄이 패널을 넘지 않는다
    const lay = await sidePanel(app).evaluate((s) => {
      const r = s.getBoundingClientRect();
      const bad = [...s.querySelectorAll('[data-thumb] button, [role=toolbar] button')].filter((e) => {
        const q = e.getBoundingClientRect();
        return q.width > 0 && (q.right > r.right + 1 || q.left < r.left - 1);
      }).length;
      const t = s.querySelector('[data-testid=thumbs]') as HTMLElement;
      return { bad, noXScroll: t.scrollWidth <= t.clientWidth };
    });
    expect(lay).toEqual({ bad: 0, noXScroll: true });
    // 키보드
    await sep.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => sideWidth(app)).toBe(108);
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => sideWidth(app)).toBe(140);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => sideWidth(app)).toBe(132);
    await page.keyboard.press('End');
    await expect.poll(() => sideWidth(app)).toBe(280);
    await page.keyboard.press('Home');
    await expect.poll(() => sideWidth(app)).toBe(100);
    await expect(sep).toHaveAttribute('aria-valuenow', '100');
    await expect.poll(async () => (await app.settingsInStorage()).sideWidth).toBe(100);
    // 줄일 때는 다시 그리지 않는다(280 → 120)
    await page.keyboard.press('End');
    await expect.poll(() => sideWidth(app)).toBe(280);
    const c0 = await app.renderQuiet();
    for (let k = 0; k < 10; k++) await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(() => sideWidth(app)).toBeLessThan(280);
    expect(await app.renderQuiet()).toBe(c0);
    // 더블클릭 → 기본 폭
    const c2 = await app.center(sep);
    await page.mouse.dblclick(c2.x, c2.y + 100);
    await expect.poll(() => sideWidth(app)).toBe(208);
    // 서랍 슬라이더
    const drawer = await app.openSettings();
    await drawer.getByRole('slider', { name: /보기 모드 썸네일 패널 폭/ }).fill('240');
    await expect.poll(() => sideWidth(app)).toBe(240);
  });
});
