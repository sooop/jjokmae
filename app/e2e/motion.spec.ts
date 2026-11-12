// 모션 시험. 다른 spec 은 모션 줄이기(playwright.config)로 도는 반면, 이 파일만 모션을 켜고 연출이 실제로 일어나는지 확인한다.
// 연출은 transform/opacity 만 움직이므로 중간 프레임은 DOM 의 비행체·고스트·실행 중 애니메이션으로 확인한다.
import { test, expect, type App } from './helpers.ts';
import { GENERATED as G } from './fixtures/paths.ts';

test.use({ reducedMotion: 'no-preference' });

async function openOrganize(app: App) {
  await app.goto();
  await app.open(G.docA);
  await app.setMode('organize');
  await app.cellDrawn(0);
  await app.cellDrawn(4);
}

test.describe('모션: 쪽 드래그 고스트', () => {
  test('한 쪽을 끌면 비트맵 고스트가 따라오고, Esc 로 취소하면 되돌아가 사라진다', async ({ app, page }) => {
    await openOrganize(app);
    const ghost = page.getByTestId('drag-ghost');
    await expect(ghost).toHaveCount(0);
    const f0 = await app.center(app.cellFace(0));
    await app.dragMouse(f0, { x: f0.x + 160, y: f0.y + 90 }, { release: false });
    await expect(ghost).toHaveCount(1);
    // 이미 그려진 캔버스를 복사해 쓴다: 한 장이고, 글자가 있다(재렌더 없이)
    const info = await ghost.evaluate((g) => {
      const cs = [...g.querySelectorAll('canvas')];
      const c = cs[0];
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 3] > 0) dark++;
      return { cards: cs.length, w: c.width, dark, badge: g.querySelectorAll('span').length };
    });
    expect(info.cards).toBe(1);
    expect(info.w).toBeGreaterThan(0);
    expect(info.dark).toBeGreaterThan(0);
    // 포인터를 따라온다(스프링이라 조금 늦게 도착한다)
    await expect.poll(async () => Math.round((await ghost.boundingBox())!.x)).toBeGreaterThan(f0.x + 40);
    await page.keyboard.press('Escape');
    await app.releaseMouse();
    await expect(ghost).toHaveCount(0);
    await expect(page.getByTestId('drop-line')).toHaveCount(0);
    expect((await app.summary()).docs[0].undo).toBe(0);
  });

  test('여러 쪽을 끌면 최대 4장이 겹치고 개수 배지가 뜬다', async ({ app, page }) => {
    await openOrganize(app);
    await page.getByTestId('grid').focus();
    await page.keyboard.press('Control+a');
    await expect.poll(async () => (await app.summary()).docs[0].selected.length).toBe(5);
    const f = await app.center(app.cellFace(1));
    await app.dragMouse(f, { x: f.x + 100, y: f.y + 120 }, { release: false });
    const ghost = page.getByTestId('drag-ghost');
    await expect(ghost).toHaveCount(1);
    expect(await ghost.locator('canvas').count()).toBe(4);
    await expect(ghost.getByText('5', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await app.releaseMouse();
    await expect(ghost).toHaveCount(0);
  });
});

test.describe('모션: 쪽 이동 연출', () => {
  test('놓으면 비행체가 새 자리로 내려앉고(조작은 기다리지 않는다), 끝나면 사라지며 순서가 바뀐다', async ({ app, page }) => {
    await openOrganize(app);
    const before = await page.locator('[data-cell] [data-thumb]').count();
    expect(before).toBeGreaterThan(0);
    const f0 = await app.center(app.cellFace(0));
    const t3 = await app.center(app.cellFace(3));
    await app.dragMouse(f0, { x: t3.x + 40, y: t3.y }, { steps: 10 });
    await expect.poll(() => page.locator('[data-flyer]').count(), { timeout: 3000, intervals: [16, 30, 50] }).toBeGreaterThan(0);
    // 비행체는 격자 안에서 transform 애니메이션 중이다
    const anims = await page.locator('[data-flyer]').first().evaluate((e) => e.getAnimations().map((a) => a.playState));
    expect(anims.length).toBeGreaterThan(0);
    await expect(page.locator('[data-flyer]')).toHaveCount(0, { timeout: 8000 });
    await expect.poll(async () => (await app.summary()).docs[0].undo).toBe(1);
    await app.cellDrawn(0);
    expect(await page.locator('[data-cell]').first().isVisible()).toBe(true);
  });
});

test.describe('모션 줄이기', () => {
  test.use({ reducedMotion: 'reduce' });
  test('이동·크기 연출 없이 바로 바뀐다(비행체·고스트 이동 연출 없음, 조작 결과는 같다)', async ({ app, page }) => {
    await openOrganize(app);
    const f0 = await app.center(app.cellFace(0));
    const t3 = await app.center(app.cellFace(3));
    await app.dragMouse(f0, { x: t3.x + 40, y: t3.y }, { steps: 10 });
    await expect.poll(async () => (await app.summary()).docs[0].undo).toBe(1);
    expect(await page.locator('[data-flyer]').count()).toBe(0);
    await expect(page.getByTestId('drag-ghost')).toHaveCount(0);
  });
});

test.describe('모션: 팝오버·서랍·확대 슬라이더', () => {
  test('저장 옵션 팝오버는 열릴 때 실행 중인 애니메이션을 가진다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.docA);
    await page.getByRole('button', { name: '저장 옵션' }).click();
    const pop = page.getByTestId('save-options');
    await expect
      .poll(() => page.evaluate(() => (document.querySelector('[data-testid=save-options]')?.getAnimations({ subtree: true }).length ?? 0)), { timeout: 2000, intervals: [8, 16, 30] })
      .toBeGreaterThan(0);
    await expect(pop).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
  });

  test('설정 서랍은 배경 딤과 함께 들어오고 닫으면 사라진다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.docA);
    await page.getByRole('button', { name: '설정' }).click();
    const drawer = page.getByRole('dialog', { name: '설정' });
    await expect(drawer).toBeVisible();
    await expect(page.locator('.scrim')).toHaveCount(1);
    await page.getByRole('button', { name: '설정 닫기' }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.locator('.scrim')).toHaveCount(0);
  });

  test('확대 슬라이더: 끄는 동안은 CSS 변환으로 즉시 따라가고, 멈추면 확정되어 설정에 저장된다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const slider = page.getByRole('slider', { name: '확대 배율 슬라이더' });
    await expect(slider).toHaveValue('500'); // 100% 는 눈금 가운데
    await slider.focus();
    for (let i = 0; i < 24; i++) await page.keyboard.press('ArrowRight');
    // 확정 전: 선택 상자 값은 이미 따라가고, 본문은 변환(scale)으로 먼저 반응한다
    await expect.poll(() => app.zoomValue()).toBeGreaterThan(1);
    await expect.poll(() => app.zoomValue(), { timeout: 3000 }).toBeGreaterThan(1);
    await expect.poll(async () => (await app.settingsInStorage()).zoom, { timeout: 5000 }).toBeGreaterThan(1);
    const z = (await app.settingsInStorage()).zoom as number;
    await expect.poll(async () => (await app.summary()).docs[0].zoom).toBe(z);
    // 선택 상자로 고르면 슬라이더가 따라간다
    await app.setZoom(2);
    await expect(slider).toHaveValue('750');
  });

  test('G 로 정리 모드를 오가는 중에도 입력을 바로 받고 활성 문서와 모드가 이어진다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.docA);
    await page.keyboard.press('g');
    await expect(page.getByTestId('grid')).toBeVisible();
    // 전환 연출 중에도 실제 화면이 입력을 받는다(비행체는 입력을 가로채지 않는다)
    await app.clickCell(1);
    await expect.poll(async () => (await app.summary()).docs[0].selected).toEqual([1]);
    await app.cellDrawn(0);
    await page.keyboard.press('g');
    await expect(page.getByTestId('scroller')).toBeVisible();
    expect((await app.summary()).mode).toBe('view');
  });
});
