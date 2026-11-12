<script lang="ts">
  // 앵커 옆에 붙는 비모달 안내. 오류는 시간으로 닫지 않고 ×·다음 성공으로만 사라진다.
  // 부모가 position: relative 인 앵커 래퍼 안에 두고, 위치는 floating 으로 고른다.
  import IconButton from './IconButton.svelte';

  let {
    kind = 'info',
    text,
    reassure,
    detail,
    floating = false,
    align = 'right',
    onclose,
  }: {
    kind?: 'info' | 'error';
    text: string;
    /** 무엇이 그대로 남았는지 */
    reassure?: string;
    /** 마우스를 올리면 보이는 엔진 메시지 */
    detail?: string;
    /** true: 앵커 아래에 떠서 표시, false: 흐름 안에 표시 */
    floating?: boolean;
    /** floating 일 때 앵커의 어느 쪽 가장자리에 맞출지 */
    align?: 'left' | 'right';
    onclose: () => void;
  } = $props();
</script>

<div class="notice" class:error={kind === 'error'} class:floating class:left={floating && align === 'left'} role={kind === 'error' ? 'alert' : 'status'} title={detail} data-notice={kind}>
  <p>
    {text}
    {#if reassure}<span class="reassure">{reassure}</span>{/if}
  </p>
  <IconButton icon="close" label="안내 닫기" onclick={onclose} />
</div>

<style>
  .notice {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    padding: 6px 4px 6px 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
    line-height: 1.5;
    word-break: keep-all;
  }
  .notice.error { border-color: var(--danger); }
  .notice.error p::before { content: '⚠ '; color: var(--danger); }
  .floating {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    width: 300px;
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.16);
  }
  .floating.left { right: auto; left: 0; }
  p { margin: 4px 0 0; flex: 1; }
  .reassure { display: block; color: var(--fg-muted); }
</style>
