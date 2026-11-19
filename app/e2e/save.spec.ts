import { test, expect, brief, qpdfCheck, readBytes } from './helpers.ts';
import { GENERATED as G, SAMPLES } from './fixtures/paths.ts';
import { FIVE, inspect } from './fixtures/synth.ts';

const startsWith = (out: Uint8Array, prefix: Uint8Array) => out.length >= prefix.length && prefix.every((b, i) => out[i] === b);
const initial = FIVE.map((p) => `${p.text}:${p.rotate ?? 0}`).join(',');

test.describe('저장 옵션', () => {
  test('옵션 3개: 기본값·호버 설명·충돌 안내, 바꾼 값은 설정에 저장된다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const pop = await app.saveOptions();
    const boxes = pop.getByRole('checkbox');
    await expect(boxes).toHaveCount(3);
    await expect(pop.getByRole('textbox')).toHaveCount(0); // 이름 입력은 저장 대화상자 한 곳에만 있다
    expect(await boxes.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked))).toEqual([true, false, false]);
    // 각 옵션은 호버 설명(title)을 갖는다
    expect(await pop.locator('label').evaluateAll((ls) => ls.every((l) => (l as HTMLElement).title.length > 20))).toBe(true);
    await expect(pop.getByRole('status')).toHaveCount(0);
    // 변경분만 덧붙이기 + 정리를 함께 켜면 정리는 적용되지 않는다는 안내
    await boxes.nth(1).check();
    await expect(pop.getByRole('status')).toContainText('정리는 적용되지 않습니다');
    await boxes.nth(2).check();
    await expect.poll(async () => {
      const s = await app.settingsInStorage();
      return [s.incremental, s.garbageCollect, s.flatten];
    }).toEqual([true, true, true]);
    // Esc 로 닫는다
    await app.closeSaveOptions();
    await expect(page.getByRole('dialog', { name: '저장 옵션' })).toHaveCount(0);
  });

  test('저장한 옵션은 같은 컨텍스트의 새로고침 뒤에도 복원된다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const pop = await app.saveOptions();
    await pop.getByRole('checkbox').nth(0).uncheck();
    await pop.getByRole('checkbox').nth(1).check();
    await expect.poll(async () => (await app.settingsInStorage()).incremental).toBe(false);
    await page.reload();
    await page.locator('[data-testid=file-input]').waitFor({ state: 'attached' });
    await app.open(G.five);
    const pop2 = await app.saveOptions();
    expect(await pop2.getByRole('checkbox').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked))).toEqual([false, true, false]);
  });
});

test.describe('저장: 서명 PDF 와 증분 저장', () => {
  test('증분 저장(기본)은 원본 바이트를 접두로 보존하고, 끄면 전체를 다시 쓴다', async ({ app }) => {
    const orig = readBytes(SAMPLES.signed);
    await app.goto();
    await app.open(SAMPLES.signed);
    // 조작 없이 저장: 안내 없음
    const a = await app.save();
    expect(startsWith(a.bytes, orig), `orig=${orig.length} out=${a.bytes.length}`).toBe(true);
    expect(await app.noticeTexts()).toEqual([]);
    expect(qpdfCheck(a.path).ok).toBe(true);
    // 회전 후 저장도 접두 보존, 회전이 반영된다
    await app.change(() => app.thumbAction(0, 'rotate'));
    const r = await app.save();
    expect(startsWith(r.bytes, orig)).toBe(true);
    expect(inspect(r.bytes)[0].rotate).toBe(90);
    // undo 뒤 저장도 접두 보존
    await app.undo();
    expect(startsWith((await app.save()).bytes, orig)).toBe(true);
    // 증분 + 정리: 삭제가 없으면 안내 없이 접두 보존(정리는 적용되지 않음)
    const pop = await app.saveOptions();
    await pop.getByRole('checkbox').nth(1).check();
    await app.closeSaveOptions();
    const g = await app.save();
    expect(startsWith(g.bytes, orig)).toBe(true);
    expect(await app.noticeTexts()).toEqual([]);
    // 증분을 끄면 전체 저장: 접두가 달라지지만 qpdf 는 통과한다
    const pop2 = await app.saveOptions();
    await pop2.getByRole('checkbox').nth(0).uncheck();
    await app.closeSaveOptions();
    const f = await app.save();
    expect(startsWith(f.bytes, orig)).toBe(false);
    expect(qpdfCheck(f.path).ok).toBe(true);
    await expect.poll(async () => {
      const s = await app.settingsInStorage();
      return [s.incremental, s.garbageCollect, s.flatten];
    }).toEqual([false, true, false]);
  });
});

test.describe('저장: 정리(gc)·평탄화·안내', () => {
  test('삭제한 쪽이 있으면 증분+정리는 안내하고, 증분을 끄면 정리가 적용되어 더 작다', async ({ app }) => {
    await app.goto();
    await app.open(G.five);
    const pop = await app.saveOptions();
    await pop.getByRole('checkbox').nth(1).check();
    await app.closeSaveOptions();
    await app.save();
    expect(await app.noticeTexts()).toEqual([]); // 삭제 전에는 안내 없음
    await app.change(() => app.thumbAction(1, 'delete'));
    const inc = await app.save();
    await expect.poll(() => app.noticeTexts()).toEqual([expect.stringContaining('삭제한 쪽의 데이터가 파일에 남아')]);
    await app.dismissNotices();
    const pop2 = await app.saveOptions();
    await pop2.getByRole('checkbox').nth(0).uncheck();
    await app.closeSaveOptions();
    const full = await app.save();
    await expect.poll(() => app.noticeTexts()).toEqual([]);
    expect(full.bytes.length, `증분 ${inc.bytes.length} / 정리 ${full.bytes.length}`).toBeLessThanOrEqual(inc.bytes.length);
    expect(inspect(full.bytes)).toHaveLength(4);
    expect(qpdfCheck(full.path).ok).toBe(true);
  });

  test('PDFium + 평탄화는 전체를 다시 써야 한다는 안내를 하고, PDFium 에서도 쪽 조작이 된다', async ({ app }) => {
    await app.goto({ engine: 'pdfium', flatten: true });
    await app.open(G.five);
    expect((await app.summary()).docs[0].kind).toBe('pdfium');
    const s = await app.save();
    await expect.poll(() => app.noticeTexts()).toEqual([expect.stringContaining('전체를 다시 써야')]);
    expect(qpdfCheck(s.path).ok).toBe(true);
    // 복제·재정렬·회전·삭제
    await app.change(() => app.thumbAction(1, 'copy'));
    expect(await app.total()).toBe(6);
    const from = await app.center(app.thumbFace(2));
    const t = (await app.thumbFace(0).boundingBox())!;
    await app.change(() => app.dragMouse(from, { x: t.x + t.width / 2, y: t.y + 4 }, { steps: 10 }));
    await app.change(() => app.thumbAction(3, 'rotate'));
    await app.change(() => app.thumbAction(4, 'delete'));
    expect(qpdfCheck((await app.save()).path).ok).toBe(true);
    for (let k = 0; k < 4; k++) await app.undo();
    expect(brief((await app.saveAndInspect()).info)).toBe(initial);
  });
});

test.describe('저장: 파일 이름', () => {
  test('<원본>-편집.pdf 이고 확장자 앞의 점은 보존한다', async ({ app }) => {
    await app.goto();
    await app.open(G.five);
    expect((await app.save()).name).toBe('five-편집.pdf');
    await app.open(SAMPLES.koEmbedded);
    expect((await app.save()).name).toBe('ko_embedded-편집.pdf');
  });

  test('저장 단추·Ctrl+S 는 이름 확인 대화상자를 먼저 띄운다: 기본 이름, 확장자 앞만 선택, 포커스, 뒤 화면 막힘', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    for (const via of ['button', 'ctrlS'] as const) {
      const dlg = await app.openSaveDialog(via);
      await expect(dlg).toHaveAttribute('aria-modal', 'true');
      await expect(dlg.getByRole('heading', { name: '저장 파일 이름' })).toBeVisible();
      const input = dlg.getByRole('textbox');
      await expect(input).toHaveValue('five-편집.pdf');
      await expect(input).toBeFocused();
      expect(await input.evaluate((e: HTMLInputElement) => [e.selectionStart, e.selectionEnd])).toEqual([0, 'five-편집'.length]);
      // 확정 단추는 '저장' 하나(주 단추), 나머지는 '취소'
      await expect(dlg.getByRole('button')).toHaveText(['취소', '저장']);
      await expect(dlg.locator('button.primary')).toHaveCount(1);
      // 뒤 화면(저장 단추가 있는 머리글)은 inert 로 막혀 있다
      expect(await page.getByTestId('save').evaluate((e) => !!e.closest('[inert]'))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(dlg).toHaveCount(0);
      expect(await page.getByTestId('save').evaluate((e) => !!e.closest('[inert]'))).toBe(false);
    }
  });

  test('저장 대화상자: Esc·취소는 내려받지 않고 저장 단추로 포커스가 돌아온다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    let downloaded = false;
    page.on('download', () => (downloaded = true));
    await app.openSaveDialog();
    await page.keyboard.press('Escape');
    await expect(app.saveDialog()).toHaveCount(0);
    await expect(page.getByTestId('save')).toBeFocused();
    await app.openSaveDialog();
    await app.saveDialog().getByRole('button', { name: '취소' }).click();
    await expect(app.saveDialog()).toHaveCount(0);
    await expect(page.getByTestId('save')).toBeFocused();
    await page.waitForTimeout(400);
    expect(downloaded).toBe(false);
  });

  test('저장 대화상자: 한글 조합 중 Enter 는 무시, 확정한 이름은 정리해 그 이름으로 저장하고 기억한다', async ({ app }) => {
    await app.goto();
    await app.open(G.five);
    const dlg = await app.openSaveDialog();
    const input = dlg.getByRole('textbox');
    // 조합 중(isComposing)의 Enter 는 확정이 아니다
    await input.fill('계약서');
    await input.evaluate((e) => e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    await expect(dlg).toBeVisible();
    // 금지 문자 제거·.pdf 보정
    const a = await app.download(async () => {
      await input.fill('계약서:최종?');
      await input.press('Enter');
    });
    expect(a.name).toBe('계약서최종.pdf');
    await expect(app.saveDialog()).toHaveCount(0);
    // 다음에는 기억한 이름이 기본값이다. 빈 값은 그 기본값으로 돌아간다
    const dlg2 = await app.openSaveDialog();
    await expect(dlg2.getByRole('textbox')).toHaveValue('계약서최종.pdf');
    const b = await app.download(async () => {
      await dlg2.getByRole('textbox').fill('');
      await dlg2.getByRole('textbox').press('Enter');
    });
    expect(b.name).toBe('계약서최종.pdf');
    // '저장' 단추로 확정
    const c = await app.download(async () => {
      await app.openSaveDialog('ctrlS');
      await app.saveDialog().getByRole('textbox').fill('내 이름');
      await app.saveDialog().getByRole('button', { name: '저장' }).click();
    });
    expect(c.name).toBe('내 이름.pdf');
  });

  test('저장 대화상자가 떠 있는 동안 Ctrl+S 는 두 번째 대화상자를 만들지 않는다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    await app.openSaveDialog();
    await page.keyboard.press('Control+s');
    await expect(app.saveDialog()).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(app.saveDialog()).toHaveCount(0);
  });

  test('같은 이름으로 열린 문서는 (2) 가 붙은 이름을 기준으로 저장한다', async ({ app }) => {
    await app.goto();
    await app.open(G.five);
    await app.open(G.five);
    expect(await app.tabNames()).toEqual(['five.pdf', 'five (2).pdf']);
    expect((await app.save()).name).toBe('five (2)-편집.pdf');
  });

  test('Ctrl+S 와 저장 단추는 같은 파일을 만든다', async ({ app }) => {
    await app.goto();
    await app.open(G.five);
    await app.change(() => app.thumbAction(0, 'rotate'));
    const a = await app.save('ctrlS');
    const b = await app.save('button');
    expect(a.name).toBe(b.name);
    expect(brief(inspect(a.bytes))).toBe(brief(inspect(b.bytes)));
  });
});
