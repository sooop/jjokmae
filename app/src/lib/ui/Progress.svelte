<script lang="ts">
  // 진행 막대. 값이 띄엄띄엄 와도 막대는 스프링으로 부드럽게 이어 가고, 값이 없으면(null) 빛이 훑고 지나간다.
  let { value, label }: { value: number | null; label: string } = $props();
  const v = $derived(value == null ? null : Math.max(0, Math.min(1, value)));
</script>

<div
  class="bar"
  class:indeterminate={v == null}
  role="progressbar"
  aria-label={label}
  aria-valuemin="0"
  aria-valuemax="100"
  aria-valuenow={v == null ? undefined : Math.round(v * 100)}
>
  <i style:transform={v == null ? undefined : `scaleX(${v})`}></i>
</div>

<style>
  .bar { position: relative; height: 6px; border-radius: var(--r-pill); background: var(--border-soft); overflow: hidden; }
  i {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--fg);
    transform: scaleX(0);
    transform-origin: left center;
    transition: transform var(--spring-glide-dur) var(--spring-glide);
  }
  .indeterminate i { width: 40%; transform: translateX(-100%); animation: run 1.2s var(--ease-in-out) infinite; transition: none; }
  @keyframes run { to { transform: translateX(250%); } }
  @media (prefers-reduced-motion: reduce) { .indeterminate i { animation: none; transform: none; width: 100%; opacity: 0.4; } }
</style>
