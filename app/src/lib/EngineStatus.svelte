<script lang="ts">
  // 엔진 내려받기 확인·진행·오류와 파일 열기 오류를 뷰어 영역 위쪽에 한 카드로 보여 준다(토스트 아님).
  import { ENGINE_LABEL, formatSize } from './engine-boot';
  import type { ViewerStatus } from './status';
  import IconButton from './ui/IconButton.svelte';

  let { status, ondismiss }: { status: ViewerStatus; ondismiss: () => void } = $props();
</script>

<div class="card" class:error={status.phase === 'error'} role={status.phase === 'error' ? 'alert' : 'status'} data-phase={status.phase}>
  {#if status.phase === 'confirm'}
    <p class="msg">
      {formatSize(status.ref.size)}를 내려받아야 PDF를 열 수 있습니다. {status.ref.reason}
    </p>
    <div class="row">
      <button type="button" class="primary" onclick={() => status.phase === 'confirm' && status.decide(true)}>내려받기</button>
      <button type="button" onclick={() => status.phase === 'confirm' && status.decide(false)}>취소</button>
    </div>
  {:else if status.phase === 'download'}
    <p class="msg">{ENGINE_LABEL[status.engine]} 엔진을 내려받는 중 · {Math.min(100, Math.floor((status.loaded / status.total) * 100))}%</p>
    <progress max={status.total} value={status.loaded} aria-label="내려받기 진행률"></progress>
  {:else if status.phase === 'start'}
    <p class="msg">{ENGINE_LABEL[status.engine]} 엔진을 시작하는 중입니다.</p>
  {:else if status.phase === 'opening'}
    <p class="msg" title={status.name}>파일을 여는 중입니다.</p>
  {:else}
    <p class="msg" title={status.detail}>{status.message}</p>
    <div class="row">
      {#if status.retry}<button type="button" onclick={() => status.phase === 'error' && status.retry?.()}>다시 시도</button>{/if}
      <IconButton icon="close" label="닫기" onclick={ondismiss} />
    </div>
  {/if}
</div>

<style>
  .card {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
    width: min(460px, calc(100% - 32px));
    display: grid;
    gap: 10px;
    padding: 12px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.14);
  }
  .card.error { border-color: var(--danger); }
  .card.error .msg::before { content: '⚠ '; color: var(--danger); }
  .msg { margin: 0; line-height: 1.5; word-break: keep-all; }
  .row { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
  progress { width: 100%; height: 8px; accent-color: var(--accent); }
</style>
