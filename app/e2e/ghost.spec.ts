// 드래그 고스트(data-testid=drag-ghost)와 이어지는 연출 요소(비행체·드롭선·놓을 수 있는 칸 표시).
// 보기 모드 썸네일 패널과 정리 모드 격자 둘 다에서: 고스트 표시·겹친 카드 수(최대 4)·개수 배지·놓기·Esc 취소·탭/파일 목록으로 복사,
// 그리고 조작이 끝난 뒤 고스트·비행체 요소가 DOM 에 남지 않는지를 본다.
import { test, expect, texts, type App, type Page } from './helpers.ts';
import { GENERATED as G } from './fixtures/paths.ts';

type Mode = 'view' | 'organize';
const MODES: Mode[] = ['view', 'organize'];

test.use({ viewport: { width: 1400, height: 1400 } });

/** 문서를 열고 모드를 맞춘 뒤 앞쪽 n 개가 그려질 때까지 */
async function setup(app: App, mode: Mode, files: string | string[], active?: string, drawn = 5) {
  await app.goto();
  await app.open(files);
  if (mode === 'organize') await app.setMode('organize');
  if (active) {
    if (mode === 'organize') await app.selectFile(active);
    else await app.switchTab(active);
  }
  for (let i = 0; i < drawn; i++) {
    if (mode === 'organize') await app.cellDrawn(i);
    else await app.canvasDrawn(app.page.locator(`[data-thumb="${i}"] canvas`));
  }
}
const face = (app: App, mode: Mode, i: number) => (mode === 'view' ? app.thumbFace(i) : app.cellFace(i));
const pick = (app: App, mode: Mode, i: number, mods: ('Control' | 'Shift')[] = []) => (mode === 'view' ? app.clickThumb(i, mods) : app.clickCell(i, mods));
/** 쪽 i "뒤(다음 쪽 앞)"를 가리키는 화면 좌표: 보기 모드는 아래쪽 절반, 정리 모드는 오른쪽 가장자리 */
async function afterPage(app: App, mode: Mode, i: number) {
  const b = (await face(app, mode, i).boundingBox())!;
  return mode === 'view' ? { x: b.x + b.width / 2, y: b.y + b.height - 4 } : { x: b.x + b.width - 8, y: b.y + b.height / 2 };
}
const ghost = (page: Page) => page.getByTestId('drag-ghost');
/** 고스트·비행체·드롭선·놓을 수 있는 칸 표시가 DOM 에 하나도 없다 */
async function expectClean(page: Page, timeout = 8000) {
  for (const sel of ['[data-testid=drag-ghost]', '.pg-ghost', '[data-flyer]', '[data-flyer-layer]', '[data-testid=drop-line]', '[data-droppable]']) {
    await expect(page.locator(sel), sel).toHaveCount(0, { timeout });
  }
}
/** moving 을 before(원래 번호 기준 '그 앞')에 끼워 넣은 순서 */
function moved(n: number, moving: number[], before: number): number[] {
  const rest = Array.from({ length: n }, (_, i) => i).filter((i) => !moving.includes(i));
  rest.splice(before - moving.filter((m) => m < before).length, 0, ...moving);
  return rest;
}
const dropBefore = (page: Page) => page.getByTestId('drop-line').getAttribute('data-before');
const P = (order: number[]) => order.map((i) => `P-${i + 1}`);

for (const mode of MODES) {
  const where = mode === 'view' ? '보기 모드 썸네일' : '정리 모드 격자';
  test.describe(`고스트: ${where}`, () => {
    test('한 쪽을 끌면 고스트(카드 1장, 배지 없음)가 뜨고, 놓으면 사라지며 순서가 바뀐다', async ({ app, page }) => {
      await setup(app, mode, G.docA);
      await expect(ghost(page)).toHaveCount(0);
      const from = await app.center(face(app, mode, 0));
      const to = await afterPage(app, mode, 3);
      await app.dragMouse(from, to, { release: false });
      await expect(ghost(page)).toHaveCount(1);
      await expect(ghost(page).locator('canvas')).toHaveCount(1);
      await expect(ghost(page).getByText('1', { exact: true })).toHaveCount(0); // 한 쪽이면 개수 배지가 없다
      await expect(ghost(page)).toContainText('1쪽 이동');
      expect(await dropBefore(page)).toBe('4');
      await app.change(() => app.releaseMouse());
      await expect(ghost(page)).toHaveCount(0);
      await expectClean(page);
      expect((await app.active())?.undo).toBe(1);
      expect(texts((await app.saveAndInspect()).info)).toEqual(['A-2', 'A-3', 'A-4', 'A-1', 'A-5']);
    });

    test('Esc 로 취소하면 고스트가 사라지고 순서·되돌리기 기록은 그대로다', async ({ app, page }) => {
      await setup(app, mode, G.docA);
      const from = await app.center(face(app, mode, 2));
      await app.dragMouse(from, await afterPage(app, mode, 4), { release: false });
      await expect(ghost(page)).toHaveCount(1);
      await expect(page.getByTestId('drop-line')).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(ghost(page)).toHaveCount(0);
      await app.releaseMouse();
      await expectClean(page);
      const d = await app.active();
      expect([d?.undo, d?.dirty]).toEqual([0, false]);
      // 취소 뒤에도 클릭은 선택으로 동작한다(끌기 직후의 클릭 억제가 남지 않는다)
      await pick(app, mode, 1);
      await expect.poll(() => app.selectedPages()).toEqual([1]);
      expect(texts((await app.saveAndInspect()).info)).toEqual(['A-1', 'A-2', 'A-3', 'A-4', 'A-5']);
    });

    test('5쪽을 골라 끌면 카드가 최대 4장 겹치고 배지 5 가 뜨며, 놓으면 사라지고 선택한 쪽이 한꺼번에 옮겨진다', async ({ app, page }) => {
      await setup(app, mode, G.p24, undefined, 6);
      await pick(app, mode, 0);
      await pick(app, mode, 4, ['Shift']);
      await expect.poll(() => app.selectedPages()).toEqual([0, 1, 2, 3, 4]);
      const from = await app.center(face(app, mode, 1));
      const to = await afterPage(app, mode, 5);
      await app.dragMouse(from, to, { release: false });
      await expect(ghost(page)).toHaveCount(1);
      await expect(ghost(page).locator('canvas')).toHaveCount(4); // 5쪽이어도 카드는 4장까지
      await expect(ghost(page).getByText('5', { exact: true })).toBeVisible();
      await expect(ghost(page)).toContainText('5쪽 이동');
      expect(await dropBefore(page)).toBe('6');
      await app.change(() => app.releaseMouse());
      await expect(ghost(page)).toHaveCount(0);
      await expectClean(page);
      expect(texts((await app.saveAndInspect()).info)).toEqual(P(moved(24, [0, 1, 2, 3, 4], 6)));
      // 같은 5쪽을 다시 집었다가 Esc: 고스트만 사라지고 순서 그대로
      await expect.poll(() => app.selectedPages()).toEqual([1, 2, 3, 4, 5]);
      await app.dragMouse(await app.center(face(app, mode, 2)), await afterPage(app, mode, 5), { release: false });
      await expect(ghost(page)).toHaveCount(1);
      await expect(ghost(page).getByText('5', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await app.releaseMouse();
      await expectClean(page);
      expect((await app.active())?.undo).toBe(1);
    });

    test('끌어서 탭·파일 목록 위에 두면 복사 표시가 뜨고, 놓으면 고스트가 사라지며 끝에 복사된다(Esc 는 취소)', async ({ app, page }) => {
      await setup(app, mode, [G.docA, G.docB], 'docA.pdf');
      await pick(app, mode, 1);
      await pick(app, mode, 2, ['Control']);
      const target = mode === 'view' ? app.tab('docB.pdf') : app.fileRow('docB.pdf');
      const from = await app.center(face(app, mode, 1));
      // Esc 로 취소
      await app.dragMouse(from, await app.center(target), { release: false });
      await expect(ghost(page)).toHaveCount(1);
      await expect(ghost(page)).toContainText('끝에 복사');
      await expect(ghost(page)).toContainText('docB.pdf');
      await expect(ghost(page).getByText('2', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await app.releaseMouse();
      await expectClean(page);
      expect(await app.pageCounts()).toEqual([5, 4]);
      // 놓으면 복사
      await app.dragMouse(from, await app.center(target), { release: false });
      await expect(ghost(page)).toContainText('끝에 복사');
      await expect(page.locator('[data-droppable]')).not.toHaveCount(0);
      await app.change(() => app.releaseMouse());
      await expect(ghost(page)).toHaveCount(0);
      await expectClean(page);
      expect(await app.pageCounts()).toEqual([5, 6]);
      expect(mode === 'view' ? await app.activeTabName() : await app.activeFileName()).toBe('docA.pdf'); // 활성 문서는 그대로
      if (mode === 'organize') {
        // 새 파일 칸: 같은 선택을 새 파일로 복사
        await app.dragMouse(from, await app.center(page.getByTestId('new-slot')), { release: false });
        await expect(ghost(page)).toContainText('새 파일로 복사');
        await app.change(() => app.releaseMouse());
        await expect(ghost(page)).toHaveCount(0);
        await expectClean(page);
        expect(await app.fileNames()).toEqual(['docA.pdf', 'docB.pdf', '새 문서 1.pdf']);
        expect(await app.pageCounts()).toEqual([5, 6, 2]);
      }
    });
  });
}

// 모션을 켠 경우: 놓기·취소 뒤에 이어지는 연출(비행체·돌아가기)이 끝나면 요소가 모두 사라진다
test.describe('고스트: 연출이 끝난 뒤 DOM 정리', () => {
  test.use({ reducedMotion: 'no-preference' });
  for (const mode of MODES) {
    test(`${mode === 'view' ? '보기 모드 썸네일' : '정리 모드 격자'}: 놓기·Esc·복사 뒤 고스트와 비행체가 남지 않는다`, async ({ app, page }) => {
      await setup(app, mode, [G.docA, G.docB], 'docA.pdf');
      const from = await app.center(face(app, mode, 0));
      // 놓기(재정렬)
      await app.dragMouse(from, await afterPage(app, mode, 3), { release: false });
      await expect(ghost(page)).toHaveCount(1);
      await app.change(() => app.releaseMouse());
      await expectClean(page, 10_000);
      expect((await app.active())?.undo).toBe(1);
      // Esc: 원래 자리로 돌아가는 연출 뒤 사라진다
      await app.dragMouse(await app.center(face(app, mode, 1)), await afterPage(app, mode, 4), { release: false });
      await expect(ghost(page)).toHaveCount(1);
      await page.keyboard.press('Escape');
      await app.releaseMouse();
      await expectClean(page, 10_000);
      expect((await app.active())?.undo).toBe(1);
      // 복사
      await pick(app, mode, 0);
      const target = mode === 'view' ? app.tab('docB.pdf') : app.fileRow('docB.pdf');
      await app.dragMouse(await app.center(face(app, mode, 0)), await app.center(target), { release: false });
      await expect(ghost(page)).toContainText('끝에 복사');
      await app.change(() => app.releaseMouse());
      await expectClean(page, 10_000);
      expect(await app.pageCounts()).toEqual([5, 5]);
    });
  }
});
