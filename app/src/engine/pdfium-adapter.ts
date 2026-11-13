// PDFium(@embedpdf/pdfium 2.15.1) 기반 EngineAdapter 구현. 보조 엔진.
// 검증된 API 사용법은 harness/ (m1_font, m2_annots, m3_forms, m4_sign) 를 따른다.
//
// 좌표 규약(adapter.ts Rect): 페이지 공간 = 원점 좌상단, y 아래로 증가, /Rotate 반영 후, pt.
//   Annotation.rect / quadPoints / extra(line start·end, ink strokes) 와 FormField.rect 의 입출력은 모두 이 공간이다.
//   PDFium 은 내부적으로 PDF 사용자 공간(좌하단 원점, MediaBox/CropBox 오프셋)을 쓰므로 pageXf() 로 변환한다.
//   (변환 행렬은 FPDF_DeviceToPage 로 구한다 — PDFium 이 렌더에 쓰는 행렬과 같다)
// Node 타입 스트리핑으로 직접 import 되므로 enum·namespace·매개변수 프로퍼티를 쓰지 않는다.

import { init } from '@embedpdf/pdfium';
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
// 값 import 는 확장자를 적는다(Node 타입 스트리핑으로 시험에서 이 파일을 직접 import 한다)
import { findInChars, type TextChar } from './text-search.ts';
import type {
  Annotation,
  AnnotationType,
  DocId,
  EngineAdapter,
  FormField,
  FormFieldKind,
  NewAnnotation,
  OpenOptions,
  PagePoint,
  PageSize,
  Rect,
  RenderedBitmap,
  Rotation,
  SaveOptions,
  SaveResult,
  StampImage,
} from './adapter';

export interface PdfiumAdapterOptions {
  /** pdfium.wasm 바이트. BinarySource 에서 받아 넘긴다 */
  wasmBinary: ArrayBuffer | Uint8Array;
  /** 한글 폰트(ttf/otf/ttc). 주어지면 SYSFONTINFO 로 등록한다(한글 미내장 PDF 렌더링에 필요) */
  koreanFont?: ArrayBuffer | Uint8Array;
  /** 등록할 폰트의 표시 이름. 기본 'Korean Font' */
  koreanFontFace?: string;
}

type Pdfium = WrappedPdfiumModule;
// @types/emscripten 가 없는 환경에서도 힙 뷰를 쓸 수 있도록 필요한 것만 선언한다
type Runtime = Pdfium['pdfium'] & { HEAPU8: Uint8Array };

interface DocState {
  doc: number;
  /** FPDF_LoadMemDocument 가 참조하는 힙 버퍼(close 때 free) */
  ptr: number;
  len: number;
  info: number;
  env: number;
  /** 쪽을 삭제했다(증분 저장 결과에는 삭제한 쪽의 데이터가 남는다) */
  deletedData?: boolean;
  /** open 때 받은 암호. 저장본을 검증·굽기 위해 임시로 다시 열 때 필요하다 */
  password?: string;
}

// FPDF_FORMFIELD_*
const FF_PUSHBUTTON = 1;
const FF_CHECKBOX = 2;
const FF_RADIOBUTTON = 3;
const FF_COMBOBOX = 4;
const FF_LISTBOX = 5;
const FF_TEXTFIELD = 6;
const FF_SIGNATURE = 7;

// FPDF_ANNOT_*
const ST_TEXT = 1;
const ST_LINK = 2;
const ST_FREETEXT = 3;
const ST_LINE = 4;
const ST_SQUARE = 5;
const ST_CIRCLE = 6;
const ST_HIGHLIGHT = 9;
const ST_STAMP = 13;
const ST_INK = 15;
const ST_POPUP = 16;
const ST_WIDGET = 20;

const SUBTYPE_OF: Partial<Record<AnnotationType, number>> = {
  text: ST_TEXT,
  freetext: ST_FREETEXT,
  line: ST_LINE,
  square: ST_SQUARE,
  circle: ST_CIRCLE,
  highlight: ST_HIGHLIGHT,
  ink: ST_INK,
  stamp: ST_STAMP,
};

const TYPE_OF: Record<number, AnnotationType> = {
  [ST_TEXT]: 'text',
  [ST_FREETEXT]: 'freetext',
  [ST_LINE]: 'line',
  [ST_SQUARE]: 'square',
  [ST_CIRCLE]: 'circle',
  [ST_HIGHLIGHT]: 'highlight',
  [ST_STAMP]: 'stamp',
  [ST_INK]: 'ink',
};

const DEFAULT_COLOR: Record<string, string> = {
  highlight: '#ffeb00',
  square: '#ff0000',
  circle: '#ff0000',
  line: '#ff0000',
  ink: '#ff0000',
  text: '#ffc800',
  freetext: '#000000',
};

/** 렌더 비트맵(RGBA) 상한. MuPDF 어댑터의 MAX_BITMAP_BYTES 와 같은 값·같은 규칙을 유지한다 */
const MAX_BITMAP_BYTES = 256 * 1024 * 1024;

function toU8(b: ArrayBuffer | Uint8Array): Uint8Array {
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}

function parseColor(c: string | undefined, fallback: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec((c ?? '').trim()) ?? /^#?([0-9a-f]{6})$/i.exec(fallback);
  const n = parseInt(m![1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** EngineAdapter + 진단용 보조 메서드(인터페이스에는 없음) */
export interface PdfiumAdapter extends EngineAdapter {
  /** WASM 힙의 현재 크기(바이트). 누수 점검용 */
  heapBytes(): number;
  /** 열려 있는 문서 수. close 누락 점검용 */
  openDocCount(): number;
}

export function createPdfiumAdapter(options: PdfiumAdapterOptions): PdfiumAdapter {
  let pdfium: Pdfium | null = null;
  const docs = new Map<DocId, DocState>();
  let seq = 0;

  const lib = (): Pdfium => {
    if (!pdfium) throw new Error('PDFium 이 초기화되지 않았다: init() 를 먼저 호출해야 한다');
    return pdfium;
  };
  const P = () => lib().pdfium as Runtime;
  const malloc = (n: number) => {
    const p = P().wasmExports.malloc(Math.max(1, n));
    if (!p) throw new Error('WASM 메모리 할당 실패');
    return p;
  };
  const free = (p: number) => {
    if (p) P().wasmExports.free(p);
  };

  /** 임시 힙 블록 묶음. 콜백이 끝나면 전부 해제한다 */
  function mem<T>(fn: (alloc: (n: number) => number) => T): T {
    const ptrs: number[] = [];
    try {
      return fn((n) => {
        const p = malloc(n);
        ptrs.push(p);
        return p;
      });
    } finally {
      for (const p of ptrs) free(p);
    }
  }

  /** 사용자 공간 ↔ 페이지 공간(좌상단 원점, 회전 반영) 아핀 변환 */
  interface PageXf {
    /** 사용자 공간 점 → 페이지 공간 점 */
    toPage(x: number, y: number): [number, number];
    /** 페이지 공간 점 → 사용자 공간 점 */
    toUser(x: number, y: number): [number, number];
  }

  /**
   * FPDF_DeviceToPage 는 장치 좌표를 int 로만 받으므로, 장치 크기를 페이지 크기의 1000 배(정수 반올림)로 잡고
   * 세 점((0,0), (W,0), (0,H))의 사용자 공간 좌표만 얻어 아핀 변환을 직접 구성한다. (결과는 double 이라 정밀도 손실 없음)
   */
  function pageXf(page: number): PageXf {
    const L = lib();
    const w = L.FPDF_GetPageWidthF(page);
    const h = L.FPDF_GetPageHeightF(page);
    const W = Math.max(1, Math.round(w * 1000));
    const H = Math.max(1, Math.round(h * 1000));
    const at = (dx: number, dy: number): [number, number] =>
      mem((alloc) => {
        const o = alloc(16);
        if (!L.FPDF_DeviceToPage(page, 0, 0, W, H, 0, dx, dy, o, o + 8)) throw new Error('FPDF_DeviceToPage 실패');
        return [P().getValue(o, 'double') as number, P().getValue(o + 8, 'double') as number];
      });
    const o = at(0, 0);
    const px = at(W, 0);
    const py = at(0, H);
    // 사용자 = o + x*(ax,ay) + y*(bx,by)  (x,y 는 페이지 공간 pt)
    const ax = (px[0] - o[0]) / w;
    const ay = (px[1] - o[1]) / w;
    const bx = (py[0] - o[0]) / h;
    const by = (py[1] - o[1]) / h;
    const det = ax * by - bx * ay;
    return {
      toUser: (x, y) => [o[0] + x * ax + y * bx, o[1] + x * ay + y * by],
      toPage: (ux, uy) => {
        const dx = ux - o[0];
        const dy = uy - o[1];
        return [(dx * by - dy * bx) / det, (dy * ax - dx * ay) / det];
      },
    };
  }

  /** 사용자 공간 사각형(left,bottom,right,top) → 페이지 공간 Rect(네 모서리의 경계 상자) */
  function userBoxToRect(xf: PageXf, x0: number, y0: number, x1: number, y1: number): Rect {
    const ps = [xf.toPage(x0, y0), xf.toPage(x1, y0), xf.toPage(x0, y1), xf.toPage(x1, y1)];
    const xs = ps.map((p) => p[0]);
    const ys = ps.map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
  }

  /** 페이지 공간 Rect → 사용자 공간 [left, bottom, right, top] */
  function rectToUserBox(xf: PageXf, r: Rect): [number, number, number, number] {
    const us = [xf.toUser(r.x, r.y), xf.toUser(r.x + r.width, r.y), xf.toUser(r.x, r.y + r.height), xf.toUser(r.x + r.width, r.y + r.height)];
    const xs = us.map((p) => p[0]);
    const ys = us.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  /** [x1,y1,x2,y2,...] 를 점 단위로 변환 */
  function mapPoints(pts: number[], fn: (x: number, y: number) => [number, number]): number[] {
    const out: number[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) out.push(...fn(pts[i], pts[i + 1]));
    return out;
  }

  const f32 = (ptr: number, i: number) => P().getValue(ptr + i * 4, 'float') as number;
  const setF32 = (ptr: number, vals: number[]) => vals.forEach((v, i) => P().setValue(ptr + i * 4, v, 'float'));

  /** UTF-16LE NUL 종료 문자열(FPDF_WIDESTRING) */
  function wstr(alloc: (n: number) => number, s: string): number {
    const p = alloc((s.length + 1) * 2);
    const h = P().HEAPU8;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h[p + i * 2] = c & 255;
      h[p + i * 2 + 1] = c >> 8;
    }
    h[p + s.length * 2] = 0;
    h[p + s.length * 2 + 1] = 0;
    return p;
  }

  function decodeWide(ptr: number, bytes: number): string {
    const s = new TextDecoder('utf-16le').decode(P().HEAPU8.slice(ptr, ptr + bytes));
    const z = s.indexOf('\0');
    return z < 0 ? s : s.slice(0, z);
  }

  /** (buf, len) → 필요한 바이트 수를 돌려주는 PDFium 관례의 UTF-16 getter */
  function readWide(fn: (buf: number, len: number) => number): string {
    const need = fn(0, 0);
    if (need <= 2) return '';
    const buf = malloc(need);
    try {
      const got = fn(buf, need);
      return decodeWide(buf, Math.min(got, need));
    } finally {
      free(buf);
    }
  }

  function getDoc(id: DocId): DocState {
    const st = docs.get(id);
    if (!st) throw new Error(`열려 있지 않은 문서: ${id}`);
    return st;
  }

  function pageCountOf(st: DocState): number {
    return lib().FPDF_GetPageCount(st.doc);
  }

  function checkIndex(st: DocState, i: number, what = '페이지'): void {
    const n = pageCountOf(st);
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new RangeError(`${what} 인덱스 범위 밖: ${i} (0..${n - 1})`);
  }

  function withPage<T>(st: DocState, idx: number, fn: (page: number) => T, formEnv = false): T {
    checkIndex(st, idx);
    const L = lib();
    const page = L.FPDF_LoadPage(st.doc, idx);
    if (!page) throw new Error(`페이지 로드 실패: ${idx}`);
    if (formEnv && st.env) L.FORM_OnAfterLoadPage(page, st.env);
    try {
      return fn(page);
    } finally {
      if (formEnv && st.env) L.FORM_OnBeforeClosePage(page, st.env);
      L.FPDF_ClosePage(page);
    }
  }

  function withTextPage<T>(page: number, fn: (tp: number) => T): T {
    const L = lib();
    const tp = L.FPDFText_LoadPage(page);
    if (!tp) throw new Error('FPDFText_LoadPage 실패');
    try {
      return fn(tp);
    } finally {
      L.FPDFText_ClosePage(tp);
    }
  }

  // ---------- 한글 폰트(SYSFONTINFO) ----------
  function installKoreanFont(fontIn: Uint8Array, face: string): void {
    const L = lib();
    const p = L.pdfium as Runtime;
    const font = fontIn;
    const dv = new DataView(font.buffer, font.byteOffset, font.byteLength);
    const isTtc = font.length > 16 && dv.getUint32(0) === 0x74746366; // 'ttcf'
    const base = isTtc ? dv.getUint32(12) : 0;
    const numTables = dv.getUint16(base + 4);
    const faceBytes = new TextEncoder().encode(face + '\0');
    const readC = (ptr: number) => {
      let s = '';
      const h = p.HEAPU8;
      for (let c; (c = h[ptr++]); ) s += String.fromCharCode(c);
      return s;
    };
    // 콜백은 PDFium 이 라이브러리 수명 동안 참조하므로 removeFunction 하지 않는다(그래서 id 목록도 따로 두지 않는다)
    const add = (f: Function, sig: string) => p.addFunction(f, sig);
    const fn = {
      release: add(() => {}, 'vi'),
      // 설치된 폰트 목록에 한글 폰트(charset 129)를 올린다
      enumFonts: add((_self: number, mapper: number) => {
        mem((alloc) => {
          const n = alloc(faceBytes.length);
          p.HEAPU8.set(faceBytes, n);
          L.FPDF_AddInstalledFont(mapper, n, 129);
        });
      }, 'vii'),
      // 한글 charset 이거나 한국어 계열 이름이면 핸들(1)을 돌려준다
      mapFont: add((_self: number, _w: number, _it: number, charset: number, _pitch: number, facePtr: number) => {
        const f = facePtr ? readC(facePtr) : '';
        return charset === 129 || /gothic|myeong|batang|gulim|dotum|hy/i.test(f) ? 1 : 0;
      }, 'iiiiiiii'),
      getFont: add((_self: number, facePtr: number) => (readC(facePtr).toLowerCase() === face.toLowerCase() ? 1 : 0), 'iii'),
      // table=0 이면 파일 전체, 아니면 해당 sfnt 테이블 조각
      getFontData: add((_self: number, _h: number, table: number, buf: number, size: number) => {
        if (table === 0) {
          if (buf && size >= font.length) p.HEAPU8.set(font, buf);
          return font.length;
        }
        for (let i = 0; i < numTables; i++) {
          const o = base + 12 + i * 16;
          const tg = dv.getUint32(o);
          const sw = (((tg & 255) << 24) | (((tg >> 8) & 255) << 16) | (((tg >> 16) & 255) << 8) | (tg >>> 24)) >>> 0;
          if (tg === table || sw === table) {
            const off = dv.getUint32(o + 8);
            const len = dv.getUint32(o + 12);
            if (buf && size >= len) p.HEAPU8.set(font.subarray(off, off + len), buf);
            return len;
          }
        }
        return 0;
      }, 'iiiiii'),
      getFaceName: add((_self: number, _h: number, buf: number, size: number) => {
        if (buf && size >= faceBytes.length) p.HEAPU8.set(faceBytes, buf);
        return faceBytes.length;
      }, 'iiiii'),
      getCharset: add(() => 129, 'iii'),
      deleteFont: add(() => {}, 'vii'),
    };
    // FPDF_SYSFONTINFO: version + 8 콜백 = 36 바이트. PDFium 이 라이브러리 수명 동안 참조하므로 해제하지 않는다.
    const info = malloc(36);
    p.setValue(info, 1, 'i32');
    [fn.release, fn.enumFonts, fn.mapFont, fn.getFont, fn.getFontData, fn.getFaceName, fn.getCharset, fn.deleteFont].forEach(
      (f, i) => p.setValue(info + 4 + i * 4, f, 'i32'),
    );
    L.FPDF_SetSystemFontInfo(info);
  }

  // ---------- 저장 ----------
  function writeCopy(st: DocState, flags: number): Uint8Array {
    const L = lib();
    const p = L.pdfium as Runtime;
    if (st.env) L.FORM_ForceToKillFocus(st.env);
    const chunks: Uint8Array[] = [];
    const cb = p.addFunction((_self: number, data: number, size: number) => {
      chunks.push(p.HEAPU8.slice(data, data + size));
      return 1;
    }, 'iiii');
    const fw = malloc(8);
    let ok = false;
    try {
      p.setValue(fw, 1, 'i32');
      p.setValue(fw + 4, cb, 'i32');
      ok = L.FPDF_SaveAsCopy(st.doc, fw, flags);
    } finally {
      p.removeFunction(cb);
      free(fw);
    }
    if (!ok) throw new Error('FPDF_SaveAsCopy 실패');
    return concat(chunks);
  }

  function concat(chunks: Uint8Array[]): Uint8Array {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  /** 바이트를 임시 문서로 로드해 콜백에 넘기고 반드시 닫는다 */
  function withTempDoc<T>(bytes: Uint8Array, fn: (doc: number) => T, password = ''): T {
    const L = lib();
    const ptr = malloc(bytes.length);
    P().HEAPU8.set(bytes, ptr);
    const doc = L.FPDF_LoadMemDocument(ptr, bytes.length, password);
    try {
      if (!doc) throw new Error(`임시 문서 로드 실패(err=${L.FPDF_GetLastError()})`);
      return fn(doc);
    } finally {
      if (doc) L.FPDF_CloseDocument(doc);
      free(ptr);
    }
  }

  /** 증분 저장 결과가 쓸 만한가: 원본 접두 보존 + 재로드 시 쪽수 일치 */
  function incrementalLooksValid(st: DocState, out: Uint8Array): boolean {
    if (out.length < st.len) return false;
    const heap = P().HEAPU8;
    for (let i = 0; i < st.len; i++) if (heap[st.ptr + i] !== out[i]) return false;
    try {
      const want = pageCountOf(st);
      return withTempDoc(out, (d) => lib().FPDF_GetPageCount(d) === want, st.password);
    } catch {
      return false;
    }
  }

  function flattenBytes(full: Uint8Array, password = ''): Uint8Array {
    const L = lib();
    const tmp = (() => {
      const ptr = malloc(full.length);
      P().HEAPU8.set(full, ptr);
      const doc = L.FPDF_LoadMemDocument(ptr, full.length, password);
      return { ptr, doc };
    })();
    try {
      if (!tmp.doc) throw new Error('flatten 용 임시 문서 로드 실패');
      const n = L.FPDF_GetPageCount(tmp.doc);
      for (let i = 0; i < n; i++) {
        const page = L.FPDF_LoadPage(tmp.doc, i);
        if (!page) throw new Error(`flatten: 페이지 로드 실패 ${i}`);
        try {
          // 0: FLAT_NORMALDISPLAY. 반환 0=실패 1=성공 2=할 일 없음
          if (L.FPDFPage_Flatten(page, 0) === 0) throw new Error(`flatten 실패: 페이지 ${i}`);
        } finally {
          L.FPDF_ClosePage(page);
        }
      }
      const tmpState: DocState = { doc: tmp.doc, ptr: tmp.ptr, len: full.length, info: 0, env: 0 };
      return writeCopy(tmpState, 0);
    } finally {
      if (tmp.doc) L.FPDF_CloseDocument(tmp.doc);
      free(tmp.ptr);
    }
  }

  // ---------- 주석 ----------
  // EPDFAnnot_GetObjectNumber 는 이 빌드에서 항상 0 이라 쓸 수 없다. 새 주석에는 /NM(고유 이름)을 부여해 id 로 쓰고,
  // /NM 이 없는 기존 주석은 쪽 안의 인덱스("i3")를 id 로 쓴다(삭제 후에는 다시 목록을 읽어야 한다).
  function annotId(annot: number, index: number): string {
    const nm = getStr(annot, 'NM');
    return nm || `i${index}`;
  }
  let nmSeq = 0;
  const newName = () => `pdfium-${Date.now().toString(36)}-${(++nmSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  function findAnnot(page: number, id: string): { annot: number; index: number } | null {
    const L = lib();
    const count = L.FPDFPage_GetAnnotCount(page);
    for (let i = 0; i < count; i++) {
      const a = L.FPDFPage_GetAnnot(page, i);
      if (!a) continue;
      if (annotId(a, i) === id) return { annot: a, index: i };
      L.FPDFPage_CloseAnnot(a);
    }
    return null;
  }

  /** 사용자 공간 [left, bottom, right, top]. 읽기 실패 시 null */
  function getUserBox(annot: number): [number, number, number, number] | null {
    return mem((alloc) => {
      const r = alloc(16);
      if (!lib().FPDFAnnot_GetRect(annot, r)) return null;
      // FS_RECTF: left, top, right, bottom
      const left = f32(r, 0);
      const top = f32(r, 1);
      const right = f32(r, 2);
      const bottom = f32(r, 3);
      return [Math.min(left, right), Math.min(top, bottom), Math.max(left, right), Math.max(top, bottom)];
    });
  }

  /** 페이지 공간 Rect */
  function getRect(annot: number, xf: PageXf): Rect {
    const b = getUserBox(annot);
    return b ? userBoxToRect(xf, b[0], b[1], b[2], b[3]) : { x: 0, y: 0, width: 0, height: 0 };
  }

  function setRect(annot: number, rect: Rect, xf: PageXf): void {
    mem((alloc) => {
      const r = alloc(16);
      const [l, b, rt, t] = rectToUserBox(xf, rect);
      setF32(r, [l, t, rt, b]);
      if (!lib().FPDFAnnot_SetRect(annot, r)) throw new Error('FPDFAnnot_SetRect 실패');
    });
  }

  function getStr(annot: number, key: string): string {
    return readWide((buf, len) => lib().FPDFAnnot_GetStringValue(annot, key, buf, len));
  }

  function setStr(annot: number, key: string, value: string): boolean {
    return mem((alloc) => lib().FPDFAnnot_SetStringValue(annot, key, wstr(alloc, value)));
  }

  function getStrokeColor(annot: number): string | undefined {
    // FPDFAnnot_GetColor 는 이 빌드에서 항상 실패해 EPDFAnnot_GetColor 를 쓴다
    return mem((alloc) => {
      const r = alloc(12);
      if (!lib().EPDFAnnot_GetColor(annot, 0, r, r + 4, r + 8)) return undefined;
      const v = (o: number) => (P().getValue(r + o, 'i32') as number) & 255;
      return `#${hex2(v(0))}${hex2(v(4))}${hex2(v(8))}`;
    });
  }

  /** FreeText 의 글자색은 DA 문자열("r g b rg" / "g g") 에서 읽는다 */
  function parseDaColor(da: string): string | undefined {
    const rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
    if (rgb) return '#' + [rgb[1], rgb[2], rgb[3]].map((v) => hex2(Math.round(parseFloat(v) * 255))).join('');
    const g = /([\d.]+)\s+g\b/.exec(da);
    if (g) {
      const v = hex2(Math.round(parseFloat(g[1]) * 255));
      return `#${v}${v}${v}`;
    }
    return undefined;
  }

  function buildDa(color: [number, number, number], size: number): string {
    const [r, g, b] = color.map((v) => +(v / 255).toFixed(3));
    return `/Helv ${size} Tf ${r} ${g} ${b} rg`;
  }

  function readQuads(annot: number, xf: PageXf): number[][] {
    const L = lib();
    const n = L.FPDFAnnot_CountAttachmentPoints(annot);
    const out: number[][] = [];
    mem((alloc) => {
      const q = alloc(32);
      for (let i = 0; i < n; i++) {
        if (!L.FPDFAnnot_GetAttachmentPoints(annot, i, q)) continue;
        out.push(mapPoints(Array.from({ length: 8 }, (_, k) => f32(q, k)), xf.toPage));
      }
    });
    return out;
  }

  function readInk(annot: number, xf: PageXf): number[][] {
    const L = lib();
    const n = L.FPDFAnnot_GetInkListCount(annot);
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
      const pts = L.FPDFAnnot_GetInkListPath(annot, i, 0, 0);
      if (pts <= 0) continue;
      mem((alloc) => {
        const buf = alloc(pts * 8);
        const got = L.FPDFAnnot_GetInkListPath(annot, i, buf, pts);
        const arr: number[] = [];
        for (let k = 0; k < Math.min(got, pts) * 2; k++) arr.push(f32(buf, k));
        out.push(mapPoints(arr, xf.toPage));
      });
    }
    return out;
  }

  function readLine(annot: number, xf: PageXf): number[] | undefined {
    return mem((alloc) => {
      const b = alloc(16);
      if (!lib().FPDFAnnot_GetLine(annot, b, b + 8)) return undefined;
      return mapPoints([f32(b, 0), f32(b, 1), f32(b, 2), f32(b, 3)], xf.toPage);
    });
  }

  function readAnnotation(annot: number, index: number, xf: PageXf): Annotation | null {
    const L = lib();
    const st = L.FPDFAnnot_GetSubtype(annot);
    if (st === ST_POPUP || st === ST_WIDGET || st === ST_LINK) return null;
    const type: AnnotationType = TYPE_OF[st] ?? 'other';
    const a: Annotation = { id: annotId(annot, index), type, rect: getRect(annot, xf) };
    const contents = getStr(annot, 'Contents');
    if (contents) a.contents = contents;
    const extra: Record<string, unknown> = { subtype: st, hasAppearance: L.EPDFAnnot_HasAppearanceStream(annot, 0) };
    if (type === 'freetext') {
      const da = getStr(annot, 'DA');
      a.color = parseDaColor(da);
      const m = /([\d.]+)\s+Tf/.exec(da);
      if (m) extra.fontSize = parseFloat(m[1]);
    } else {
      a.color = getStrokeColor(annot);
    }
    if (a.color === undefined) delete a.color;
    if (type === 'highlight') a.quadPoints = readQuads(annot, xf);
    if (type === 'ink') extra.strokes = readInk(annot, xf);
    if (type === 'line') {
      const l = readLine(annot, xf);
      if (l) {
        extra.start = [l[0], l[1]];
        extra.end = [l[2], l[3]];
      }
    }
    a.extra = extra;
    return a;
  }

  function defaultQuad(r: Rect): number[] {
    // 페이지 공간의 상좌, 상우, 하좌, 하우 (MuPDF 어댑터와 같은 순서)
    return [r.x, r.y, r.x + r.width, r.y, r.x, r.y + r.height, r.x + r.width, r.y + r.height];
  }

  function applyQuads(annot: number, quads: number[][], xf: PageXf): void {
    const L = lib();
    const existing = L.FPDFAnnot_CountAttachmentPoints(annot);
    mem((alloc) => {
      const q = alloc(32);
      quads.forEach((quad, i) => {
        setF32(q, mapPoints(quad, xf.toUser));
        const ok = i < existing ? L.FPDFAnnot_SetAttachmentPoints(annot, i, q) : L.FPDFAnnot_AppendAttachmentPoints(annot, q);
        if (!ok) throw new Error('QuadPoints 설정 실패');
      });
    });
  }

  function quadsBounds(quads: number[][]): [number, number, number, number] {
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
    return [x0, y0, x1, y1];
  }

  function sameQuads(a: number[][], b: number[][]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].length !== b[i].length) return false;
      for (let k = 0; k < a[i].length; k++) if (Math.abs(a[i][k] - b[i][k]) > 0.01) return false;
    }
    return true;
  }

  /**
   * 하이라이트 quad 결정. 새로 만들 때는 주어진 quad(없으면 rect). 갱신할 때 quad 가 저장된 것과 같고 rect 만 바뀌었으면
   * 저장된 quad 를 새 rect 로 옮기고(평행이동·배율), quad 가 바뀌었으면 quad 가 우선한다.
   */
  function resolveHighlightQuads(annot: number, a: NewAnnotation, xf: PageXf, isNew: boolean): number[][] {
    const given = a.quadPoints && a.quadPoints.length ? a.quadPoints : null;
    if (isNew) return given ?? [defaultQuad(a.rect)];
    const stored = readQuads(annot, xf);
    if (given && !sameQuads(given, stored)) return given;
    const base = given ?? stored;
    if (!base.length) return [defaultQuad(a.rect)];
    const b = quadsBounds(base);
    const ok = (u: number, v: number) => Math.abs(u - v) < 0.01;
    const r = a.rect;
    if (ok(b[0], r.x) && ok(b[1], r.y) && ok(b[2], r.x + r.width) && ok(b[3], r.y + r.height)) return base;
    const sx = b[2] - b[0] > 1e-6 ? r.width / (b[2] - b[0]) : 1;
    const sy = b[3] - b[1] > 1e-6 ? r.height / (b[3] - b[1]) : 1;
    return base.map((q) => q.map((v, i) => (i % 2 === 0 ? r.x + (v - b[0]) * sx : r.y + (v - b[1]) * sy)));
  }

  function applyCommon(annot: number, type: AnnotationType, a: NewAnnotation, xf: PageXf, isNew = true): void {
    const L = lib();
    const extra = a.extra ?? {};
    const hlQuads = type === 'highlight' ? resolveHighlightQuads(annot, a, xf, isNew) : null;
    if (hlQuads) {
      // 하이라이트의 rect 는 quad 의 경계 상자로 맞춘다(UI 가 rect 를 믿을 수 있게)
      const b = quadsBounds(hlQuads);
      setRect(annot, { x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] }, xf);
    } else setRect(annot, a.rect, xf);
    const color = parseColor(a.color, DEFAULT_COLOR[type] ?? '#ff0000');
    if (type !== 'freetext') {
      // FPDFAnnot_SetColor 는 AP 가 이미 있는 주석에서는 false 를 돌려주므로(수정 경로) EPDFAnnot_SetColor 로 대신한다.
      // 하이라이트의 알파(120)는 새로 만들 때만 FPDFAnnot_SetColor 로 준다.
      if (!L.FPDFAnnot_SetColor(annot, 0, color[0], color[1], color[2], type === 'highlight' ? 120 : 255)) {
        if (!L.EPDFAnnot_SetColor(annot, 0, color[0], color[1], color[2])) throw new Error('주석 색 설정 실패');
      }
    }
    if (a.contents !== undefined) setStr(annot, 'Contents', a.contents);
    // 갱신에서 borderWidth 가 없으면 기존 값을 유지한다(부분 갱신이 선 굵기를 기본값으로 되돌리지 않도록). 새 주석만 기본값 2
    const bw = typeof extra.borderWidth === 'number' ? extra.borderWidth : isNew ? 2 : null;
    if (bw !== null && (type === 'square' || type === 'circle' || type === 'line' || type === 'ink')) L.FPDFAnnot_SetBorder(annot, 0, 0, bw);
    if (hlQuads) applyQuads(annot, hlQuads, xf);
    if (type === 'freetext') {
      const size = typeof extra.fontSize === 'number' ? extra.fontSize : 12;
      setStr(annot, 'DA', buildDa(color, size));
    }
    if (type === 'line') {
      const r = a.rect;
      const s = Array.isArray(extra.start) ? (extra.start as number[]) : [r.x, r.y];
      const e = Array.isArray(extra.end) ? (extra.end as number[]) : [r.x + r.width, r.y + r.height];
      mem((alloc) => {
        const b = alloc(16);
        setF32(b, [...xf.toUser(s[0], s[1]), ...xf.toUser(e[0], e[1])]);
        if (!L.EPDFAnnot_SetLine(annot, b, b + 8)) throw new Error('EPDFAnnot_SetLine 실패');
      });
    }
  }

  /**
   * 이미지 스탬프: rect 를 지정하고 이미지 오브젝트를 rect 크기로 맞춰 AP 에 넣는다.
   * (FPDFAnnot_AppendObject 는 Ink·Stamp 만 지원. 이미지 디코딩은 EPDFImageObj_SetPng/SetJpeg)
   */
  function buildImageStamp(st: DocState, annot: number, a: NewAnnotation, im: StampImage, xf: PageXf): void {
    const L = lib();
    setRect(annot, a.rect, xf);
    if (a.contents !== undefined) setStr(annot, 'Contents', a.contents);
    const img = L.FPDFPageObj_NewImageObj(st.doc);
    if (!img) throw new Error('FPDFPageObj_NewImageObj 실패');
    let appended = false;
    try {
      mem((alloc) => {
        const p = alloc(im.bytes.length);
        P().HEAPU8.set(im.bytes, p);
        // 인자 순서: (pages, count, imageObject, data, size) — pages 는 쓰지 않는다
        const ok = im.mime === 'image/png' ? L.EPDFImageObj_SetPng(0, 0, img, p, im.bytes.length) : L.EPDFImageObj_SetJpeg(0, 0, img, p, im.bytes.length);
        if (!ok) throw new Error(`이미지를 디코딩할 수 없다(${im.mime})`);
      });
      const [l, b, r, t] = rectToUserBox(xf, a.rect);
      if (!L.FPDFImageObj_SetMatrix(img, r - l, 0, 0, t - b, l, b)) throw new Error('FPDFImageObj_SetMatrix 실패');
      if (!L.FPDFAnnot_AppendObject(annot, img)) throw new Error('FPDFAnnot_AppendObject 실패');
      appended = true;
    } finally {
      if (!appended) L.FPDFPageObj_Destroy(img);
    }
  }

  /** ink·line 갱신용: 저장된 점과 같은 점이 오고 rect 가 달라졌으면 점을 새 rect 로 변환한 사본을 돌려준다. 아니면 a 그대로 */
  function rebaseVertices(annot: number, type: 'ink' | 'line', a: Annotation, xf: PageXf): Annotation {
    const cur = getRect(annot, xf);
    const ok = (u: number, v: number) => Math.abs(u - v) < 0.01;
    if (ok(cur.x, a.rect.x) && ok(cur.y, a.rect.y) && ok(cur.width, a.rect.width) && ok(cur.height, a.rect.height)) return a;
    const sx = cur.width > 1e-6 ? a.rect.width / cur.width : 1;
    const sy = cur.height > 1e-6 ? a.rect.height / cur.height : 1;
    const f = (pts: number[]) => pts.map((v, i) => (i % 2 === 0 ? a.rect.x + (v - cur.x) * sx : a.rect.y + (v - cur.y) * sy));
    const same = (u: number[], v: number[]) => u.length === v.length && u.every((n, i) => ok(n, v[i]));
    const ex = a.extra ?? {};
    if (type === 'ink') {
      const stored = readInk(annot, xf);
      const given = Array.isArray(ex.strokes) ? (ex.strokes as number[][]) : stored;
      if (given.length !== stored.length || !given.every((s, i) => same(s, stored[i]))) return a; // 획을 직접 바꿨다
      return { ...a, extra: { ...ex, strokes: stored.map(f) } };
    }
    const sl = readLine(annot, xf);
    if (!sl) return a;
    const gs = Array.isArray(ex.start) ? (ex.start as number[]) : [sl[0], sl[1]];
    const ge = Array.isArray(ex.end) ? (ex.end as number[]) : [sl[2], sl[3]];
    if (!same(gs, [sl[0], sl[1]]) || !same(ge, [sl[2], sl[3]])) return a;
    const m = f(sl);
    return { ...a, extra: { ...ex, start: [m[0], m[1]], end: [m[2], m[3]] } };
  }

  function addInkStrokes(annot: number, strokes: number[][], xf: PageXf): void {
    const L = lib();
    for (const s of strokes) {
      mem((alloc) => {
        const n = Math.floor(s.length / 2);
        const b = alloc(n * 8);
        setF32(b, mapPoints(s.slice(0, n * 2), xf.toUser));
        if (L.FPDFAnnot_AddInkStroke(annot, b, n) < 0) throw new Error('FPDFAnnot_AddInkStroke 실패');
      });
    }
  }

  // ---------- 양식 ----------
  interface Widget {
    pageIndex: number;
    annot: number;
    name: string;
    ftype: number;
    flags: number;
  }

  /** 모든 쪽의 위젯을 훑는다. 콜백(page 열린 상태, 위젯)이 true 를 돌려주면 중단 */
  function scanWidgets(st: DocState, cb: (page: number, w: Widget) => boolean | void, onlyName?: string): void {
    const L = lib();
    const n = pageCountOf(st);
    for (let pi = 0; pi < n; pi++) {
      let stop = false;
      withPage(
        st,
        pi,
        (page) => {
          const count = L.FPDFPage_GetAnnotCount(page);
          for (let i = 0; i < count && !stop; i++) {
            const annot = L.FPDFPage_GetAnnot(page, i);
            if (!annot) continue;
            try {
              if (L.FPDFAnnot_GetSubtype(annot) !== ST_WIDGET) continue;
              const name = readWide((buf, len) => L.FPDFAnnot_GetFormFieldName(st.env, annot, buf, len));
              if (onlyName !== undefined && name !== onlyName) continue;
              const w: Widget = {
                pageIndex: pi,
                annot,
                name,
                ftype: L.FPDFAnnot_GetFormFieldType(st.env, annot),
                flags: L.FPDFAnnot_GetFormFieldFlags(st.env, annot),
              };
              if (cb(page, w)) stop = true;
            } finally {
              L.FPDFPage_CloseAnnot(annot);
            }
          }
        },
        true,
      );
      if (stop) return;
    }
  }

  const kindOf = (ft: number): FormFieldKind | null => {
    switch (ft) {
      case FF_PUSHBUTTON:
        return 'button';
      case FF_CHECKBOX:
        return 'checkbox';
      case FF_RADIOBUTTON:
        return 'radio';
      case FF_COMBOBOX:
        return 'combo';
      case FF_LISTBOX:
        return 'list';
      case FF_TEXTFIELD:
        return 'text';
      case FF_SIGNATURE:
        return 'signature';
      default:
        return null;
    }
  };

  const exportValue = (st: DocState, annot: number): string =>
    readWide((buf, len) => lib().FPDFAnnot_GetFormFieldExportValue(st.env, annot, buf, len));

  function readOptions(st: DocState, annot: number): string[] {
    const L = lib();
    const n = L.FPDFAnnot_GetOptionCount(st.env, annot);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(readWide((buf, len) => L.FPDFAnnot_GetOptionLabel(st.env, annot, i, buf, len)));
    return out;
  }

  /** 위젯 중앙을 FORM_OnLButtonDown/Up 으로 클릭한다(체크박스·라디오) */
  function clickWidget(st: DocState, page: number, annot: number): void {
    const L = lib();
    // FORM_OnLButton* 은 사용자 공간 좌표를 받는다
    const b = getUserBox(annot) ?? [0, 0, 0, 0];
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    L.FORM_OnLButtonDown(st.env, page, 0, cx, cy);
    L.FORM_OnLButtonUp(st.env, page, 0, cx, cy);
  }

  // ---------- 어댑터 ----------
  const adapter: PdfiumAdapter = {
    name: 'pdfium',

    heapBytes: () => P().HEAPU8.length,
    openDocCount: () => docs.size,

    async init() {
      if (pdfium) return;
      const wasm = toU8(options.wasmBinary);
      const L = await init({ wasmBinary: wasm } as Parameters<typeof init>[0]);
      L.PDFiumExt_Init();
      pdfium = L;
      if (options.koreanFont) installKoreanFont(toU8(options.koreanFont), options.koreanFontFace ?? 'Korean Font');
    },

    async open(bytes: ArrayBuffer | Uint8Array, opts?: OpenOptions): Promise<DocId> {
      const L = lib();
      const src = toU8(bytes);
      const ptr = malloc(src.length);
      P().HEAPU8.set(src, ptr);
      const doc = L.FPDF_LoadMemDocument(ptr, src.length, opts?.password ?? '');
      if (!doc) {
        const err = L.FPDF_GetLastError();
        free(ptr);
        // 1 UNKNOWN, 2 FILE, 3 FORMAT, 4 PASSWORD, 5 SECURITY, 6 PAGE
        const reason = err === 4 ? '암호가 필요하거나 올바르지 않다' : err === 3 ? 'PDF 형식이 올바르지 않다' : `오류 코드 ${err}`;
        throw new Error(`PDF 를 열 수 없다: ${reason}`);
      }
      let info = 0;
      let env = 0;
      try {
        info = L.PDFiumExt_OpenFormFillInfo();
        env = info ? L.PDFiumExt_InitFormFillEnvironment(doc, info) : 0;
      } catch (e) {
        if (info) L.PDFiumExt_CloseFormFillInfo(info);
        L.FPDF_CloseDocument(doc);
        free(ptr);
        throw e;
      }
      const id = `pdfium-${++seq}`;
      docs.set(id, { doc, ptr, len: src.length, info, env, password: opts?.password });
      return id;
    },

    async close(id: DocId): Promise<void> {
      const st = docs.get(id);
      if (!st) return;
      docs.delete(id);
      const L = lib();
      if (st.env) L.PDFiumExt_ExitFormFillEnvironment(st.env);
      if (st.info) L.PDFiumExt_CloseFormFillInfo(st.info);
      L.FPDF_CloseDocument(st.doc);
      free(st.ptr);
    },

    async pageCount(id) {
      return pageCountOf(getDoc(id));
    },

    async pageSize(id, pageIndex): Promise<PageSize> {
      const st = getDoc(id);
      return withPage(st, pageIndex, (page) => ({
        width: lib().FPDF_GetPageWidthF(page),
        height: lib().FPDF_GetPageHeightF(page),
      }));
    },

    async renderPage(id, pageIndex, scale): Promise<RenderedBitmap> {
      const st = getDoc(id);
      const L = lib();
      if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError(`scale 이 올바르지 않다: ${scale}`);
      return withPage(
        st,
        pageIndex,
        (page) => {
          const w = Math.max(1, Math.round(L.FPDF_GetPageWidthF(page) * scale));
          const h = Math.max(1, Math.round(L.FPDF_GetPageHeightF(page) * scale));
          if (!Number.isFinite(w * h) || w * h * 4 > MAX_BITMAP_BYTES) {
            throw new RangeError(
              `렌더 크기가 너무 크다: ${w}x${h}px(${Math.round((w * h * 4) / 1048576)}MB). 상한은 ${MAX_BITMAP_BYTES / 1048576}MB 이다. 배율을 낮춰 주세요.`,
            );
          }
          const bmp = L.FPDFBitmap_Create(w, h, 0);
          if (!bmp) throw new Error(`FPDFBitmap_Create 실패: ${w}x${h}`);
          try {
            L.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
            L.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, 1 /* FPDF_ANNOT */);
            if (st.env) L.FPDF_FFLDraw(st.env, bmp, page, 0, 0, w, h, 0, 1);
            const buf = L.FPDFBitmap_GetBuffer(bmp);
            const stride = L.FPDFBitmap_GetStride(bmp);
            const src = P().HEAPU8.subarray(buf, buf + stride * h);
            const out = new Uint8Array(w * h * 4);
            for (let y = 0; y < h; y++) {
              let s = y * stride;
              let d = y * w * 4;
              for (let x = 0; x < w; x++, s += 4, d += 4) {
                out[d] = src[s + 2];
                out[d + 1] = src[s + 1];
                out[d + 2] = src[s];
                out[d + 3] = 255;
              }
            }
            return { width: w, height: h, data: out.buffer as ArrayBuffer };
          } finally {
            L.FPDFBitmap_Destroy(bmp);
          }
        },
        true,
      );
    },

    async rotatePage(id, pageIndex, rotation: Rotation) {
      const st = getDoc(id);
      if (![0, 90, 180, 270].includes(rotation)) throw new RangeError(`회전값이 올바르지 않다: ${rotation}`);
      withPage(st, pageIndex, (page) => lib().FPDFPage_SetRotation(page, rotation / 90));
    },

    async deletePages(id, pageIndexes) {
      const st = getDoc(id);
      const uniq = [...new Set(pageIndexes)].sort((a, b) => b - a);
      for (const i of uniq) checkIndex(st, i);
      if (uniq.length >= pageCountOf(st)) throw new Error('모든 페이지를 삭제할 수 없다');
      if (uniq.length === 0) return; // 지운 것이 없으면 '삭제한 데이터가 남음' 표시를 켜지 않는다
      for (const i of uniq) lib().FPDFPage_Delete(st.doc, i);
      st.deletedData = true;
    },

    async movePage(id, from, to) {
      const st = getDoc(id);
      checkIndex(st, from, '원본 페이지');
      checkIndex(st, to, '대상 페이지');
      if (from === to) return;
      mem((alloc) => {
        const arr = alloc(4);
        P().setValue(arr, from, 'i32');
        if (!lib().FPDF_MovePages(st.doc, arr, 1, to)) throw new Error('FPDF_MovePages 실패');
      });
    },

    async importPages(destId, srcId, srcPageIndexes, at) {
      const dest = getDoc(destId);
      const src = getDoc(srcId);
      if (dest === src) throw new Error('같은 문서에서 가져올 수 없다');
      if (!srcPageIndexes.length) return;
      for (const i of srcPageIndexes) checkIndex(src, i, '원본 페이지');
      const n = pageCountOf(dest);
      const pos = at ?? n;
      if (!Number.isInteger(pos) || pos < 0 || pos > n) throw new RangeError(`삽입 위치 범위 밖: ${pos}`);
      mem((alloc) => {
        const arr = alloc(srcPageIndexes.length * 4);
        srcPageIndexes.forEach((v, k) => P().setValue(arr + k * 4, v, 'i32'));
        if (!lib().FPDF_ImportPagesByIndex(dest.doc, src.doc, arr, srcPageIndexes.length, pos)) {
          throw new Error('FPDF_ImportPagesByIndex 실패');
        }
      });
    },

    async listAnnotations(id, pageIndex) {
      const st = getDoc(id);
      const L = lib();
      return withPage(st, pageIndex, (page) => {
        const out: Annotation[] = [];
        const xf = pageXf(page);
        const count = L.FPDFPage_GetAnnotCount(page);
        for (let i = 0; i < count; i++) {
          const annot = L.FPDFPage_GetAnnot(page, i);
          if (!annot) continue;
          try {
            const a = readAnnotation(annot, i, xf);
            if (a) out.push(a);
          } finally {
            L.FPDFPage_CloseAnnot(annot);
          }
        }
        return out;
      });
    },

    async addAnnotation(id, pageIndex, a) {
      const st = getDoc(id);
      const L = lib();
      const sub = SUBTYPE_OF[a.type];
      if (sub === undefined) throw new Error(`PDFium 어댑터가 만들 수 없는 주석 종류: ${a.type}`);
      if (a.type === 'ink' && !(Array.isArray(a.extra?.strokes) && (a.extra!.strokes as number[][]).length)) {
        throw new Error('ink 주석에는 extra.strokes(좌표 배열의 배열)가 필요하다');
      }
      let stampImg: StampImage | null = null;
      if (a.type === 'stamp') {
        stampImg = (a.extra?.image as StampImage | undefined) ?? null;
        if (!stampImg || !(stampImg.bytes instanceof Uint8Array) || stampImg.bytes.length === 0) {
          throw new Error('stamp 주석에는 extra.image({bytes, mime})가 필요하다');
        }
        // 선언한 mime 과 실제 매직 바이트가 맞는지 검사한다
        const b = stampImg.bytes;
        const isPng = b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
        const isJpg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
        if (stampImg.mime === 'image/png' ? !isPng : stampImg.mime === 'image/jpeg' ? !isJpg : true) {
          throw new Error(`이미지 형식이 mime(${String(stampImg.mime)})과 맞지 않는다(PNG·JPEG 만 지원)`);
        }
      }
      return withPage(st, pageIndex, (page) => {
        const annot = L.FPDFPage_CreateAnnot(page, sub);
        if (!annot) throw new Error(`FPDFPage_CreateAnnot 실패: ${a.type}`);
        const xf = pageXf(page);
        try {
          setStr(annot, 'NM', newName());
          if (stampImg) {
            buildImageStamp(st, annot, a, stampImg, xf);
          } else {
            applyCommon(annot, a.type, a, xf);
            if (a.type === 'ink') addInkStrokes(annot, a.extra!.strokes as number[][], xf);
            if (!L.EPDFAnnot_GenerateAppearance(annot)) throw new Error('EPDFAnnot_GenerateAppearance 실패');
          }
          const index = L.FPDFPage_GetAnnotIndex(page, annot);
          const res = readAnnotation(annot, index, xf);
          if (!res) throw new Error('생성한 주석을 읽을 수 없다');
          return res;
        } catch (e) {
          // 생성 도중 실패하면 반쪽짜리 주석을 남기지 않는다
          const idx = L.FPDFPage_GetAnnotIndex(page, annot);
          if (idx >= 0) L.FPDFPage_RemoveAnnot(page, idx);
          throw e;
        } finally {
          L.FPDFPage_CloseAnnot(annot);
        }
      });
    },

    async updateAnnotation(id, pageIndex, a) {
      const st = getDoc(id);
      const L = lib();
      withPage(st, pageIndex, (page) => {
        const found = findAnnot(page, a.id);
        if (!found) throw new Error(`주석을 찾을 수 없다: ${a.id}`);
        try {
          const cur = TYPE_OF[L.FPDFAnnot_GetSubtype(found.annot)] ?? 'other';
          if (cur === 'other') throw new Error(`수정할 수 없는 주석 종류: ${cur}`);
          if (a.type !== cur) throw new Error(`주석 종류는 바꿀 수 없다: ${cur} → ${a.type}`);
          if (cur === 'stamp') {
            // 스탬프는 AP(이미지)를 다시 만들지 않는다. rect 를 바꾸면 AP 가 새 rect 로 늘어나 그려지고, 내용만 갱신한다
            setRect(found.annot, a.rect, pageXf(page));
            if (a.contents !== undefined) setStr(found.annot, 'Contents', a.contents);
            return;
          }
          const xfu = pageXf(page);
          // ink·line 은 rect 만 바뀌고 점(extra.strokes / extra.start·end)이 저장된 그대로면, 점을 새 rect 로 옮긴다(평행이동·배율)
          const moved = cur === 'ink' || cur === 'line' ? rebaseVertices(found.annot, cur, a, xfu) : a;
          applyCommon(found.annot, cur, moved, xfu, false);
          if (cur === 'ink' && moved !== a) {
            L.FPDFAnnot_RemoveInkList(found.annot);
            addInkStrokes(found.annot, moved.extra!.strokes as number[][], xfu);
          }
          // ink 의 기존 획은 바꿀 수 없다(획 변경은 삭제 후 재생성). AP 만 다시 만든다
          if (!L.EPDFAnnot_GenerateAppearance(found.annot)) throw new Error('EPDFAnnot_GenerateAppearance 실패');
        } finally {
          L.FPDFPage_CloseAnnot(found.annot);
        }
      });
    },

    async deleteAnnotation(id, pageIndex, annotId_) {
      const st = getDoc(id);
      const L = lib();
      withPage(st, pageIndex, (page) => {
        const found = findAnnot(page, annotId_);
        if (!found) throw new Error(`주석을 찾을 수 없다: ${annotId_}`);
        L.FPDFPage_CloseAnnot(found.annot);
        if (!L.FPDFPage_RemoveAnnot(page, found.index)) throw new Error('FPDFPage_RemoveAnnot 실패');
      });
    },

    async textQuads(id, pageIndex, from, to) {
      const st = getDoc(id);
      const L = lib();
      return withPage(st, pageIndex, (page) =>
        withTextPage(page, (tp) => {
          const n = L.FPDFText_CountChars(tp);
          if (n <= 0) return [];
          const xf = pageXf(page);
          // 글자 상자(페이지 공간). 줄바꿈 등 면적 없는 글자는 제외한다.
          // FPDFText_GetLooseCharBox 는 이 빌드에서 줄 높이가 2배로 크고 위치도 어긋나 쓰지 않고, 글자 모양 상자를 쓴다.
          const boxes: ({ x0: number; y0: number; x1: number; y1: number; fs: number } | null)[] = [];
          mem((alloc) => {
            const r = alloc(32);
            const d = (k: number) => P().getValue(r + k * 8, 'double') as number;
            for (let i = 0; i < n; i++) {
              if (!L.FPDFText_GetCharBox(tp, i, r, r + 8, r + 16, r + 24)) {
                boxes.push(null);
                continue;
              }
              const b = [d(0), d(2), d(1), d(3)]; // left, right, bottom, top → l, b, r, t
              if (!(b[2] > b[0]) || !(b[3] > b[1])) {
                boxes.push(null);
                continue;
              }
              const rc = userBoxToRect(xf, b[0], b[1], b[2], b[3]);
              boxes.push({ x0: rc.x, y0: rc.y, x1: rc.x + rc.width, y1: rc.y + rc.height, fs: L.FPDFText_GetFontSize(tp, i) });
            }
          });
          const FAR = 40 * 40; // 이보다 먼 곳(글자 없는 여백)에서 시작·끝나는 드래그는 선택 없음
          const nearest = (p: PagePoint): { i: number; d: number } => {
            let best = -1;
            let bd = Infinity;
            boxes.forEach((b, i) => {
              if (!b) return;
              const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1);
              const dy = Math.max(b.y0 - p.y, 0, p.y - b.y1);
              // 세로 거리에 가중을 둬 같은 줄의 글자를 우선한다
              const d = dx * dx + dy * dy * 4;
              if (d < bd) {
                bd = d;
                best = i;
              }
            });
            return { i: best, d: bd };
          };
          const na = nearest(from);
          const nb = nearest(to);
          if (na.i < 0 || nb.i < 0 || (na.d > FAR && nb.d > FAR)) return [];
          let a = na.i;
          let b = nb.i;
          if (a > b) [a, b] = [b, a];
          const out: number[][] = [];
          let cur: { x0: number; y0: number; x1: number; y1: number; fs: number } | null = null;
          const flush = () => {
            if (cur) {
              // 글자 모양 상자는 낮을 수 있으므로 글꼴 크기의 1.3배까지 위아래로 넓힌다
              const want = cur.fs * 1.3;
              const extra = Math.max(0, want - (cur.y1 - cur.y0)) / 2;
              out.push([cur.x0, cur.y0 - extra, cur.x1, cur.y0 - extra, cur.x0, cur.y1 + extra, cur.x1, cur.y1 + extra]);
            }
            cur = null;
          };
          for (let i = a; i <= b; i++) {
            const bx = boxes[i];
            if (!bx) continue;
            if (cur) {
              const overlap = Math.min(cur.y1, bx.y1) - Math.max(cur.y0, bx.y0);
              const minH = Math.min(cur.y1 - cur.y0, bx.y1 - bx.y0);
              if (overlap >= minH * 0.5 && bx.x0 >= cur.x0 - 0.5) {
                cur = {
                  x0: Math.min(cur.x0, bx.x0),
                  y0: Math.min(cur.y0, bx.y0),
                  x1: Math.max(cur.x1, bx.x1),
                  y1: Math.max(cur.y1, bx.y1),
                  fs: Math.max(cur.fs, bx.fs),
                };
                continue;
              }
              flush();
            }
            cur = { ...bx };
          }
          flush();
          return out;
        }),
      );
    },

    async searchPage(id, pageIndex, needle, opts) {
      if (!needle.trim()) return [];
      const st = getDoc(id);
      const L = lib();
      return withPage(st, pageIndex, (page) =>
        withTextPage(page, (tp) => {
          const n = L.FPDFText_CountChars(tp);
          if (n <= 0) return [];
          const xf = pageXf(page);
          const chars: TextChar[] = [];
          mem((alloc) => {
            const r = alloc(32);
            const d = (k: number) => P().getValue(r + k * 8, 'double') as number;
            let line = 0;
            let prev: { y0: number; y1: number; x1: number } | null = null;
            for (let i = 0; i < n; i++) {
              const code = L.FPDFText_GetUnicode(tp, i);
              const ch = code ? String.fromCodePoint(code) : ' ';
              if (code === 13 || code === 10) {
                // 엔진이 줄 끝에 넣는 줄바꿈: 다음 글자부터 새 줄
                if (prev) line++;
                prev = null;
                chars.push({ ch: ' ', box: null, line });
                continue;
              }
              let box: TextChar['box'] = null;
              if (L.FPDFText_GetCharBox(tp, i, r, r + 8, r + 16, r + 24)) {
                const b = [d(0), d(2), d(1), d(3)]; // left, right, bottom, top → l, b, r, t
                if (b[2] > b[0] && b[3] > b[1]) {
                  const rc = userBoxToRect(xf, b[0], b[1], b[2], b[3]);
                  // 글자 모양 상자는 낮을 수 있으므로 글꼴 크기의 1.3배까지 위아래로 넓힌다(textQuads 와 같은 규칙)
                  const extra = Math.max(0, L.FPDFText_GetFontSize(tp, i) * 1.3 - rc.height) / 2;
                  box = { x0: rc.x, y0: rc.y - extra, x1: rc.x + rc.width, y1: rc.y + rc.height + extra };
                }
              }
              if (box) {
                // 줄바꿈 글자 없이 줄이 넘어간 경우: 세로로 겹치지 않으면 새 줄로 본다
                if (prev) {
                  const overlap = Math.min(prev.y1, box.y1) - Math.max(prev.y0, box.y0);
                  if (overlap < Math.min(prev.y1 - prev.y0, box.y1 - box.y0) * 0.5) line++;
                }
                prev = { y0: box.y0, y1: box.y1, x1: box.x1 };
              }
              chars.push({ ch, box, line });
            }
          });
          return findInChars(chars, needle, opts);
        }),
      );
    },

    async pageText(id, pageIndex) {
      const st = getDoc(id);
      const L = lib();
      return withPage(st, pageIndex, (page) =>
        withTextPage(page, (tp) => {
          const n = L.FPDFText_CountChars(tp);
          if (n <= 0) return '';
          return mem((alloc) => {
            const buf = alloc((n + 1) * 2);
            const got = L.FPDFText_GetText(tp, 0, n, buf);
            return decodeWide(buf, Math.max(0, got) * 2);
          });
        }),
      );
    },

    async listFormFields(id) {
      const st = getDoc(id);
      const L = lib();
      // 계약(adapter.ts FormField): 라디오는 위젯 하나가 필드 하나(이름은 그룹 공통), 나머지는 이름당 첫 위젯 하나
      const out: FormField[] = [];
      const seen = new Set<string>();
      scanWidgets(st, (page, w) => {
        const kind = kindOf(w.ftype);
        if (!kind) return;
        if (kind !== 'radio') {
          if (seen.has(w.name)) return;
          seen.add(w.name);
        }
        const field: FormField = {
          name: w.name,
          kind,
          pageIndex: w.pageIndex,
          rect: getRect(w.annot, pageXf(page)),
          value: null,
          readOnly: (w.flags & 1) !== 0,
        };
        switch (kind) {
          case 'text':
            field.value = readWide((buf, len) => L.FPDFAnnot_GetFormFieldValue(st.env, w.annot, buf, len));
            break;
          case 'checkbox':
            field.value = L.FPDFAnnot_IsChecked(st.env, w.annot);
            break;
          case 'radio': {
            field.options = [exportValue(st, w.annot)];
            field.value = L.FPDFAnnot_IsChecked(st.env, w.annot);
            break;
          }
          case 'combo':
            field.options = readOptions(st, w.annot);
            field.value = readWide((buf, len) => L.FPDFAnnot_GetFormFieldValue(st.env, w.annot, buf, len));
            break;
          case 'list': {
            const opts = readOptions(st, w.annot);
            field.options = opts;
            field.value = opts.filter((_o, i) => L.FPDFAnnot_IsOptionSelected(st.env, w.annot, i));
            break;
          }
          default:
            break;
        }
        out.push(field);
      });
      return out;
    },

    async setFormFieldValue(id, fieldName, value) {
      const st = getDoc(id);
      const L = lib();
      let handled = false;
      const typeErr = (kind: string, want: string) => new TypeError(`${kind} 필드(${fieldName})의 값은 ${want} 이어야 한다`);
      scanWidgets(
        st,
        (page, w) => {
          const kind = kindOf(w.ftype);
          if (!kind) return;
          if (kind === 'button' || kind === 'signature') throw new Error(`값을 설정할 수 없는 필드 종류: ${kind}`);
          if (w.flags & 1) throw new Error(`읽기 전용 필드: ${fieldName}`);
          const killFocus = () => L.FORM_ForceToKillFocus(st.env);

          if (kind === 'text' || (kind === 'combo' && typeof value === 'string' && !readOptions(st, w.annot).includes(value))) {
            if (value !== null && typeof value !== 'string') throw typeErr(kind, '문자열');
            // 폼 입력 시뮬레이션: 위젯 AP 를 폼 환경이 직접 다시 만든다(한글 값은 이 경로만 PDFium 에서 보임)
            L.FORM_SetFocusedAnnot(st.env, w.annot);
            L.FORM_SelectAllText(st.env, page);
            mem((alloc) => L.FORM_ReplaceSelection(st.env, page, wstr(alloc, value ?? '')));
            killFocus();
            handled = true;
            return true;
          }
          if (kind === 'checkbox') {
            if (typeof value !== 'boolean') throw typeErr(kind, 'boolean');
            if (L.FPDFAnnot_IsChecked(st.env, w.annot) !== value) {
              clickWidget(st, page, w.annot);
              if (L.FPDFAnnot_IsChecked(st.env, w.annot) !== value) throw new Error(`체크박스 상태를 바꾸지 못했다: ${fieldName}`);
            }
            handled = true;
            return true;
          }
          if (kind === 'radio') {
            // 같은 이름의 위젯 중 켜짐 값(options[0])이 일치하는 것을 클릭한다. true 는 이름이 같은 첫 위젯. false 는 아무것도 안 한다
            if (typeof value !== 'string' && typeof value !== 'boolean') throw typeErr(kind, '켜짐 값(문자열) 또는 boolean');
            if (value === false) {
              handled = true;
              return true;
            }
            if (typeof value === 'string' && exportValue(st, w.annot) !== value) return;
            if (!L.FPDFAnnot_IsChecked(st.env, w.annot)) {
              clickWidget(st, page, w.annot);
              if (!L.FPDFAnnot_IsChecked(st.env, w.annot)) throw new Error(`라디오 버튼을 선택하지 못했다: ${fieldName}`);
            }
            handled = true;
            return true;
          }
          if (kind === 'combo') {
            if (typeof value !== 'string') throw typeErr(kind, '문자열');
            const idx = readOptions(st, w.annot).indexOf(value);
            L.FORM_SetFocusedAnnot(st.env, w.annot);
            L.FORM_SetIndexSelected(st.env, page, idx, true);
            killFocus();
            handled = true;
            return true;
          }
          if (kind === 'list') {
            const want = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null;
            if (!want) throw typeErr(kind, '문자열 배열');
            const opts = readOptions(st, w.annot);
            for (const v of want) if (!opts.includes(v)) throw new Error(`목록에 없는 값: ${v}`);
            L.FORM_SetFocusedAnnot(st.env, w.annot);
            opts.forEach((o, i) => {
              const on = want.includes(o);
              if (L.FPDFAnnot_IsOptionSelected(st.env, w.annot, i) !== on) L.FORM_SetIndexSelected(st.env, page, i, on);
            });
            killFocus();
            handled = true;
            return true;
          }
        },
        fieldName,
      );
      if (!handled) throw new Error(`양식 필드를 찾을 수 없다(또는 값이 맞지 않는다): ${fieldName}`);
    },

    async save(id, opts: SaveOptions): Promise<SaveResult> {
      const st = getDoc(id);
      // 연속 저장: MuPDF 와 달리 PDFium 의 증분 저장은 매번 "열 때의 원본 + 원본 이후 누적 변경" 을 처음부터 다시 쓴다
      //   (실측: 증분 3회·전체 저장 뒤 증분 모두 qpdf 통과, 앞선 변경 유지). 따라서 재기준화가 필요 없고,
      //   증분 저장의 접두 기준은 항상 열 때의 원본이다(MuPDF 는 마지막 저장 결과).
      // garbageCollect: 별도 동작 없음. PDFium 전체 저장(FPDF_SaveAsCopy flags=0)은 이 플래그와 무관하게 쪽 트리에서 도달할 수 없는
      //   객체를 쓰지 않는다 — 근거 시험: test/pdfium-adapter.test.mjs '삭제 후 전체 저장은 삭제 쪽 객체를 정리한다'
      //   (scan.pdf 에서 한 쪽 삭제 뒤 garbageCollect 유무와 관계없이 결과가 원본의 70% 미만이고 같은 크기).
      //   (증분 저장은 원본 접두를 보존하므로 삭제된 쪽의 객체가 파일에 남는다)
      const L = lib();
      const notes: string[] = [];
      const done = (bytes: Uint8Array, fullFallback: boolean): SaveResult => {
        if (opts.incremental && fullFallback) notes.unshift('증분 저장을 할 수 없어 전체 저장으로 대체했다(디지털 서명이 있으면 무효가 될 수 있다).');
        if (opts.incremental && !fullFallback && st.deletedData) {
          notes.push('삭제한 쪽의 데이터가 파일에 남음(증분 저장은 원본을 보존하므로 정리하지 않는다. 정리하려면 전체 저장).');
        }
        if ((!opts.incremental || fullFallback) && !notes.some((n) => n.includes('서명'))) {
          let sigs = 0;
          try {
            sigs = L.FPDF_GetSignatureCount(st.doc);
          } catch {
            /* 판정 실패는 무시 */
          }
          if (sigs > 0) notes.unshift('전체 저장이라 기존 디지털 서명이 무효가 되었을 수 있다(서명을 보존하려면 증분 저장).');
        }
        return { bytes, fullFallback, notes: notes.length ? notes : undefined };
      };
      if (opts.flatten) {
        // 열려 있는 문서를 건드리지 않도록 전체 저장본을 임시로 열어 굽는다. 굽기는 증분이 불가능하다
        notes.push('주석·양식을 내용에 구운 사본이다(편집 중인 문서에는 반영되지 않는다).');
        return done(flattenBytes(writeCopy(st, 0), st.password), opts.incremental);
      }
      if (opts.incremental) {
        let out: Uint8Array | null = null;
        try {
          out = writeCopy(st, 1 /* FPDF_INCREMENTAL */);
        } catch {
          out = null;
        }
        if (out && incrementalLooksValid(st, out)) return done(out, false);
        return done(writeCopy(st, 0), true);
      }
      return done(writeCopy(st, 0), false);
    },
  };

  return adapter;
}
