<script lang="ts">
  // 한 페이지(또는 썸네일)의 비트맵을 그리는 캔버스. visible 이 true 인 동안만 렌더를 요청하고,
  // false 가 되면 요청을 취소하고 캔버스 크기를 0 으로 만들어 비트맵을 해제한다.
  import { stats, type RenderScheduler } from './render-queue';

  let {
    index,
    visible,
    scale,
    scheduler,
    priority,
    rev = 0,
    ondraw,
    reuse = false,
  }: {
    index: number;
    visible: boolean;
    /** 72dpi 기준 배율(devicePixelRatio 포함) */
    scale: number;
    scheduler: RenderScheduler;
    /** 작을수록 먼저 그린다. 보내는 시점에 평가된다 */
    priority: () => number;
    /** 무효화 키. 바뀌면 같은 배율이어도 이 쪽만 다시 그린다(이전 비트맵은 새 것이 올 때까지 둔다) */
    rev?: number;
    /** 비트맵을 캔버스에 그린 직후(그 때의 rev) */
    ondraw?: (rev: number) => void;
    /** true 면 이미 그린 비트맵이 요청 배율 이상일 때 다시 그리지 않고 CSS 로 줄여 쓴다(썸네일 크기를 줄일 때) */
    reuse?: boolean;
  } = $props();

  let canvas: HTMLCanvasElement;
  let drawnScale = 0;
  let drawnRev = -1;

  function release() {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
    drawnScale = 0;
    drawnRev = -1;
  }

  $effect(() => {
    if (!visible) {
      release();
      return;
    }
    const s = scale;
    const r = rev;
    if (drawnRev === r && (drawnScale === s || (reuse && drawnScale > s))) return;
    const job = scheduler.request(index, s, priority);
    let alive = true;
    void job.promise.then(async (b) => {
      if (!alive || !b) return;
      // 픽셀 변환·복사를 메인 스레드 밖에서 하도록 ImageBitmap 으로 한 번 거친다
      const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(b.data), b.width, b.height), {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      }).catch(() => null);
      if (!bmp) return;
      if (!alive) {
        bmp.close();
        return;
      }
      const t0 = performance.now();
      canvas.width = b.width;
      canvas.height = b.height;
      canvas.getContext('2d')?.drawImage(bmp, 0, 0);
      bmp.close();
      drawnScale = s;
      drawnRev = r;
      const dt = performance.now() - t0;
      stats.draws++;
      stats.drawMs += dt;
      stats.drawMax = Math.max(stats.drawMax, dt);
      ondraw?.(r);
    });
    return () => {
      alive = false;
      job.cancel();
    };
  });

  $effect(() => release);
</script>

<canvas bind:this={canvas} width="0" height="0"></canvas>

<style>
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
