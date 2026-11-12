<script lang="ts">
  // 오른쪽 서랍: 가끔 쓰는 설정과 단축키 안내.
  import { onMount } from 'svelte';
  import { drawerIn, drawerOut, rangeFill } from './motion';
  import { GRID_MAX, GRID_MIN, SIDE_MAX, SIDE_MIN, type Settings } from './settings';
  import IconButton from './ui/IconButton.svelte';
  import { ZOOM_PRESETS } from './zoom';

  let {
    settings,
    docOpen,
    onchange,
    onclose,
  }: {
    settings: Settings;
    docOpen: boolean;
    onchange: (patch: Partial<Settings>) => void;
    onclose: () => void;
  } = $props();

  let panel: HTMLElement;
  onMount(() => panel.focus());

  const zoomOptions = $derived(
    ZOOM_PRESETS.includes(settings.zoom) ? ZOOM_PRESETS : [...ZOOM_PRESETS, settings.zoom].sort((a, b) => a - b),
  );

  const keys: [string[], string][] = [
    [['PageUp'], '이전 쪽'],
    [['PageDown'], '다음 쪽'],
    [['+'], '확대'],
    [['−'], '축소'],
    [['Ctrl', 'O'], '파일 열기(새 탭)'],
    [['Ctrl', 'Tab'], '다음 탭'],
    [['Ctrl', 'Shift', 'Tab'], '이전 탭'],
    [['Ctrl', 'W'], '탭 닫기'],
    [['Ctrl', 'S'], '새 파일로 저장'],
    [['Ctrl', 'P'], '인쇄'],
    [['G'], '보기 · 정리 모드 전환'],
    [['Ctrl', 'Z'], '되돌리기'],
    [['Ctrl', 'Shift', 'Z'], '다시하기'],
    [['Ctrl', 'Y'], '다시하기'],
    [['Ctrl', '클릭'], '쪽 선택 추가·해제'],
    [['Shift', '클릭'], '쪽 범위 선택'],
    [['Delete'], '선택한 쪽 삭제'],
    [['Ctrl', 'A'], '정리 모드: 모든 쪽 선택'],
    [['←', '→', '↑', '↓'], '정리 모드: 칸 이동'],
    [['Space'], '정리 모드: 포커스 쪽 선택 토글'],
    [['Ctrl', '휠'], '정리 모드: 썸네일 크기'],
    [['V'], '선택 도구'],
    [['H'], '하이라이트'],
    [['R'], '사각형'],
    [['O'], '원'],
    [['N'], '메모'],
    [['T'], '텍스트 상자'],
    [['S'], '서명 이미지 넣기'],
    [['Delete'], '선택한 주석 삭제'],
    [['Tab'], '다음 양식 칸'],
    [['Esc'], '선택 해제·설정 닫기'],
  ];
</script>

<div class="drawer" bind:this={panel} tabindex="-1" role="dialog" aria-label="설정" onkeydown={(e) => e.key === 'Escape' && onclose()} in:drawerIn|global out:drawerOut|global>
  <header>
    <h2>설정</h2>
    <IconButton icon="close" label="설정 닫기" onclick={onclose} />
  </header>

  <div class="field">
    <label for="set-engine">엔진</label>
    <select id="set-engine" value={settings.engine} onchange={(e) => onchange({ engine: e.currentTarget.value as Settings['engine'] })}>
      <option value="mupdf">MuPDF (한글 폰트 대체 지원)</option>
      <option value="pdfium">PDFium</option>
    </select>
    {#if docOpen}<p class="hint">열려 있는 문서는 그대로이고, 다음에 여는 파일부터 적용됩니다.</p>{/if}
  </div>

  <div class="field">
    <label for="set-zoom">확대 배율</label>
    <select id="set-zoom" value={settings.zoom} onchange={(e) => onchange({ zoom: Number(e.currentTarget.value) })}>
      {#each zoomOptions as z (z)}
        <option value={z}>{Math.round(z * 100)}%</option>
      {/each}
    </select>
  </div>

  <div class="field">
    <label for="set-grid">정리 모드 썸네일 크기 <span class="val">{settings.gridThumb}px</span></label>
    <input id="set-grid" type="range" use:rangeFill={settings.gridThumb} min={GRID_MIN} max={GRID_MAX} step="4" value={settings.gridThumb} oninput={(e) => onchange({ gridThumb: Number(e.currentTarget.value) })} data-testid="set-grid" />
  </div>

  <div class="field">
    <label for="set-side">보기 모드 썸네일 패널 폭 <span class="val">{settings.sideWidth}px</span></label>
    <input id="set-side" type="range" use:rangeFill={settings.sideWidth} min={SIDE_MIN} max={SIDE_MAX} step="4" value={settings.sideWidth} oninput={(e) => onchange({ sideWidth: Number(e.currentTarget.value) })} data-testid="set-side" />
  </div>

  <div class="field">
    <label for="set-theme">테마</label>
    <select id="set-theme" value={settings.theme} onchange={(e) => onchange({ theme: e.currentTarget.value as Settings['theme'] })}>
      <option value="system">시스템</option>
      <option value="light">라이트</option>
      <option value="dark">다크</option>
    </select>
  </div>

  <section aria-labelledby="keys-h">
    <h3 id="keys-h">단축키</h3>
    <dl>
      {#each keys as [k, desc] (`${k.join('+')} ${desc}`)}
        <dt>{#each k as key (key)}<kbd>{key}</kbd>{/each}</dt>
        <dd>{desc}</dd>
      {/each}
    </dl>
  </section>
</div>

<style>
  .drawer {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(320px, 100%);
    z-index: 20;
    padding: 8px 16px 20px;
    background: var(--surface);
    border-left: 1px solid var(--border);
    box-shadow: var(--shadow-drawer);
    overflow-y: auto;
    outline: none;
  }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  h2 { font-size: 15px; margin: 0; }
  h3 { font-size: 13px; margin: 20px 0 8px; color: var(--fg-muted); font-weight: 600; }
  .field { display: grid; gap: 6px; margin-top: 14px; }
  label { font-size: 13px; color: var(--fg-muted); }
  select { width: 100%; }
  input[type='range'] { width: 100%; }
  .val { margin-left: 6px; font-variant-numeric: tabular-nums; }
  .hint { margin: 0; font-size: 12px; color: var(--fg-muted); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; margin: 0; align-items: center; }
  .field, section { animation: var(--kf-rise) var(--dur-slow) var(--ease-out) backwards; }
  .field:nth-of-type(1) { animation-delay: 90ms; }
  .field:nth-of-type(2) { animation-delay: 120ms; }
  .field:nth-of-type(3) { animation-delay: 150ms; }
  .field:nth-of-type(4) { animation-delay: 180ms; }
  .field:nth-of-type(5) { animation-delay: 210ms; }
  section { animation-delay: 250ms; }
  dt { display: flex; gap: 4px; }
  dd { margin: 0; }
</style>
