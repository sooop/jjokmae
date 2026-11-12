import { test, expect, readBytes } from './helpers.ts';
import { GENERATED as G, SAMPLES } from './fixtures/paths.ts';

test.describe('열기', () => {
  test('빈 상태: 파일 열기 단추만 있고 문서 도구는 없다', async ({ app, page }) => {
    await app.goto();
    await expect(page.getByRole('button', { name: '파일 열기' })).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(app.topButton(/^정리 모드/)).toHaveCount(0);
    await expect(app.topButton('설정')).toBeVisible();
    await expect(page.getByTestId('save')).toHaveCount(0);
    expect((await app.summary()).docs).toEqual([]);
  });

  test('파일 열기: 탭·쪽 수·본문 렌더', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    expect(await app.tabNames()).toEqual(['five.pdf']);
    expect(await app.total()).toBe(5);
    await expect(page.getByText('/ 5')).toBeVisible();
    await expect(app.currentPageInput()).toHaveValue('1');
    await expect(page.getByRole('list', { name: '페이지 썸네일' }).getByRole('listitem')).toHaveCount(5);
    // 아직 변경이 없으므로 변경됨 표시가 없고 되돌리기는 꺼져 있다
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    await expect(app.topButton(/^되돌리기/)).toBeDisabled();
  });

  test('드롭으로 열기', async ({ app }) => {
    await app.goto();
    await app.drop([{ name: 'dropped.pdf', mime: 'application/pdf', bytes: readBytes(G.five) }]);
    expect(await app.tabNames()).toEqual(['dropped.pdf']);
    expect(await app.total()).toBe(5);
  });

  test('드롭: 확장자가 .pdf 이면 형식이 비어 있어도 시도한다', async ({ app }) => {
    await app.goto();
    await app.drop([{ name: 'notype.PDF', mime: '', bytes: readBytes(G.five) }]);
    expect(await app.tabNames()).toEqual(['notype.PDF']);
  });

  test('PDF 가 아닌 파일만 놓으면 열지 않고 안내한다', async ({ app, page }) => {
    await app.goto();
    await app.drop([{ name: 'note.txt', mime: 'text/plain', bytes: readBytes(G.note) }], { expectError: true });
    const card = page.locator('[data-phase=error]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('PDF 파일만 열 수 있습니다');
    expect((await app.summary()).docs).toEqual([]);
  });

  test('손상된 PDF 는 탭 없이 파일명을 짚어 안내하고, 같이 고른 정상 파일은 열린다', async ({ app, page }) => {
    await app.goto();
    await app.open([G.broken, SAMPLES.scan], { expectError: true });
    // single 빌드는 첫 열기에서 확인 카드가 먼저 뜬다
    const confirm = page.locator('[data-phase=confirm]');
    await confirm.getByRole('button', { name: '내려받기' }).click({ timeout: 3000 }).catch(() => {});
    const card = page.locator('[data-phase=error]');
    await expect(card).toContainText('‘broken.pdf’', { timeout: 120_000 });
    await expect(card).toContainText('열지 못했습니다');
    await expect.poll(async () => (await app.summary()).docs.length).toBe(1);
    expect(await app.docNames()).toEqual(['scan.pdf']);
    // 닫기 단추로 안내를 치울 수 있다
    await card.getByRole('button', { name: '닫기' }).click();
    await expect(page.locator('[data-phase]')).toHaveCount(0);
  });

  test('여러 파일을 한 번에 열면 모두 탭이 되고 마지막 파일이 활성이다', async ({ app }) => {
    await app.goto();
    await app.open([SAMPLES.koEmbedded, SAMPLES.koNonEmbedded, SAMPLES.scan]);
    expect(await app.tabNames()).toEqual(['ko_embedded.pdf', 'ko_nonembedded.pdf', 'scan.pdf']);
    expect(await app.activeTabName()).toBe('scan.pdf');
    await expect(app.tabs().first()).toHaveAttribute('aria-selected', 'false');
  });

  test('같은 이름은 (2) 로 구분하고 열린 파일은 12개까지다', async ({ app, page }) => {
    test.slow();
    await app.goto();
    await app.open(G.docC);
    await app.open(G.docC);
    expect(await app.tabNames()).toEqual(['docC.pdf', 'docC (2).pdf']);
    await app.open(Array.from({ length: 10 }, () => G.docC));
    expect(await app.tabNames()).toHaveLength(12);
    await app.open([G.docC, G.docC], { expectError: true });
    await expect(page.locator('[data-phase=error]')).toContainText('12개');
    expect(await app.tabNames()).toHaveLength(12);
    // 탭이 넘치면 가로로 스크롤되고 활성 탭은 보인다
    const overflow = await page.getByRole('tablist').evaluate((s) => {
      const t = s.querySelector('[role=tab][aria-selected=true]')!.getBoundingClientRect();
      const r = s.getBoundingClientRect();
      return { scroll: s.scrollWidth > s.clientWidth, visible: t.left >= r.left - 1 && t.right <= r.right + 1 };
    });
    expect(overflow).toEqual({ scroll: true, visible: true });
  });

  test('Ctrl+O 는 파일 선택 창을 연다', async ({ app, page }) => {
    await app.goto();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+o');
    const fc = await chooser;
    expect(fc.isMultiple()).toBe(true);
    await fc.setFiles(G.five);
    await app.settleOpen(1);
    expect(await app.docNames()).toEqual(['five.pdf']);
  });
});

test.describe('single 빌드의 엔진 내려받기', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'single', 'single 빌드에서만 해당');
  });

  test('첫 열기는 크기·이유를 보여 주는 확인 카드가 먼저 뜬다', async ({ app, page }) => {
    await app.goto();
    await page.locator('[data-testid=file-input]').setInputFiles(G.five);
    const card = page.locator('[data-phase=confirm]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('MB');
    await expect(card.getByRole('button', { name: '내려받기' })).toBeVisible();
    await expect(card.getByRole('button', { name: '취소' })).toBeVisible();
    // 수락하면 열린다(WASM 은 로컬 파일로 응답되어 해시 검증을 그대로 통과한다)
    await card.getByRole('button', { name: '내려받기' }).click();
    await app.settleOpen(1);
    expect(await app.total()).toBe(5);
  });

  test('취소하면 문서가 열리지 않는다', async ({ app, page }) => {
    await app.goto();
    await page.locator('[data-testid=file-input]').setInputFiles(G.five);
    await page.locator('[data-phase=confirm]').getByRole('button', { name: '취소' }).click();
    await expect(page.locator('[data-phase=confirm]')).toHaveCount(0);
    expect((await app.summary()).docs).toEqual([]);
  });

  test('받은 엔진은 저장소에 남아 새로고침 뒤에는 확인 없이 열린다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    await page.reload();
    await page.locator('[data-testid=file-input]').waitFor({ state: 'attached' });
    await page.locator('[data-testid=file-input]').setInputFiles(G.five);
    await expect.poll(async () => (await app.summary()).docs.length).toBe(1);
    await expect(page.locator('[data-phase=confirm]')).toHaveCount(0);
  });

  test('받은 파일의 해시가 다르면 저장하지 않고 오류 카드와 다시 시도를 보여 준다', async ({ app, page }) => {
    // 나중에 등록한 route 가 먼저 적용되므로 fixture 의 CDN 응답을 덮어쓴다
    await page.route(/cdn\.jsdelivr\.net/, (r) => r.fulfill({ status: 200, body: 'not the real wasm bytes', contentType: 'application/wasm', headers: { 'access-control-allow-origin': '*' } }));
    await app.goto();
    await page.locator('[data-testid=file-input]').setInputFiles(G.five);
    await page.locator('[data-phase=confirm]').getByRole('button', { name: '내려받기' }).click();
    const err = page.locator('[data-phase=error]');
    await expect(err).toBeVisible({ timeout: 30_000 });
    await expect(err.getByRole('button', { name: '다시 시도' })).toBeVisible();
    expect((await app.summary()).docs).toEqual([]);
  });

  test('네트워크가 끊기면 오류 카드와 다시 시도가 나온다', async ({ app, page }) => {
    await page.route(/cdn\.jsdelivr\.net/, (r) => r.abort('internetdisconnected'));
    await app.goto();
    await page.locator('[data-testid=file-input]').setInputFiles(G.five);
    await page.locator('[data-phase=confirm]').getByRole('button', { name: '내려받기' }).click();
    const err = page.locator('[data-phase=error]');
    await expect(err).toBeVisible({ timeout: 30_000 });
    await expect(err.getByRole('button', { name: '다시 시도' })).toBeVisible();
  });
});
