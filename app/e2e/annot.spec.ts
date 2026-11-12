import { test, expect, qpdfCheck, reloadPdf, renderPdf, colorBBox, readBytes, type App } from './helpers.ts';
import { GENERATED as G, SAMPLES } from './fixtures/paths.ts';

test.use({ viewport: { width: 1400, height: 1000 } });

const PW = 595.304; // ko_embedded 쪽 너비(pt)
const K = 96 / 72; // 100% 배율의 화면 픽셀/pt

/** 만든 직후 선택은 저장소 반영이 끝난 뒤 걸리므로 조건으로 기다려 읽는다 */
async function selectedSoon(app: App): Promise<string | null> {
  await expect.poll(() => app.selectedAnnotType()).not.toBeNull();
  return app.selectedAnnotType();
}

/** 도형·메모·텍스트 상자·서명 이미지를 한 쪽에 만든다(쪽 공간 pt 좌표). 만든 직후 선택 상태를 함께 확인한다 */
async function makeShapes(app: App) {
  const made: (string | null)[] = [];
  await app.pickTool('사각형');
  await app.change(() => app.dragOnPage(PW, [60, 300], [200, 360]));
  made.push(await selectedSoon(app));
  await app.pickTool('원');
  await app.change(() => app.dragOnPage(PW, [230, 300], [340, 380]));
  made.push(await selectedSoon(app));
  await app.pickTool('메모');
  await app.clickOnPage(PW, [400, 300]);
  await app.change(() => app.typeInAnnotEditor('메모 내용 한글 test'));
  made.push(await selectedSoon(app));
  await app.pickTool('텍스트 상자');
  await app.dragOnPage(PW, [60, 420], [300, 480]);
  await app.change(() => app.typeInAnnotEditor('텍스트 상자 한글 내용'));
  made.push(await selectedSoon(app));
  // 서명 이미지: 파일을 고르면 도구가 켜지고, 끌어서 크기를 정한다(비율 유지 2:1)
  await app.page.locator('[data-testid=stamp-input]').setInputFiles(G.stampPng);
  await expect(app.annotTool('서명 이미지')).toHaveAttribute('aria-pressed', 'true');
  await app.change(() => app.dragOnPage(PW, [350, 420], [470, 520]));
  made.push(await selectedSoon(app));
  return made;
}

const near = (a: number, b: number, tol: number, what = '') => expect(Math.abs(a - b), `${what} ${a.toFixed(2)} ≈ ${b} (±${tol})`).toBeLessThanOrEqual(tol);
const rectNear = (r: { x: number; y: number; width: number; height: number }, e: [number, number, number, number], what: string, tol = 2) => {
  near(r.x, e[0], tol, what + ' x');
  near(r.y, e[1], tol, what + ' y');
  near(r.width, e[2], tol, what + ' w');
  near(r.height, e[3], tol, what + ' h');
};

test.describe('주석: 만들기', () => {
  test('하이라이트: 본문 줄을 끌면 그 줄에 맞는 표준 Highlight 주석(quad 1개, 노랑)이 저장된다', async ({ app }) => {
    await app.goto();
    await app.open(SAMPLES.koEmbedded);
    await app.pickTool('하이라이트');
    // 두 번째 줄(y 70.18~87.55)을 가로로 끈다
    await app.change(() => app.dragOnPage(PW, [60, 79], [300, 79]));
    const { file } = await app.saveAndInspect();
    const r = await reloadPdf(file.bytes);
    const hs = r.pages[0].filter((x) => x.type === 'highlight');
    expect(hs).toHaveLength(1);
    const h = hs[0];
    expect(h.quadPoints).toHaveLength(1);
    const q = h.quadPoints![0];
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(69);
    expect(Math.max(...ys)).toBeLessThanOrEqual(89);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(55);
    expect(Math.min(...xs)).toBeLessThanOrEqual(66);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(285);
    expect(Math.max(...xs)).toBeLessThanOrEqual(320);
    expect(h.color).toBe('#ffd400');
    await r.close();
    const bb = colorBBox(await renderPdf(file.bytes, 0, K), 'yellowish');
    expect(bb && bb.n > 500, JSON.stringify(bb)).toBe(true);
    // 하이라이트 도구는 만든 뒤에도 켜져 있다
    await expect(app.annotTool('하이라이트')).toHaveAttribute('aria-pressed', 'true');
  });

  test('사각형·원·메모·텍스트 상자·서명 이미지: 만든 직후 선택되고, 저장본의 유형·좌표·내용(한글)·색·글자 크기가 맞고 화면과 같은 위치에 그려진다', async ({ app }) => {
    await app.goto();
    await app.open(SAMPLES.koEmbedded);
    const made = await makeShapes(app);
    expect(made).toEqual(['square', 'circle', 'text', 'freetext', 'stamp']);
    const { file } = await app.saveAndInspect();
    const r = await reloadPdf(file.bytes);
    const by = (t: string) => r.pages[0].find((x) => x.type === t)!;
    expect(r.pages[0].map((x) => x.type).sort()).toEqual(['circle', 'freetext', 'square', 'stamp', 'text']);
    expect([by('square'), by('circle'), by('text'), by('freetext'), by('stamp')].map((x) => x.extra?.subtype)).toEqual(['Square', 'Circle', 'Text', 'FreeText', 'Stamp']);
    expect(by('text').contents).toBe('메모 내용 한글 test');
    expect(by('freetext').contents).toBe('텍스트 상자 한글 내용');
    rectNear(by('square').rect, [60, 300, 140, 60], '사각형');
    rectNear(by('circle').rect, [230, 300, 110, 80], '원');
    rectNear(by('freetext').rect, [60, 420, 240, 60], '텍스트 상자');
    near(by('text').rect.x, 400, 2, '메모 x');
    near(by('text').rect.y, 300, 2, '메모 y');
    near(by('stamp').rect.width / by('stamp').rect.height, 2, 0.05, '이미지 비율');
    near(by('stamp').rect.x, 350, 2, '이미지 x');
    near(by('stamp').rect.y, 420, 2, '이미지 y');
    expect(by('square').color).toBe('#e5484d');
    expect(by('freetext').extra?.fontSize).toBe(12);
    await r.close();
    // 저장 PDF 렌더: 이미지는 왼쪽 빨강·오른쪽 파랑이고 텍스트 상자 글자가 보인다
    const img = await renderPdf(file.bytes, 0, K);
    const win: [number, number, number, number] = [350 * K - 4, 420 * K - 4, 470 * K + 4, 520 * K + 4];
    const red = colorBBox(img, 'red', win);
    const blue = colorBBox(img, 'blue', win);
    expect(red && blue && red.x0 < blue.x0, `red ${JSON.stringify(red)} blue ${JSON.stringify(blue)}`).toBe(true);
    const dark = colorBBox(img, 'dark', [60 * K, 420 * K, 300 * K, 480 * K]);
    expect(dark && dark.n > 100, JSON.stringify(dark)).toBe(true);
    // 화면 캔버스의 이미지 위치 = 저장 렌더(±3px)
    const cv = await app.canvasBBox(0, 'red', win);
    expect(cv && red).toBeTruthy();
    for (const k of ['x0', 'y0', 'x1', 'y1'] as const) near(cv![k], red![k], 3, `화면=저장 ${k}`);
  });

  test('스캔본(글자 없는 쪽)은 끈 영역이 하이라이트가 되고, 글자 있는 쪽의 빈 곳을 끌면 아무것도 만들지 않는다', async ({ app }) => {
    await app.goto();
    await app.open(SAMPLES.scan);
    await app.pickTool('하이라이트');
    await app.change(() => app.dragOnPage(595.44, [100, 200], [300, 260], 0, 10));
    const { file } = await app.saveAndInspect();
    const r = await reloadPdf(file.bytes);
    const hs = r.pages[0].filter((x) => x.type === 'highlight');
    expect(hs).toHaveLength(1);
    rectNear(hs[0].rect, [100, 200, 200, 60], '영역 하이라이트');
    expect(hs[0].quadPoints).toHaveLength(1);
    await r.close();
  });

  test('글자가 있는 쪽의 빈 곳을 끌어도 하이라이트가 생기지 않는다', async ({ app }) => {
    await app.goto();
    await app.open(SAMPLES.koEmbedded);
    await app.pickTool('하이라이트');
    await app.dragOnPage(PW, [10, 700], [40, 730]);
    await app.idle();
    const r = await reloadPdf((await app.save()).bytes);
    expect(r.pages[0]).toHaveLength(0);
    await r.close();
  });

  test('도구 단축키(H·R·O·N·T·V)와 Esc, 이미지가 아닌 파일은 안내한다', async ({ app, page }) => {
    await app.goto();
    await app.open(SAMPLES.koEmbedded);
    const pressed = () => page.getByRole('toolbar', { name: '주석 도구' }).locator('button[aria-pressed=true]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    for (const [key, label] of [['h', '하이라이트 (H)'], ['r', '사각형 (R)'], ['o', '원 (O)'], ['n', '메모 (N)'], ['t', '텍스트 상자 (T)'], ['v', '선택 (V)']] as const) {
      await page.keyboard.press(key);
      await expect.poll(pressed).toEqual([label]);
    }
    await page.keyboard.press('h');
    await page.keyboard.press('Escape');
    await expect.poll(pressed).toEqual(['선택 (V)']);
    // 설정 서랍의 단축키 목록
    const drawer = await app.openSettings();
    const dd = await drawer.locator('dd').allInnerTexts();
    for (const t of ['선택 도구', '하이라이트', '사각형', '원', '메모', '텍스트 상자', '서명 이미지 넣기', '선택한 주석 삭제', '다음 양식 칸']) expect(dd).toContain(t);
    await app.closeSettings();
    // 이미지가 아닌 파일
    await page.locator('[data-testid=stamp-input]').setInputFiles(G.fakePng);
    await expect(page.locator('[data-notice]').filter({ hasText: 'PNG 또는 JPEG' })).toBeVisible();
  });
});

test.describe('주석: 다시 편집', () => {
  test('저장한 PDF 를 다시 열어 선택·이동·내용 수정·글자 크기·색 변경·삭제를 하고 저장한다', async ({ app, page }) => {
    await app.goto();
    await app.open(SAMPLES.koEmbedded);
    await makeShapes(app);
    const first = await app.save();
    // 저장본을 새 탭으로 연다(같은 앱에서 다시 편집)
    await app.open(first.path);
    await expect(app.annotCount()).resolves.toBeGreaterThanOrEqual(0);
    await expect.poll(() => app.annotCount(), { timeout: 30_000 }).toBeGreaterThanOrEqual(5);
    // 사각형 선택 → 이동
    await app.clickOnPage(PW, [62, 330]);
    await expect.poll(() => app.selectedAnnotType()).toBe('square');
    await expect.poll(() => page.locator('[data-annot-handle]').count()).toBeGreaterThanOrEqual(4);
    await app.change(() => app.dragOnPage(PW, [62, 330], [102, 370]));
    // 메모 선택 → 내용 수정(속성 패널)
    await app.clickOnPage(PW, [410, 310]);
    await expect.poll(() => app.selectedAnnotType()).toBe('text');
    const props = page.getByTestId('annot-props');
    await expect(props).toBeVisible();
    await app.change(async () => {
      const ta = props.getByRole('textbox', { name: '내용' });
      await ta.focus();
      await ta.selectText();
      await page.keyboard.insertText('수정된 메모');
      await ta.blur();
    });
    // 텍스트 상자: 글자 크기·색
    await app.clickOnPage(PW, [70, 450]);
    await expect.poll(() => app.selectedAnnotType()).toBe('freetext');
    await app.change(() => page.getByRole('combobox', { name: '글자 크기' }).selectOption('18'));
    await app.change(() => page.getByRole('button', { name: '색 파랑' }).click());
    // 원 삭제(Delete 키)
    await app.clickOnPage(PW, [235, 340]);
    await expect.poll(() => app.selectedAnnotType()).toBe('circle');
    await app.change(() => page.keyboard.press('Delete'));
    const { file } = await app.saveAndInspect();
    const r = await reloadPdf(file.bytes);
    const by = (t: string) => r.pages[0].find((x) => x.type === t);
    expect(by('circle')).toBeUndefined();
    near(by('square')!.rect.x, 100, 2.5, '사각형 이동 x');
    near(by('square')!.rect.y, 340, 2.5, '사각형 이동 y');
    expect(by('text')!.contents).toBe('수정된 메모');
    expect(by('freetext')!.extra?.fontSize).toBe(18);
    expect(by('freetext')!.color).toBe('#3e63dd');
    expect(by('freetext')!.contents).toBe('텍스트 상자 한글 내용');
    expect(by('stamp')).toBeTruthy();
    await r.close();
  });

  test('주석 편집·되돌리기·다시하기는 뷰어를 다시 만들지 않고, 새 편집은 다시하기를 버린다', async ({ app, page }) => {
    await app.goto();
    await app.open(SAMPLES.koEmbedded);
    await page.getByTestId('scroller').evaluate((e) => ((e as unknown as { __mark: string }).__mark = 'live'));
    const mark = () => page.getByTestId('scroller').evaluate((e) => (e as unknown as { __mark?: string }).__mark);
    // 주석 목록은 편집 직후 비동기로 다시 읽히므로 개수는 조건으로 기다려 확인한다
    const counts: number[] = [];
    const settle = async (n: number) => {
      await expect.poll(() => app.annotCount()).toBe(n);
      counts.push(n);
    };
    await app.pickTool('사각형');
    await app.change(() => app.dragOnPage(PW, [60, 300], [160, 360]));
    await settle(1);
    await app.pickTool('원');
    await app.change(() => app.dragOnPage(PW, [200, 300], [300, 360]));
    await settle(2);
    expect(await mark()).toBe('live');
    // 사각형 이동
    await app.clickOnPage(PW, [62, 330]);
    await expect.poll(() => app.selectedAnnotType()).toBe('square');
    await app.change(() => app.dragOnPage(PW, [62, 330], [122, 330]));
    await settle(2);
    // 원 삭제
    await app.clickOnPage(PW, [205, 330]);
    await expect.poll(() => app.selectedAnnotType()).toBe('circle');
    await app.change(() => page.keyboard.press('Delete'));
    await settle(1);
    expect(counts).toEqual([1, 2, 2, 1]);
    const fin = await reloadPdf((await app.save()).bytes);
    near(fin.pages[0].find((x) => x.type === 'square')!.rect.x, 120, 2.5, '최종 사각형 x');
    expect(fin.pages[0].find((x) => x.type === 'circle')).toBeUndefined();
    await fin.close();
    // Ctrl+Z ×4: 삭제 취소 → 이동 취소 → 원 취소 → 사각형 취소
    const seq: number[] = [];
    for (let i = 0; i < 4; i++) {
      await app.undo();
      await expect.poll(() => app.annotCount()).toBe([2, 2, 1, 0][i]);
      seq.push(await app.annotCount());
    }
    expect(seq).toEqual([2, 2, 1, 0]);
    await expect(app.topButton(/^되돌리기/)).toBeDisabled();
    const redo: number[] = [];
    for (let i = 0; i < 4; i++) {
      await app.redo();
      await expect.poll(() => app.annotCount()).toBe([1, 2, 2, 1][i]);
      redo.push(await app.annotCount());
    }
    expect(redo).toEqual([1, 2, 2, 1]);
    expect(await mark()).toBe('live');
    const r = await reloadPdf((await app.save()).bytes);
    near(r.pages[0].find((x) => x.type === 'square')?.rect.x ?? -1, 120, 2.5, 'redo 뒤 사각형 x');
    expect(r.pages[0].find((x) => x.type === 'circle')).toBeUndefined();
    await r.close();
    // 새 편집은 다시하기를 버린다
    await app.undo();
    await app.pickTool('원');
    await app.change(() => app.dragOnPage(PW, [200, 400], [260, 440]));
    await expect(app.topButton(/^다시하기/)).toBeDisabled();
  });
});

test.describe('주석: 회전된 쪽', () => {
  for (const rot of [90, 270] as const) {
    test(`/Rotate ${rot} 쪽에서 이미지·텍스트 상자·하이라이트의 화면 위치와 저장 위치가 같다`, async ({ app }) => {
      const pdf = rot === 90 ? G.koRot90 : G.koRot270;
      // 회전된 쪽의 폭(pt)과 본문 4번째 줄 상자: 시험용 PDF 를 mupdf 로 직접 읽어 구한다
      const mupdf = await import('mupdf');
      const doc = mupdf.Document.openDocument(readBytes(pdf), 'application/pdf');
      const pg = doc.loadPage(0);
      const [x0, y0, x1, y1] = pg.getBounds();
      const PWr = x1 - x0;
      const lines: { bb: number[] }[] = [];
      let cur: { bb: number[] } | null = null;
      pg.toStructuredText('preserve-whitespace').walk({
        beginLine(bb: number[]) { cur = { bb }; },
        endLine() { if (cur) lines.push(cur); },
      });
      const L = lines[3].bb;
      await app.goto();
      await app.open(pdf);
      // 서명 이미지 (100,100)→(200,150) 2:1
      await app.page.locator('[data-testid=stamp-input]').setInputFiles(G.stampPng);
      await expect(app.annotTool('서명 이미지')).toHaveAttribute('aria-pressed', 'true');
      await app.change(() => app.dragOnPage(PWr, [100, 100], [200, 150]));
      await app.pickTool('텍스트 상자');
      await app.dragOnPage(PWr, [300, 100], [520, 160]);
      await app.change(() => app.typeInAnnotEditor('회전 쪽 한글 텍스트'));
      // 하이라이트: 본문의 한 줄을 줄 방향으로 끈다
      await app.pickTool('하이라이트');
      const horizontal = L[2] - L[0] > L[3] - L[1];
      const sx = horizontal ? L[0] + 3 : (L[0] + L[2]) / 2, sy = horizontal ? (L[1] + L[3]) / 2 : L[1] + 3;
      const ex = horizontal ? L[0] + (L[2] - L[0]) * 0.5 : sx, ey = horizontal ? sy : L[1] + (L[3] - L[1]) * 0.5;
      await app.change(() => app.dragOnPage(PWr, [sx, sy], [ex, ey]));
      const { file } = await app.saveAndInspect();
      const r = await reloadPdf(file.bytes);
      const pgs = r.pages[0];
      const st = pgs.find((x) => x.type === 'stamp'), ft = pgs.find((x) => x.type === 'freetext'), hl = pgs.find((x) => x.type === 'highlight');
      expect(!!(st && ft && hl), pgs.map((x) => x.type).join(',')).toBe(true);
      const sz = await r.size(0);
      expect([Math.round(sz.width), Math.round(sz.height)]).toEqual([Math.round(x1 - x0), Math.round(y1 - y0)]);
      rectNear(st!.rect, [100, 100, 100, 50], '이미지');
      rectNear(ft!.rect, [300, 100, 220, 60], '텍스트 상자');
      expect(ft!.contents).toBe('회전 쪽 한글 텍스트');
      const q = hl!.quadPoints![0];
      const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(L[0] - 2);
      expect(Math.max(...xs)).toBeLessThanOrEqual(L[2] + 2);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(L[1] - 2);
      expect(Math.max(...ys)).toBeLessThanOrEqual(L[3] + 2);
      await r.close();
      // 화면 캔버스와 저장 렌더가 ±3px 안에서 같다
      const img = await renderPdf(file.bytes, 0, K);
      const win: [number, number, number, number] = [95 * K, 95 * K, 205 * K, 155 * K];
      const cmp = (a: { x0: number; y0: number; x1: number; y1: number } | null, b: { x0: number; y0: number; x1: number; y1: number } | null, what: string) => {
        expect(a && b, what).toBeTruthy();
        for (const k of ['x0', 'y0', 'x1', 'y1'] as const) near(a![k], b![k], 3, `${what} ${k}`);
      };
      const sr = colorBBox(img, 'red', win), sb = colorBBox(img, 'blue', win);
      cmp(await app.canvasBBox(0, 'red', win), sr, '이미지 빨강');
      cmp(await app.canvasBBox(0, 'blue', win), sb, '이미지 파랑');
      // 이미지가 바로 서 있다: 빨강이 왼쪽, 파랑이 오른쪽, 노랑 표식이 위쪽
      expect(sr!.x0).toBeLessThan(sb!.x0);
      const syl = colorBBox(img, 'yellowish', [sr!.x0, sr!.y0, sb!.x1 + 1, sr!.y1 + 1]);
      expect(syl && syl.y1 < (sr!.y0 + sr!.y1) / 2, `노랑 ${JSON.stringify(syl)}`).toBe(true);
      const hwin: [number, number, number, number] = [L[0] * K - 6, L[1] * K - 6, L[2] * K + 6, L[3] * K + 6];
      cmp(await app.canvasBBox(0, 'yellowish', hwin), colorBBox(img, 'yellowish', hwin), '하이라이트');
      const fwin: [number, number, number, number] = [300 * K, 100 * K, 520 * K, 160 * K];
      cmp(await app.canvasBBox(0, 'dark', fwin), colorBBox(img, 'dark', fwin), '텍스트 상자 글자');
    });
  }
});

test.describe('주석: 저장 옵션과의 연동', () => {
  for (const cfg of [
    { name: '평탄화', flatten: true, incremental: false, garbageCollect: false },
    { name: '정리(gc)', flatten: false, incremental: false, garbageCollect: true },
    { name: '기본(증분)', flatten: false, incremental: true, garbageCollect: false },
  ]) {
    test(`${cfg.name} 저장: 사각형·텍스트 상자가 보이고, 저장 뒤에도 같은 문서에서 계속 편집할 수 있다`, async ({ app }) => {
      await app.goto({ engine: 'mupdf', flatten: cfg.flatten, incremental: cfg.incremental, garbageCollect: cfg.garbageCollect });
      await app.open(SAMPLES.koEmbedded);
      await app.pickTool('사각형');
      await app.change(() => app.dragOnPage(PW, [60, 300], [200, 360]));
      await app.pickTool('텍스트 상자');
      await app.dragOnPage(PW, [60, 420], [300, 470]);
      await app.change(() => app.typeInAnnotEditor('평탄화 시험 한글'));
      const { file } = await app.saveAndInspect();
      const r = await reloadPdf(file.bytes);
      const red = colorBBox(await renderPdf(file.bytes, 0, K), 'redish', [58 * K, 298 * K, 202 * K, 362 * K]);
      expect(red && red.n > 200, JSON.stringify(red)).toBe(true);
      if (cfg.flatten) expect(r.pages[0]).toHaveLength(0); // 평탄화 저장은 표준 주석이 남지 않는다
      else expect(r.pages[0].map((x) => x.type)).toEqual(['square', 'freetext']);
      await r.close();
      // 저장 뒤에도 라이브 문서의 주석은 편집 가능(id 가 바뀌었을 수 있다)
      await app.clickOnPage(PW, [62, 330]);
      await expect.poll(() => app.selectedAnnotType()).toBe('square');
      await app.change(() => app.dragOnPage(PW, [62, 330], [92, 330]));
      if (!cfg.flatten) {
        const r2 = await reloadPdf((await app.save()).bytes);
        near(r2.pages[0].find((x) => x.type === 'square')?.rect.x ?? -1, 90, 2.5, '저장 뒤 이동');
        await r2.close();
      }
    });
  }
});

test.describe('주석: 300쪽 문서', () => {
  test.setTimeout(180_000);
  test('주석을 만들면 편집한 쪽만 다시 그리고, 주석 목록은 보이는 쪽만 읽는다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.big300);
    await app.gotoPage(121);
    await app.pageDrawn(120);
    const quiet = () => app.renderQuiet();
    await quiet();
    const cur = Number(await app.currentPageInput().inputValue()) - 1;
    const before = await page.evaluate(() => {
      const S = (globalThis as unknown as { __pdfeditStats: { calls: number; draws: number; log: unknown[] } }).__pdfeditStats;
      return { calls: S.calls, draws: S.draws, log: S.log.length };
    });
    const sz = (await app.slot(cur).boundingBox())!;
    await app.pickTool('사각형');
    await app.change(() => app.dragMouse({ x: sz.x + 80, y: sz.y + 120 }, { x: sz.x + 220, y: sz.y + 200 }, { steps: 8 }));
    await quiet();
    const after = await page.evaluate(() => {
      const S = (globalThis as unknown as { __pdfeditStats: { calls: number; draws: number; log: [number, number][]; annotLists: number } }).__pdfeditStats;
      return { calls: S.calls, draws: S.draws, annotLists: S.annotLists, log: S.log };
    });
    const newLog = after.log.slice(before.log >= 600 ? 0 : before.log);
    expect([...new Set(newLog.map((e) => e[0]))]).toEqual([cur]);
    expect(after.calls - before.calls).toBeLessThanOrEqual(2); // 본문 1 + 썸네일 1
    expect(after.draws - before.draws).toBeLessThanOrEqual(2);
    expect(after.annotLists).toBeLessThanOrEqual(20); // 300쪽 전체를 읽지 않는다
    await expect.poll(() => app.selectedAnnotType()).toBe('square');
    // 삭제해도 그 쪽만 다시 그린다
    const logLen = after.log.length;
    await app.change(() => page.keyboard.press('Delete'));
    const q2 = await quiet();
    void q2;
    const log2 = await page.evaluate((n) => (globalThis as unknown as { __pdfeditStats: { log: [number, number][] } }).__pdfeditStats.log.slice(n >= 600 ? 0 : n), logLen);
    expect([...new Set(log2.map((e) => e[0]))]).toEqual([cur]);
  });
});

test.describe('주석: 터치', () => {
  test.use({ hasTouch: true });
  test('터치로 그리고, 본문을 끌어 이동하고, 핸들을 끌어 크기를 바꾼다', async ({ app, page }) => {
    await app.goto();
    await app.open(SAMPLES.koEmbedded);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const tdrag = async (a: { x: number; y: number }, z: { x: number; y: number }, steps = 8) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] });
      for (let s = 1; s <= steps; s++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + ((z.x - a.x) * s) / steps, y: a.y + ((z.y - a.y) * s) / steps }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const P = (x: number, y: number) => app.toClient(0, PW, x, y);
    await app.pickTool('사각형');
    await app.change(async () => tdrag(await P(60, 300), await P(200, 360)));
    await expect.poll(() => app.selectedAnnotType()).toBe('square');
    await app.change(async () => tdrag(await P(130, 330), await P(170, 350)));
    const h = await app.center(page.locator('[data-annot-handle=se]'));
    await app.change(() => tdrag(h, { x: h.x + 40, y: h.y + 26.667 }));
    const r = await reloadPdf((await app.save()).bytes);
    const sq = r.pages[0].find((x) => x.type === 'square')!;
    rectNear(sq.rect, [100, 320, 170, 80], '터치 이동·크기', 2.5);
    await r.close();
  });
});

test.describe('주석: PDFium 엔진', () => {
  test('도형·영문 텍스트 상자는 저장되고, 한글 텍스트 상자는 한 번만 안내한다', async ({ app, page }) => {
    await app.goto({ engine: 'pdfium' });
    await app.open(SAMPLES.koEmbedded);
    expect((await app.summary()).docs[0].kind).toBe('pdfium');
    await app.pickTool('사각형');
    await app.change(() => app.dragOnPage(PW, [60, 300], [160, 360]));
    await expect.poll(() => app.selectedAnnotType()).toBe('square');
    await app.pickTool('원');
    await app.change(() => app.dragOnPage(PW, [200, 300], [300, 360]));
    // 영문 텍스트 상자에는 한글 안내가 없다
    await app.pickTool('텍스트 상자');
    await app.dragOnPage(PW, [60, 420], [300, 470]);
    await app.change(() => app.typeInAnnotEditor('English text box'));
    expect(await app.noticeTexts()).toEqual([]);
    // 한글 텍스트 상자 → 도구 모음 옆 안내 1회
    await app.pickTool('텍스트 상자');
    await app.dragOnPage(PW, [60, 500], [300, 550]);
    await app.change(() => app.typeInAnnotEditor('한글 텍스트 상자'));
    await expect.poll(() => app.noticeTexts()).toEqual([expect.stringMatching(/PDFium.*한글/)]);
    // 안내는 한 번뿐: 닫고 또 만들어도 뜨지 않는다
    await app.dismissNotices();
    await app.pickTool('텍스트 상자');
    await app.dragOnPage(PW, [60, 580], [300, 620]);
    await app.change(() => app.typeInAnnotEditor('또 한글'));
    await expect(page.locator('[data-notice]')).toHaveCount(0);
    const { file } = await app.saveAndInspect();
    const r = await reloadPdf(file.bytes);
    const pg = r.pages[0];
    expect(pg.map((x) => x.type)).toEqual(['square', 'circle', 'freetext', 'freetext', 'freetext']);
    near(pg[0].rect.x, 60, 2.5, '사각형 x');
    near(pg[0].rect.width, 100, 2.5, '사각형 w');
    expect(pg[2].contents).toBe('English text box');
    expect(pg[3].contents).toBe('한글 텍스트 상자'); // Contents 는 저장된다(글자만 PDFium 화면에서 안 보임)
    await r.close();
    const eng = colorBBox(await renderPdf(file.bytes, 0, K), 'dark', [60 * K, 420 * K, 300 * K, 470 * K]);
    expect(eng && eng.n > 50, JSON.stringify(eng)).toBe(true);
  });
});

void qpdfCheck;
