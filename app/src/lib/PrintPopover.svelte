<script lang="ts">
  import { popIn, popOut } from './motion';
  import Progress from './ui/Progress.svelte';
  // 인쇄 대화상자(툴바 인쇄 버튼에 붙는 팝오버): 대상 요약, 범위(전체·선택한 쪽·현재 쪽·범위 입력), 방식(자동·이미지), 이미지 해상도.
  // 실행 중 진행률과 취소, 방식 전환 안내·실패 안내도 이 안에 보인다. 인쇄 창이 뜨면 닫힌다.
  import { onMount, untrack } from 'svelte';
  import type { PrintJob } from './print-job.svelte';
  import { DPI_CHOICES, resolveTarget, selectedParts, type PrintDocInfo, type PrintMethod, type PrintScope } from './print';
  import { vectorBlockReason } from './print-run';
  import { parseRanges } from './ranges';
  import type { Settings } from './settings';
  import Notice from './ui/Notice.svelte';

  let {
    docs,
    activeKey,
    mode,
    initialScope,
    method,
    dpi,
    job,
    busy,
    onchange,
    onclose,
  }: {
    docs: PrintDocInfo[];
    activeKey: number | null;
    mode: 'view' | 'organize';
    initialScope: PrintScope;
    method: PrintMethod;
    dpi: number;
    job: PrintJob;
    /** 다른 작업이 문서를 쓰는 중 */
    busy: boolean;
    onchange: (p: Partial<Settings>) => void;
    /** printed: 인쇄 창을 띄웠다 */
    onclose: (printed: boolean) => void;
  } = $props();

  let scope = $state<PrintScope>(untrack(() => initialScope));
  let rangeText = $state('');
  let pop: HTMLDivElement | undefined = $state();
  let rangeInput: HTMLInputElement | undefined = $state();
  let shownError = $state(false);

  const target = $derived(resolveTarget(scope, docs, activeKey, mode, rangeText, parseRanges));
  const hasSelection = $derived(selectedParts(docs, activeKey, mode).length > 0);
  const blocked = vectorBlockReason();
  const image = $derived(method === 'image' || blocked !== null);
  const running = $derived(job.busy);

  // 처음에는 지금 고른 범위의 라디오에 포커스를 둔다(Enter·방향키로 바로 조작)
  onMount(() => pop?.querySelector<HTMLInputElement>('input[name=print-scope]:checked')?.focus());

  async function run() {
    shownError = true;
    if (!target.ok || running || busy) return;
    const printed = await job.start({ parts: target.target.parts, method, dpi });
    if (printed) onclose(true);
  }

  function close() {
    if (running) job.cancel();
    onclose(false);
  }

  const progress = $derived(
    job.canceling ? '취소하는 중…' : job.phase === 'render' ? `${job.done}/${job.total}쪽 준비 중` : '인쇄용 파일을 준비하는 중…',
  );
</script>

<div
  class="pop stagger"
  bind:this={pop}
  in:popIn|global={{ origin: 'top right' }}
  out:popOut|global={{ origin: 'top right' }}
  role="dialog"
  aria-label="인쇄"
  data-testid="print-pop"
  tabindex="-1"
  onkeydown={(e) => {
    if (e.key === 'Escape') (e.stopPropagation(), close());
    else if (e.key === 'Enter' && (e.target as HTMLInputElement).type === 'radio') (e.preventDefault(), void run());
  }}
>
  <p class="head" data-testid="print-summary" title={target.ok ? target.target.summary : undefined}>{target.ok ? target.target.summary : '인쇄할 쪽이 없습니다'}</p>

  <fieldset disabled={running}>
    <legend>범위</legend>
    <label class="opt">
      <input type="radio" name="print-scope" value="all" bind:group={scope} data-testid="print-scope-all" />
      <span>전체</span>
    </label>
    <label class="opt" title={hasSelection ? undefined : '선택한 쪽이 없습니다'}>
      <input type="radio" name="print-scope" value="selected" bind:group={scope} disabled={!hasSelection} data-testid="print-scope-selected" />
      <span>선택한 쪽</span>
    </label>
    <label class="opt">
      <input type="radio" name="print-scope" value="current" bind:group={scope} data-testid="print-scope-current" />
      <span>현재 쪽</span>
    </label>
    <div class="opt">
      <input type="radio" name="print-scope" value="range" bind:group={scope} aria-label="쪽 범위" data-testid="print-scope-range" />
      <input
        bind:this={rangeInput}
        class="field"
        type="text"
        placeholder="1-3,5,8-"
        aria-label="인쇄할 쪽 범위"
        title="쪽 번호 순서대로 인쇄합니다. 예: 1-3,5,8-"
        bind:value={rangeText}
        onfocus={() => (scope = 'range')}
        onkeydown={(e) => e.key === 'Enter' && void run()}
        data-testid="print-range"
      />
    </div>
  </fieldset>
  {#if scope === 'range' && !target.ok && (shownError || rangeText)}<p class="err" role="alert">{target.error}</p>{/if}

  <fieldset disabled={running}>
    <legend>방식</legend>
    <label class="opt" title="문서를 PDF 로 인쇄합니다. 글자가 선명하고 빠릅니다">
      <input type="radio" name="print-method" value="auto" checked={method === 'auto'} onchange={() => onchange({ printMethod: 'auto' })} data-testid="print-method-auto" />
      <span>자동</span>
    </label>
    <label class="opt" title="쪽을 그림으로 바꿔 인쇄합니다. 자동 방식이 잘 안 될 때 씁니다">
      <input type="radio" name="print-method" value="image" checked={method === 'image'} onchange={() => onchange({ printMethod: 'image' })} data-testid="print-method-image" />
      <span>이미지로 인쇄</span>
    </label>
  </fieldset>

  {#if image}
    <div class="seg" role="radiogroup" aria-label="이미지 품질" data-testid="print-dpi">
      {#each DPI_CHOICES as v (v)}
        <label class:on={dpi === v}>
          <input type="radio" name="print-dpi" value={v} checked={dpi === v} disabled={running} onchange={() => onchange({ printDpi: v })} data-testid="print-dpi-{v}" />
          <span>{v}dpi</span>
        </label>
      {/each}
    </div>
  {/if}
  {#if blocked && method === 'auto'}
    <p class="hint" data-testid="print-direct-hint">
      {blocked === 'file' ? '파일로 직접 연 화면에서는' : '브라우저의 PDF 보기 기능이 꺼져 있어'} 자동이 이미지 방식으로 인쇄합니다.
    </p>
  {/if}

  {#if job.note}<Notice kind={job.note.kind} text={job.note.text} detail={job.note.detail} onclose={() => (job.note = null)} />{/if}
  {#if job.error}<Notice kind="error" text={job.error.text} reassure={job.error.reassure} detail={job.error.detail} onclose={() => (job.error = null)} />{/if}

  {#if running}<Progress value={job.phase === 'render' && job.total ? job.done / job.total : null} label="인쇄 준비 진행률" />{/if}
  <div class="btns">
    {#if running}
      <span class="prog" role="status" data-testid="print-progress">{progress}</span>
    {/if}
    <button type="button" onclick={close} data-testid="print-cancel">취소</button>
    <button type="button" class="primary" disabled={!target.ok || running || busy} onclick={() => void run()} data-testid="print-run">인쇄</button>
  </div>
</div>

<style>
  .pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    width: 316px;
    max-height: min(80vh, 600px);
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
  .head { margin: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  fieldset { margin: 0; padding: 0; border: 0; display: grid; gap: 0; min-width: 0; }
  fieldset:disabled { opacity: 0.55; }
  legend { padding: 0; margin-bottom: 2px; font-size: 12px; color: var(--fg-muted); font-weight: 600; }
  .opt { display: flex; align-items: center; gap: 8px; min-height: 32px; cursor: pointer; min-width: 0; }

  .field { flex: 1; min-width: 0; }
  .seg label { font-variant-numeric: tabular-nums; }
  .hint { margin: 0; font-size: 12px; color: var(--fg-muted); line-height: 1.5; word-break: keep-all; }
  .err { margin: 0; font-size: 13px; color: var(--danger); line-height: 1.5; word-break: keep-all; }
  .btns { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
  .prog { flex: 1; min-width: 0; font-size: 13px; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
</style>
