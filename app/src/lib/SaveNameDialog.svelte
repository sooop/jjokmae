<script lang="ts">
  // 저장 파일 이름 확인 대화상자: 저장 버튼·Ctrl+S·정리 모드의 파일 저장이 모두 먼저 이 창을 거친다.
  // Enter = 저장(한글 조합 중에는 무시), Esc = 취소. 확정하면 정리된 이름(금지 문자 제거·.pdf 보정)을 돌려준다.
  import { tick } from 'svelte';
  import { normalizeSaveName } from './download';
  import Modal from './ui/Modal.svelte';

  let {
    open,
    defaultName,
    onconfirm,
    oncancel,
  }: {
    open: boolean;
    /** 입력칸의 처음 값(예: 문서-편집.pdf) */
    defaultName: string;
    onconfirm: (name: string) => void;
    oncancel: () => void;
  } = $props();

  let draft = $state('');
  let input: HTMLInputElement | undefined = $state();

  // 열릴 때마다 기본값으로 채우고, 확장자 앞부분만 선택한다
  $effect(() => {
    if (!open) return;
    draft = defaultName;
    void tick().then(() => {
      if (!input) return;
      input.focus({ preventScroll: true });
      const end = /\.pdf$/i.test(draft) ? draft.length - 4 : draft.length;
      input.setSelectionRange(0, end);
    });
  });

  const clean = $derived(normalizeSaveName(draft, defaultName));

  function confirm() {
    onconfirm(clean);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return; // 한글 조합 확정용 Enter 는 무시
    e.preventDefault();
    if (!e.repeat) confirm();
  }
</script>

<Modal {open} labelledby="save-name-title" onclose={oncancel} backdropClose={draft === defaultName} fallbackFocus="[data-testid=save]">
  <h2 id="save-name-title">저장 파일 이름</h2>
  <input
    bind:this={input}
    bind:value={draft}
    type="text"
    class="fname"
    aria-labelledby="save-name-title"
    spellcheck="false"
    autocomplete="off"
    placeholder={defaultName}
    onkeydown={onKey}
    data-testid="save-name"
  />
  <div class="btns">
    <button type="button" onclick={oncancel} data-testid="save-name-cancel">취소</button>
    <button type="button" class="primary" onclick={confirm} data-testid="save-name-ok">저장</button>
  </div>
</Modal>

<style>
  h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .fname { width: 100%; min-width: 0; font-size: 14px; }
  .btns { display: flex; gap: 8px; justify-content: flex-end; }
</style>
