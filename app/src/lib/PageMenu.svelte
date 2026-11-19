<script lang="ts" module>
  export interface PageMenuReq {
    x: number;
    y: number;
    /** 메뉴를 연 시점의 문서(메뉴가 열려 있는 동안 활성 문서가 바뀌어도 이 문서에 적용한다) */
    fromKey: number;
    pages: number[];
  }
</script>

<script lang="ts">
  // 쪽 우클릭·길게 누르기·메뉴 키 메뉴. 정리 모드 격자(Organize)와 보기 모드 썸네일 패널(App)이 같은 메뉴를 쓴다.
  // 항목 순서: 보내기·옮기기 → 복제·회전 → 추출·분할·인쇄 → (구분선) 삭제. 대상은 호출한 쪽이 정해 pages 로 넘긴다
  // (눌린 칸이 선택에 있으면 선택 전체, 없으면 그 칸만). 삭제는 되돌리기(Ctrl+Z)로 되돌릴 수 있어 확인창이 없다.
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
  import SendPopover from './SendPopover.svelte';
  import * as pa from './page-actions';
  import type { SendPos } from './transfer';
  import type { Workspace } from './workspace.svelte';

  let {
    ws,
    req,
    onsplit,
    onprint,
    onclose,
  }: {
    ws: Workspace;
    req: PageMenuReq;
    onsplit: () => void;
    /** 메뉴를 연 쪽들이 선택이 되도록 맞춘 뒤 부른다 */
    onprint: () => void;
    /** 닫는다. refocus 가 true 면 호출한 쪽이 포커스를 돌려준다 */
    onclose: (refocus: boolean) => void;
  } = $props();

  /** 'send' 는 '위치 지정…' 팝오버 */
  let stage = $state<{ kind: 'menu' } | { kind: 'send'; mode: 'copy' | 'move' }>({ kind: 'menu' });

  const items = $derived.by((): MenuItem[] => {
    const d = ws.docOf(req.fromKey);
    if (!d) return [];
    const n = req.pages.length;
    const all = n >= d.total;
    const targets = (mode: 'copy' | 'move'): MenuItem[] => [
      {
        id: `${mode}:new`,
        label: '새 파일',
        disabled: mode === 'move' && all,
        title: mode === 'move' && all ? '모든 쪽을 옮기면 원본이 빈 문서가 됩니다. 복사를 쓰거나 한 쪽 이상 남겨 주세요.' : undefined,
      },
      ...ws.docs.map((t) => ({
        id: `${mode}:doc:${t.key}`,
        label: `‘${t.name}’ 맨 뒤${t.key === d.key ? ' (이 파일)' : ''}`,
        disabled: mode === 'move' && t.key !== d.key && all,
        title: mode === 'move' && t.key !== d.key && all ? '모든 쪽을 옮기면 원본이 빈 문서가 됩니다.' : t.name,
      })),
      { id: `${mode}:pos`, label: '위치 지정…' },
    ];
    return [
      { id: 'copy', label: '복사 →', sub: targets('copy') },
      { id: 'move', label: '이동 →', sub: targets('move') },
      { id: 'dup', label: `${n}쪽 복제`, title: '고른 쪽을 바로 뒤에 복제합니다' },
      { id: 'rotcw', label: `${n}쪽 오른쪽으로 회전`, title: '시계 방향 90°' },
      { id: 'rotccw', label: `${n}쪽 왼쪽으로 회전`, title: '반시계 방향 90°' },
      { id: 'extract', label: '추출', title: '고른 쪽만 새 PDF 로 저장합니다' },
      { id: 'split', label: '분할…' },
      { id: 'print', label: '인쇄…', title: '고른 쪽을 인쇄합니다' },
      {
        id: 'del',
        label: `${n}쪽 삭제`,
        danger: true,
        divider: true,
        disabled: all,
        title: all ? '모든 쪽을 삭제할 수 없습니다. 한 쪽 이상 남겨 주세요.' : 'Ctrl+Z 로 되돌릴 수 있습니다',
      },
    ];
  });

  function pick(path: string[]) {
    const d = ws.docOf(req.fromKey);
    if (!d) return;
    const id = path[path.length - 1];
    const pages = req.pages;
    const [head, kind, key] = id.split(':');
    if (head === 'copy' || head === 'move') {
      const mode = head;
      if (kind === 'pos') {
        stage = { kind: 'send', mode };
        return;
      }
      onclose(true);
      if (kind === 'new') void pa.send(ws, { from: d, pages, mode, target: { type: 'new' } });
      else void pa.send(ws, { from: d, pages, mode, target: { type: 'doc', key: Number(key), pos: 'end' } });
      return;
    }
    onclose(true);
    if (id === 'dup') pa.duplicate(ws, pages);
    else if (id === 'rotcw') pa.rotate(ws, pages, 'cw');
    else if (id === 'rotccw') pa.rotate(ws, pages, 'ccw');
    else if (id === 'del') pa.remove(ws, pages);
    else if (id === 'extract') void ws.extract(pages);
    else if (id === 'split') onsplit();
    else if (id === 'print') {
      // 메뉴를 연 쪽(선택에 속하면 선택 전체)을 인쇄 대상으로 삼는다
      const same = d.selected.length === pages.length && pages.every((p) => d.selected.includes(p));
      if (!same) d.selected = [...pages];
      onprint();
    }
  }

  // 위치 지정(보내기 팝오버)을 메뉴가 열린 자리에 띄운다
  let sendHost: HTMLDivElement | undefined = $state();
  let adj = $state({ dx: 0, dy: 0 });
  $effect(() => {
    if (stage.kind !== 'send') return;
    adj = { dx: 0, dy: 0 };
    queueMicrotask(() => {
      const pop = sendHost?.firstElementChild as HTMLElement | null;
      if (!pop) return;
      const r = pop.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      adj = { dx: Math.min(0, vw - 8 - r.right), dy: r.bottom > vh - 8 ? Math.max(8 - r.top, vh - 8 - r.bottom) : 0 };
    });
  });
  $effect(() => {
    if (stage.kind !== 'send') return;
    const down = (e: PointerEvent) => {
      if (sendHost && !sendHost.contains(e.target as Node)) onclose(true);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  });

  function onSendRun(mode: 'copy' | 'move', target: { type: 'new' } | { type: 'doc'; key: number; pos: SendPos }) {
    const d = ws.docOf(req.fromKey);
    onclose(true);
    if (d) void pa.send(ws, { from: d, pages: req.pages, mode, target });
  }
</script>

{#if stage.kind === 'menu'}
  <ContextMenu x={req.x} y={req.y} label="{req.pages.length}쪽" {items} onpick={pick} onclose={() => onclose(true)} />
{:else}
  <div class="sendhost" bind:this={sendHost} style:left="{req.x + adj.dx}px" style:top="{req.y + adj.dy}px" data-testid="send-host">
    <SendPopover
      count={req.pages.length}
      docs={ws.docs.map((d) => ({ key: d.key, name: d.name, total: d.total, self: d.key === req.fromKey }))}
      busy={ws.opBusy}
      initialMode={stage.mode}
      onrun={onSendRun}
      onclose={() => onclose(true)}
    />
  </div>
{/if}

<style>
  .sendhost { position: fixed; z-index: 60; width: 0; height: 0; }
</style>
