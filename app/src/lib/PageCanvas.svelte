<script lang="ts">
  // 한 페이지(또는 썸네일)의 비트맵을 그리는 캔버스. visible 이 true 인 동안만 렌더를 요청하고,
  // false 가 되면 요청을 취소하고 캔버스 크기를 0 으로 만들어 비트맵을 해제한다.
  // 같은 내용의 그림이 비트맵 캐시에 있으면 엔진에 요청하지 않고 바로 그린다(쪽 순서 바꾸기·삭제·복제·모드 전환 뒤).
  import { untrack } from 'svelte';
  import { pageBitmaps } from './bitmap-cache';
  import { reduced } from './motion';
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
  /** 요청한 배율로 그린 그림의 배율(임시 그림만 있으면 0) */
  let drawnScale = 0;
  let drawnRev = -1;
  /** 캔버스에 무언가(임시 그림 포함) 그려져 있는가 */
  let shown = false;

  function release() {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
    drawnScale = 0;
    drawnRev = -1;
    shown = false;
  }

  function paint(bmp: ImageBitmap) {
    const t0 = performance.now();
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d')?.drawImage(bmp, 0, 0);
    shown = true;
    const dt = performance.now() - t0;
    stats.draws++;
    stats.drawMs += dt;
    stats.drawMax = Math.max(stats.drawMax, dt);
  }

  $effect(() => {
    if (!visible) {
      release();
      return;
    }
    const s = scale;
    const r = rev;
    const idx = index;
    const sch = scheduler;
    if (drawnRev === r && (drawnScale === s || (reuse && drawnScale > s))) return;
    // 캐시에서 바로 그릴 수 있으면 요청하지 않는다. 내용 id 는 반응 상태가 아니다(바뀔 때는 rev 나 화면 재생성이 함께 온다)
    const key = sch.cacheKey(idx);
    const done = untrack(() => {
      if (key == null) return false;
      const hit = pageBitmaps.get(key, s);
      if (hit) {
        paint(hit);
        drawnScale = s;
        drawnRev = r;
        ondraw?.(r);
        return true;
      }
      // 같은 내용의 다른 배율 그림이 있으면(썸네일 ↔ 본문, 확대 전후) 새 그림이 올 때까지 그것을 늘려 보여 준다
      if (!shown) {
        const near = pageBitmaps.nearest(key, s);
        if (near) {
          paint(near);
          ondraw?.(r);
        }
      }
      return false;
    });
    if (done) return;
    const job = sch.request(idx, s, priority);
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
      const first = !shown;
      paint(bmp);
      // 요청한 뒤로 이 쪽의 내용 id 가 바뀌었으면(그 사이 편집) 어느 내용의 그림인지 알 수 없으므로 캐시에 넣지 않는다
      if (key == null || sch.cacheKey(idx) !== key || !pageBitmaps.put(key, s, bmp)) bmp.close();
      drawnScale = s;
      drawnRev = r;
      // 자리표시에서 실제 이미지로: 처음 그려질 때 한 번만 부드럽게 나타난다. CSS 애니메이션으로 걸어 두면 스크롤 표시
      // (data-scrolling)가 풀릴 때 모든 쪽의 애니메이션이 다시 시작해 화면이 깜박이므로 그릴 때 직접 한 번 재생한다.
      // 빠르게 스크롤하는 동안은 바로 보인다(수십 장이 동시에 페이드하면 프레임이 끊긴다).
      if (first && canvas.animate && !canvas.closest('[data-scrolling]')) {
        canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced() ? 90 : 160, easing: 'ease-out' });
      }
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
