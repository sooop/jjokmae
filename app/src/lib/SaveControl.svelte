<script lang="ts">
  // 저장 버튼(항상 새 파일로 내려받기) + 저장 옵션 팝오버. 저장 직후의 안내는 이 버튼 아래에 붙는다.
  import type { Settings } from './settings';
  import type { NoticeData } from './status';
  import IconButton from './ui/IconButton.svelte';
  import Notice from './ui/Notice.svelte';

  let {
    settings,
    busy,
    saving,
    notice,
    onsave,
    onchange,
    onclosenotice,
  }: {
    settings: Settings;
    busy: boolean;
    saving: boolean;
    notice: NoticeData | null;
    onsave: () => void;
    onchange: (patch: Partial<Settings>) => void;
    onclosenotice: () => void;
  } = $props();

  let open = $state(false);
  let root: HTMLDivElement;

  const opts: { key: 'incremental' | 'garbageCollect' | 'flatten'; label: string; hint: string }[] = [
    {
      key: 'incremental',
      label: '변경분만 덧붙여 저장',
      hint: '원본 내용을 그대로 두고 바뀐 부분만 뒤에 붙입니다. 기존 전자서명의 서명 값은 깨지지 않습니다. 다만 서명 뒤에 주석 추가나 쪽 회전 같은 편집을 하면 일부 뷰어에서 ‘서명 이후 문서가 변경되었다’고 표시할 수 있습니다. 삭제한 쪽의 데이터는 파일에 남으므로 ‘남은 데이터 정리’와 함께 쓸 수 없습니다.',
    },
    {
      key: 'garbageCollect',
      label: '남은 데이터 정리',
      hint: '삭제한 쪽에서 쓰던 데이터를 지워 파일 크기를 줄입니다. 변경분만 덧붙여 저장이 켜져 있으면 적용되지 않습니다. 전자서명이 있는 문서는 서명이 무효가 될 수 있습니다.',
    },
    {
      key: 'flatten',
      label: '주석·양식을 내용에 굽기',
      hint: '주석과 양식 입력값을 쪽 내용에 합칩니다. 저장한 파일에서는 더 이상 고칠 수 없고, 전자서명이 있으면 무효가 됩니다.',
    },
  ];

  const conflict = $derived(settings.incremental && settings.garbageCollect);

  function onDocClick(e: MouseEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window onclick={onDocClick} />

<div class="save" bind:this={root} onkeydown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); open = false; } }} role="presentation">
  <button type="button" class="primary" disabled={busy} onclick={onsave} title="새 파일로 내려받기 (Ctrl+S). 원본은 바뀌지 않습니다." data-testid="save">
    {saving ? '저장 중…' : '저장'}
  </button>
  <IconButton icon="chevron-down" label="저장 옵션" haspopup expanded={open} onclick={() => (open = !open)} />

  {#if open}
    <div class="pop" role="dialog" aria-label="저장 옵션" data-testid="save-options">
      {#each opts as o (o.key)}
        <label class="opt" title={o.hint}>
          <input
            type="checkbox"
            checked={settings[o.key]}
            aria-describedby="hint-{o.key}"
            onchange={(e) => onchange({ [o.key]: e.currentTarget.checked })}
          />
          <span>{o.label}</span>
          <span id="hint-{o.key}" class="sr">{o.hint}</span>
        </label>
      {/each}
      {#if conflict}
        <p class="warn" role="status">두 옵션을 함께 켜면 정리는 적용되지 않습니다. 용량을 줄이려면 ‘변경분만 덧붙여 저장’을 끄세요.</p>
      {/if}
    </div>
  {/if}

  {#if notice}
    <Notice floating kind={notice.kind} text={notice.text} reassure={notice.reassure} detail={notice.detail} onclose={onclosenotice} />
  {/if}
</div>

<style>
  .save { position: relative; display: flex; align-items: center; gap: 2px; }
  .pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    width: 280px;
    display: grid;
    gap: 2px;
    padding: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.16);
  }
  .opt { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 4px; cursor: pointer; color: var(--fg); font-size: 14px; }
  .opt input { min-height: 0; width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
  .warn { margin: 4px 4px 2px; font-size: 12px; color: var(--fg-muted); line-height: 1.5; word-break: keep-all; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
