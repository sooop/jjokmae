<script lang="ts">
  // 한 쪽 위의 찾기 표시. 일치마다 줄 단위 사각형을 칠하고, 현재 항목은 더 진하게 표시한다. 입력은 받지 않는다.
  let {
    hits,
    k,
    active = -1,
  }: {
    /** 이 쪽의 일치들(일치마다 줄 단위 quad: 좌상·우상·좌하·우하, 쪽 공간 pt) */
    hits: number[][][];
    /** pt → css px */
    k: number;
    /** 현재 항목(이 쪽 안의 번호). 이 쪽이 아니면 -1 */
    active?: number;
  } = $props();

  const PAD = 1.5;
  function style(q: number[]): string {
    const x0 = Math.min(q[0], q[2], q[4], q[6]);
    const x1 = Math.max(q[0], q[2], q[4], q[6]);
    const y0 = Math.min(q[1], q[3], q[5], q[7]);
    const y1 = Math.max(q[1], q[3], q[5], q[7]);
    return `left:${x0 * k - PAD}px;top:${y0 * k - PAD}px;width:${(x1 - x0) * k + PAD * 2}px;height:${(y1 - y0) * k + PAD * 2}px`;
  }
</script>

<div class="marks" aria-hidden="true" data-find-marks>
  {#each hits as h, i (i)}
    {#each h as q, j (j)}
      <span class="mark" class:on={i === active} style={style(q)} data-find-hit={i}></span>
    {/each}
  {/each}
</div>

<style>
  .marks { position: absolute; inset: 0; pointer-events: none; }
  .mark {
    position: absolute;
    border-radius: 2px;
    background: #ffd400;
    opacity: 0.42;
    mix-blend-mode: multiply;
  }
  .mark.on {
    background: #ff8a00;
    opacity: 0.62;
    box-shadow: 0 0 0 1.5px #c45f00;
  }
  @media print { .marks { display: none; } }
</style>
