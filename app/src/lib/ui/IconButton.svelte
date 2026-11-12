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

<button type="button" class="icon-btn" aria-label={label} title={label} {disabled} aria-pressed={pressed} aria-haspopup={haspopup ? 'dialog' : undefined} aria-expanded={expanded} {onclick}>
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
  }
  .icon-btn[aria-pressed='true'] { background: var(--hover); }
  @media (pointer: coarse) {
    .icon-btn { width: 40px; height: 40px; }
  }
</style>
