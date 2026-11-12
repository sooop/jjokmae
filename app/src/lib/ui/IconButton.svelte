<script lang="ts">
  import Icon, { type IconName } from './Icon.svelte';
  // 아이콘 버튼은 aria-label 과 title 을 반드시 받는다. 터치 대상 32px(터치 기기 40px).
  let {
    icon,
    label,
    onclick,
    disabled = false,
    pressed,
    haspopup,
    expanded,
  }: {
    icon: IconName;
    label: string;
    onclick: (e: MouseEvent) => void;
    disabled?: boolean;
    pressed?: boolean;
    haspopup?: boolean;
    expanded?: boolean;
  } = $props();
</script>

<button type="button" class="icon-btn" class:chev={icon === 'chevron-down'} aria-label={label} title={label} {disabled} aria-pressed={pressed} aria-haspopup={haspopup ? 'dialog' : undefined} aria-expanded={expanded} {onclick}>
  <Icon name={icon} />
</button>

<style>
  .icon-btn {
    display: inline-grid;
    place-items: center;
    padding: 0;
    width: 32px;
    height: 32px;
    border-color: transparent;
    background: transparent;
    box-shadow: none;
    color: var(--fg);
  }
  .icon-btn:hover:not(:disabled) { border-color: transparent; background: var(--hover); }
  .icon-btn:active:not(:disabled) { background: var(--press); transform: scale(0.9); }
  .icon-btn[aria-pressed='true'], .icon-btn[aria-expanded='true'] { background: var(--press); }
  .icon-btn :global(svg) { transition: transform var(--spring-bouncy-dur) var(--spring-bouncy); }
  .icon-btn:hover:not(:disabled) :global(svg) { transform: scale(1.08); }
  .icon-btn:active:not(:disabled) :global(svg) { transform: scale(0.94); }
  .icon-btn[aria-expanded='true'] :global(svg) { transform: none; }
  .chev[aria-expanded='true'] :global(svg) { transform: rotate(180deg); }
  @media (pointer: coarse) {
    .icon-btn { width: 40px; height: 40px; }
  }
</style>
