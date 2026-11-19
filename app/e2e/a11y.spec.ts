import { test, expect, type App } from './helpers.ts';
import { GENERATED as G, SAMPLES } from './fixtures/paths.ts';

/** 글자 없이 아이콘만 있는 단추 중 이름(aria-label)·title 이 없는 것, 그리고 작은 터치 대상을 찾는다 */
async function auditButtons(app: App, minSize = 28) {
  return app.page.evaluate((min) => {
    const bad: string[] = [];
    const small: string[] = [];
    for (const b of document.querySelectorAll('button')) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // 보이지 않는 단추는 제외
      const text = (b.textContent ?? '').trim();
      const label = b.getAttribute('aria-label') ?? '';
      const desc = label || text || b.getAttribute('title') || '(이름 없음)';
      if (!text) {
        if (!label) bad.push(`aria-label 없음: ${b.outerHTML.slice(0, 80)}`);
        else if (!b.title) bad.push(`title 없음: ${label}`);
      }
      // 터치 대상: 아이콘 단추(글자 없음)는 28px 이상이어야 한다
      if (!text && (r.width < min || r.height < min)) small.push(`${desc} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return { bad, small };
  }, minSize);
}

test.describe('접근성: 아이콘 단추', () => {
  test('보기 모드: 모든 아이콘 단추에 aria-label·title 이 있고 터치 대상이 28px 이상이다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    await app.thumb(0).hover(); // 호버해야 나타나는 체크박스
    await expect(app.pageCheckbox(0)).toBeVisible();
    let r = await auditButtons(app);
    expect(r.bad, r.bad.join('\n')).toEqual([]);
    expect(r.small, r.small.join('\n')).toEqual([]);
    // 주석 도구 모음
    await app.openAnnotToolbar();
    const tools = page.getByRole('toolbar', { name: '주석 도구' }).getByRole('button');
    expect(await tools.count()).toBeGreaterThanOrEqual(6);
    expect(await tools.evaluateAll((els) => els.every((x) => x.getAttribute('aria-label') && (x as HTMLElement).title === x.getAttribute('aria-label')))).toBe(true);
    // 팝오버·서랍을 열어도 마찬가지
    await app.topButton('나누기').click();
    r = await auditButtons(app);
    expect(r.bad, r.bad.join('\n')).toEqual([]);
    await page.keyboard.press('Escape');
    await app.openSettings();
    r = await auditButtons(app);
    expect(r.bad, r.bad.join('\n')).toEqual([]);
    expect(r.small, r.small.join('\n')).toEqual([]);
  });

  test('정리 모드: 파일 목록·격자 항목 단추도 이름과 크기를 갖는다', async ({ app, page }) => {
    await app.goto();
    await app.open([G.docA, G.docB]);
    await app.setMode('organize');
    await app.cellDrawn(0);
    await app.cell(0).hover();
    const r = await auditButtons(app);
    expect(r.bad, r.bad.join('\n')).toEqual([]);
    expect(r.small, r.small.join('\n')).toEqual([]);
    // 파일 목록 닫기 단추
    const closes = page.getByTestId('file-close');
    expect(await closes.evaluateAll((els) => els.every((x) => { const b = x.getBoundingClientRect(); return b.width >= 28 && b.height >= 28 && x.getAttribute('aria-label') && (x as HTMLElement).title; }))).toBe(true);
  });

  test('탭 닫기 단추와 주석 핸들도 28px 이상이다', async ({ app, page }) => {
    await app.goto();
    await app.open([G.docA, G.docB]);
    const closes = page.getByTestId('tab-close');
    expect(await closes.evaluateAll((els) => els.every((x) => { const b = x.getBoundingClientRect(); return b.width >= 28 && b.height >= 28 && x.getAttribute('aria-label') && (x as HTMLElement).title; }))).toBe(true);
    // 주석 핸들: 사각형을 만들어 선택하면 핸들이 나타난다
    await app.open(SAMPLES.koEmbedded);
    await app.pickTool('사각형');
    await app.change(() => app.dragOnPage(595.304, [60, 300], [200, 360]));
    await expect(page.locator('[data-annot-handle]').first()).toBeVisible();
    expect(await page.locator('[data-annot-handle]').evaluateAll((els) => els.every((h) => { const r = h.getBoundingClientRect(); return r.width >= 28 && r.height >= 28; }))).toBe(true);
  });
});

test.describe('접근성: 역할과 이름', () => {
  test('탭·목록·도구 모음·대화상자·분할선·알림에 알맞은 role 과 이름이 있다', async ({ app, page }) => {
    await app.goto();
    await app.open([G.docA, G.docB]);
    await app.switchTab('docA.pdf');
    // 탭
    await expect(page.getByRole('tablist', { name: '열린 파일' })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.locator('[role=tab][aria-selected=true]')).toHaveCount(1);
    // 썸네일 목록·본문·작업 영역
    await expect(page.getByRole('list', { name: '페이지 썸네일' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: '페이지 목록' })).toBeVisible();
    await expect(page.getByRole('main', { name: '뷰어' })).toBeVisible();
    await expect(page.getByRole('region', { name: '작업 영역' })).toBeVisible();
    await expect(page.getByRole('separator', { name: '썸네일 패널 폭 조절' })).toHaveAttribute('aria-valuenow', '208');
    // 도구 모음
    await expect(page.getByRole('toolbar', { name: '선택한 쪽 조작' })).toBeVisible();
    await app.openAnnotToolbar();
    // 썸네일 단추는 쪽 번호와 선택 상태를 이름·aria-pressed 로 알린다
    await app.clickThumb(1);
    await expect(page.getByRole('button', { name: '2쪽으로 이동 (선택됨)' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-thumb] button[aria-current=page]')).toHaveCount(1);
    // 대화상자들
    await app.topButton('나누기').click();
    await expect(page.getByRole('dialog', { name: '나누기' })).toBeVisible();
    await page.keyboard.press('Escape');
    await app.topButton('열린 파일 병합').click();
    await expect(page.getByRole('dialog', { name: '열린 파일 병합' })).toBeVisible();
    await page.keyboard.press('Escape');
    await app.openSend();
    await expect(page.getByRole('radiogroup', { name: '보내는 방식' })).toBeVisible();
    await page.keyboard.press('Escape');
    await app.saveOptions();
    await app.closeSaveOptions();
    await app.openSaveDialog();
    await expect(app.saveDialog()).toHaveAttribute('aria-modal', 'true');
    await page.keyboard.press('Escape');
    await expect(app.saveDialog()).toHaveCount(0);
    await expect(page.getByTestId('save')).toBeFocused();
    await app.openSettings();
    await app.closeSettings();
    // 알림: 오류는 role=alert, 안내는 role=status
    await page.locator('[data-testid=file-input]').setInputFiles(G.broken);
    await expect(page.getByRole('alert').filter({ hasText: 'broken.pdf' })).toBeVisible();
    // 정리 모드: listbox/option, aria-multiselectable, 파일 목록
    await app.setMode('organize');
    const grid = page.getByRole('listbox', { name: '쪽 썸네일' });
    await expect(grid).toHaveAttribute('aria-multiselectable', 'true');
    await expect(grid.getByRole('option')).toHaveCount(5);
    await expect(page.getByRole('listbox', { name: '열린 파일' }).getByRole('option')).toHaveCount(2);
    await expect(page.getByRole('complementary', { name: '파일 목록' })).toBeVisible();
    await expect(page.getByRole('region', { name: '쪽 정리' })).toBeVisible();
    await expect(page.getByRole('slider', { name: '썸네일 크기' })).toBeVisible();
  });

  test('주석 속성·양식 칸에 이름이 있다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.formAll);
    await expect(page.getByRole('textbox', { name: 'name', exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'agree' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'city' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'color' })).toHaveCount(2);
    await expect(page.getByRole('button', { name: '다음 양식 칸으로 이동' })).toBeVisible();
    await app.pickTool('메모');
    await app.clickOnPage(595, [300, 100]);
    await app.change(() => app.typeInAnnotEditor('접근성 메모'));
    const props = page.getByRole('group', { name: /속성/ });
    await expect(props.getByRole('textbox', { name: '내용' })).toHaveValue('접근성 메모');
    await expect(page.getByRole('group', { name: '색' }).getByRole('button', { name: /^색 / }).first()).toBeVisible();
  });
});

test.describe('접근성: 키보드만으로 주요 흐름', () => {
  /** Tab(또는 Shift+Tab)으로 이름이 맞는 요소에 포커스가 올 때까지(상한 안에서) 이동한다 */
  async function tabTo(app: App, match: RegExp, { back = false, max = 80 } = {}) {
    for (let i = 0; i < max; i++) {
      await app.page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
      const label = await app.page.evaluate(() => {
        const e = document.activeElement as HTMLElement | null;
        return e ? (e.getAttribute('aria-label') ?? e.textContent ?? '').trim() : '';
      });
      if (match.test(label)) return label;
    }
    throw new Error(`Tab ${max}번 안에 ${match} 에 닿지 못함`);
  }

  test('Tab·Enter 만으로 쪽을 고르고 회전한 뒤 저장 단추에 닿아 저장한다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    await page.locator('body').click({ position: { x: 5, y: 5 } }); // 포커스를 문서 처음으로
    await tabTo(app, /^2쪽으로 이동/);
    await page.keyboard.press('Enter'); // 이동(선택 모드가 아니므로 선택은 하지 않는다)
    await expect(app.currentPageInput()).toHaveValue('2');
    await expect.poll(() => app.selectedPages()).toEqual([]);
    await tabTo(app, /^2쪽 선택$/); // 다음 Tab 정지는 같은 칸의 체크박스
    await page.keyboard.press('Space');
    await expect.poll(() => app.selectedPages()).toEqual([1]);
    // 거꾸로 Tab 해서 「선택한 쪽 회전」 단추에 닿아 누른다
    await tabTo(app, /^선택한 쪽 시계 방향 90° 회전$/, { back: true });
    await app.change(() => page.keyboard.press('Enter'));
    expect((await app.doc('five.pdf')).undo).toBe(1);
    // 저장 단추까지 Tab 으로 이동해 Enter
    await tabTo(app, /^저장$/);
    const saved = await app.download(async () => {
      await page.keyboard.press('Enter'); // 이름 확인 대화상자가 열리고 포커스는 이름 입력칸에 있다
      await expect(app.saveDialog().getByRole('textbox')).toBeFocused();
      await page.keyboard.press('Enter'); // Enter = 저장
    });
    expect(saved.name).toBe('five-편집.pdf');
    expect(saved.bytes.length).toBeGreaterThan(0);
  });

  test('정리 모드: 방향키로 칸을 옮기고 Space 로 고른 뒤 Delete 로 지우고 Ctrl+Z 로 되돌리며 G 로 돌아온다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    await page.keyboard.press('g');
    await expect(page.getByTestId('grid')).toBeVisible();
    await app.cellDrawn(0);
    await page.getByTestId('grid').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press(' ');
    await expect.poll(() => app.selectedPages()).toEqual([1]);
    await app.change(() => page.keyboard.press('Delete'));
    expect(await app.total()).toBe(4);
    await app.undo();
    expect(await app.total()).toBe(5);
    await page.keyboard.press('g');
    await expect(page.getByTestId('scroller')).toBeVisible();
  });

  test('탭 목록은 화살표로 이동하고, 설정 서랍은 키보드로 열고 Esc 로 닫는다', async ({ app, page }) => {
    await app.goto();
    await app.open([G.docA, G.docB]);
    await app.switchTab('docA.pdf');
    await app.tab('docA.pdf').focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => app.activeTabName()).toBe('docB.pdf');
    await app.topButton('설정').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: '설정' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '설정' })).toHaveCount(0);
  });
});
