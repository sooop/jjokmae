// 주석 편집 UI 의 순수 계산(좌표 변환·드래그·핸들·팔레트). DOM 을 만지지 않는다.
// 좌표는 adapter.ts Rect 규약(페이지 공간, 좌상단 원점, y 아래, pt). 화면 CSS px = pt × zoom × 96/72.
// 주의: erasable 문법만 쓴다(Node 타입 스트리핑으로 시험에서 직접 import).
import type { Annotation, AnnotationType, PagePoint, Rect, Rotation } from '../engine/adapter';

export type Tool = 'select' | 'highlight' | 'square' | 'circle' | 'memo' | 'freetext' | 'stamp';
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const CORNERS: Handle[] = ['nw', 'ne', 'se', 'sw'];

/** 소수의 기본 팔레트. name 은 접근성 이름 */
export const PALETTE: { name: string; hex: string }[] = [
  { name: '노랑', hex: '#ffd400' },
  { name: '빨강', hex: '#e5484d' },
  { name: '파랑', hex: '#3e63dd' },
  { name: '초록', hex: '#30a46c' },
  { name: '검정', hex: '#171717' },
];

/** 도구별 처음 색. 하이라이트는 노랑, 글자는 검정 */
export const DEFAULT_COLORS: Record<'highlight' | 'square' | 'circle' | 'memo' | 'freetext', string> = {
  highlight: '#ffd400',
  square: '#e5484d',
  circle: '#e5484d',
  memo: '#ffd400',
  freetext: '#171717',
};

export const MIN_SIZE = 6; // pt
export const MEMO_SIZE = 20; // pt (text 주석 아이콘은 크기 고정)
export const DEFAULT_FONT_SIZE = 12;
export const FONT_SIZES = [8, 10, 12, 14, 18, 24, 36];
export const BORDER_WIDTH = 2;

export const cssPerPt = (zoom: number) => (zoom * 96) / 72;

/** 이 주석을 선택·이동할 수 있는가(링크·위젯 등 'other' 는 건드리지 않는다) */
export const isEditable = (t: AnnotationType) => t !== 'other';
/** 크기 조절 핸들을 줄 수 있는가 */
export const isResizable = (t: AnnotationType) => t === 'square' || t === 'circle' || t === 'freetext' || t === 'stamp' || t === 'line' || t === 'ink';
export const hasColor = (t: AnnotationType) => t !== 'stamp' && t !== 'other';
export const hasContents = (t: AnnotationType) => t === 'text' || t === 'freetext';

export const TYPE_LABEL: Record<AnnotationType, string> = {
  highlight: '하이라이트',
  square: '사각형',
  circle: '원',
  line: '선',
  ink: '펜',
  text: '메모',
  freetext: '텍스트 상자',
  stamp: '이미지',
  other: '주석',
};

export const hasHangul = (s: string) => /[ᄀ-ᇿ㄰-㆏가-힯]/.test(s);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 두 점으로 정규화한 사각형 */
export function normRect(a: PagePoint, b: PagePoint): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function clampPoint(p: PagePoint, page: { width: number; height: number }): PagePoint {
  return { x: clamp(p.x, 0, page.width), y: clamp(p.y, 0, page.height) };
}

/** 사각형이 쪽 안에 머물도록 옮긴다(크기는 쪽보다 크면 쪽 크기로 줄인다) */
export function keepInPage(r: Rect, page: { width: number; height: number }): Rect {
  const width = Math.min(r.width, page.width);
  const height = Math.min(r.height, page.height);
  return { x: clamp(r.x, 0, page.width - width), y: clamp(r.y, 0, page.height - height), width, height };
}

export function moveRect(r: Rect, dx: number, dy: number, page: { width: number; height: number }): Rect {
  return keepInPage({ ...r, x: r.x + dx, y: r.y + dy }, page);
}

/**
 * 핸들을 (dx, dy) 만큼 끈 크기 조절. keepAspect 면 비율(width/height)을 유지한다(모서리 핸들만 의미 있음).
 * 반대편 모서리는 고정. 끌어서 뒤집히면 MIN_SIZE 에서 멈춘다.
 */
export function resizeRect(
  r: Rect,
  h: Handle,
  dx: number,
  dy: number,
  page: { width: number; height: number },
  keepAspect = false,
  min = MIN_SIZE,
): Rect {
  let l = r.x;
  let t = r.y;
  let rt = r.x + r.width;
  let b = r.y + r.height;
  if (h.includes('w')) l = clamp(l + dx, 0, rt - min);
  if (h.includes('e')) rt = clamp(rt + dx, l + min, page.width);
  if (h.includes('n')) t = clamp(t + dy, 0, b - min);
  if (h.includes('s')) b = clamp(b + dy, t + min, page.height);
  if (keepAspect && CORNERS.includes(h) && r.width > 0 && r.height > 0) {
    const aspect = r.width / r.height;
    // 고정점 = 반대편 모서리
    const fx = h.includes('w') ? r.x + r.width : r.x;
    const fy = h.includes('n') ? r.y + r.height : r.y;
    let w = Math.abs((h.includes('w') ? l : rt) - fx);
    let hh = Math.abs((h.includes('n') ? t : b) - fy);
    // 더 많이 움직인 축을 따른다
    if (w / aspect >= hh) hh = w / aspect;
    else w = hh * aspect;
    // 쪽 경계 안에서 가능한 최대
    const maxW = h.includes('w') ? fx : page.width - fx;
    const maxH = h.includes('n') ? fy : page.height - fy;
    const s = Math.min(1, maxW / w, maxH / hh);
    w *= s;
    hh *= s;
    if (w < min || hh < min) {
      const m = Math.max(min / w, min / hh);
      w *= m;
      hh *= m;
    }
    return { x: h.includes('w') ? fx - w : fx, y: h.includes('n') ? fy - hh : fy, width: w, height: hh };
  }
  return { x: l, y: t, width: rt - l, height: b - t };
}

/** 시작점에서 현재점까지 끌되 가로세로 비율(width/height)을 유지하는 사각형. 현재점의 방향이 사분면을 정한다 */
export function aspectRect(start: PagePoint, cur: PagePoint, aspect: number, page: { width: number; height: number }): Rect {
  const sx = cur.x >= start.x ? 1 : -1;
  const sy = cur.y >= start.y ? 1 : -1;
  let w = Math.abs(cur.x - start.x);
  let h = Math.abs(cur.y - start.y);
  if (w / aspect >= h) h = w / aspect;
  else w = h * aspect;
  const maxW = sx > 0 ? page.width - start.x : start.x;
  const maxH = sy > 0 ? page.height - start.y : start.y;
  const s = Math.min(1, maxW / Math.max(w, 1e-9), maxH / Math.max(h, 1e-9));
  w *= s;
  h *= s;
  return { x: sx > 0 ? start.x : start.x - w, y: sy > 0 ? start.y : start.y - h, width: w, height: h };
}

/** 클릭만 했을 때의 이미지 기본 크기: 쪽 너비의 1/4(60~200pt) 로 비율 유지, 클릭 지점이 중심 */
export function defaultStampRect(center: PagePoint, aspect: number, page: { width: number; height: number }): Rect {
  let w = clamp(page.width / 4, 60, 200);
  let h = w / aspect;
  if (h > page.height / 2) {
    h = page.height / 2;
    w = h * aspect;
  }
  return keepInPage({ x: center.x - w / 2, y: center.y - h / 2, width: w, height: h }, page);
}

/** 클릭만 했을 때의 텍스트 상자 기본 크기: 클릭 지점이 왼쪽 위 */
export function defaultTextBox(at: PagePoint, fontSize: number, page: { width: number; height: number }): Rect {
  return keepInPage({ x: at.x, y: at.y, width: Math.max(120, fontSize * 10), height: Math.max(28, fontSize * 2.4) }, page);
}

/** 메모 아이콘 사각형(클릭 지점이 왼쪽 위) */
export function memoRect(at: PagePoint, page: { width: number; height: number }): Rect {
  return keepInPage({ x: at.x, y: at.y, width: MEMO_SIZE, height: MEMO_SIZE }, page);
}

/** quad([x1,y1,x2,y2,x3,y3,x4,y4]) 들의 경계 상자 */
export function quadsRect(quads: number[][]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of quads) {
    for (let i = 0; i + 1 < q.length; i += 2) {
      x0 = Math.min(x0, q[i]);
      x1 = Math.max(x1, q[i]);
      y0 = Math.min(y0, q[i + 1]);
      y1 = Math.max(y1, q[i + 1]);
    }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** 사각형 하나를 quad 로(좌상·우상·좌하·우하) */
export const rectQuad = (r: Rect): number[] => [r.x, r.y, r.x + r.width, r.y, r.x, r.y + r.height, r.x + r.width, r.y + r.height];

/** 하이라이트 이동: 모든 quad 를 같은 만큼 옮긴다(미리보기용) */
export const shiftQuads = (quads: number[][], dx: number, dy: number): number[][] =>
  quads.map((q) => q.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)));

/** 한 annotation 의 그려질 조각들(하이라이트는 quad 별, 나머지는 rect 하나). 모두 pt */
export function hitRects(a: Pick<Annotation, 'type' | 'rect' | 'quadPoints'>): Rect[] {
  if (a.type === 'highlight' && a.quadPoints && a.quadPoints.length > 0) {
    return a.quadPoints.map((q) => quadsRect([q]));
  }
  return [a.rect];
}

/** 회전된 쪽에서 이미지를 바로 보이게 하려면 이미지를 이 각도(시계 방향)만큼 미리 돌려 넘긴다. 쪽 회전의 역방향 */
export const preRotation = (pageRotation: Rotation): Rotation => ((360 - pageRotation) % 360) as Rotation;

/** 이미지 가로세로 비율(width/height). 회전 전 원본 기준 = 사용자가 보는 모습 */
export const aspectOf = (w: number, h: number) => (h > 0 ? w / h : 1);

/** JPEG 의 EXIF Orientation(1~8). 없으면 1 */
export function jpegOrientation(b: Uint8Array): number {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 < b.length) {
    if (b[p] !== 0xff) return 1;
    const marker = b[p + 1];
    const len = (b[p + 2] << 8) | b[p + 3];
    if (marker === 0xe1 && len >= 16 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
      const t = p + 10; // TIFF 헤더
      const le = b[t] === 0x49;
      const u16 = (o: number) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
      const u32 = (o: number) => (le ? (b[t + o] | (b[t + o + 1] << 8) | (b[t + o + 2] << 16) | (b[t + o + 3] << 24)) >>> 0 : ((b[t + o] << 24) | (b[t + o + 1] << 16) | (b[t + o + 2] << 8) | b[t + o + 3]) >>> 0);
      const ifd = u32(4);
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (t + e + 12 > b.length) return 1;
        if (u16(e) === 0x0112) return u16(e + 8) || 1;
      }
      return 1;
    }
    if (marker === 0xda) return 1; // 이미지 데이터 시작
    p += 2 + len;
  }
  return 1;
}

export type ImageKind = 'image/png' | 'image/jpeg';
/** 파일 앞 바이트로 PNG/JPEG 를 판별한다(확장자·MIME 을 믿지 않는다) */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}
