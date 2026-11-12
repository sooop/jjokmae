// 쪽 조작의 화면 진입점. 모든 화면(격자·썸네일·메뉴·도구 줄·키보드)이 Workspace 를 직접 부르는 대신 여기를 지난다:
// 조작 직전의 쪽 비트맵으로 FLIP 연출(page-flip)을 먼저 띄우고, 같은 호출로 Workspace 조작을 시작한다.
// 연출은 조작 완료를 기다리지 않고, 조작이 거절되면(작업 중 등) 연출도 하지 않는다.
import type { ScreenRect } from './motion/drag-ghost';
import { duplicatePlan, flyToTarget, planFor, removePlan, reorderPlan, rotatePlan, run, type Plan } from './motion/page-flip';
import { dropOrder, isIdentity } from './page-ops';
import type { DocState, SendSpec, Workspace } from './workspace.svelte';

const uniq = (pages: number[]) => [...new Set(pages)].sort((a, b) => a - b);

function play(ws: Workspace, plan: Plan | null, starts?: Map<number, ScreenRect>) {
  const d = ws.active;
  if (!d || !plan) return;
  run(plan, { starts }, { docKey: d.key, stateId: d.stateId });
}

export function reorder(ws: Workspace, moving: number[], before: number, starts?: Map<number, ScreenRect>) {
  const d = ws.active;
  if (!d) return;
  if (!ws.opBusy) {
    const order = dropOrder(d.total, moving, before);
    if (!isIdentity(order)) play(ws, reorderPlan(d.sizes, order), starts);
  }
  ws.reorder(moving, before);
}

export function rotate(ws: Workspace, pages: number[]) {
  const d = ws.active;
  const list = uniq(pages).filter((i) => d && i >= 0 && i < d.total);
  if (d && !ws.opBusy && list.length) play(ws, rotatePlan(d.sizes, list));
  ws.rotate(pages);
}

export function remove(ws: Workspace, pages: number[]) {
  const d = ws.active;
  const list = uniq(pages).filter((i) => d && i >= 0 && i < d.total);
  // 전부 지우는 요청은 Workspace 가 안내만 하고 거절한다
  if (d && !ws.opBusy && list.length && list.length < d.total) play(ws, removePlan(d.sizes, list));
  ws.remove(pages);
}

export function duplicate(ws: Workspace, pages: number[]) {
  const d = ws.active;
  const list = uniq(pages).filter((i) => d && i >= 0 && i < d.total);
  if (d && !ws.opBusy && list.length) play(ws, duplicatePlan(d.sizes, list, list[list.length - 1] + 1));
  ws.duplicate(pages);
}

export function step(ws: Workspace, dir: 'undo' | 'redo') {
  const d = ws.active;
  if (d && !ws.opBusy && (dir === 'undo' ? d.undoCount : d.redoCount) > 0) {
    const plan = planFor(d.stateId, dir, d.total);
    if (plan) run(plan);
  }
  return ws.stepHistory(dir);
}

/** 쪽을 대상 파일로 보낸다: 쪽이 대상 칸으로 날아가 빨려 들고 대상이 반응한다. 이동이면 원본 칸이 비워진다 */
export function send(ws: Workspace, spec: SendSpec, rects?: ScreenRect[]): Promise<boolean> {
  const from: DocState = spec.from;
  const pages = uniq(spec.pages);
  if (!ws.opBusy && pages.length && ws.docs.includes(from)) {
    const t = spec.target;
    let el: Element | null = null;
    if (t.type === 'doc') el = document.querySelector(`[data-tab-key="${t.key}"]`);
    else el = document.querySelector('[data-new-file]') ?? document.querySelector('[data-testid=tabs]');
    if (from.key === ws.activeKey) {
      flyToTarget(pages, el, rects);
      if (spec.mode === 'move' && pages.length < from.total) play(ws, { ...removePlan(from.sizes, pages), skipExit: true });
    }
  }
  return ws.send(spec);
}
