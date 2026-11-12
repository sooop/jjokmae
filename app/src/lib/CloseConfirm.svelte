<script lang="ts">
  // 저장하지 않은 변경이 있는 파일을 닫을 때의 확인 안내. 상단 탭 막대와 정리 모드 파일 목록이 같은 카드를 쓴다.
  // 위치는 부모가 정한다(이 카드는 위치를 정하지 않는다).
  import { onMount } from 'svelte';

  let {
    name,
    busy,
    onconfirm,
    fluid = false,
  }: {
    /** true 면 부모 폭에 맞춘다(좁은 파일 목록 안) */
    fluid?: boolean;
    name: string;
    busy: boolean;
    onconfirm: (choice: 'save' | 'discard' | 'cancel') => void;
  } = $props();

  let first: HTMLButtonElement | undefined = $state();
  onMount(() => first?.focus());
</script>

<div
  class="confirm"
  class:fluid
  role="alertdialog"
  aria-label="저장하지 않은 변경"
  tabindex="-1"
  onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), onconfirm('cancel'))}
  data-testid="close-confirm"
>
  <p>‘{name}’에 저장하지 않은 변경이 있습니다.</p>
  <div class="btns">
    <button bind:this={first} type="button" class="primary" disabled={busy} onclick={() => onconfirm('save')} data-testid="close-save">{busy ? '저장 중…' : '저장 후 닫기'}</button>
    <button type="button" disabled={busy} onclick={() => onconfirm('discard')} data-testid="close-discard">저장 안 하고 닫기</button>
    <button type="button" disabled={busy} onclick={() => onconfirm('cancel')} data-testid="close-cancel">취소</button>
  </div>
</div>

<style>
  .confirm {
    width: 320px;
    max-width: calc(100vw - 16px);
    display: grid;
    gap: 8px;
    padding: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.16);
    outline: none;
  }
  .fluid { width: 100%; }
  p { margin: 0; line-height: 1.5; word-break: keep-all; }
  .btns { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
</style>
