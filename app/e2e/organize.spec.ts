import { test, expect, texts, qpdfCheck, readZip, type App } from './helpers.ts';
import { GENERATED as G } from './fixtures/paths.ts';
import { inspect } from './fixtures/synth.ts';

const ABC = [G.docA, G.docB, G.docC];

/** 정리 모드로 문서를 열고 첫 문서의 격자가 그려질 때까지 */
async function openOrganize(app: App, files: string | string[], active?: string) {
  await app.goto();
  await app.open(files);
  await app.setMode('organize');
  if (active) await app.selectFile(active);
  else await app.cellDrawn(0);
}
const selectedCells = (app: App) => app.page.locator('[data-cell][aria-selected=true]').evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.cell)));

/** 탭(파일)을 닫는다. 저장 안 한 변경이 있으면 버리고 닫는다 */
async function closeDoc(app: { page: import('@playwright/test').Page }, name: string) {
  await app.page.getByRole('button', { name: `${name} 닫기` }).click();
  await app.page.getByTestId('close-discard').click({ timeout: 1500 }).catch(() => {});
}

test.describe('정리 모드: 전환', () => {
  test('G·툴바 단추로 오가도 활성 문서·선택·되돌리기 기록이 이어지고, 더블클릭은 그 쪽을 보기 모드로 연다', async ({ app, page }) => {
    await app.goto();
    await app.open(ABC);
    expect((await app.summary()).mode).toBe('view');
    await expect(page.getByRole('tablist')).toBeVisible();
    await expect(page.getByTestId('grid')).toHaveCount(0);
    await app.switchTab('docA.pdf');
    await app.clickThumb(1);
    await app.clickThumb(3, ['Control']);
    await app.change(() => app.thumbAction(0, 'rotate'));
    let a = (await app.summary()).docs[0];
    expect([a.selected, a.undo]).toEqual([[1, 3], 1]);

    await page.keyboard.press('g');
    await expect(page.getByTestId('grid')).toBeVisible();
    expect((await app.summary()).mode).toBe('organize');
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByTestId('scroller')).toHaveCount(0);
    await expect(page.getByRole('listbox', { name: '열린 파일' })).toBeVisible();
    const s = await app.summary();
    a = s.docs[0];
    expect([s.active === a.key, a.selected, a.undo, a.dirty]).toEqual([true, [1, 3], 1, true]);
    expect(await app.fileNames()).toEqual(['docA.pdf', 'docB.pdf', 'docC.pdf']);
    expect(await app.activeFileName()).toBe('docA.pdf');
    expect(await app.fileBadges()).toEqual([2, 0, 0]);
    await app.cellDrawn(0);
    expect(await selectedCells(app)).toEqual([1, 3]);
    // 정리 모드에서도 되돌리기가 이어진다
    await app.undo();
    a = (await app.summary()).docs[0];
    expect([a.undo, a.redo, a.dirty]).toEqual([0, 1, false]);
    await app.redo();
    expect((await app.summary()).docs[0].undo).toBe(1);
    // 다시 G → 보기 모드(같은 선택·기록)
    await page.keyboard.press('g');
    await expect(page.getByTestId('scroller')).toBeVisible();
    await expect(page.getByRole('tablist')).toBeVisible();
    a = (await app.summary()).docs[0];
    expect([a.selected, a.undo]).toEqual([[1, 3], 1]);
    // 툴바 단추(aria-pressed)
    const toggle = app.topButton(/^정리 모드/);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await app.cellDrawn(0);
    // 쪽을 더블클릭하면 보기 모드로 돌아가 그 쪽(4)을 연다
    await app.clickCell(3, [], 2);
    await expect(page.getByTestId('scroller')).toBeVisible();
    await expect(app.currentPageInput()).toHaveValue('4');
    expect((await app.summary()).mode).toBe('view');
    // (더블클릭의 첫 클릭이 고르고 둘째 클릭이 선택 모드의 토글로 푼다. 선택 여부는 이 동작의 약속이 아니다)
    expect(await app.activeTabName()).toBe('docA.pdf');
  });

  test('정리 모드에서 문서를 모두 닫으면 빈 상태(파일 열기)가 된다', async ({ app, page }) => {
    await openOrganize(app, G.docA);
    await page.getByRole('button', { name: 'docA.pdf 닫기' }).click();
    await expect.poll(async () => (await app.summary()).docs.length).toBe(0);
    // 나가는 정리 화면(120ms 페이드)의 파일 목록 단추와 겹쳐 보일 수 있으니 뷰어 영역의 단추로 한정한다
    await expect(page.getByRole('main', { name: '뷰어' }).getByRole('button', { name: '파일 열기' })).toBeVisible();
    await expect(page.getByTestId('grid')).toHaveCount(0);
    expect((await app.summary()).mode).toBe('organize');
  });

  test('마지막으로 쓴 모드는 설정에 저장되어 새로 열 때 그 모드로 열린다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.docA);
    await page.keyboard.press('g');
    await expect.poll(async () => (await app.settingsInStorage()).mode).toBe('organize');
    await page.reload();
    await page.locator('[data-testid=file-input]').waitFor({ state: 'attached' });
    // 문서가 없으면 모드와 무관하게 빈 상태
    await expect(page.getByRole('button', { name: '파일 열기' })).toBeVisible();
    await expect(page.getByTestId('grid')).toHaveCount(0);
    await app.open(G.docA);
    await expect(page.getByTestId('grid')).toBeVisible();
    expect((await app.summary()).mode).toBe('organize');
  });
});

test.describe('정리 모드: 파일별 선택·파일 목록', () => {
  test('파일마다 선택을 따로 유지하고 배지가 합계를 보여 주며, 보기 모드와 같은 선택을 쓴다', async ({ app, page }) => {
    await openOrganize(app, ABC, 'docA.pdf');
    await app.clickCell(2);
    await app.clickCell(4, ['Control']);
    expect((await app.summary()).docs.map((d) => d.selected)).toEqual([[2, 4], [], []]);
    expect(await app.fileBadges()).toEqual([2, 0, 0]);
    await app.selectFile('docB.pdf');
    expect(await selectedCells(app)).toEqual([]);
    await app.clickCell(1);
    expect((await app.summary()).docs.map((d) => d.selected)).toEqual([[2, 4], [1], []]);
    expect(await app.fileBadges()).toEqual([2, 1, 0]);
    await app.selectFile('docA.pdf');
    expect(await selectedCells(app)).toEqual([2, 4]);
    expect(await app.fileBadges()).toEqual([2, 1, 0]);
    // 보기 모드 썸네일도 같은 선택
    await app.setMode('view');
    await app.pageDrawn(0);
    await expect(page.locator('[data-thumb] button[aria-pressed=true]')).toHaveCount(2);
    expect((await app.summary()).docs[0].selected).toEqual([2, 4]);
  });

  test('파일 목록은 listbox/option 이고 위·아래·End 키로 활성 문서를 옮긴다', async ({ app, page }) => {
    await openOrganize(app, ABC, 'docA.pdf');
    const list = page.getByRole('listbox', { name: '열린 파일' });
    await expect(list.getByRole('option')).toHaveCount(3);
    await expect(list.locator('[role=option][aria-selected=true]')).toHaveCount(1);
    await app.fileOption('docA.pdf').focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => app.activeFileName()).toBe('docB.pdf');
    await page.keyboard.press('End');
    await expect.poll(() => app.activeFileName()).toBe('docC.pdf');
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => app.activeFileName()).toBe('docB.pdf');
    // 항목은 전체 이름을 title 로 갖는다
    await expect(app.fileOption('docA.pdf')).toHaveAttribute('title', 'docA.pdf');
  });

  test('변경됨 점, 변경된 파일 닫기 확인(목록 안), Esc 취소, 저장 안 하고 닫기', async ({ app, page }) => {
    await openOrganize(app, ABC, 'docA.pdf');
    await app.change(() => app.thumbAction(0, 'rotate'));
    expect(await page.getByTestId('file').evaluateAll((els) => els.map((e) => !!e.querySelector('[data-testid=file-dirty]')))).toEqual([true, false, false]);
    await page.getByRole('button', { name: 'docA.pdf 닫기' }).click();
    const confirm = page.getByRole('alertdialog', { name: '저장하지 않은 변경' });
    await expect(confirm.getByRole('button')).toHaveText(['저장 후 닫기', '저장 안 하고 닫기', '취소']);
    const cr = (await confirm.boundingBox())!;
    const fl = (await page.getByTestId('files').boundingBox())!;
    expect(cr.x).toBeGreaterThanOrEqual(fl.x - 1);
    expect(cr.x + cr.width).toBeLessThanOrEqual(fl.x + fl.width + 1);
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    expect((await app.summary()).docs).toHaveLength(3);
    await page.getByRole('button', { name: 'docA.pdf 닫기' }).click();
    await confirm.getByTestId('close-discard').click();
    await expect.poll(() => app.fileNames()).toEqual(['docB.pdf', 'docC.pdf']);
  });
});

test.describe('정리 모드: 파일 목록으로 끌기', () => {
  test('선택한 쪽을 다른 파일 위에 놓으면 끝에 복사하고, 자기 자신·Esc·새 파일 칸 클릭은 아무 일도 없다', async ({ app, page }) => {
    await openOrganize(app, ABC, 'docA.pdf');
    await app.clickCell(1);
    await app.clickCell(3, ['Control']);
    const from = await app.center(app.cellFace(1));
    const rowB = await app.center(app.fileRow('docB.pdf'));
    await app.dragMouse(from, rowB, { steps: 14, release: false });
    // 끄는 동안: 놓을 수 있는 칸은 B·C 와 새 파일 칸(3), 자기 항목은 비활성
    await expect(page.locator('[data-droppable]')).toHaveCount(3);
    await expect(app.fileOption('docA.pdf')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('new-slot')).toHaveAttribute('data-droppable', '');
    await app.change(() => app.releaseMouse());
    expect(await app.pageCounts()).toEqual([5, 6, 3]);
    expect(await app.activeFileName()).toBe('docA.pdf');
    await expect(page.locator('[data-droppable]')).toHaveCount(0);
    await app.selectFile('docB.pdf');
    expect(texts((await app.saveAndInspect()).info)).toEqual(['B-1', 'B-2', 'B-3', 'B-4', 'A-2', 'A-4']);

    // 자기 항목에 놓아도 변화 없음
    await app.selectFile('docA.pdf');
    await app.clickCell(0);
    await app.dragMouse(await app.center(app.cellFace(0)), await app.center(app.fileRow('docA.pdf')));
    await app.idle();
    expect(await app.pageCounts()).toEqual([5, 6, 3]);
    expect((await app.doc('docA.pdf')).undo).toBe(0);

    // 새 파일 칸에 놓으면 그 쪽만 든 새 파일
    await app.clickCell(4);
    await app.dragMouse(await app.center(app.cellFace(4)), await app.center(page.getByTestId('new-slot')), { release: false });
    await app.change(() => app.releaseMouse());
    expect(await app.fileNames()).toEqual(['docA.pdf', 'docB.pdf', 'docC.pdf', '새 문서 1.pdf']);
    expect(await app.activeFileName()).toBe('새 문서 1.pdf');
    expect(texts((await app.saveAndInspect()).info)).toEqual(['A-5']);
    // 새 파일 칸을 클릭해도 아무것도 만들어지지 않는다
    await page.getByTestId('new-slot').click();
    expect((await app.summary()).docs).toHaveLength(4);
    await expect(page.getByTestId('new-slot')).toHaveAttribute('title', /끌어다 놓으면/);

    // Esc 로 취소
    await app.selectFile('docA.pdf');
    await app.clickCell(0);
    await app.dragMouse(await app.center(app.cellFace(0)), await app.center(app.fileRow('docC.pdf')), { release: false });
    await expect(page.locator('[data-droppable]')).not.toHaveCount(0);
    await page.keyboard.press('Escape');
    await app.releaseMouse();
    await expect(page.locator('[data-droppable]')).toHaveCount(0);
    expect(await app.pageCounts()).toEqual([5, 6, 3, 1]);
  });
});

test.describe('정리 모드: 우클릭 메뉴', () => {
  test('쪽 우클릭: 항목·선택·화면 안 위치, 하위 목록과 키보드(←·↓·Esc)·바깥 클릭', async ({ app, page }) => {
    await openOrganize(app, ABC, 'docA.pdf');
    await app.openCellMenu(1);
    const items = (await app.menuItems()).filter((t) => !t.startsWith('인쇄')); // 인쇄 항목은 별도 기능
    expect(items).toEqual(['복사 →', '이동 →', '1쪽 복제', '1쪽 오른쪽으로 회전', '1쪽 왼쪽으로 회전', '추출', '분할…', '1쪽 삭제']); // 삭제(위험 항목)는 구분선 뒤 맨 끝
    expect((await app.summary()).docs[0].selected).toEqual([1]);
    const mr = (await app.contextMenu().boundingBox())!;
    const vp = page.viewportSize()!;
    expect(mr.x).toBeGreaterThanOrEqual(0);
    expect(mr.y).toBeGreaterThanOrEqual(0);
    expect(mr.x + mr.width).toBeLessThanOrEqual(vp.width);
    expect(mr.y + mr.height).toBeLessThanOrEqual(vp.height);
    await app.menuItem('복사 →').click();
    expect(await app.menuItems()).toEqual(['‹ 복사', '새 파일', '‘docA.pdf’ 맨 뒤 (이 파일)', '‘docB.pdf’ 맨 뒤', '‘docC.pdf’ 맨 뒤', '위치 지정…']);
    await page.keyboard.press('ArrowLeft'); // 상위 목록으로
    await expect(app.menuItem('복사 →')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(app.menuItem('이동 →')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(app.contextMenu()).toHaveCount(0);
    await app.openCellMenu(1);
    await page.mouse.click(5, 880); // 바깥 클릭으로 닫힘
    await expect(app.contextMenu()).toHaveCount(0);
  });

  test('복사·이동·새 파일·위치 지정: 이동은 두 문서가 한 번에 되돌려지고, 모든 쪽 이동은 막힌다', async ({ app, page }) => {
    await openOrganize(app, ABC, 'docA.pdf');
    // 복사 → docB 맨 뒤
    await app.openCellMenu(1);
    await app.menuItem('복사 →').click();
    await app.change(() => app.menuItem('‘docB.pdf’ 맨 뒤').click());
    expect(await app.pageCounts()).toEqual([5, 5, 3]);
    expect((await app.doc('docA.pdf')).undo).toBe(0);
    // 복사 → 새 파일
    await app.openCellMenu(4);
    await app.menuItem('복사 →').click();
    await app.change(() => app.menuItem('새 파일').click());
    expect(await app.fileNames()).toEqual(['docA.pdf', 'docB.pdf', 'docC.pdf', '새 문서 1.pdf']);
    expect(await app.activeFileName()).toBe('새 문서 1.pdf');
    expect(texts((await app.saveAndInspect()).info)).toEqual(['A-5']);
    // 이동 → docC 맨 뒤, 한 번의 되돌리기로 두 문서가 복귀
    await app.selectFile('docA.pdf');
    await app.openCellMenu(0);
    await app.menuItem('이동 →').click();
    await app.change(() => app.menuItem('‘docC.pdf’ 맨 뒤').click());
    expect(await app.pageCounts()).toEqual([4, 5, 4, 1]);
    await app.undo();
    expect(await app.pageCounts()).toEqual([5, 5, 3, 1]);
    await app.redo();
    expect(await app.pageCounts()).toEqual([4, 5, 4, 1]);
    await app.undo();
    // 모든 쪽을 옮기려 하면 새 파일 항목이 꺼진다
    await app.clickCell(0);
    await page.keyboard.press('Control+a');
    await expect.poll(() => app.selectedPages()).toEqual([0, 1, 2, 3, 4]);
    await app.openCellMenu(2);
    await app.menuItem('이동 →').click();
    const nf = app.menuItem('새 파일');
    await expect(nf).toBeDisabled();
    await expect(nf).toHaveAttribute('title', /빈 문서/);
    await page.keyboard.press('Escape');
    await app.page.getByTestId('grid').focus();
    await page.keyboard.press('Escape');
    // 위치 지정…(복사): B 의 2쪽 뒤
    await app.clickCell(1);
    await app.clickCell(2, ['Control']);
    await app.openCellMenu(1);
    await app.menuItem('복사 →').click();
    await app.menuItem('위치 지정…').click();
    const dlg = page.getByRole('dialog', { name: '쪽 보내기' });
    await expect(dlg).toBeVisible();
    const vp = page.viewportSize()!;
    const pr = (await dlg.boundingBox())!;
    expect(pr.x).toBeGreaterThanOrEqual(0);
    expect(pr.y).toBeGreaterThanOrEqual(0);
    expect(pr.x + pr.width).toBeLessThanOrEqual(vp.width);
    expect(pr.y + pr.height).toBeLessThanOrEqual(vp.height);
    await expect(dlg.getByRole('radio', { name: '복사', exact: true })).toBeChecked();
    await dlg.getByRole('group', { name: '대상' }).locator('label', { hasText: 'docB.pdf' }).getByRole('radio').check({ force: true });
    await dlg.getByRole('textbox', { name: '쪽 번호' }).fill('2');
    await app.change(() => dlg.getByTestId('send-run').click());
    await app.selectFile('docB.pdf');
    // B 는 앞서 A-2 가 맨 뒤에 복사되어 [B-1..B-4, A-2]. 2쪽 뒤에 [A-2, A-3]
    expect(texts((await app.saveAndInspect()).info)).toEqual(['B-1', 'B-2', 'A-2', 'A-3', 'B-3', 'B-4', 'A-2']);
    // 이동 → 위치 지정… 은 이동 방식으로 열리고 Esc 로 닫힌다
    await app.selectFile('docA.pdf');
    await app.clickCell(4);
    await app.openCellMenu(4);
    await app.menuItem('이동 →').click();
    await app.menuItem('위치 지정…').click();
    await expect(dlg.getByRole('radio', { name: '이동', exact: true })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
  });

  test('복제·회전·삭제·추출·분할 항목', async ({ app, page }) => {
    await openOrganize(app, G.docA);
    await app.clickCell(0);
    await app.openCellMenu(0);
    await app.change(() => app.menuItem('복제').click());
    expect(await app.total()).toBe(6);
    await app.clickCell(1);
    await app.openCellMenu(1);
    await app.change(() => app.menuItem(/오른쪽으로 회전/).click());
    await app.clickCell(5);
    await app.openCellMenu(5);
    await app.change(() => app.menuItem('삭제').click());
    expect(await app.total()).toBe(5);
    const sv = await app.saveAndInspect();
    expect(texts(sv.info)).toEqual(['A-1', 'A-1', 'A-2', 'A-3', 'A-4']);
    expect(sv.info.map((p) => p.rotate)).toEqual([0, 90, 0, 0, 0]);
    // 추출: 선택한 2쪽만
    await app.clickCell(2);
    await app.clickCell(3, ['Control']);
    await app.openCellMenu(2);
    const ex = await app.download(() => app.menuItem('추출').click());
    expect(qpdfCheck(ex.path).ok).toBe(true);
    expect(texts(inspect(ex.bytes))).toEqual(['A-2', 'A-3']);
    // 분할…: 범위로 ZIP
    await app.openCellMenu(2);
    await app.menuItem('분할…').click();
    const pop = page.getByRole('dialog', { name: '나누기' });
    await expect(pop).toBeVisible();
    await pop.getByRole('textbox', { name: '쪽 범위' }).fill('1-2,3-5');
    const zip = await app.download(() => pop.getByTestId('split-run').click(), '.zip');
    expect(readZip(zip.bytes).map((e) => texts(inspect(e.data)))).toEqual([['A-1', 'A-1'], ['A-2', 'A-3', 'A-4']]);
  });

  test('파일 항목 메뉴: 모든 쪽 선택·저장·닫기(변경이 있으면 확인이 먼저)', async ({ app, page }) => {
    await openOrganize(app, ABC, 'docB.pdf');
    await app.openFileMenu('docB.pdf');
    const items = (await app.menuItems()).filter((t) => !t.startsWith('인쇄'));
    expect(items).toEqual(['이 파일의 모든 쪽 선택', '이 파일의 쪽 선택 해제', '저장', '닫기']);
    await app.menuItem('이 파일의 모든 쪽 선택').click();
    await expect.poll(async () => (await app.doc('docB.pdf')).selected.length).toBe(4);
    expect((await app.fileBadges())[1]).toBe(4);
    await app.openFileMenu('docB.pdf');
    await expect(app.menuItem('이 파일의 모든 쪽 선택')).toBeDisabled(); // 이미 전부 선택
    await app.menuItem('이 파일의 쪽 선택 해제').click();
    await expect.poll(async () => (await app.doc('docB.pdf')).selected.length).toBe(0);
    await app.openFileMenu('docB.pdf');
    const saved = await app.download(async () => {
      await app.menuItem('저장').click();
      await expect(app.saveDialog()).toBeVisible(); // 정리 모드의 파일 저장도 이름 확인을 거친다
      await expect(app.saveDialog().getByRole('textbox')).toHaveValue('docB-편집.pdf');
      await app.confirmSaveDialog();
    });
    expect(qpdfCheck(saved.path).ok).toBe(true);
    // 변경 없는 파일은 바로 닫힌다
    await app.openFileMenu('docC.pdf');
    await app.menuItem('닫기').click();
    await expect.poll(() => app.fileNames()).toEqual(['docA.pdf', 'docB.pdf']);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    // 변경이 있으면 확인 안내가 먼저
    await app.change(() => app.thumbAction(0, 'rotate'));
    await app.openFileMenu('docB.pdf');
    await app.menuItem('닫기').click();
    await expect(page.getByRole('alertdialog', { name: '저장하지 않은 변경' })).toBeVisible();
    expect((await app.summary()).docs).toHaveLength(2);
    await page.keyboard.press('Escape');
  });
});

test.describe('정리 모드: 선택한 쪽 모두 → 새 파일', () => {
  test('파일마다 고른 쪽을 순서대로 합쳐 새 파일로(복사·이동), 이동은 한 번에 되돌려진다', async ({ app, page }) => {
    await openOrganize(app, ABC, 'docA.pdf');
    const sendAll = page.getByTestId('send-all-new');
    await expect(sendAll).toBeDisabled();
    await app.clickCell(1);
    await app.selectFile('docB.pdf');
    await app.clickCell(0);
    await app.clickCell(2, ['Control']);
    await app.selectFile('docC.pdf');
    await expect(sendAll).toHaveText('선택한 쪽 모두 → 새 파일 (3)');
    await app.change(() => sendAll.click());
    expect(await app.fileNames()).toEqual(['docA.pdf', 'docB.pdf', 'docC.pdf', '새 문서 1.pdf']);
    expect(await app.activeFileName()).toBe('새 문서 1.pdf');
    const s = await app.saveAndInspect();
    expect(texts(s.info)).toEqual(['A-2', 'B-1', 'B-3']);
    expect(await app.pageCounts()).toEqual([5, 4, 3, 3]); // 복사라 원본 그대로
    await page.keyboard.press('Control+z'); // 복사로 만든 새 파일은 되돌려도 닫히지 않는다
    await expect(app.tabNotice()).toContainText('만든 시점');
    expect(await app.fileNames()).toHaveLength(4);
    await closeDoc(app, '새 문서 1.pdf');
    await expect.poll(() => app.fileNames()).toHaveLength(3);
    expect(await app.fileNames()).toEqual(['docA.pdf', 'docB.pdf', 'docC.pdf']);

    // 이동
    await app.selectFile('docC.pdf');
    await app.clickCell(2);
    expect((await app.summary()).docs.map((d) => d.selected)).toEqual([[1], [0, 2], [2]]);
    await page.getByRole('button', { name: '선택한 쪽 모두 보내기 방식' }).click();
    await app.change(() => page.getByTestId('send-all-move').click());
    expect(await app.pageCounts()).toEqual([4, 2, 2, 4]);
    expect(texts((await app.saveAndInspect()).info)).toEqual(['A-2', 'B-1', 'B-3', 'C-3']);
    await expect(app.tabNotice()).toContainText('함께');
    await app.undo();
    expect(await app.fileNames()).toEqual(['docA.pdf', 'docB.pdf', 'docC.pdf']);
    expect(await app.pageCounts()).toEqual([5, 4, 3]);
    expect((await app.summary()).docs.map((d) => d.selected)).toEqual([[1], [0, 2], [2]]); // 선택도 복원
    await app.redo();
    expect(await app.fileNames()).toEqual(['docA.pdf', 'docB.pdf', 'docC.pdf', '새 문서 2.pdf']);
    expect(await app.pageCounts()).toEqual([4, 2, 2, 4]);
    await app.undo();

    // 한 파일의 모든 쪽이 사라지는 이동은 막는다
    await app.selectFile('docC.pdf');
    await app.clickCell(0);
    await page.keyboard.press('Control+a');
    await app.selectFile('docA.pdf');
    await app.clickCell(0);
    await page.getByRole('button', { name: '선택한 쪽 모두 보내기 방식' }).click();
    await page.getByTestId('send-all-move').click();
    const note = page.locator('[data-notice=error]');
    await expect(note).toContainText('docC.pdf');
    await expect(note).toContainText('빈 문서');
    expect(await app.pageCounts()).toEqual([5, 4, 3]);
  });
});

test.describe('정리 모드: 선택', () => {
  test.use({ viewport: { width: 1400, height: 1100 } });
  test('클릭·Ctrl·Shift·러버밴드·Ctrl+A·Esc 로 쪽을 고른다', async ({ app, page }) => {
    await openOrganize(app, G.p24);
    const { cols } = await app.gridState();
    expect(cols).toBeGreaterThanOrEqual(6);
    const idx = (r: number, c: number) => r * cols + c;
    const box = async (i: number) => (await app.cellFace(i).boundingBox())!;
    const c0 = await box(0);
    const a = await box(idx(1, 1));
    const d = await box(idx(2, 2));
    const left = await box(idx(1, 0));
    // 러버밴드: 빈 곳에서 시작해 2×2 칸을 감싼다
    const start = { x: left.x + left.width + 6, y: a.y + 6 };
    expect(await page.evaluate(({ x, y }) => !document.elementFromPoint(x, y)?.closest('[data-thumb]'), start)).toBe(true);
    const end = { x: d.x + d.width - 6, y: d.y + d.height - 6 };
    await app.dragMouse(start, end, { release: false });
    await expect(page.getByTestId('band')).toBeVisible();
    await app.releaseMouse();
    await expect.poll(() => app.selectedPages()).toEqual([idx(1, 1), idx(1, 2), idx(2, 1), idx(2, 2)]);
    await expect(page.getByTestId('band')).toHaveCount(0);
    // Ctrl+러버밴드는 기존 선택에 더한다
    const e0 = await box(idx(0, cols - 2));
    const e1 = await box(idx(0, cols - 1));
    await app.dragMouse({ x: e0.x - 6, y: e0.y - 6 }, { x: e1.x + e1.width - 6, y: e1.y + e1.height - 6 }, { steps: 8, modifiers: ['Control'] });
    await expect.poll(async () => (await app.selectedPages()).length).toBe(6);
    const sel2 = await app.selectedPages();
    for (const i of [idx(1, 1), idx(2, 2), idx(0, cols - 2), idx(0, cols - 1)]) expect(sel2).toContain(i);
    // 빈 곳 클릭 → 해제
    await page.mouse.click(c0.x - 18, a.y + 6);
    await expect.poll(() => app.selectedPages()).toEqual([]);
    // 클릭 / Ctrl / Shift
    await app.clickCell(2);
    await expect.poll(() => app.selectedPages()).toEqual([2]);
    await app.clickCell(5, ['Control']);
    await expect.poll(() => app.selectedPages()).toEqual([2, 5]);
    await app.clickCell(2, ['Control']);
    await expect.poll(() => app.selectedPages()).toEqual([5]);
    await app.clickCell(3);
    await app.clickCell(8, ['Shift']);
    await expect.poll(() => app.selectedPages()).toEqual([3, 4, 5, 6, 7, 8]);
    await app.clickCell(12, ['Control', 'Shift']);
    await expect.poll(() => app.selectedPages()).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // Ctrl+A / Esc / 배지 / aria-selected
    await app.clickCell(10);
    await page.keyboard.press('Control+a');
    await expect.poll(async () => (await app.selectedPages()).length).toBe(24);
    expect((await app.fileBadges())[0]).toBe(24);
    await page.keyboard.press('Escape');
    await expect.poll(() => app.selectedPages()).toEqual([]);
    await app.clickCell(1);
    await expect(app.cell(1)).toHaveAttribute('aria-selected', 'true');
  });

  test('키보드: 방향키·Home/End 로 칸을 옮기고 Space/Enter 로 토글, Shift+방향키로 범위, Delete 로 삭제, 메뉴 키', async ({ app, page }) => {
    await openOrganize(app, G.p24);
    const { cols } = await app.gridState();
    const grid = page.getByTestId('grid');
    await app.clickCell(0);
    const act = () => grid.getAttribute('aria-activedescendant');
    await expect.poll(act).toBe('gc-0');
    await page.keyboard.press('ArrowRight');
    await expect.poll(act).toBe('gc-1');
    await page.keyboard.press('ArrowDown');
    await expect.poll(act).toBe(`gc-${1 + cols}`);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(act).toBe(`gc-${cols}`);
    await page.keyboard.press('ArrowUp');
    await expect.poll(act).toBe('gc-0');
    await page.keyboard.press('End');
    await expect.poll(act).toBe('gc-23');
    await expect.poll(async () => {
      const g = (await grid.boundingBox())!;
      const c = (await app.cell(23).boundingBox())!;
      return c.y + c.height <= g.y + g.height + 1 && c.y >= g.y - 1;
    }).toBe(true);
    await page.keyboard.press('Home');
    await expect.poll(act).toBe('gc-0');
    await page.keyboard.press('Escape');
    await page.keyboard.press(' ');
    await expect.poll(() => app.selectedPages()).toEqual([0]);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect.poll(() => app.selectedPages()).toEqual([0, 1]);
    await page.keyboard.press('Enter');
    await expect.poll(() => app.selectedPages()).toEqual([0]);
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => app.selectedPages()).toEqual([1, 2, 3]);
    await app.change(() => page.keyboard.press('Delete'));
    expect(await app.total()).toBe(21);
    // ContextMenu 키
    await app.clickCell(3);
    await page.keyboard.press('ContextMenu');
    await expect(app.contextMenu()).toBeVisible();
    await expect(app.menuItem('복사 →')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(grid).toBeFocused();
    await page.keyboard.press('g');
    await expect.poll(async () => (await app.summary()).mode).toBe('view');
  });
});

test.describe('정리 모드: 격자 재정렬', () => {
  test.use({ viewport: { width: 1400, height: 1100 } });
  test('행을 가로지르는 이동·다중 선택 끌기·Esc 취소', async ({ app, page }) => {
    await openOrganize(app, G.p24);
    const { cols } = await app.gridState();
    const lab = (arr: number[]) => arr.map((i) => `P-${i + 1}`);
    const dropLine = () => page.getByTestId('drop-line').getAttribute('data-before');
    const drop = async (from: number, beforeCell: number, side: 'left' | 'right') => {
      await app.scrollCell(from);
      const f = await app.center(app.cellFace(from));
      const t = (await app.cellFace(beforeCell).boundingBox())!;
      const to = { x: side === 'left' ? t.x + 8 : t.x + t.width - 8, y: t.y + t.height / 2 };
      await app.dragMouse(f, to, { release: false });
      const line = await dropLine();
      await app.change(() => app.releaseMouse());
      return line;
    };
    // 1쪽(idx 1) → 행 1 의 열 3 칸 앞
    const tgt = cols + 3;
    expect(await drop(1, tgt, 'left')).toBe(String(tgt));
    let order = Array.from({ length: 24 }, (_, i) => i).filter((i) => i !== 1);
    order.splice(tgt - 1, 0, 1);
    expect(texts((await app.saveAndInspect()).info)).toEqual(lab(order));
    // 뒤 → 앞: 마지막 줄 idx 20 을 행 0 의 열 2 칸 앞으로
    expect(await drop(20, 2, 'left')).toBe('2');
    const cur = order.slice();
    const moved = cur.splice(20, 1)[0];
    cur.splice(2, 0, moved);
    expect(texts((await app.saveAndInspect()).info)).toEqual(lab(cur));
    // 여러 쪽(비연속)을 골라 끌어 맨 끝으로
    await app.clickCell(0);
    await app.clickCell(4, ['Control']);
    await app.clickCell(9, ['Control']);
    const picked = [0, 4, 9];
    const f = await app.center(app.cellFace(4));
    const t = (await app.cellFace(23).boundingBox())!;
    await app.dragMouse(f, { x: t.x + t.width - 6, y: t.y + t.height / 2 }, { release: false });
    expect(await dropLine()).toBe('24');
    await app.change(() => app.releaseMouse());
    const rest = cur.filter((_, i) => !picked.includes(i));
    const mv = picked.map((i) => cur[i]);
    expect(texts((await app.saveAndInspect()).info)).toEqual(lab([...rest, ...mv]));
    expect((await app.summary()).docs[0].selected).toEqual([21, 22, 23]); // 옮긴 쪽이 선택 유지
    // Esc 취소
    await app.scrollCell(0);
    await app.clickCell(0);
    const f0 = await app.center(app.cellFace(0));
    const t0 = (await app.cellFace(10).boundingBox())!;
    await app.dragMouse(f0, { x: t0.x + 8, y: t0.y + 20 }, { release: false });
    await page.keyboard.press('Escape');
    await app.releaseMouse();
    await expect(page.getByTestId('drop-line')).toHaveCount(0);
    expect((await app.summary()).docs[0].undo).toBe(3);
  });
});

test.describe('정리 모드: 썸네일 크기', () => {
  test('슬라이더 속성·레이아웃·키보드·Ctrl+휠·설정 저장, 줄일 때는 다시 그리지 않고 키울 때만 해상도를 채운다', async ({ app, page }) => {
    await openOrganize(app, [G.docA, G.p24], 'docA.pdf');
    const slider = page.getByRole('slider', { name: '썸네일 크기' });
    await expect(slider).toHaveAttribute('min', '80');
    await expect(slider).toHaveAttribute('max', '640');
    await slider.fill('120');
    await app.renderQuiet();
    const c0 = await app.renderCalls();
    await slider.fill('80');
    await expect.poll(async () => (await app.gridState()).size).toBe(80);
    expect(await app.renderQuiet()).toBe(c0); // 줄일 때는 다시 그리지 않는다
    // 키울 때: 멈춘 뒤 보이는 5쪽을 다시 그리고 해상도가 표시 폭을 채운다
    await slider.fill('300');
    await expect.poll(async () => (await app.gridState()).size).toBe(300);
    const c2 = await app.renderQuiet();
    expect(c2 - c0).toBeGreaterThanOrEqual(5);
    const log = await page.evaluate(() => (globalThis as unknown as { __pdfeditStats: { log: [number, number][] } }).__pdfeditStats.log.slice(-5));
    const PW = [300, 310, 320, 330, 340];
    expect(log.every(([p, s]) => s * PW[p] >= 296), JSON.stringify(log)).toBe(true);
    await slider.fill('150');
    expect(await app.renderQuiet()).toBe(c2); // 300→150 도 다시 그리지 않는다
    // 연속 조절 뒤 재렌더는 쪽당 한 번 안팎
    const c4a = await app.renderCalls();
    for (const v of [160, 180, 220, 260, 310]) await slider.fill(String(v));
    const c4 = await app.renderQuiet();
    expect(c4 - c4a).toBeGreaterThanOrEqual(5);
    expect(c4 - c4a).toBeLessThanOrEqual(10);
    // 최소·최대·중간에서 레이아웃(가로 넘침·칸 이탈·겹침 없음)
    for (const v of [80, 640, 200]) {
      await slider.fill(String(v));
      await expect.poll(async () => (await app.gridState()).size).toBe(v);
      const gs = await app.gridState();
      const lay = await page.evaluate(() => {
        const g = document.querySelector('[data-testid=grid]')!.getBoundingClientRect();
        const cs = [...document.querySelectorAll('[data-cell]')].map((c) => c.getBoundingClientRect());
        const inside = cs.every((r) => r.left >= g.left - 1 && r.right <= g.right + 1);
        let overlap = false;
        for (let i = 0; i < cs.length; i++)
          for (let j = i + 1; j < cs.length; j++) {
            const a = cs[i], c = cs[j];
            if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) overlap = true;
          }
        const th = [...document.querySelectorAll('[data-thumb]')].every((t) => {
          const f = t.closest('[data-cell]')!.getBoundingClientRect();
          const r = t.getBoundingClientRect();
          return r.left >= f.left - 1 && r.right <= f.right + 1 && r.top >= f.top - 1 && r.bottom <= f.bottom + 1;
        });
        return { inside, overlap, thumbsInCell: th };
      });
      expect(gs.sw, `${v}px 가로 넘침`).toBeLessThanOrEqual(gs.cw);
      expect(lay).toEqual({ inside: true, overlap: false, thumbsInCell: true });
    }
    // 슬라이더 키보드
    await slider.focus();
    const before = Number(await slider.inputValue());
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => Number(await slider.inputValue())).toBeLessThan(before);
    // Ctrl+휠: 위로 커지고 아래로 작아진다
    const g = (await page.getByTestId('grid').boundingBox())!;
    await page.mouse.move(g.x + 300, g.y + 200);
    const w0 = (await app.gridState()).size;
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await expect.poll(async () => (await app.gridState()).size).toBeGreaterThan(w0);
    const w1 = (await app.gridState()).size;
    await page.mouse.wheel(0, 100);
    await expect.poll(async () => (await app.gridState()).size).toBeLessThan(w1);
    await page.keyboard.up('Control');
    const w2 = (await app.gridState()).size;
    await expect.poll(async () => (await app.settingsInStorage()).gridThumb).toBe(w2);
    // 설정 서랍의 슬라이더도 같은 값을 바꾼다
    const drawer = await app.openSettings();
    await drawer.getByRole('slider', { name: /정리 모드 썸네일 크기/ }).fill('200');
    await expect.poll(async () => (await app.gridState()).size).toBe(200);
    await app.closeSettings();
    // 큰 문서에서 크기를 바꿔도 맨 위에 보이던 쪽 근처를 유지한다
    await app.selectFile('docP.pdf');
    await page.getByTestId('grid').evaluate((e) => (e.scrollTop = 600));
    const topCell = () =>
      page.evaluate(() => {
        const g = document.querySelector('[data-testid=grid]')!.getBoundingClientRect();
        const c = [...document.querySelectorAll('[data-cell]')].find((x) => x.getBoundingClientRect().bottom > g.top + 4)!;
        return Number((c as HTMLElement).dataset.cell);
      });
    await expect.poll(topCell).toBeGreaterThan(0);
    const topBefore = await topCell();
    await slider.fill('120');
    await expect.poll(async () => (await app.gridState()).size).toBe(120);
    const cols = (await app.gridState()).cols;
    await expect.poll(async () => Math.abs((await topCell()) - topBefore)).toBeLessThanOrEqual(cols * 2);
  });
});

test.describe('정리 모드: 터치', () => {
  test.use({ hasTouch: true });
  test('길게 누르면 우클릭 메뉴가 뜨고, 짧게 누르거나 누른 채 움직이면 뜨지 않는다', async ({ app, page }) => {
    await openOrganize(app, [G.docA, G.docB], 'docA.pdf');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await app.scrollCell(2);
    const p = await app.center(app.cellFace(2));
    // 길게 누르기(준비) 뒤 움직이지 않고 떼면 메뉴(움직이면 끌기라서 메뉴는 손을 뗄 때 연다)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
    await page.waitForTimeout(700);
    await expect(app.contextMenu()).toHaveCount(0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(app.contextMenu()).toBeVisible({ timeout: 5000 });
    expect((await app.menuItems()).filter((t) => !t.startsWith('인쇄'))).toHaveLength(8);
    expect((await app.summary()).docs[0].selected).toEqual([2]);
    // 메뉴 바깥을 눌러 닫는다
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 5, y: 880, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(app.contextMenu()).toHaveCount(0);
    // 짧게 누르기
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(app.contextMenu()).toHaveCount(0);
    // 누른 채 움직이면 취소. 길게 누르기 시간이 지나도 뜨지 않음을 보이려면 시간이 흘러야 한다
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y + 40, id: 1 }] });
    await page.waitForTimeout(1200); // 부정 확인(메뉴가 뜨지 않음)은 길게 누르기 제한 시간이 지나야 의미가 있다
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(app.contextMenu()).toHaveCount(0);
  });
});

test.describe('정리 모드: 300쪽', () => {
  test.setTimeout(240_000);
  test('최소 크기에서 빠르게 스크롤해도 동시 캔버스·진행 중 렌더에 상한이 있고, 맨 끝 쪽이 그려진다', async ({ app, page }) => {
    await openOrganize(app, G.big300);
    const slider = page.getByRole('slider', { name: '썸네일 크기' });
    await slider.fill('80');
    await expect.poll(async () => (await app.gridState()).size).toBe(80);
    await app.renderQuiet();
    await app.startSampler('[data-cell] canvas');
    await app.smoothScroll('grid', 0, 600, 4);
    await app.smoothScroll('grid', 0, 4000, 5);
    await app.smoothScroll('grid', 0, 20000, 3);
    await app.renderQuiet();
    const r = await app.stopSampler();
    expect(r.live, `동시 캔버스 ${r.live} (DOM 칸 ${r.dom})`).toBeLessThanOrEqual(120);
    expect(r.inFlight).toBeLessThanOrEqual(2);
    expect(r.errors).toBe(0);
    const s = await page.evaluate(() => (globalThis as unknown as { __pdfeditStats: { canceledQueued: number; discarded: number } }).__pdfeditStats);
    expect(s.canceledQueued + s.discarded).toBeGreaterThan(0);
    await page.getByTestId('grid').evaluate((e) => (e.scrollTop = 1e9));
    await app.cellDrawn(299);
    // 최대 크기에서도 상한
    await slider.fill('640');
    await expect.poll(async () => (await app.gridState()).size).toBe(640);
    await app.renderQuiet();
    await app.startSampler('[data-cell] canvas');
    await app.smoothScroll('grid', 0, 3000, 4);
    await app.renderQuiet();
    expect((await app.stopSampler()).live).toBeLessThanOrEqual(120);
  });
});
