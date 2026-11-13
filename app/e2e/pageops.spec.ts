import { test, expect, brief, texts, qpdfCheck, readZip } from './helpers.ts';
import { GENERATED as G, SAMPLES } from './fixtures/paths.ts';
import { FIVE, inspect } from './fixtures/synth.ts';

const initial = FIVE.map((p) => `${p.text}:${p.rotate ?? 0}`).join(',');

test.describe('쪽 조작', () => {
  test('회전·재정렬·복제·다중 선택·삭제를 하고 저장하면 쪽 순서·회전·크기가 맞고, 되돌리기·다시하기로 왕복한다', async ({ app, page }) => {
    // 다섯 쪽의 썸네일이 한 화면에 들어오도록 패널 폭을 고정한다(끌기 좌표가 화면 안이어야 한다)
    await app.goto({ sideWidth: 176 });
    await app.open(G.five);
    const model = FIVE.map((p) => ({ id: p.text, rot: p.rotate ?? 0 }));
    const expectBrief = () => model.map((m) => `${m.id}:${m.rot}`).join(',');

    // 1) 회전(항목 버튼) → 썸네일이 가로세로가 바뀐다
    const before = (await app.thumbFace(0).boundingBox())!;
    await app.change(() => app.thumbAction(0, 'rotate'));
    model[0].rot = 90;
    expect(before.height).toBeGreaterThan(before.width);
    await expect.poll(async () => { const b = (await app.thumbFace(0).boundingBox())!; return b.width / b.height; }).toBeGreaterThan(1);
    await app.canvasDrawn(page.locator('[data-thumb="0"] canvas'));

    // 2) 드래그 재정렬: PAGE-5(idx 4) 를 2쪽 앞으로. 끄는 동안 드롭선이 앞 칸 번호를 알린다
    const from = await app.center(app.thumbFace(4));
    const target = (await app.thumbFace(1).boundingBox())!;
    await app.change(async () => {
      await app.dragMouse(from, { x: target.x + target.width / 2, y: target.y + 4 }, { steps: 10, release: false });
      await expect(page.getByTestId('drop-line')).toHaveAttribute('data-before', '1');
      await app.releaseMouse();
    });
    model.splice(1, 0, model.splice(4, 1)[0]);

    // 3) 복제: 원래 /Rotate 90 이던 쪽(idx 3) 뒤에
    await app.change(() => app.thumbAction(3, 'copy'));
    model.splice(4, 0, { ...model[3] });
    expect(await app.total()).toBe(6);

    // 4) 다중 선택: 클릭 + Shift 클릭 → 선택 회전
    await app.clickThumb(1);
    await app.clickThumb(2, ['Shift']);
    await expect(app.selectionCountText()).toHaveAccessibleName(/^2쪽 선택됨/);
    await app.change(() => app.pageTool('선택한 쪽 시계 방향 90° 회전').click());
    model[1].rot = (model[1].rot + 90) % 360;
    model[2].rot = (model[2].rot + 90) % 360;
    // Ctrl 클릭으로 선택 추가·해제
    await app.clickThumb(0);
    await app.clickThumb(4, ['Control']);
    await expect(app.selectionCountText()).toHaveAccessibleName(/^2쪽 선택됨/);
    await app.clickThumb(4, ['Control']);
    await expect(app.selectionCountText()).toHaveAccessibleName(/^1쪽 선택됨/);

    // 5) 삭제
    await app.change(() => app.thumbAction(2, 'delete'));
    model.splice(2, 1);
    expect(await app.total()).toBe(5);

    // 저장(Ctrl+S) → 파일명·qpdf·쪽 순서·회전·크기
    const { file, info } = await app.saveAndInspect('ctrlS');
    expect(file.name).toBe('five-편집.pdf');
    expect(info.length).toBe(model.length);
    expect(brief(info)).toBe(expectBrief());
    const sizes = model.map((m) => {
      const o = FIVE.find((p) => p.text === m.id)!;
      return m.rot % 180 !== 0 ? [o.h, o.w] : [o.w, o.h];
    });
    expect(info.map((p) => [p.w, p.h])).toEqual(sizes);
    const finalBrief = brief(info);

    // 되돌리기 ×5 → 원본
    await expect(app.topButton(/^되돌리기/)).toBeEnabled();
    for (let k = 0; k < 5; k++) await app.undo();
    expect(await app.total()).toBe(5);
    expect(brief((await app.saveAndInspect()).info)).toBe(initial);
    await expect(app.topButton(/^되돌리기/)).toBeDisabled();
    await page.keyboard.press('Control+z'); // 소진 뒤에는 아무 일도 없다
    await app.idle();
    expect(await app.total()).toBe(5);
    // 다시하기 ×5 → 최종
    for (let k = 0; k < 5; k++) await app.redo();
    expect(brief((await app.saveAndInspect()).info)).toBe(finalBrief);
    // 새 조작은 다시하기를 버린다
    await app.undo();
    await expect(app.topButton(/^다시하기/)).toBeEnabled();
    await app.change(() => app.thumbAction(0, 'rotate'));
    await expect(app.topButton(/^다시하기/)).toBeDisabled();
  });

  test('Ctrl+Y 도 다시하기이고, 변경됨 표시는 저장하면 사라진다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    await app.change(() => app.thumbAction(0, 'rotate'));
    await expect(page.getByTestId('tab-dirty')).toBeVisible();
    await app.undo();
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    await app.change(() => page.keyboard.press('Control+y'));
    expect((await app.doc('five.pdf')).undo).toBe(1);
    await expect(page.getByTestId('tab-dirty')).toBeVisible();
    await app.save();
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
  });

  test('삭제하면 현재 쪽 번호가 따라가고, 마지막 한 쪽은 지울 수 없다', async ({ app, page }) => {
    await app.goto();
    await app.open(SAMPLES.koNonEmbedded);
    const cur = app.currentPageInput();
    expect(await app.total()).toBe(5);
    await app.clickThumb(3);
    await expect(cur).toHaveValue('4');
    await app.change(() => app.thumbAction(0, 'delete'));
    await expect(cur).toHaveValue('3'); // 앞쪽을 지우면 번호가 당겨진다
    expect(await app.total()).toBe(4);
    await app.change(() => app.thumbAction(2, 'delete'));
    await expect(cur).toHaveValue('3'); // 현재 쪽을 지우면 같은 자리
    await app.change(() => app.thumbAction(2, 'delete'));
    await expect(cur).toHaveValue('2'); // 마지막 쪽을 지우면 새 마지막
    expect(await app.total()).toBe(2);
    await app.change(() => app.thumbAction(0, 'delete'));
    expect(await app.total()).toBe(1);
    await app.thumb(0).hover();
    await expect(app.thumbActionButton(0, 'delete')).toBeDisabled();
    // Delete 키로 모든 쪽을 지우려 하면 안내하고 막는다
    await app.clickThumb(0);
    await page.keyboard.press('Delete');
    await expect(page.getByRole('alert').or(page.locator('[data-notice]')).filter({ hasText: '모든 쪽을 삭제할 수 없습니다' })).toBeVisible();
    expect(await app.total()).toBe(1);
  });

  test('선택한 쪽을 Delete 키로 지우고, Esc 로 선택을 푼다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    await app.clickThumb(1);
    await app.clickThumb(3, ['Control']);
    await app.change(() => page.keyboard.press('Delete'));
    expect(await app.total()).toBe(3);
    await app.clickThumb(0);
    await expect(app.selectionCountText()).toHaveAccessibleName(/^1쪽 선택됨/);
    await page.keyboard.press('Escape');
    await expect.poll(() => app.selectedPages()).toEqual([]);
  });
});

test.describe('쪽 조작: 터치', () => {
  test.use({ hasTouch: true });
  test('터치 기기에서는 손잡이를 끌어 순서를 바꾼다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const grip = page.getByRole('button', { name: '1쪽을 끌어서 옮기기' });
    await expect(grip).toBeVisible();
    const a = (await grip.boundingBox())!;
    const t = (await app.thumbFace(3).boundingBox())!;
    const sx = a.x + a.width / 2, sy = a.y + a.height / 2;
    const ex = t.x + t.width / 2, ey = t.y + 4;
    await app.change(async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
      for (let k = 1; k <= 10; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + ((ex - sx) * k) / 10, y: sy + ((ey - sy) * k) / 10 }] });
      await expect(page.getByTestId('drop-line')).toHaveAttribute('data-before', '3');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    });
    const { info } = await app.saveAndInspect();
    expect(texts(info)).toEqual(['PAGE-2', 'PAGE-3', 'PAGE-1', 'PAGE-4', 'PAGE-5']);
  });
});

test.describe('추출·분할', () => {
  test('선택한 쪽만 새 PDF 로 추출한다', async ({ app }) => {
    await app.goto();
    await app.open(G.five);
    await app.clickThumb(1);
    await app.clickThumb(3, ['Shift']);
    const ex = await app.download(() => app.pageTool('선택한 쪽만 새 PDF 로 저장').click());
    expect(ex.name).toBe('five-추출.pdf');
    const q = qpdfCheck(ex.path);
    expect(q).toMatchObject({ ok: true, pages: 3 });
    expect(texts(inspect(ex.bytes))).toEqual(['PAGE-2', 'PAGE-3', 'PAGE-4']);
  });

  test('나누기: 범위 오류는 입력칸 아래에 안내하고, 쪽 범위·N쪽마다 모두 ZIP 하나로 받는다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.five);
    await app.topButton('나누기').click();
    const pop = page.getByRole('dialog', { name: '나누기' });
    await expect(pop).toBeVisible();
    // 입력 오류
    await pop.getByRole('textbox', { name: '쪽 범위' }).fill('1-9');
    await pop.getByTestId('split-run').click();
    await expect(pop.getByRole('alert')).toContainText('1~5쪽');
    // 쪽 범위: 쉼표 하나가 파일 하나
    await pop.getByRole('textbox', { name: '쪽 범위' }).fill('1-2,4,5-');
    const zip = await app.download(() => pop.getByTestId('split-run').click(), '.zip');
    expect(zip.name).toBe('five-분할.zip');
    const entries = readZip(zip.bytes);
    expect(entries.map((e) => e.name)).toEqual(['five-1-2.pdf', 'five-4.pdf', 'five-5.pdf']);
    const exp = [['PAGE-1', 'PAGE-2'], ['PAGE-4'], ['PAGE-5']];
    entries.forEach((e, i) => expect(texts(inspect(e.data))).toEqual(exp[i]));
    expect(await app.total()).toBe(5); // 열린 문서는 그대로
    // 각 파일이 정상 PDF 인지 qpdf 로도 확인
    for (const [i, e] of entries.entries()) {
      const p = app.testInfo.outputPath(`split-${i}.pdf`);
      (await import('node:fs')).writeFileSync(p, e.data);
      expect(qpdfCheck(p)).toMatchObject({ ok: true, pages: exp[i].length });
    }

    // N쪽마다
    await app.topButton('나누기').click();
    const pop2 = page.getByRole('dialog', { name: '나누기' });
    await pop2.getByRole('radio', { name: /쪽마다/ }).check({ force: true });
    await pop2.getByTestId('split-every').fill('2');
    const zip2 = await app.download(() => pop2.getByTestId('split-run').click(), '.zip');
    const e2 = readZip(zip2.bytes);
    expect(e2.map((e) => e.name)).toEqual(['five-1-2.pdf', 'five-3-4.pdf', 'five-5.pdf']);
    expect(e2.map((e) => texts(inspect(e.data)))).toEqual([['PAGE-1', 'PAGE-2'], ['PAGE-3', 'PAGE-4'], ['PAGE-5']]);
  });
});
