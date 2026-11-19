<script lang="ts">
  // 그 자리 이름 변경 입력칸(탭·파일 목록 행). 열리면 포커스 + 전체 선택.
  // Enter·바깥 클릭(blur)은 확정, Esc 는 취소. 한글 조합 중의 Enter 는 무시한다. 값이 비었거나 그대로면 취소로 처리한다.
  // 키보드로 끝냈을 때만 byKey 가 true — 호출한 쪽이 원래 행으로 포커스를 돌린다.
  import { onMount } from 'svelte';

  let {
    value,
    label,
    oncommit,
    oncancel,
  }: {
    value: string;
    label: string;
    oncommit: (name: string, byKey: boolean) => void;
    oncancel: (byKey: boolean) => void;
  } = $props();

  let el: HTMLInputElement | undefined = $state();
  // 열릴 때의 이름으로 시작한다(이후 value 가 바뀌어도 입력 중인 글을 덮지 않는다)
  // svelte-ignore state_referenced_locally
  let draft = $state(value);
  let done = false;

  onMount(() => {
    el?.focus({ preventScroll: true });
    el?.select();
  });

  function finish(ok: boolean, byKey: boolean) {
    if (done) return;
    done = true;
    const v = draft.trim();
    if (ok && v && v !== value) oncommit(v, byKey);
    else oncancel(byKey);
  }
  function onKey(e: KeyboardEvent) {
    // 방향키·Space·Home/End·Alt+방향키 등은 부모 목록의 탭 이동 핸들러로 올라가면 안 된다(Ctrl+S 같은 조합키만 통과)
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false, true);
    }
  }
</script>

<input
  bind:this={el}
  bind:value={draft}
  type="text"
  class="rename"
  aria-label={label}
  spellcheck="false"
  autocomplete="off"
  onkeydown={onKey}
  onblur={() => finish(true, false)}
  onpointerdown={(e) => e.stopPropagation()}
  onclick={(e) => e.stopPropagation()}
  ondblclick={(e) => e.stopPropagation()}
  data-testid="rename-input"
/>

<style>
  .rename { flex: 1; min-width: 0; width: 100%; height: 26px; padding: 0 6px; font: inherit; }
</style>
