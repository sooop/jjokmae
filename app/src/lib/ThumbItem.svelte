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

  /** 비트맵이 그려졌는가(그려지기 전에는 자리표시 배경을 보인다. :has() 선택자 대신 상태로 안다 — 칸이 수백 개여도 스타일 무효화가 없다) */
  let drawn = $state(false);
  $effect(() => {
    if (!visible) drawn = false;
  });
</script>

<div
  class="thumb"
  class:selected
  class:checked
  class:moving
  class:vis={visible}
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
      class:blank={visible && !drawn}
      aria-label="{index + 1}쪽으로 이동{checked ? ' (선택됨)' : ''}"
      title="{index + 1}쪽 · Ctrl/Shift+클릭으로 여러 쪽 선택"
      aria-current={selected ? 'page' : undefined}
      aria-pressed={checked}
      tabindex={grid ? -1 : undefined}
      onclick={(e) => onselect(index, e)}
    >
      <PageCanvas {index} {visible} {scale} {scheduler} {priority} {rev} reuse ondraw={() => (drawn = true)} />
    </button>
    {#if selected || checked}<span class="ring" aria-hidden="true"></span>{/if}
    {#if checked}
      <span class="check" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path class="draw" d="M5 12.5l4.5 4.5L19 7" pathLength="1" /></svg>
      </span>
    {/if}
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
    position: relative;
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
    transition:
      box-shadow var(--dur-base) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      opacity var(--dur-base) var(--ease-out),
      transform var(--spring-snappy-dur) var(--spring-snappy);
  }
  .face:hover:not(:disabled) { background: var(--page-bg); border-color: var(--fg-muted); box-shadow: var(--shadow-2); }
  .face:active:not(:disabled) { transform: scale(0.985); box-shadow: var(--shadow-1); }
  /* 아직 그려지지 않은 쪽은 정적인 자리표시(연속 애니메이션은 스크롤 성능을 해쳐서 쓰지 않는다) */
  .face.blank { background: color-mix(in srgb, var(--page-bg) 94%, var(--fg)); }
  /* 선택 테두리: 칸 둘레를 감싸며 스프링으로 나타난다(선택된 칸에만 만든다) */
  .ring {
    position: absolute;
    inset: -4px;
    border: 2px solid var(--fg);
    border-radius: 7px;
    pointer-events: none;
    animation: ring-in var(--spring-bouncy-dur) var(--spring-bouncy) backwards;
  }
  @keyframes ring-in { from { opacity: 0; transform: scale(0.95); } }
  .checked:not(.selected):not(.grid) .ring { border-style: dashed; }
  .grid.checked .ring { border-width: 3px; inset: -5px; border-radius: 8px; }
  .grid.focused .face { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--fg-muted); }
  .grid.checked .num { color: var(--fg); font-weight: 600; }
  .num { transition: color var(--dur-fast) var(--ease-out); }
  /* 끌려 간 쪽의 원래 자리: 윤곽만 남은 자리표시 */
  .moving .face { opacity: 0.22; border-style: dashed; box-shadow: none; }
  .moving .ring { display: none; }
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
    box-shadow: 0 0 0 2px var(--page-bg), var(--shadow-1);
    pointer-events: none;
    animation: var(--kf-pop) var(--spring-bouncy-dur) var(--spring-bouncy) both;
  }
  .draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 260ms var(--ease-out) 110ms forwards; }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .draw { animation: none; stroke-dashoffset: 0; }
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
    transition: opacity var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out);
  }
  .grip :global(svg) { transform: scale(0.8); transition: transform var(--spring-bouncy-dur) var(--spring-bouncy); }
  .frame:hover .grip,
  .frame:focus-within .grip { opacity: 1; }
  .frame:hover .grip :global(svg), .frame:focus-within .grip :global(svg) { transform: none; }
  .grip:active:not(:disabled) { cursor: grabbing; transform: none; }
  .num {
    font-size: 12px;
    line-height: 18px;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }
  .selected .num { color: var(--fg); font-weight: 600; }
  /* 아이콘 버튼 줄: 호버·포커스에서 아래에서 솟아오른다. 평소에는 배치에서 빠져 있어(칸이 수백 개여도) 비용이 없다 */
  .actions {
    position: absolute;
    left: 50%;
    bottom: 4px;
    transform: translateX(-50%);
    transform-origin: 50% 100%;
    display: none;
    flex-direction: row;
    gap: 2px;
    padding: 2px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-2);
  }
  .frame:hover .actions,
  .frame:focus-within .actions {
    display: flex;
    animation: actions-in var(--spring-pop-dur) var(--spring-pop);
  }
  @keyframes actions-in { from { opacity: 0; transform: translate(-50%, 9px) scale(0.94); } }
  @media (hover: none) {
    .actions { display: flex; }
    .grip { opacity: 1; width: 32px; height: 32px; }
    .grip :global(svg) { transform: none; }
  }
</style>
