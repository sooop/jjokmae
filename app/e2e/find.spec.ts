// 문서 안에서 찾기: Ctrl+F 로 열고, 일치 개수·표시·이동·대소문자 구분·닫기를 확인한다.
import { test, expect, type App } from './helpers.ts';
import { GENERATED as G, SAMPLES } from './fixtures/paths.ts';

const bar = (app: App) => app.page.getByTestId('find-bar');
const input = (app: App) => app.page.getByTestId('find-input');
const status = (app: App) => app.page.getByTestId('find-status');
const marks = (app: App, pageIndex: number) => app.page.locator(`[data-page="${pageIndex}"] [data-find-hit]`);
const activeMark = (app: App, pageIndex: number) => app.page.locator(`[data-page="${pageIndex}"] [data-find-hit].on`);

async function openFind(app: App, file: string) {
  await app.goto();
  await app.open(file);
  await app.firstPageDrawn();
  await app.page.keyboard.press('Control+f');
  await expect(bar(app)).toBeVisible();
  await expect(input(app)).toBeFocused();
}

test.describe('문서에서 찾기', () => {
  test('Ctrl+F 로 열고 찾으면 개수가 나오고, 일치한 곳이 글자 위에 칠해지며 현재 항목이 표시된다', async ({ app, page }) => {
    await openFind(app, G.p24);
    await input(app).fill('P-1');
    // P-1, P-10 … P-19: 11곳
    await expect(status(app)).toHaveText('1 / 11');
    await expect(marks(app, 0)).toHaveCount(1);
    await expect(activeMark(app, 0)).toHaveCount(1);
    // 표시는 쪽 캔버스의 글자(어두운 픽셀) 위에 놓인다
    const m = (await marks(app, 0).first().boundingBox())!;
    const dark = await page.evaluate(
      ({ x, y, w, h }) => {
        const c = document.querySelector('[data-page="0"] canvas') as HTMLCanvasElement;
        const r = c.getBoundingClientRect();
        const k = c.width / r.width;
        const d = c.getContext('2d')!.getImageData(Math.round((x - r.left) * k), Math.round((y - r.top) * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 110 && d[i + 1] < 110 && d[i + 2] < 110) n++;
        return n;
      },
      { x: m.x, y: m.y, w: m.width, h: m.height },
    );
    expect(dark).toBeGreaterThan(20);
    // 표시가 낱말 폭에 맞다(줄 전체를 칠하지 않는다)
    expect(m.width).toBeLessThan(200);
  });

  test('Enter·Shift+Enter·F3·단추로 다음·이전 항목으로 가고 그 쪽으로 스크롤하며, 끝에서는 처음으로 돌아간다', async ({ app, page }) => {
    await openFind(app, G.p24);
    await input(app).fill('P-1');
    await expect(status(app)).toHaveText('1 / 11');
    await page.keyboard.press('Enter');
    await expect(status(app)).toHaveText('2 / 11');
    await expect(app.currentPageInput()).toHaveValue('10'); // P-10 은 10쪽
    await expect(activeMark(app, 9)).toHaveCount(1);
    await expect(activeMark(app, 9)).toBeInViewport();
    await page.keyboard.press('Shift+Enter');
    await expect(status(app)).toHaveText('1 / 11');
    await expect(app.currentPageInput()).toHaveValue('1');
    await page.keyboard.press('Shift+Enter'); // 처음에서 이전 → 마지막
    await expect(status(app)).toHaveText('11 / 11');
    await expect(app.currentPageInput()).toHaveValue('19');
    await page.getByRole('button', { name: '다음 (Enter)' }).click(); // 마지막에서 다음 → 처음
    await expect(status(app)).toHaveText('1 / 11');
    await page.keyboard.press('F3');
    await expect(status(app)).toHaveText('2 / 11');
  });

  test('보던 쪽에서 가까운 뒤쪽 결과가 현재 항목이 된다', async ({ app }) => {
    await app.goto();
    await app.open(G.p24);
    await app.firstPageDrawn();
    await app.gotoPage(12);
    await app.page.keyboard.press('Control+f');
    await input(app).fill('P-1');
    // 12쪽부터 찾으므로 P-12 가 현재 항목(전체 11곳 가운데 4번째: P-1, P-10, P-11, P-12)
    await expect(status(app)).toHaveText('4 / 11');
    await expect(app.currentPageInput()).toHaveValue('12');
  });

  test('대소문자 구분을 켜면 다른 대소문자는 빠지고, 없는 말은 없음으로 알린다. 닫으면 표시가 사라진다', async ({ app, page }) => {
    await openFind(app, G.p24);
    await input(app).fill('p-2');
    await expect(status(app)).toHaveText('1 / 6'); // P-2, P-20 … P-24
    await page.getByRole('button', { name: '대소문자 구분' }).click();
    await expect(status(app)).toHaveText('없음');
    await expect(page.locator('[data-find-hit]')).toHaveCount(0);
    await input(app).fill('P-2');
    await expect(status(app)).toHaveText('1 / 6');
    await input(app).fill('이런말은없다');
    await expect(status(app)).toHaveText('없음');
    await input(app).fill('P-2');
    await expect(marks(app, 1)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(bar(app)).toHaveCount(0);
    await expect(page.locator('[data-find-hit]')).toHaveCount(0);
    // 다시 열면 같은 말이 남아 있어 바로 다시 찾는다
    await page.keyboard.press('Control+f');
    await expect(input(app)).toHaveValue('P-2');
    await expect(status(app)).toHaveText('1 / 6');
  });

  for (const engine of ['mupdf', 'pdfium'] as const) {
    test(`한글 문서에서 본문의 낱말을 찾는다(${engine})`, async ({ app }) => {
      await app.goto({ engine });
      await app.open(SAMPLES.koEmbedded);
      await app.firstPageDrawn();
      const word = await app.page.evaluate(async () => {
        type Ws = { active: { id: string }; clientOf: (d: unknown) => { pageText: (id: string, i: number) => Promise<string> } };
        const ws = (globalThis as unknown as { __pdfeditWs: Ws }).__pdfeditWs;
        const t = await ws.clientOf(ws.active).pageText(ws.active.id, 0);
        return t.split(/\s+/).find((w) => /^[가-힣]{2,}$/.test(w)) ?? '';
      });
      expect(word.length).toBeGreaterThan(1);
      await app.page.keyboard.press('Control+f');
      await input(app).fill(word);
      await expect(status(app)).toHaveText(/^1 \/ \d+$/);
      await expect(marks(app, 0).first()).toBeVisible();
    });
  }

  test('정리 모드에서 Ctrl+F 를 누르면 보기 모드로 가서 찾기 줄이 열리고, 정리 모드로 돌아가면 닫힌다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.docA);
    await app.setMode('organize');
    await page.keyboard.press('Control+f');
    await expect(bar(app)).toBeVisible();
    expect((await app.summary()).mode).toBe('view');
    await input(app).fill('A-3');
    await expect(status(app)).toHaveText('1 / 1');
    await app.setMode('organize');
    await expect(bar(app)).toHaveCount(0);
  });

  test('쪽을 지우면 결과가 새 자리로 따라간다', async ({ app, page }) => {
    await openFind(app, G.docA);
    await input(app).fill('A-5');
    await expect(status(app)).toHaveText('1 / 1');
    await expect(marks(app, 4)).toHaveCount(1);
    await app.change(() => app.thumbAction(0, 'delete'));
    await expect(status(app)).toHaveText('1 / 1');
    await expect(marks(app, 3)).toHaveCount(1);
    await expect(page.locator('[data-page="4"]')).toHaveCount(0);
  });
});
