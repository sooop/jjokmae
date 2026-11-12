<script lang="ts">
  // 앵커 옆에 붙는 비모달 안내. 오류는 시간으로 닫지 않고 ×·다음 성공으로만 사라진다.
  // floating 이면 앵커 아래에 뜨고(부모가 position: relative 인 앵커 래퍼 안에 둔다), 아니면 흐름 안에 자리를 차지해
  // 아래의 조작 대상을 덮지 않는다. 등장은 스프링으로 떠오르고 퇴장은 빠르게 접힌다.
  import { noticeIn, noticeOut, slideDownIn, slideUpOut } from '../motion';
  import Icon from './Icon.svelte';
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

{#if floating}
  <div
    class="notice floating"
    class:error={kind === 'error'}
    class:left={align === 'left'}
    role={kind === 'error' ? 'alert' : 'status'}
    title={detail}
    data-notice={kind}
    in:noticeIn|global={{ y: -8 }}
    out:noticeOut|global
  >
    <span class="mark" aria-hidden="true"><Icon name={kind === 'error' ? 'alert' : 'info'} size={16} /></span>
    <p>
      {text}
      {#if reassure}<span class="reassure">{reassure}</span>{/if}
    </p>
    <IconButton icon="close" label="안내 닫기" onclick={onclose} />
  </div>
{:else}
  <div class="flow" in:slideDownIn|global={{ h: 120 }} out:slideUpOut|global={{ h: 120 }}>
    <div
      class="notice"
      class:error={kind === 'error'}
      role={kind === 'error' ? 'alert' : 'status'}
      title={detail}
      data-notice={kind}
    >
      <span class="mark" aria-hidden="true"><Icon name={kind === 'error' ? 'alert' : 'info'} size={16} /></span>
      <p>
        {text}
        {#if reassure}<span class="reassure">{reassure}</span>{/if}
      </p>
      <IconButton icon="close" label="안내 닫기" onclick={onclose} />
    </div>
  </div>
{/if}

<style>
  .notice {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 4px 6px 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-1), var(--edge);
    font-size: 13px;
    line-height: 1.5;
    word-break: keep-all;
  }
  .notice.error { border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); }
  .mark { flex: none; display: grid; place-items: center; height: 20px; margin-top: 4px; color: var(--fg-muted); }
  .error .mark { color: var(--danger); }
  .floating {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    width: 300px;
    box-shadow: var(--shadow-2), var(--edge);
    transform-origin: top right;
  }
  .floating.left { right: auto; left: 0; transform-origin: top left; }
  .flow { padding: 0; }
  p { margin: 4px 0 0; flex: 1; }
  .reassure { display: block; color: var(--fg-muted); }
</style>
