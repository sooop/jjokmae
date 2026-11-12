<script lang="ts">
  // 썸네일 항목 한 칸. 회전·삭제·복사 아이콘 버튼은 `actions` 스니펫으로 받는다.
  // 드래그 재정렬: 마우스는 항목 어디서나(문턱 거리 이후), 터치·펜은 왼쪽 위 손잡이에서 시작한다
  // (항목 자체는 세로 스크롤을 그대로 둔다).
  import type { Snippet } from 'svelte';
  import PageCanvas from './PageCanvas.svelte';
  import type { RenderScheduler } from './render-queue';
  import Icon from './ui/Icon.svelte';

  let {
    index,
    width,
    height,
    selected,
    checked = false,
    moving = false,
    visible,
    scale,
    scheduler,
    priority,
    rev = 0,
    onselect,
    onpress,
    actions,
    grid = false,
    focused = false,
    showActions = true,
    ondblopen,
  }: {
    index: number;
    width: number;
    height: number;
    /** 현재 보고 있는 쪽 */
    selected: boolean;
    /** 다중 선택에 들어 있는 쪽 */
    checked?: boolean;
    /** 드래그로 옮기는 중인 쪽 */
    moving?: boolean;
    visible: boolean;
    scale: number;
    scheduler: RenderScheduler;
    priority: () => number;
    rev?: number;
    onselect: (index: number, e: MouseEvent) => void;
    onpress?: (e: PointerEvent, index: number, handle: boolean) => void;
    /** 아이콘 버튼 슬롯. 호버·포커스 때 face 아래쪽에 겹쳐 보인다(터치 기기는 항상) */
    actions?: Snippet<[number]>;
    /** 정리 모드 격자의 칸: 선택 표시를 실선으로, 얼굴 버튼은 Tab 정지에서 뺀다(격자가 키보드를 맡는다) */
    grid?: boolean;
    /** 키보드 포커스가 있는 칸 */
    focused?: boolean;
    /** false 면 아이콘 버튼 줄을 숨긴다(칸이 너무 작을 때. 같은 조작은 우클릭 메뉴로 한다) */
    showActions?: boolean;
    /** 더블클릭(정리 모드: 그 쪽을 보기 모드로 열기) */
    ondblopen?: (index: number) => void;
  } = $props();
</script>

<div
  class="thumb"
  class:selected
  class:checked
  class:moving
  class:grid
  class:focused
  data-thumb={index}
  onpointerdown={(e) => onpress?.(e, index, false)}
  ondblclick={() => ondblopen?.(index)}
  role="presentation"
>
  <div class="frame" style:width="{width}px" style:height="{height}px">
    <button
      type="button"
      class="face"
      aria-label="{index + 1}쪽으로 이동{checked ? ' (선택됨)' : ''}"
      title="{index + 1}쪽 · Ctrl/Shift+클릭으로 여러 쪽 선택"
      aria-current={selected ? 'page' : undefined}
      aria-pressed={checked}
      tabindex={grid ? -1 : undefined}
      onclick={(e) => onselect(index, e)}
    >
      <PageCanvas {index} {visible} {scale} {scheduler} {priority} {rev} reuse />
    </button>
    {#if checked}<span class="check" aria-hidden="true"><Icon name="check" size={14} /></span>{/if}
    {#if onpress}
      <button
        type="button"
        class="grip"
        aria-label="{index + 1}쪽을 끌어서 옮기기"
        title="끌어서 순서 바꾸기"
        tabindex="-1"
        onpointerdown={(e) => {
          e.stopPropagation();
          onpress?.(e, index, true);
        }}
      >
        <Icon name="grip" size={14} />
      </button>
    {/if}
    {#if actions && showActions}
      <div class="actions">{@render actions(index)}</div>
    {/if}
  </div>
  <span class="num">{index + 1}</span>
</div>

<style>
  .thumb {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    user-select: none;
    -webkit-user-select: none;
  }
  .frame {
    position: relative;
  }
  .face {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
    min-width: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--page-bg);
    overflow: hidden;
    touch-action: pan-y;
  }
  .face:hover:not(:disabled) { background: var(--page-bg); border-color: var(--fg-muted); }
  .selected .face { outline: 2px solid var(--fg); outline-offset: 1px; border-color: var(--fg); }
  .checked .face { outline: 2px dashed var(--fg); outline-offset: 1px; border-color: var(--fg); }
  .selected.checked .face { outline-style: solid; }
  .grid.checked .face { outline: 3px solid var(--fg); outline-offset: 0; border-color: var(--fg); }
  .grid.focused .face { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--fg-muted); }
  .grid.checked .num { color: var(--fg); font-weight: 600; }
  .moving { opacity: 0.45; }
  .check {
    position: absolute;
    right: 3px;
    top: 3px;
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-fg);
    pointer-events: none;
  }
  .grip {
    position: absolute;
    top: 2px;
    left: 2px;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    min-width: 0;
    min-height: 0;
    padding: 0;
    border-radius: 6px;
    cursor: grab;
    touch-action: none;
    opacity: 0;
  }
  .frame:hover .grip,
  .frame:focus-within .grip { opacity: 1; }
  .num {
    font-size: 12px;
    line-height: 18px;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }
  .selected .num { color: var(--fg); font-weight: 600; }
  .actions {
    position: absolute;
    left: 50%;
    bottom: 4px;
    transform: translateX(-50%);
    display: none;
    flex-direction: row;
    gap: 2px;
    padding: 1px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.18);
  }
  .frame:hover .actions,
  .frame:focus-within .actions { display: flex; }
  @media (hover: none) {
    .actions { display: flex; }
    .grip { opacity: 1; width: 32px; height: 32px; }
  }
</style>
