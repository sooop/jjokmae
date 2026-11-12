<script lang="ts">
  // 양식 위젯 하나 위의 HTML 입력. 평소에는 투명하고 엔진이 그린 위젯이 보인다(이중 표시 없음).
  // 입력 중에만 불투명하게 위젯을 덮어 입력 내용을 보여 주고, 확정하면 엔진이 그 쪽을 다시 그린 뒤에 투명으로 돌아간다.
  import type { FormField } from '../engine/adapter';
  import type { AnnotApi, AnnotUi } from './annot-ui.svelte';

  let {
    field,
    k,
    page,
    rev,
    locked,
    ui,
    api,
  }: {
    field: FormField;
    k: number;
    page: number;
    rev: number;
    /** 주석 도구가 켜져 있으면 입력을 받지 않는다 */
    locked: boolean;
    ui: AnnotUi;
    api: AnnotApi;
  } = $props();

  const r = $derived(field.rect);
  const hPx = $derived(r.height * k);
  const multiline = $derived(field.kind === 'text' && r.height > 30);
  const fs = $derived(Math.round(Math.min(18, Math.max(11, hPx * 0.62)) * 10) / 10);
  const style = $derived(
    `left:${r.x * k}px;top:${r.y * k}px;width:${r.width * k}px;height:${hPx}px;--fs:${multiline ? Math.min(fs, 14) : fs}px`,
  );
  const str = (v: FormField['value']) => (Array.isArray(v) ? v.join('\n') : typeof v === 'string' ? v : '');

  let focused = $state(false);
  let hold = $state<number | null>(null);
  let text = $state('');
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    // 입력 중이거나 확정 후 다시 그려지길 기다리는 동안이 아니면 엔진 값을 따른다
    if (!focused && hold === null) text = str(field.value);
  });

  // 확정한 쪽이 다시 그려지면(또는 시간이 지나면) HTML 을 걷는다
  $effect(() => {
    if (hold !== null && (ui.drawn[page] ?? -1) >= hold) release();
  });
  function release() {
    clearTimeout(holdTimer);
    hold = null;
  }
  function holdUntilDrawn() {
    hold = rev;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(release, 2500);
  }
  $effect(() => () => clearTimeout(holdTimer));

  async function commit(value: FormField['value']): Promise<boolean> {
    holdUntilDrawn();
    const ok = await api.setForm(field, value);
    if (!ok) release();
    return ok;
  }

  async function onTextBlur() {
    focused = false;
    if (text === str(field.value)) return;
    await commit(text);
  }

  function onTextKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      text = str(field.value);
      (e.currentTarget as HTMLElement).blur();
      e.stopPropagation();
    } else if (e.key === 'Enter' && !multiline) {
      (e.currentTarget as HTMLElement).blur();
    }
  }

  async function onCheck(e: Event & { currentTarget: HTMLInputElement }) {
    const el = e.currentTarget;
    const ok = await commit(el.checked);
    if (!ok) el.checked = field.value === true;
  }

  async function onRadio(e: Event & { currentTarget: HTMLInputElement }) {
    const el = e.currentTarget;
    const on = field.options?.[0];
    const ok = await commit(on ?? true);
    if (!ok) el.checked = field.value === true;
  }

  async function onSelect(e: Event & { currentTarget: HTMLSelectElement }) {
    await commit(e.currentTarget.value);
  }

  const shown = $derived(focused || hold !== null);
  const common = $derived({
    'data-form-input': '',
    'data-field-name': field.name,
    'data-field-kind': field.kind,
    'aria-label': field.name,
    title: field.readOnly ? `${field.name} (읽기 전용)` : field.name,
    tabindex: locked ? -1 : 0,
    disabled: !!field.readOnly,
  });
</script>

{#if field.kind === 'signature'}
  <div
    class="sig"
    {style}
    data-form-signature
    role="note"
    aria-label="{field.name} 전자서명 필드"
    title="전자서명 필드입니다. 값을 입력할 수 없습니다. 서명 이미지는 주석 도구에서 넣습니다."
  ></div>
{:else if field.kind === 'text'}
  {#if multiline}
    <textarea
      class="f"
      class:shown
      {style}
      {...common}
      bind:value={text}
      onfocus={() => (focused = true)}
      onblur={onTextBlur}
      onkeydown={onTextKey}
    ></textarea>
  {:else}
    <input
      class="f"
      class:shown
      type="text"
      {style}
      {...common}
      bind:value={text}
      onfocus={() => (focused = true)}
      onblur={onTextBlur}
      onkeydown={onTextKey}
    />
  {/if}
{:else if field.kind === 'checkbox'}
  <input class="f box" type="checkbox" {style} {...common} checked={field.value === true} onchange={onCheck} />
{:else if field.kind === 'radio'}
  <input class="f box" type="radio" {style} {...common} checked={field.value === true} onchange={onRadio} />
{:else if field.kind === 'combo' || field.kind === 'list'}
  {@const cur = str(field.value)}
  <select
    class="f"
    class:shown
    {style}
    {...common}
    value={cur}
    onfocus={() => (focused = true)}
    onblur={() => (focused = false)}
    onchange={onSelect}
  >
    {#if !(field.options ?? []).includes(cur)}<option value={cur}>{cur}</option>{/if}
    {#each field.options ?? [] as o (o)}<option value={o}>{o}</option>{/each}
  </select>
{/if}

<style>
  .f, .sig {
    position: absolute;
    pointer-events: auto;
    margin: 0;
    padding: 0 3px;
    min-height: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: transparent;
    caret-color: #171717;
    font-family: var(--font-sans);
    font-size: var(--fs);
    line-height: 1.25;
    outline: 0;
  }
  textarea.f { resize: none; padding-top: 2px; }
  .f.box { padding: 0; appearance: none; -webkit-appearance: none; cursor: pointer; }
  .f:hover:not(:disabled) { outline: 1px solid rgb(23 23 23 / 0.45); }
  .f:focus-visible { outline: 2px solid #171717; outline-offset: 0; }
  .f.shown:not(.box) {
    background: #fff;
    color: #171717;
    box-shadow: 0 0 0 2px #171717;
    z-index: 3;
  }
  .f:disabled { cursor: not-allowed; }
  select.f { padding: 0 2px; }
  select.f option { color: #171717; background: #fff; }
  .sig { cursor: not-allowed; pointer-events: auto; }
  .sig:hover { outline: 1px dashed rgb(23 23 23 / 0.55); }
  @media (pointer: coarse) {
    .f:not(.box) { font-size: max(16px, var(--fs)); }
  }
</style>
