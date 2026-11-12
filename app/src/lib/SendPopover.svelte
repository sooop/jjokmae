<script lang="ts">
  import { popIn, popOut } from './motion';
  // 쪽 보내기 팝오버: 복사/이동 → 대상(새 파일·열린 파일) → 위치(맨 앞·맨 뒤·특정 쪽 뒤).
  import { onMount, untrack } from 'svelte';
  import type { SendPos, SendTargetRow } from './transfer';
  import { restoreFocus } from './ui/restore-focus';

  let {
    count,
    docs,
    busy,
    onrun,
    onclose,
    initialMode = 'copy',
  }: {
    /** 처음 고른 보내기 방식(우클릭 메뉴의 '이동 → 위치 지정…'에서 이동으로 연다) */
    initialMode?: 'copy' | 'move';
    count: number;
    docs: SendTargetRow[];
    busy: boolean;
    onrun: (mode: 'copy' | 'move', target: { type: 'new' } | { type: 'doc'; key: number; pos: SendPos }) => void;
    onclose: () => void;
  } = $props();

  let mode = $state<'copy' | 'move'>(untrack(() => initialMode));
  let target = $state<'new' | number>('new');
  let posKind = $state<'start' | 'end' | 'after'>('end');
  let afterText = $state('1');
  let inputError = $state<string | null>(null);
  let first: HTMLInputElement | undefined = $state();
  let afterInput: HTMLInputElement | undefined = $state();

  onMount(() => first?.focus());

  const row = $derived(typeof target === 'number' ? (docs.find((d) => d.key === target) ?? null) : null);

  function run() {
    if (target === 'new') {
      inputError = null;
      onrun(mode, { type: 'new' });
      return;
    }
    const r = row;
    if (!r) {
      inputError = '대상 파일을 고르세요.';
      return;
    }
    let pos: SendPos;
    if (posKind === 'after') {
      const n = Number(afterText);
      if (!Number.isInteger(n) || n < 1 || n > r.total) {
        inputError = `‘${r.name}’은(는) ${r.total}쪽까지 있습니다. 1~${r.total} 사이의 쪽 번호를 입력해 주세요.`;
        afterInput?.focus();
        return;
      }
      pos = { after: n };
    } else pos = posKind;
    inputError = null;
    onrun(mode, { type: 'doc', key: r.key, pos });
  }
</script>

<div class="pop stagger" role="dialog" aria-label="쪽 보내기" data-testid="send-pop" use:restoreFocus={{ fallback: ['[data-testid=grid]', '[data-testid=thumbs]'] }} in:popIn|global={{ origin: 'top left' }}
  out:popOut|global={{ origin: 'top left' }} onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), onclose())} tabindex="-1">
  <p class="head">{count}쪽 보내기</p>

  <div class="seg" role="radiogroup" aria-label="보내는 방식">
    <label title="원본은 그대로 두고 대상에 붙입니다">
      <input bind:this={first} type="radio" name="send-mode" value="copy" bind:group={mode} data-testid="send-mode-copy" />
      <span>복사</span>
    </label>
    <label title="대상에 넣은 뒤 원본에서 지웁니다. 되돌리기는 두 파일에 함께 적용됩니다">
      <input type="radio" name="send-mode" value="move" bind:group={mode} data-testid="send-mode-move" />
      <span>이동</span>
    </label>
  </div>

  <fieldset>
    <legend>대상</legend>
    <label class="opt">
      <input type="radio" name="send-target" value="new" bind:group={target} data-testid="send-target-new" />
      <span>새 파일</span>
    </label>
    {#each docs as d (d.key)}
      <label class="opt" title={d.name}>
        <input type="radio" name="send-target" value={d.key} bind:group={target} data-testid="send-target-{d.key}" />
        <span class="nm">{d.name}</span>
        <span class="meta">{d.self ? '현재 · ' : ''}{d.total}쪽</span>
      </label>
    {/each}
  </fieldset>

  {#if target !== 'new'}
    <fieldset>
      <legend>위치</legend>
      <label class="opt">
        <input type="radio" name="send-pos" value="start" bind:group={posKind} data-testid="send-pos-start" />
        <span>맨 앞</span>
      </label>
      <label class="opt">
        <input type="radio" name="send-pos" value="end" bind:group={posKind} data-testid="send-pos-end" />
        <span>맨 뒤</span>
      </label>
      <div class="opt">
        <input type="radio" name="send-pos" value="after" bind:group={posKind} aria-label="특정 쪽 뒤" data-testid="send-pos-after" />
        <input
          bind:this={afterInput}
          class="num"
          type="text"
          inputmode="numeric"
          aria-label="쪽 번호"
          bind:value={afterText}
          onfocus={() => (posKind = 'after')}
          onkeydown={(e) => e.key === 'Enter' && run()}
          data-testid="send-after"
        />
        <span>쪽 뒤</span>
      </div>
    </fieldset>
  {/if}

  {#if inputError}<p class="err" role="alert">{inputError}</p>{/if}
  <div class="btns">
    <button type="button" onclick={onclose}>닫기</button>
    <button type="button" class="primary" disabled={busy} onclick={run} data-testid="send-run">{busy ? '보내는 중…' : mode === 'move' ? '이동' : '복사'}</button>
  </div>
</div>

<style>
  .pop {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 30;
    width: 296px;
    max-height: min(70vh, 520px);
    overflow-y: auto;
    display: grid;
    gap: 8px;
    padding: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-2), var(--edge);
    outline: none;
  }
  .head { margin: 0; font-weight: 600; }
  fieldset { margin: 0; padding: 0; border: 0; display: grid; gap: 0; min-width: 0; }
  legend { padding: 0; margin-bottom: 2px; font-size: 12px; color: var(--fg-muted); font-weight: 600; }
  .opt { display: flex; align-items: center; gap: 8px; min-height: 32px; cursor: pointer; min-width: 0; }

  .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { flex: none; font-size: 12px; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
  .num { width: 64px; text-align: center; }
  .err { margin: 0; font-size: 13px; color: var(--danger); line-height: 1.5; word-break: keep-all; }
  .btns { display: flex; justify-content: flex-end; gap: 8px; }
</style>
