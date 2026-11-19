<script lang="ts">
  // 썸네일 항목 한 칸. 왼쪽 위 체크박스로 이 쪽을 선택에 넣고 뺀다(평소엔 숨기고 호버·포커스·선택됨·선택 모드·터치에서 보인다).
  // 회전·복제·삭제 같은 조작은 우클릭·길게 누르기·메뉴 키로 여는 쪽 메뉴(PageMenu)가 맡는다.
  // 드래그 재정렬: 마우스는 항목 어디서나(문턱 거리 이후), 터치·펜은 길게 눌러 준비한 뒤 끈다(부모가 TouchHold 로 처리).
  import PageCanvas from './PageCanvas.svelte';
  import type { RenderScheduler } from './render-queue';

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
    oncheck,
    selectMode = false,
    armed = false,
    grid = false,
    focused = false,
    ondblopen,
    lift = 0,
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
    onpress?: (e: PointerEvent, index: number) => void;
    /** 체크박스를 눌렀다(shift: 범위로 더한다). 눌러도 이 칸의 선택 여부만 바뀐다 */
    oncheck?: (index: number, shift: boolean) => void;
    /** 선택이 하나라도 있다: 모든 칸에 체크박스를 보이고, 본체 클릭은 선택을 토글한다 */
    selectMode?: boolean;
    /** 터치로 길게 눌러 끌 준비가 된 칸(살짝 떠오른다) */
    armed?: boolean;
    /** 정리 모드 격자의 칸: 선택 표시를 실선으로, 얼굴 버튼은 Tab 정지에서 뺀다(격자가 키보드를 맡는다) */
    grid?: boolean;
    /** 키보드 포커스가 있는 칸 */
    focused?: boolean;
    /** 더블클릭(정리 모드: 그 쪽을 보기 모드로 열기) */
    ondblopen?: (index: number) => void;
    /** 쪽 얼굴을 번호 위로 띄우는 거리(px). 격자에서 칸보다 낮은 쪽을 쪽 영역 가운데에 놓는다 */
    lift?: number;
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
  class:armed
  class:selmode={selectMode}
  class:vis={visible}
  class:grid
  class:focused
  data-thumb={index}
  onpointerdown={(e) => onpress?.(e, index)}
  ondblclick={() => ondblopen?.(index)}
  role="presentation"
>
  <div class="frame" style:width="{width}px" style:height="{height}px" style:margin-bottom={lift ? `${lift}px` : undefined}>
    <button
      type="button"
      class="face"
      class:blank={visible && !drawn}
      aria-label="{index + 1}쪽으로 이동{checked ? ' (선택됨)' : ''}"
      title={selectMode ? `${index + 1}쪽 · 클릭으로 선택 전환 (Shift+클릭: 범위)` : `${index + 1}쪽 · Ctrl/Shift+클릭으로 여러 쪽 선택`}
      aria-current={selected ? 'page' : undefined}
      aria-pressed={checked}
      tabindex={grid ? -1 : undefined}
      onclick={(e) => onselect(index, e)}
    >
      <PageCanvas {index} {visible} {scale} {scheduler} {priority} {rev} reuse ondraw={() => (drawn = true)} />
    </button>
    {#if selected || checked}<span class="ring" aria-hidden="true"></span>{/if}
    <button
      type="button"
      class="chk"
      role="checkbox"
      aria-checked={checked}
      aria-label="{index + 1}쪽 선택"
      title="{index + 1}쪽 선택 (Shift+클릭: 범위)"
      tabindex={grid ? -1 : undefined}
      onpointerdown={(e) => e.stopPropagation()}
      ondblclick={(e) => e.stopPropagation()}
      onclick={(e) => {
        e.stopPropagation();
        oncheck?.(index, e.shiftKey);
      }}
    >
      <span class="box">
        {#if checked}
          <span class="check" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path class="draw" d="M5 12.5l4.5 4.5L19 7" pathLength="1" /></svg>
          </span>
        {/if}
      </span>
    </button>
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
  /* 체크박스: 눌리는 영역은 28px(터치 36px), 보이는 것은 20px 원. 선택되면 .check 가 스프링으로 차오른다 */
  .chk {
    position: absolute;
    top: 2px;
    left: 2px;
    z-index: 1;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    min-width: 0;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    box-shadow: none;
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease-out);
  }
  .box {
    position: relative;
    display: block;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid var(--fg-muted);
    background: color-mix(in srgb, var(--surface) 85%, transparent);
    box-shadow: var(--shadow-1);
    transition: transform var(--spring-bouncy-dur) var(--spring-bouncy), border-color var(--dur-fast) var(--ease-out);
    transform: scale(0.85);
  }
  .frame:hover .chk,
  .frame:focus-within .chk,
  .selmode .chk,
  .checked .chk { opacity: 1; }
  .frame:hover .box, .frame:focus-within .box, .selmode .box, .checked .box { transform: none; }
  .chk:hover:not(:disabled) .box { border-color: var(--fg); }
  .chk:focus-visible { outline: 2px solid var(--fg); outline-offset: 0; }
  .chk:active:not(:disabled) { transform: none; }
  .checked .box { border-color: transparent; background: var(--accent); }
  .check {
    position: absolute;
    inset: -2px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-fg);
    pointer-events: none;
    animation: var(--kf-pop) var(--spring-bouncy-dur) var(--spring-bouncy) both;
  }
  .draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 260ms var(--ease-out) 110ms forwards; }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .draw { animation: none; stroke-dashoffset: 0; }
  }
  .num {
    font-size: 12px;
    line-height: 18px;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }
  .selected .num { color: var(--fg); font-weight: 600; }
  /* 터치로 길게 눌러 끌 준비가 됐다: 칸이 살짝 떠오른다 */
  .armed .face { transform: scale(1.04); box-shadow: var(--shadow-3); border-color: var(--fg-muted); }
  /* 호버가 없는 기기: 체크박스를 항상 보이고, 누르는 영역을 키운다 */
  @media (hover: none), (pointer: coarse) {
    .chk { opacity: 1; width: 36px; height: 36px; }
    .box { transform: none; }
  }
</style>
