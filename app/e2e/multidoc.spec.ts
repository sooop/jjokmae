import { test, expect, texts, qpdfCheck, brief } from './helpers.ts';
import { GENERATED as G, SAMPLES } from './fixtures/paths.ts';
import { FIVE, inspect } from './fixtures/synth.ts';

const ABC = [G.docA, G.docB, G.docC];

test.describe('다중 문서: 탭', () => {
  test('탭마다 현재 쪽·확대·선택·스크롤을 따로 보관하고 전환하면 복원한다', async ({ app, page }) => {
    await app.goto();
    await app.open(ABC);
    expect(await app.tabNames()).toEqual(['docA.pdf', 'docB.pdf', 'docC.pdf']);
    expect(await app.activeTabName()).toBe('docC.pdf');
    const scroller = page.getByTestId('scroller');
    // C: 배율 200%, 2쪽 선택, 스크롤을 조금 더 민다
    await app.setZoom(2);
    await app.clickThumb(1);
    await scroller.evaluate((e) => (e.scrollTop += 37));
    const scrC = await scroller.evaluate((e) => e.scrollTop);
    // B: 75%, 3쪽 + Ctrl 1쪽
    await app.switchTab('docB.pdf');
    await app.setZoom(0.75);
    await app.clickThumb(2);
    await app.clickThumb(0, ['Control']);
    // A: 150%, 5쪽 + Ctrl 2쪽
    await app.switchTab('docA.pdf');
    await app.setZoom(1.5);
    await app.clickThumb(4);
    await app.clickThumb(1, ['Control']);

    await app.switchTab('docC.pdf');
    let d = await app.doc('docC.pdf');
    expect([d.current, d.zoom, d.selected]).toEqual([1, 2, [1]]);
    expect(await app.zoomValue()).toBe(2);
    await expect(app.currentPageInput()).toHaveValue('2');
    await expect.poll(async () => Math.abs((await scroller.evaluate((e) => e.scrollTop)) - scrC)).toBeLessThanOrEqual(3);
    await app.switchTab('docB.pdf');
    d = await app.doc('docB.pdf');
    expect([d.current, d.zoom, d.selected]).toEqual([2, 0.75, [0, 2]]);
    await app.switchTab('docA.pdf');
    d = await app.doc('docA.pdf');
    expect([d.current, d.zoom, d.selected]).toEqual([4, 1.5, [1, 4]]);
    await expect(app.currentPageInput()).toHaveValue('5');
  });

  test('Ctrl+Tab·Ctrl+Shift+Tab·화살표로 탭을 옮기고, role 은 tablist/tab 이다', async ({ app, page }) => {
    await app.goto();
    await app.open(ABC);
    await app.switchTab('docA.pdf');
    await page.keyboard.press('Control+Tab');
    await expect.poll(() => app.activeTabName()).toBe('docB.pdf');
    await page.keyboard.press('Control+Shift+Tab');
    await expect.poll(() => app.activeTabName()).toBe('docA.pdf');
    await page.keyboard.press('Control+Shift+Tab'); // 처음에서 거꾸로 → 끝 탭
    await expect.poll(() => app.activeTabName()).toBe('docC.pdf');
    await page.keyboard.press('Control+Tab'); // 끝에서 앞으로 → 처음 탭
    await expect.poll(() => app.activeTabName()).toBe('docA.pdf');
    await app.tab('docA.pdf').focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => app.activeTabName()).toBe('docB.pdf');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => app.activeTabName()).toBe('docA.pdf');
    await expect(page.getByRole('tablist')).toHaveCount(1);
    await expect(page.locator('[role=tab][aria-selected=true]')).toHaveCount(1);
  });

  test('Ctrl+W 는 깨끗한 탭을 바로 닫고, 같은 이름은 (2) 로 구분하며, 엔진은 mupdf 하나다', async ({ app, page }) => {
    await app.goto();
    await app.open(ABC);
    await app.switchTab('docB.pdf');
    await page.keyboard.press('Control+w');
    await expect.poll(() => app.tabNames()).toEqual(['docA.pdf', 'docC.pdf']);
    await app.open(G.docA);
    expect(await app.tabNames()).toEqual(['docA.pdf', 'docC.pdf', 'docA (2).pdf']);
    expect((await app.summary()).engines).toEqual(['mupdf']);
  });
});

test.describe('다중 문서: 보내기', () => {
  test('복사: 새 파일·다른 파일의 맨 앞/특정 쪽 뒤/맨 뒤, 원본은 그대로이고 활성 탭도 그대로다', async ({ app }) => {
    await app.goto();
    await app.open(ABC);
    await app.switchTab('docA.pdf');
    await app.clickThumb(1);
    await app.clickThumb(3, ['Control']);
    await app.send({ target: 'new' });
    expect(await app.tabNames()).toEqual(['docA.pdf', 'docB.pdf', 'docC.pdf', '새 문서 1.pdf']);
    expect(await app.activeTabName()).toBe('새 문서 1.pdf');
    expect((await app.doc('새 문서 1.pdf')).dirty).toBe(true);
    const s1 = await app.saveAndInspect();
    expect(s1.file.name).toBe('새 문서 1-편집.pdf');
    expect(texts(s1.info)).toEqual(['A-2', 'A-4']);

    await app.switchTab('docA.pdf');
    const a = await app.doc('docA.pdf');
    expect([a.pages, a.dirty]).toEqual([5, false]);
    await app.clickThumb(0);
    await app.send({ target: 'docB.pdf', pos: 'start' });
    await expect(app.tabNotice()).toContainText('docB.pdf');
    await app.clickThumb(4);
    await app.send({ target: 'docB.pdf', pos: 'end' });
    await app.clickThumb(2);
    await app.clickThumb(3, ['Control']);
    await app.send({ target: 'docB.pdf', pos: 2 });
    expect(await app.activeTabName()).toBe('docA.pdf');
    await app.switchTab('docB.pdf');
    const s2 = await app.saveAndInspect();
    // B-1 앞에 A-1, 2쪽 뒤(= 앞에 A-1 이 들어와 B-1 다음)에 A-3·A-4, 맨 뒤 A-5
    expect(texts(s2.info)).toEqual(['A-1', 'B-1', 'A-3', 'A-4', 'B-2', 'B-3', 'B-4', 'A-5']);
  });

  test('범위를 벗어난 쪽 번호는 입력칸 아래에 안내한다', async ({ app, page }) => {
    await app.goto();
    await app.open(ABC);
    await app.switchTab('docA.pdf');
    await app.clickThumb(0);
    const dlg = await app.openSend();
    await dlg.getByRole('group', { name: '대상' }).locator('label', { hasText: 'docC.pdf' }).getByRole('radio').check({ force: true });
    await dlg.getByRole('textbox', { name: '쪽 번호' }).fill('9');
    await dlg.getByTestId('send-run').click();
    await expect(dlg.getByRole('alert')).toContainText('3쪽까지');
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    expect(await app.pageCounts()).toEqual([5, 4, 3]);
  });

  test('이동: 두 문서가 함께 바뀌고, 어느 쪽에서 되돌려도 함께 복귀하며, 이후 편집이 있으면 막힌다', async ({ app, page }) => {
    await app.goto();
    await app.open([G.docA, G.docB]);
    await app.switchTab('docA.pdf');
    await app.clickThumb(0);
    await app.clickThumb(1, ['Control']);
    await app.send({ mode: 'move', target: 'docB.pdf', pos: 'end' });
    expect(await app.pageCounts()).toEqual([3, 6]);
    expect((await app.summary()).docs.map((d) => d.dirty)).toEqual([true, true]);
    await app.undo(); // A 에서 한 번 → 두 문서 함께(B 는 비활성)
    expect(await app.pageCounts()).toEqual([5, 4]);
    await expect(app.tabNotice()).toContainText('docB.pdf');
    await app.redo();
    expect(await app.pageCounts()).toEqual([3, 6]);
    await app.switchTab('docB.pdf');
    await app.undo();
    expect(await app.pageCounts()).toEqual([5, 4]);
    await app.redo();
    expect(await app.pageCounts()).toEqual([3, 6]);
    expect(texts((await app.saveAndInspect()).info)).toEqual(['B-1', 'B-2', 'B-3', 'B-4', 'A-1', 'A-2']);
    // B 에서 이후 편집을 하면 A 의 되돌리기는 막히고 안내한다
    await app.change(() => app.thumbAction(0, 'rotate'));
    await app.switchTab('docA.pdf');
    await page.keyboard.press('Control+z');
    await expect(app.tabNotice()).toContainText('먼저');
    expect(await app.pageCounts()).toEqual([3, 6]);
  });

  test('이동으로 만든 새 파일: 되돌리면 새 탭이 닫히고 A 가 복귀하며, 다시하기하면 되살아난다', async ({ app }) => {
    await app.goto();
    await app.open(G.docA);
    await app.clickThumb(2);
    await app.send({ mode: 'move', target: 'new' });
    expect(await app.pageCounts()).toEqual([4, 1]);
    await app.undo();
    expect(await app.tabNames()).toEqual(['docA.pdf']);
    expect(await app.pageCounts()).toEqual([5]);
    await app.redo();
    expect(await app.tabNames()).toEqual(['docA.pdf', '새 문서 1.pdf']);
    expect(await app.pageCounts()).toEqual([4, 1]);
    await app.undo(); // 새 탭이 활성인 채로 되돌려도 같다
    expect(await app.tabNames()).toEqual(['docA.pdf']);
    // 복사로 만든 새 파일을 되돌려도 탭이 닫힌다
    await app.clickThumb(0);
    await app.send({ target: 'new' });
    await app.undo();
    expect(await app.tabNames()).toEqual(['docA.pdf']);
  });
});

test.describe('다중 문서: 탭으로 끌어 복사', () => {
  test('선택한 쪽을 다른 탭 위에 놓으면 그 파일 끝에 복사하고 활성 탭은 그대로다', async ({ app, page }) => {
    await app.goto();
    await app.open([G.docA, G.docB]);
    await app.switchTab('docA.pdf');
    await app.clickThumb(1);
    await app.clickThumb(2, ['Control']);
    const from = await app.center(app.thumbFace(1));
    const to = await app.center(app.tab('docB.pdf'));
    await app.dragMouse(from, to, { steps: 12, release: false });
    // 끄는 동안 놓을 수 있는 탭(B)만 표시된다. 활성 탭은 바뀌지 않는다
    await expect(page.locator('[data-droppable]')).toHaveCount(1);
    await expect(page.locator('[data-tab-name="docB.pdf"][data-droppable]')).toHaveCount(1);
    expect(await app.activeTabName()).toBe('docA.pdf');
    await app.change(() => app.releaseMouse());
    expect(await app.pageCounts()).toEqual([5, 6]);
    expect(await app.activeTabName()).toBe('docA.pdf');
    await expect(page.locator('[data-droppable]')).toHaveCount(0);
    await app.switchTab('docB.pdf');
    expect(texts((await app.saveAndInspect()).info)).toEqual(['B-1', 'B-2', 'B-3', 'B-4', 'A-2', 'A-3']);
  });

  test('끄는 도중 Esc 를 누르면 취소되어 아무것도 바뀌지 않는다', async ({ app, page }) => {
    await app.goto();
    await app.open([G.docA, G.docB]);
    await app.switchTab('docA.pdf');
    await app.clickThumb(0);
    const from = await app.center(app.thumbFace(0));
    const to = await app.center(app.tab('docB.pdf'));
    await app.dragMouse(from, to, { steps: 12, release: false });
    await expect(page.locator('[data-droppable]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await app.releaseMouse();
    await expect(page.locator('[data-droppable]')).toHaveCount(0);
    expect(await app.pageCounts()).toEqual([5, 4]);
    expect((await app.doc('docB.pdf')).undo).toBe(0);
  });
});

test.describe('다중 문서: 열린 파일 병합', () => {
  test('체크·순서를 정해 새 탭으로 합치고, 원본 탭은 그대로이며, 병합 탭을 되돌리면 닫힌다', async ({ app, page }) => {
    await app.goto();
    await app.open([SAMPLES.koEmbedded, SAMPLES.koNonEmbedded, SAMPLES.scan]);
    const counts = (await app.summary()).docs.map((d) => d.pages);
    let dlg = await app.openMerge();
    await expect(dlg.locator('[data-merge-row]')).toHaveCount(3);
    // scan 을 한 칸 위로 → [embedded, scan, nonembedded]
    await dlg.getByRole('button', { name: 'scan.pdf 위로' }).click();
    await expect(dlg.locator('[data-merge-row] label span')).toHaveText(['ko_embedded.pdf', 'scan.pdf', 'ko_nonembedded.pdf']);
    await app.change(() => dlg.getByTestId('merge-run').click());
    await expect.poll(() => app.tabNames()).toEqual(['ko_embedded.pdf', 'ko_nonembedded.pdf', 'scan.pdf', 'ko_embedded-병합.pdf']);
    expect(await app.activeTabName()).toBe('ko_embedded-병합.pdf');
    const sum = counts.reduce((x, y) => x + y, 0);
    expect(await app.total()).toBe(sum);
    await expect(app.tab('ko_embedded-병합.pdf').getByTestId('tab-dirty')).toBeVisible();
    const sv = await app.saveAndInspect();
    expect(sv.file.name).toBe('ko_embedded-병합-편집.pdf');
    expect(sv.q.pages).toBe(sum);
    // 파일 순서: E=임베디드, S=스캔(글자 없음), N=미내장(“[n]” 머리글)
    const kind = (t: string) => (/^\[\d+\]/.test(t) ? 'N' : t === '' ? 'S' : 'E');
    expect(sv.info.map((p) => kind(p.text)).join('')).toBe('E'.repeat(counts[0]) + 'S'.repeat(counts[2]) + 'N'.repeat(counts[1]));
    await expect(app.tab('ko_embedded-병합.pdf').getByTestId('tab-dirty')).toHaveCount(0); // 저장하면 점이 사라진다

    // 병합 탭에서 되돌리면 새 탭이 닫히고 원본은 그대로
    await app.undo();
    expect(await app.tabNames()).toEqual(['ko_embedded.pdf', 'ko_nonembedded.pdf', 'scan.pdf']);

    // 체크를 끄면 제외된다. 이미 열린 five 를 끝에 두고 합친다
    await app.open(G.five);
    dlg = await app.openMerge();
    await expect(dlg.locator('[data-merge-row]')).toHaveCount(4);
    await dlg.getByRole('checkbox', { name: 'ko_embedded.pdf 포함' }).uncheck();
    await app.change(() => dlg.getByTestId('merge-run').click());
    await expect.poll(() => app.tabNames().then((n) => n.length)).toBe(5);
    const sv2 = await app.saveAndInspect();
    expect(texts(sv2.info).slice(-5)).toEqual(FIVE.map((p) => p.text));
    expect(sv2.info.length).toBe(counts[1] + counts[2] + 5);
    // 두 파일 이상을 체크해야 병합할 수 있다
    await app.switchTab('ko_nonembedded.pdf');
    dlg = await app.openMerge();
    const boxes = dlg.getByRole('checkbox');
    for (let i = 0, n = await boxes.count(); i < n; i++) await boxes.nth(i).uncheck();
    await expect(dlg.getByTestId('merge-run')).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  test('파일이 하나뿐이면 병합 단추가 꺼져 있다', async ({ app }) => {
    await app.goto();
    await app.open(G.five);
    await expect(app.topButton(/^열린 파일 병합/)).toBeDisabled();
  });
});

test.describe('다중 문서: 엔진 혼합', () => {
  test('MuPDF 와 PDFium 문서 사이에서도 쪽을 보내고(복사·이동) 저장본이 유효하며, 설정은 새 파일부터 적용된다', async ({ app }) => {
    test.slow();
    await app.goto();
    await app.open(G.docA); // mupdf
    await app.setEngine('pdfium');
    await app.open(G.docB); // pdfium
    let s = await app.summary();
    expect(s.docs.map((d) => d.kind)).toEqual(['mupdf', 'pdfium']);
    expect([...s.engines].sort()).toEqual(['mupdf', 'pdfium']);
    // MuPDF → PDFium 복사
    await app.switchTab('docA.pdf');
    await app.clickThumb(0);
    await app.clickThumb(2, ['Control']);
    await app.send({ target: 'docB.pdf', pos: 1 });
    await app.switchTab('docB.pdf');
    const sv = await app.saveAndInspect();
    expect(texts(sv.info)).toEqual(['B-1', 'A-1', 'A-3', 'B-2', 'B-3', 'B-4']);
    // PDFium → MuPDF 이동
    await app.clickThumb(3);
    await app.send({ mode: 'move', target: 'docA.pdf', pos: 'start' });
    await app.switchTab('docA.pdf');
    expect(texts((await app.saveAndInspect()).info)).toEqual(['B-2', 'A-1', 'A-2', 'A-3', 'A-4', 'A-5']);
    expect((await app.doc('docB.pdf')).pages).toBe(5);
    // 열린 문서가 없는 엔진은 해제된다
    await app.page.getByRole('button', { name: 'docB.pdf 닫기' }).click();
    await app.page.getByTestId('close-discard').click();
    await expect.poll(async () => (await app.summary()).engines).toEqual(['mupdf']);
    // 설정은 새로 여는 파일부터: A 는 mupdf 유지, 새로 여는 B·C 는 pdfium
    await app.open([G.docB, G.docC]);
    s = await app.summary();
    expect(s.docs.map((d) => d.kind)).toEqual(['mupdf', 'pdfium', 'pdfium']);
    // PDFium → PDFium
    await app.switchTab('docC.pdf');
    await app.clickThumb(0);
    await app.send({ target: 'docB.pdf', pos: 'end' });
    await app.switchTab('docB.pdf');
    expect(texts((await app.saveAndInspect()).info)).toEqual(['B-1', 'B-2', 'B-3', 'B-4', 'C-1']);
  });
});

test.describe('다중 문서: 닫기 확인', () => {
  test('변경된 탭을 닫으면 해당 탭 근처에 확인이 뜨고, Esc 는 취소, 저장 후 닫기·저장 안 하고 닫기가 동작한다', async ({ app, page }) => {
    await app.goto();
    await app.open([G.docA, G.docB]);
    await app.switchTab('docA.pdf');
    await app.change(() => app.thumbAction(0, 'rotate'));
    await expect(app.tab('docA.pdf').getByTestId('tab-dirty')).toBeVisible();
    await expect(app.tab('docB.pdf').getByTestId('tab-dirty')).toHaveCount(0);
    await page.getByRole('button', { name: 'docA.pdf 닫기' }).click();
    const confirm = page.getByRole('alertdialog', { name: '저장하지 않은 변경' });
    await expect(confirm).toBeVisible();
    const tb = (await app.tab('docA.pdf').boundingBox())!;
    const cb = (await confirm.boundingBox())!;
    expect(Math.abs(cb.x - tb.x)).toBeLessThan(30);
    expect(cb.y).toBeGreaterThanOrEqual(tb.y);
    await expect(confirm.getByRole('button')).toHaveText(['저장 후 닫기', '저장 안 하고 닫기', '취소']);
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    expect(await app.tabNames()).toEqual(['docA.pdf', 'docB.pdf']);
    // Ctrl+W 도 변경된 탭은 확인을 거친다
    await page.keyboard.press('Control+w');
    await expect(confirm).toBeVisible();
    // 저장 후 닫기 → 파일이 내려받아지고 탭이 닫힌다
    const saved = await app.download(() => confirm.getByTestId('close-save').click());
    expect(saved.name).toBe('docA-편집.pdf');
    expect(brief(inspect(saved.bytes))).toBe('A-1:90,A-2:0,A-3:0,A-4:0,A-5:0');
    await expect.poll(() => app.tabNames()).toEqual(['docB.pdf']);
    // 저장 안 하고 닫기 → 문서가 없는 빈 상태
    await app.change(() => app.thumbAction(0, 'delete'));
    await page.getByRole('button', { name: 'docB.pdf 닫기' }).click();
    await page.getByTestId('close-discard').click();
    await expect.poll(async () => (await app.summary()).docs.length).toBe(0);
    await expect(page.getByRole('button', { name: '파일 열기' })).toBeVisible();
    expect((await app.summary()).engines).toEqual([]);
  });
});
