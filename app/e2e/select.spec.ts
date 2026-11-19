import { test, expect } from './helpers.ts';
import { GENERATED as G } from './fixtures/paths.ts';

// 썸네일 체크박스·선택 모드·쪽 메뉴(호버 단추 줄 없음)

test.describe('쪽 선택: 체크박스와 선택 모드(보기 모드 썸네일)', () => {
  test('체크박스는 평소 숨고 호버에 나타나며, 선택이 생기면 모든 칸에 보이고 본체 클릭이 선택을 토글한다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const op = (i: number) => app.pageCheckbox(i).evaluate((e) => getComputedStyle(e).opacity);
    await page.mouse.move(700, 450);
    expect(await op(1)).toBe('0');
    await app.thumb(1).hover();
    await expect.poll(() => op(1)).toBe('1');
    await expect(app.thumb(1).locator('.actions')).toHaveCount(0);
    // 일반 클릭은 이동만
    await app.thumbFace(2).click();
    await expect(app.currentPageInput()).toHaveValue('3');
    expect(await app.selectedPages()).toEqual([]);
    // 체크박스: 불연속 선택
    await app.pageCheckbox(0).click();
    await app.pageCheckbox(3).click();
    expect(await app.selectedPages()).toEqual([0, 3]);
    await expect(app.pageCheckbox(0)).toHaveAttribute('aria-checked', 'true');
    // 선택 모드: 선택 안 된 칸에서 마우스를 치워도 체크박스가 보인다
    await page.mouse.move(700, 450);
    await expect.poll(() => op(4)).toBe('1');
    // 본체 클릭 = 토글(이동하지 않는다)
    await app.thumbFace(4).click();
    expect(await app.selectedPages()).toEqual([0, 3, 4]);
    await expect(app.currentPageInput()).toHaveValue('3');
    await app.thumbFace(3).click();
    expect(await app.selectedPages()).toEqual([0, 4]);
    // Shift+체크박스: 범위
    await app.pageCheckbox(2).click({ modifiers: ['Shift'] });
    expect((await app.selectedPages()).includes(2)).toBe(true);
    // Esc: 선택 해제 → 선택 모드 종료, 다시 일반 클릭은 이동
    await page.keyboard.press('Escape');
    await expect.poll(() => app.selectedPages()).toEqual([]);
    await app.thumbFace(1).click();
    await expect(app.currentPageInput()).toHaveValue('2');
  });

  test('우클릭 메뉴: 선택 개수가 라벨에 들어가고, 삭제는 구분선 뒤 맨 끝이며 확인 없이 되돌릴 수 있다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    // 선택에 없는 칸 → 그 칸만
    await app.pageCheckbox(0).click();
    await app.openThumbMenu(3);
    expect(await app.menuItems()).toEqual(expect.arrayContaining(['1쪽 복제', '1쪽 오른쪽으로 회전', '1쪽 왼쪽으로 회전']));
    const items = await app.menuItems();
    expect(items[items.length - 1]).toBe('1쪽 삭제');
    await page.keyboard.press('Escape');
    // 선택에 있는 칸 → 선택 전체
    await app.pageCheckbox(1).click();
    await app.openThumbMenu(1);
    await expect(app.menuItem('2쪽 삭제')).toBeVisible();
    await app.change(() => app.menuItem('2쪽 삭제').click());
    expect(await app.total()).toBe(3);
    await app.undo();
    expect(await app.total()).toBe(5);
  });

  test('메뉴 키(Shift+F10)로 포커스한 쪽의 메뉴가 열린다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    await app.thumbFace(2).focus();
    await page.keyboard.press('Shift+F10');
    await expect(app.contextMenu()).toBeVisible();
    await expect(app.thumbMenuItem('delete')).toBeVisible();
  });

  test('왼쪽으로 회전은 반시계 방향이다', async ({ app }) => {
    await app.goto();
    await app.open(G.five);
    await app.change(() => app.thumbAction(0, 'rotate-left'));
    const { info } = await app.saveAndInspect();
    expect(info[0].rotate).toBe(270);
  });
});

test.describe('쪽 선택: 정리 모드 격자', () => {
  test('체크박스로 불연속 선택하고 본체 클릭이 토글이며 호버 단추 줄이 없다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    await app.setMode('organize');
    await app.cellDrawn(0);
    await app.cell(0).hover();
    await expect(app.cell(0).locator('.actions')).toHaveCount(0);
    await app.pageCheckbox(0).click();
    await app.pageCheckbox(2).click();
    expect(await app.selectedPages()).toEqual([0, 2]);
    await app.cellFace(4).click(); // 선택 모드: 토글
    expect(await app.selectedPages()).toEqual([0, 2, 4]);
    await app.openCellMenu(2);
    await expect(app.menuItem('3쪽 삭제')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(app.contextMenu()).toHaveCount(0);
    await page.getByTestId('grid').focus();
    await page.keyboard.press('Escape');
    await expect.poll(() => app.selectedPages()).toEqual([]);
  });
});
