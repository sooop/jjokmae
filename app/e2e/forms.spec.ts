import { test, expect, qpdfCheck, reloadPdf, renderPdf, colorBBox, type App } from './helpers.ts';
import { GENERATED as G, SAMPLES } from './fixtures/paths.ts';

test.use({ viewport: { width: 1400, height: 1000 } });

const PW = 595.304;
const K = 96 / 72;
const field = (app: App, name: string, nth = 0) => app.page.locator(`[data-field-name="${name}"]`).nth(nth);
const chip = (app: App) => app.page.locator('[data-testid=annot-chip], .form-chip').first();
const fieldValues = async (bytes: Uint8Array) => {
  const r = await reloadPdf(bytes);
  const f = await r.fields();
  await r.close();
  return f;
};
/** 입력 칸에 포커스를 주고 글자를 넣는다(실제 입력과 같은 경로) */
async function typeInto(app: App, loc: ReturnType<typeof field>, text: string) {
  await loc.focus();
  await app.page.keyboard.insertText(text);
}

test.describe('양식: 텍스트(한글 값)', () => {
  test('칸을 눌러 입력하면 입력 중에는 불투명, 확정되면 엔진이 값을 그리고, Tab 으로 다음 칸에 가며, 저장본에 한글 값이 들어간다', async ({ app, page }) => {
    await app.goto();
    await app.open(SAMPLES.formKo);
    await expect(chip(app)).toHaveText('양식 2');
    expect(await page.locator('[data-form-input]').evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.fieldName}:${(e as HTMLElement).dataset.fieldKind}`))).toEqual(['name:text', 'memo:text']);
    // 평소에는 HTML 입력이 투명해 엔진이 그린 위젯만 보인다(이중 표시 없음)
    const name = field(app, 'name');
    await expect(name).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
    await expect(name).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await name.click();
    await expect(name).toBeFocused();
    await expect(name).toHaveCSS('background-color', 'rgb(255, 255, 255)'); // 입력 중에는 불투명
    await page.keyboard.insertText('홍길동 Hong');
    await page.keyboard.press('Tab');
    await expect(field(app, 'memo')).toBeFocused(); // Tab → 다음 칸
    await page.keyboard.insertText('여러 줄 메모 한글 입력');
    await app.change(() => page.keyboard.press('Tab'));
    // 확정 뒤 HTML 은 투명으로 돌아가고, 엔진이 값을 화면 캔버스에 그린다
    await expect(name).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const win: [number, number, number, number] = [(120 * 96) / 72, (92 * 96) / 72, (420 * 96) / 72, (117 * 96) / 72];
    await expect.poll(async () => (await app.canvasBBox(0, 'dark', win))?.n ?? 0, { timeout: 15_000 }).toBeGreaterThan(30);
    const { file } = await app.saveAndInspect();
    const f = await fieldValues(file.bytes);
    expect(f.find((x) => x.name === 'name')?.value).toBe('홍길동 Hong');
    expect(f.find((x) => x.name === 'memo')?.value).toBe('여러 줄 메모 한글 입력');
    const d = colorBBox(await renderPdf(file.bytes, 0, K), 'dark', win);
    expect(d && d.n > 30, JSON.stringify(d)).toBe(true);
  });
});

test.describe('양식: 체크·라디오·콤보·목록·읽기 전용', () => {
  test('모든 종류를 채워 저장하면 값이 재로드에서 같고, 되돌리기는 마지막 입력만 되돌린다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.formAll);
    await expect(chip(app)).toHaveText('양식 6');
    await expect(field(app, 'readonly')).toBeDisabled();
    const win: [number, number, number, number] = [100 * K + 4, (842 - 670) * K + 4, 120 * K - 4, (842 - 650) * K - 4];
    // 체크박스 → 엔진이 체크 표시를 그린다
    await app.change(() => field(app, 'agree').click());
    await expect.poll(async () => (await app.canvasBBox(0, 'dark', win))?.n ?? 0, { timeout: 15_000 }).toBeGreaterThan(30);
    // 라디오 color: 두 번째(blue)
    await app.change(() => field(app, 'color', 1).click());
    // 콤보 city → Busan, 목록 langs → en
    await app.change(() => field(app, 'city').selectOption('Busan'));
    await app.change(() => field(app, 'langs').selectOption('en'));
    // 텍스트 name
    await field(app, 'name').focus();
    await page.keyboard.insertText('Alice');
    await app.change(() => field(app, 'name').blur());
    const { file } = await app.saveAndInspect();
    const f = await fieldValues(file.bytes);
    const byName = (n: string) => f.filter((x) => x.name === n);
    expect(byName('agree')[0]?.value).toBe(true);
    expect(byName('color').map((x) => x.value)).toEqual([false, true]);
    expect(byName('city')[0]?.value).toBe('Busan');
    expect(byName('langs')[0]?.value).toBe('en');
    expect(byName('name')[0]?.value).toBe('Alice');
    expect(byName('readonly')[0]?.value).toBe('fixed');
    // 되돌리기: 마지막 입력(name)만 사라진다
    await app.undo();
    const f2 = await fieldValues((await app.save()).bytes);
    expect([f2.find((x) => x.name === 'name')?.value, f2.find((x) => x.name === 'city')?.value]).toEqual(['', 'Busan']);
  });

  test('입력 중 Ctrl+S, 입력 중 저장 단추 클릭에도 방금 친 값이 저장본에 들어간다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.formAll);
    await expect(chip(app)).toHaveText('양식 6');
    await typeInto(app, field(app, 'name'), 'Zed');
    const a = await app.save('ctrlS'); // 입력 칸에 포커스가 있는 채로
    expect((await fieldValues(a.bytes)).find((x) => x.name === 'name')?.value).toBe('Zed');
    await app.idle();
    await field(app, 'name').focus();
    await field(app, 'name').selectText();
    await page.keyboard.insertText('Yan');
    const b = await app.download(() => page.getByTestId('save').click()); // 실제 마우스로 저장 단추
    expect((await fieldValues(b.bytes)).find((x) => x.name === 'name')?.value).toBe('Yan');
  });

  test('「다음 양식 칸으로 이동」 단추가 다음 칸에 포커스를 준다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.formAll);
    await expect(chip(app)).toHaveText('양식 6');
    await page.getByRole('button', { name: '다음 양식 칸으로 이동' }).click();
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.formInput !== undefined)).toBe(true);
  });
});

test.describe('양식: 서명 필드', () => {
  test('서명 필드는 입력칸이 아닌 표식이고 양식 칸 수에 세지 않는다', async ({ app, page }) => {
    await app.goto();
    await app.open(SAMPLES.signed);
    await expect(page.locator('[data-form-signature]')).toHaveCount(1);
    await expect(page.locator('[data-field-name="Sig1"]')).toHaveCount(0);
    await expect(chip(app)).toHaveText('양식 2');
    const title = await page.locator('[data-form-signature]').getAttribute('title');
    expect(title).toContain('전자서명');
    expect(title).toContain('서명 이미지');
  });
});

test.describe('양식: 터치 기기', () => {
  test.use({ hasTouch: true });
  test('거친 포인터에서는 입력 글꼴이 16px 이상이다(모바일 확대 방지)', async ({ app, page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    await app.goto();
    await app.open(G.formAll);
    await expect(chip(app)).toHaveText('양식 6');
    const r = await page.evaluate(() => ({
      coarse: matchMedia('(pointer: coarse)').matches,
      fs: [...document.querySelectorAll('[data-form-input]:not([type=checkbox]):not([type=radio])')].map((e) => parseFloat(getComputedStyle(e).fontSize)),
    }));
    test.skip(!r.coarse, '이 환경에서 pointer: coarse 에뮬레이션이 되지 않아 검증하지 못함');
    expect(r.fs.every((x) => x >= 16), JSON.stringify(r)).toBe(true);
  });
});

test.describe('양식: PDFium 엔진', () => {
  test('텍스트·체크·콤보를 채워 저장하면 값이 들어간다', async ({ app, page }) => {
    await app.goto({ engine: 'pdfium' });
    await app.open(G.formAll);
    expect((await app.summary()).docs[0].kind).toBe('pdfium');
    await expect(chip(app)).toHaveText('양식 6');
    await field(app, 'name').focus();
    await page.keyboard.insertText('Alice');
    await app.change(() => field(app, 'name').blur());
    await app.change(() => field(app, 'agree').click());
    await app.change(() => field(app, 'city').selectOption('Busan'));
    const { file } = await app.saveAndInspect();
    const f = await fieldValues(file.bytes);
    const v = (n: string) => f.find((x) => x.name === n)?.value;
    expect([v('name'), v('agree'), v('city')]).toEqual(['Alice', true, 'Busan']);
  });
});

void qpdfCheck;
