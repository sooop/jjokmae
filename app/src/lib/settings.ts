// 설정은 마지막 값만 저장한다. localStorage 접근은 모두 try/catch.
export interface Settings {
  /** 마지막에 쓴 엔진. 기본 mupdf */
  engine: 'pdfium' | 'mupdf';
  /** 확대 배율(1 = 100%). 마지막으로 쓴 값이 곧 다음 실행의 시작 배율이다 */
  zoom: number;
  /** 저장할 때 주석·양식을 내용에 굽는다 */
  flatten: boolean;
  /** 저장할 때 변경분만 덧붙인다(서명 값·메타데이터 보존. 편집이 있으면 서명 이후 변경으로 표시될 수 있음). 기본 켜짐 */
  incremental: boolean;
  /** 저장할 때 삭제한 쪽의 남은 데이터를 정리한다 */
  garbageCollect: boolean;
  theme: 'system' | 'light' | 'dark';
  /** 마지막으로 쓴 화면 모드: 보기(탭+썸네일+본문) 또는 정리(파일 목록+썸네일 격자) */
  mode: 'view' | 'organize';
  /** 정리 모드 격자 썸네일 폭(px) */
  gridThumb: number;
  /** 보기 모드 왼쪽 썸네일 패널 폭(px) */
  sideWidth: number;
  /** 인쇄 방식: 자동(PDF 로 인쇄, 안 되면 이미지) 또는 이미지 */
  printMethod: 'auto' | 'image';
  /** 이미지 방식의 해상도(dpi) */
  printDpi: 150 | 200 | 300;
}

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const GRID_MIN = 80;
export const GRID_MAX = 640;
export const SIDE_MIN = 100;
export const SIDE_MAX = 280;

const KEY = 'pdf-edit:settings';
export const defaultSettings: Settings = { engine: 'mupdf', zoom: 1, flatten: false, incremental: true, garbageCollect: false, theme: 'system', mode: 'view', gridThumb: 160, sideWidth: 208, printMethod: 'auto', printDpi: 200 };

export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

const clampTo = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt;
export const clampGrid = (v: number) => clampTo(v, GRID_MIN, GRID_MAX, defaultSettings.gridThumb);
export const clampSide = (v: number) => clampTo(v, SIDE_MIN, SIDE_MAX, defaultSettings.sideWidth);

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultSettings };
    const s = { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) };
    // 손상·구버전 값 보정
    if (s.engine !== 'pdfium' && s.engine !== 'mupdf') s.engine = defaultSettings.engine;
    if (s.theme !== 'light' && s.theme !== 'dark' && s.theme !== 'system') s.theme = 'system';
    s.flatten = s.flatten === true;
    s.incremental = s.incremental !== false;
    s.garbageCollect = s.garbageCollect === true;
    if (s.mode !== 'view' && s.mode !== 'organize') s.mode = 'view';
    if (s.printMethod !== 'auto' && s.printMethod !== 'image') s.printMethod = 'auto';
    if (s.printDpi !== 150 && s.printDpi !== 200 && s.printDpi !== 300) s.printDpi = 200;
    s.gridThumb = clampGrid(s.gridThumb);
    s.sideWidth = clampSide(s.sideWidth);
    s.zoom = typeof s.zoom === 'number' && Number.isFinite(s.zoom) ? clampZoom(s.zoom) : 1;
    return s;
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 저장 불가 환경(file://, 사생활 보호 모드 등)은 무시 */
  }
}
