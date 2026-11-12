<script lang="ts">
  // 주석 도구 모음(뷰어 위). 도구 선택·색·글자 크기와, 선택한 주석의 속성 패널을 맡는다.
  import type { Annotation } from '../engine/adapter';
  import { FONT_SIZES, hasColor, hasContents, PALETTE, TYPE_LABEL, type Tool } from './annot-geom';
  import type { AnnotUi } from './annot-ui.svelte';
  import type { NoticeData } from './status';
  import Icon from './ui/Icon.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Notice from './ui/Notice.svelte';

  let {
    ui,
    busy,
    formCount,
    notice,
    onrequestimage,
    onupdate,
    ondelete,
    onnextfield,
    onclosenotice,
  }: {
    ui: AnnotUi;
    busy: boolean;
    /** 양식 입력 칸 수(서명 필드 제외). 0 이면 표시하지 않는다 */
    formCount: number;
    notice: NoticeData | null;
    onrequestimage: () => void;
    onupdate: (a: Annotation) => Promise<boolean>;
    ondelete: () => void;
    onnextfield: () => void;
    onclosenotice: () => void;
  } = $props();

  const tools: { tool: Tool; icon: 'pointer' | 'highlighter' | 'square' | 'circle' | 'note' | 'text-box' | 'image'; label: string }[] = [
    { tool: 'select', icon: 'pointer', label: '선택 (V)' },
    { tool: 'highlight', icon: 'highlighter', label: '하이라이트 (H)' },
    { tool: 'square', icon: 'square', label: '사각형 (R)' },
    { tool: 'circle', icon: 'circle', label: '원 (O)' },
    { tool: 'memo', icon: 'note', label: '메모 (N)' },
    { tool: 'freetext', icon: 'text-box', label: '텍스트 상자 (T)' },
  ];

  let contentEl: HTMLTextAreaElement | undefined = $state();
  let contentDraft = $state('');
  let contentFocused = $state(false);

  const sel = $derived(ui.sel?.annot ?? null);
  const colorKey = $derived(ui.colorKey);
  const fontTool = $derived(ui.tool === 'freetext');

  $effect(() => {
    const c = sel?.contents ?? '';
    if (!contentFocused) contentDraft = c;
  });

  let lastFocusSignal = 0;
  $effect(() => {
    const s = ui.focusContent;
    if (s !== lastFocusSignal) {
      lastFocusSignal = s;
      contentEl?.focus();
    }
  });

  function pickColor(hex: string) {
    if (sel && ui.tool === 'select') {
      void onupdate({ ...sel, color: hex });
    } else if (colorKey) {
      ui.colors[colorKey] = hex;
    }
  }

  function pickFont(size: number) {
    ui.fontSize = size;
    if (sel && sel.type === 'freetext') void onupdate({ ...sel, extra: { ...sel.extra, fontSize: size } });
  }

  async function commitContent() {
    contentFocused = false;
    if (!sel) return;
    if (contentDraft === (sel.contents ?? '')) return;
    await onupdate({ ...sel, contents: contentDraft });
  }

  const activeColor = $derived(sel && ui.tool === 'select' ? (sel.color ?? '') : colorKey ? ui.colors[colorKey] : '');
  const showPalette = $derived((sel && ui.tool === 'select' && hasColor(sel.type)) || !!colorKey);
  const showFont = $derived(fontTool || (sel?.type === 'freetext' && ui.tool === 'select'));
  const fontValue = $derived(sel?.type === 'freetext' && ui.tool === 'select' ? Number(sel.extra?.fontSize ?? ui.fontSize) : ui.fontSize);
  const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
</script>

<div class="bar" aria-label="주석">
  <div class="row">
    <div class="tools" role="toolbar" aria-label="주석 도구">
      {#each tools as t (t.tool)}
        <IconButton icon={t.icon} label={t.label} pressed={ui.tool === t.tool} onclick={() => ui.setTool(t.tool)} />
      {/each}
      <IconButton
        icon="image"
        label="서명 이미지 (S)"
        pressed={ui.tool === 'stamp'}
        disabled={busy}
        onclick={onrequestimage}
      />
    </div>
    <div class="anchor">
      {#if notice}
        <Notice floating align="left" kind={notice.kind} text={notice.text} reassure={notice.reassure} detail={notice.detail} onclose={onclosenotice} />
      {/if}
    </div>

    {#if showPalette}
      <div class="swatches" role="group" aria-label="색">
        {#each PALETTE as c (c.hex)}
          <button
            type="button"
            class="sw"
            style="--c:{c.hex}"
            aria-label="색 {c.name}"
            title={c.name}
            aria-pressed={sameHex(activeColor, c.hex)}
            disabled={busy && !!sel && ui.tool === 'select'}
            onclick={() => pickColor(c.hex)}
          ></button>
        {/each}
      </div>
    {/if}

    {#if showFont}
      <select class="fs" aria-label="글자 크기" title="글자 크기" value={fontValue} onchange={(e) => pickFont(Number(e.currentTarget.value))}>
        {#each FONT_SIZES.includes(fontValue) ? FONT_SIZES : [...FONT_SIZES, fontValue].sort((a, b) => a - b) as s (s)}
          <option value={s}>{s}pt</option>
        {/each}
      </select>
    {/if}

    {#if ui.tool === 'stamp' && ui.stamp}
      <span class="stamp-info" title="쪽 위를 눌러 이미지를 놓거나, 끌어서 크기를 정합니다. 비율은 유지됩니다.">
        <img src={ui.stamp.url} alt="" />
        <span class="nm">{ui.stamp.name}</span>
      </span>
    {/if}

    {#if sel && ui.tool === 'select'}
      <div class="props" role="group" aria-label="{TYPE_LABEL[sel.type]} 속성" data-testid="annot-props" data-keep-selection>
        <span class="type">{TYPE_LABEL[sel.type]}</span>
        {#if hasContents(sel.type)}
          <div class="content-wrap">
            <textarea
              class="content"
              bind:this={contentEl}
              bind:value={contentDraft}
              rows="1"
              aria-label="내용"
              placeholder="내용"
              onfocus={() => (contentFocused = true)}
              onblur={() => void commitContent()}
              onkeydown={(e) => {
                if (e.key === 'Escape') {
                  contentDraft = sel.contents ?? '';
                  e.currentTarget.blur();
                  e.stopPropagation();
                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
            ></textarea>
          </div>
        {/if}
        <IconButton icon="trash" label="주석 삭제 (Delete)" onclick={ondelete} disabled={busy} />
      </div>
    {/if}

    <span class="spacer"></span>

    {#if formCount > 0}
      <span class="form-chip" title="양식이 있는 문서입니다. 칸을 눌러 입력하고 Tab 으로 다음 칸으로 갑니다.">
        <Icon name="form" size={14} />
        <span>양식 {formCount}</span>
      </span>
      <IconButton icon="arrow-down" label="다음 양식 칸으로 이동" onclick={onnextfield} />
    {/if}

  </div>

</div>

<style>
  .bar {
    flex: none;
    display: grid;
    gap: 2px;
    padding: 2px 8px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .row { display: flex; align-items: center; gap: 8px; min-height: 38px; flex-wrap: wrap; }
  .tools { display: flex; align-items: center; gap: 2px; }
  .spacer { flex: 1; }
  .swatches { display: flex; align-items: center; gap: 4px; padding-left: 6px; border-left: 1px solid var(--border); }
  .sw {
    width: 28px;
    height: 28px;
    min-width: 28px;
    min-height: 28px;
    padding: 0;
    border-radius: 50%;
    background: var(--c);
    border: 2px solid var(--surface);
    box-shadow: 0 0 0 1px var(--border);
  }
  .sw:hover:not(:disabled) { background: var(--c); }
  .sw[aria-pressed='true'] { box-shadow: 0 0 0 2px var(--fg); }
  .fs { width: 76px; }
  .stamp-info { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-muted); max-width: 220px; }
  .stamp-info img { height: 26px; max-width: 60px; object-fit: contain; border: 1px solid var(--border); border-radius: 4px; background: #fff; }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .form-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--fg-muted);
    font-size: 12px;
  }
  .anchor { position: relative; width: 0; height: 32px; }
  .props { display: flex; align-items: center; gap: 6px; padding-left: 6px; border-left: 1px solid var(--border); }
  .type { color: var(--fg-muted); white-space: nowrap; }
  .content-wrap { position: relative; width: min(300px, 36vw); height: 32px; }
  .content { position: absolute; left: 0; top: 0; width: 100%; height: 32px; min-height: 32px; resize: none; overflow: hidden; line-height: 1.3; }
  .content:focus { height: 96px; z-index: 20; overflow: auto; box-shadow: 0 4px 16px rgb(0 0 0 / 0.16); }
</style>
