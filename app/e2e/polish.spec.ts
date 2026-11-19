// 실제로 쓰다가 나온 화면 결함의 회귀 시험: 스크롤 뒤 깜박임, 재정렬 뒤 썸네일이 비는 것, 가로 문서의 격자 배치,
// 칸의 빈 자리를 끌었을 때의 영역 선택, 좁은 썸네일 패널의 도구 줄.
import { writeFileSync } from 'node:fs';
import { test, expect, type App } from './helpers.ts';
import { GENERATED as G } from './fixtures/paths.ts';
import { makePdf, type PageSpec } from './fixtures/synth.ts';

function fixture(app: App, name: string, specs: PageSpec[]): string {
  const p = app.testInfo.outputPath(name);
  writeFileSync(p, makePdf(specs));
  return p;
}
const land = (n: number): PageSpec => ({ w: 842, h: 595, text: `L-${n}` });

test.describe('깜박임 없음', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('조금 스크롤하고 멈춰도 이미 그려진 쪽·썸네일은 다시 나타나는 애니메이션을 하지 않는다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.p24);
    await app.firstPageDrawn();
    await app.renderQuiet();
    await page.waitForTimeout(400); // 처음 그릴 때의 페이드가 끝나길 기다린다
    const max = await page.evaluate(
      () =>
        new Promise<number>((res) => {
          const drawn = [...document.querySelectorAll<HTMLCanvasElement>('[data-testid=scroller] canvas, [data-testid=thumbs] canvas')].filter((c) => c.width > 0);
          const running = () => drawn.filter((c) => c.getAnimations().some((a) => a.playState === 'running')).length;
          let m = running();
          const sc = document.querySelector('[data-testid=scroller]') as HTMLElement;
          const th = document.querySelector('[data-testid=thumbs]') as HTMLElement;
          sc.scrollTop += 24;
          th.scrollTop += 12;
          const t0 = performance.now();
          const tick = () => {
            m = Math.max(m, running());
            if (performance.now() - t0 < 700) requestAnimationFrame(tick);
            else res(m);
          };
          requestAnimationFrame(tick);
        }),
    );
    expect(max).toBe(0);
  });

  test('썸네일을 끌어 순서를 바꾼 뒤, 보이는 썸네일이 빈 칸으로 드러나지 않는다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.p24);
    await app.firstPageDrawn();
    await app.renderQuiet();
    // 쪽이 무거운 실제 문서처럼 렌더를 느리게 한다(시험용 쪽은 너무 빨리 그려져 차이가 드러나지 않는다)
    await page.evaluate(() => {
      type Client = { renderPage: (...a: unknown[]) => Promise<unknown> };
      const ws = (globalThis as unknown as { __pdfeditWs: { active: unknown; clientOf: (d: unknown) => Client } }).__pdfeditWs;
      const client = ws.clientOf(ws.active);
      const real = client.renderPage;
      client.renderPage = (...a) => new Promise((r) => setTimeout(r, 140)).then(() => real(...a));
    });
    const f0 = await app.center(app.thumbFace(0));
    const t2 = await app.center(app.thumbFace(2));
    await app.dragMouse(f0, { x: t2.x, y: t2.y + 30 }, { steps: 10, release: false });
    await page.evaluate(() => {
      const w = globalThis as unknown as { __blank: { bad: number; flyers: number; stop: boolean } };
      const st = (w.__blank = { bad: 0, flyers: 0, stop: false });
      const host = document.querySelector('[data-testid=thumbs]') as HTMLElement;
      const tick = () => {
        if (st.stop) return;
        const flyers = host.querySelectorAll('[data-flyer]').length;
        st.flyers = Math.max(st.flyers, flyers);
        // 칸이 드러나 있는데(가려 두지 않았다) 화면 안의 썸네일이 아직 비어 있으면 깜박임이다. 비행체가 흐려지는 동안도 포함한다
        if (!host.classList.contains('holding')) {
          const r = host.getBoundingClientRect();
          for (const c of host.querySelectorAll<HTMLCanvasElement>('[data-thumb] canvas')) {
            const b = c.getBoundingClientRect();
            if (b.bottom > r.top + 4 && b.top < r.bottom - 4 && c.width === 0) st.bad++;
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await app.releaseMouse();
    await expect.poll(async () => (await app.summary()).docs[0].undo).toBe(1);
    await expect(page.locator('[data-flyer]')).toHaveCount(0, { timeout: 8000 });
    await app.renderQuiet();
    const r = await page.evaluate(() => {
      const st = (globalThis as unknown as { __blank: { bad: number; flyers: number; stop: boolean } }).__blank;
      st.stop = true;
      return { bad: st.bad, flyers: st.flyers };
    });
    expect(r.flyers).toBeGreaterThan(0);
    expect(r.bad).toBe(0);
  });
});

test.describe('정리 모드: 가로 문서', () => {
  test('가로 쪽만 있는 문서는 칸이 낮아져 쪽 위에 빈 공간이 남지 않는다', async ({ app }) => {
    await app.goto();
    await app.open(fixture(app, 'land.pdf', [1, 2, 3, 4, 5, 6].map(land)));
    await app.setMode('organize');
    await app.cellDrawn(0);
    const cell = (await app.cell(0).boundingBox())!;
    const face = (await app.cellFace(0).boundingBox())!;
    expect(cell.height).toBeLessThan(cell.width); // A4 세로 비율(폭의 1.42배)이 아니다
    expect(face.y - cell.y).toBeLessThan(4);
    expect(Math.abs(face.width - cell.width)).toBeLessThan(2);
  });

  test('세로·가로가 섞이면 가로 쪽은 칸의 세로 가운데에 놓이고, 그 위아래 빈 자리만 끈 영역은 쪽을 고르지 않는다', async ({ app, page }) => {
    await app.goto();
    await app.open(fixture(app, 'mixed.pdf', [{ w: 595, h: 842, text: 'P-1' }, ...[2, 3, 4, 5, 6].map(land)]));
    await app.setMode('organize');
    await app.cellDrawn(2);
    const c1 = (await app.cell(1).boundingBox())!;
    const f1 = (await app.cellFace(1).boundingBox())!;
    const f2 = (await app.cellFace(2).boundingBox())!;
    const above = f1.y - c1.y;
    const below = c1.y + c1.height - 20 - (f1.y + f1.height); // 번호 줄(20px) 위까지
    expect(above).toBeGreaterThan(20);
    expect(Math.abs(above - below)).toBeLessThanOrEqual(4.5);
    // 쪽 위의 빈 자리 안에서만 끈다: 칸과는 겹치지만 쪽 얼굴과는 겹치지 않는다
    const start = { x: f1.x + 10, y: c1.y + 3 };
    expect(await page.evaluate(({ x, y }) => !document.elementFromPoint(x, y)?.closest('[data-thumb]'), start)).toBe(true);
    await app.dragMouse(start, { x: f2.x + f2.width - 10, y: f1.y - 8 }, { release: false });
    await expect(page.getByTestId('band')).toBeVisible();
    expect(await app.selectedPages()).toEqual([]);
    // 쪽 얼굴까지 내려오면 고른다
    await page.mouse.move(f2.x + f2.width - 10, f1.y + 12, { steps: 4 });
    await expect.poll(() => app.selectedPages()).toEqual([1, 2]);
    await app.releaseMouse();
  });
});

test.describe('썸네일 패널 도구 줄', () => {
  const toolbar = (app: App) => app.page.getByRole('toolbar', { name: '선택한 쪽 조작' });

  test('좁은 폭: 단추가 한 줄이고 넘치는 조작은 더 보기 메뉴에 있다', async ({ app }) => {
    await app.goto({ sideWidth: 150 });
    await app.open(G.docA);
    await app.firstPageDrawn();
    const more = app.pageTool('선택한 쪽 조작 더 보기');
    await expect(more).toBeVisible();
    const tops = await toolbar(app).locator('.icon-btn').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))]);
    expect(tops).toHaveLength(1);
    // 메뉴의 조작이 실제로 실행된다
    await app.clickThumb(1);
    await app.change(async () => (await app.pageToolMore('뒤에 복제')).click());
    expect(await app.total()).toBe(6);
  });

  test('기본 폭: 모든 단추가 줄에 있고 더 보기 단추가 없다', async ({ app }) => {
    await app.goto();
    await app.open(G.docA);
    await app.firstPageDrawn();
    await expect(app.pageTool('선택한 쪽 인쇄')).toBeVisible();
    await expect(app.pageTool('선택한 쪽만 새 PDF 로 저장')).toBeVisible();
    await expect(app.pageTool('선택한 쪽 조작 더 보기')).toHaveCount(0);
  });
});

test.describe('쪽 그림 재사용', () => {
  test('정리 모드에서 순서를 바꾸고 되돌려도 엔진에 다시 그리게 하지 않고, 회전은 그 쪽만 다시 그린다', async ({ app, page }) => {
    await app.goto();
    await app.open(G.docA);
    await app.setMode('organize');
    for (let i = 0; i < 5; i++) await app.cellDrawn(i);
    const c0 = await app.renderQuiet();
    const f0 = await app.center(app.cellFace(0));
    const t3 = await app.center(app.cellFace(3));
    await app.change(() => app.dragMouse(f0, { x: t3.x + 40, y: t3.y }, { steps: 10 }));
    for (let i = 0; i < 5; i++) await app.cellDrawn(i);
    expect(await app.renderQuiet()).toBe(c0);
    await app.undo();
    for (let i = 0; i < 5; i++) await app.cellDrawn(i);
    expect(await app.renderQuiet()).toBe(c0);
    // 복제한 쪽은 원본과 그림이 같다
    await app.openCellMenu(1);
    await app.change(() => app.menuItem('복제').click());
    for (let i = 0; i < 6; i++) await app.cellDrawn(i);
    expect(await app.renderQuiet()).toBe(c0);
    // 회전은 그 쪽만
    await app.openCellMenu(0);
    await app.change(() => app.menuItem(/오른쪽으로 회전/).click());
    for (let i = 0; i < 6; i++) await app.cellDrawn(i);
    expect(await app.renderQuiet()).toBe(c0 + 1);
    expect(page.url()).toBeTruthy();
  });

  test('주석을 넣고 되돌리고 다시 해도 화면의 쪽 그림은 그때그때의 내용이다(옛 그림을 잘못 재사용하지 않는다)', async ({ app }) => {
    await app.goto();
    await app.open(G.docA);
    await app.firstPageDrawn();
    await app.renderQuiet();
    const red = async () => ((await app.canvasBBox(0, 'redish'))?.n ?? 0) > 50;
    expect(await red()).toBe(false);
    await app.pickTool('사각형');
    await app.change(() => app.dragOnPage(300, [60, 60], [200, 160]));
    await expect.poll(red).toBe(true);
    await app.undo();
    await expect.poll(red).toBe(false);
    await app.redo();
    await expect.poll(red).toBe(true);
    await app.undo();
    await expect.poll(red).toBe(false);
    // 쪽 구조 조작을 거친 뒤에도(화면이 다시 만들어진다) 같다
    await app.redo();
    await expect.poll(red).toBe(true);
    await app.change(() => app.thumbAction(1, 'copy'));
    await app.pageDrawn(0);
    await expect.poll(red).toBe(true);
    await app.undo();
    await app.pageDrawn(0);
    await expect.poll(red).toBe(true);
    await app.undo();
    await expect.poll(red).toBe(false);
  });
});

test.describe('끌어서 다른 파일로: Shift 를 누른 채 놓으면 이동', () => {
  const ghost = (app: App) => app.page.getByTestId('drag-ghost');

  test('보기 모드: 탭 위에서 Shift 를 누르면 설명이 이동으로 바뀌고, 놓으면 원본에서 빠지며 한 번에 되돌려진다', async ({ app, page }) => {
    await app.goto();
    await app.open([G.docA, G.docB]);
    await app.switchTab('docA.pdf');
    await app.clickThumb(1);
    const from = await app.center(app.thumbFace(1));
    const to = await app.center(app.tab('docB.pdf'));
    await app.dragMouse(from, to, { steps: 12, release: false });
    await expect(ghost(app)).toContainText('끝에 복사');
    await page.keyboard.down('Shift');
    await expect(ghost(app)).toContainText('끝에 이동');
    await page.keyboard.up('Shift');
    await expect(ghost(app)).toContainText('끝에 복사');
    await page.keyboard.down('Shift');
    await app.change(() => app.releaseMouse());
    await page.keyboard.up('Shift');
    await expect.poll(() => app.pageCounts()).toEqual([4, 5]);
    expect(await app.activeTabName()).toBe('docA.pdf');
    await app.undo();
    await expect.poll(() => app.pageCounts()).toEqual([5, 4]);
  });

  test('정리 모드: 파일 항목·새 파일 칸에 Shift 를 누른 채 놓으면 이동, 그냥 놓으면 복사', async ({ app, page }) => {
    await app.goto();
    await app.open([G.docA, G.docB]);
    await app.setMode('organize');
    await app.selectFile('docA.pdf');
    await app.clickCell(0);
    await app.dragMouse(await app.center(app.cellFace(0)), await app.center(app.fileRow('docB.pdf')), { steps: 12, release: false });
    await page.keyboard.down('Shift');
    await expect(ghost(app)).toContainText('끝에 이동');
    await app.change(() => app.releaseMouse());
    await page.keyboard.up('Shift');
    await expect.poll(() => app.pageCounts()).toEqual([4, 5]);
    // 새 파일 칸: Shift 없이 놓으면 복사
    await app.selectFile('docA.pdf');
    await app.clickCell(0);
    await app.dragMouse(await app.center(app.cellFace(0)), await app.center(page.getByTestId('new-slot')), { release: false });
    await expect(ghost(app)).toContainText('새 파일로 복사');
    await app.change(() => app.releaseMouse());
    await expect.poll(() => app.pageCounts()).toEqual([4, 5, 1]);
    // 새 파일 칸: Shift 를 누른 채 놓으면 이동
    await app.selectFile('docA.pdf');
    await app.clickCell(1);
    await app.dragMouse(await app.center(app.cellFace(1)), await app.center(page.getByTestId('new-slot')), { release: false });
    await page.keyboard.down('Shift');
    await expect(ghost(app)).toContainText('새 파일로 이동');
    await app.change(() => app.releaseMouse());
    await page.keyboard.up('Shift');
    await expect.poll(() => app.pageCounts()).toEqual([3, 5, 1, 1]);
  });
});
