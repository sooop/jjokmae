<script lang="ts">
  // 쪽 위에 겹치는 양식 입력(아래)과 주석 상호작용(위) 레이어.
  import type { FormField } from '../engine/adapter';
  import AnnotLayer from './AnnotLayer.svelte';
  import type { AnnotApi, AnnotUi } from './annot-ui.svelte';
  import FormInput from './FormInput.svelte';

  let {
    index,
    page,
    k,
    visible,
    rev,
    fields,
    ui,
    api,
  }: {
    index: number;
    page: { width: number; height: number };
    k: number;
    visible: boolean;
    rev: number;
    fields: FormField[];
    ui: AnnotUi;
    api: AnnotApi;
  } = $props();

  // 칸 목록이 다시 만들어져도 같은 칸은 같은 요소로 남도록 이름+위치로 키를 만든다(같은 조합이 겹치면 순번을 붙인다)
  const keyed = $derived.by(() => {
    const seen = new Map<string, number>();
    return fields.map((f) => {
      const base = `${f.name}@${f.pageIndex}:${f.rect.x},${f.rect.y}`;
      const c = seen.get(base) ?? 0;
      seen.set(base, c + 1);
      return { key: c ? `${base}#${c}` : base, f };
    });
  });
</script>

{#if fields.length}
  <div class="forms" data-form-layer={index}>
    {#each keyed as { key, f } (key)}
      <FormInput field={f} {k} page={index} {rev} locked={ui.tool !== 'select'} {ui} {api} />
    {/each}
  </div>
{/if}
<AnnotLayer {index} {page} {k} {visible} {rev} {ui} {api} />

<style>
  .forms { position: absolute; inset: 0; pointer-events: none; }
</style>
