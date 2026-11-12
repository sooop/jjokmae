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
</script>

{#if fields.length}
  <div class="forms" data-form-layer={index}>
    {#each fields as f, n (n)}
      <FormInput field={f} {k} page={index} {rev} locked={ui.tool !== 'select'} {ui} {api} />
    {/each}
  </div>
{/if}
<AnnotLayer {index} {page} {k} {visible} {rev} {ui} {api} />

<style>
  .forms { position: absolute; inset: 0; pointer-events: none; }
</style>
