// MuPDF(1.28.6) 기반 EngineAdapter 구현.
//
// 좌표 규약: MuPDF 페이지 공간 = 왼쪽 위 원점, y 아래로 증가, 단위 pt, 페이지 회전 반영 후.
// 주석·양식의 Rect 는 이 공간을 쓴다(렌더 비트맵 좌표 / scale 과 곧바로 대응된다).
// 주의: 이 파일은 erasable 문법만 쓴다(Node 타입 스트리핑으로 직접 import 가능하도록).
import type {
  Annotation,
  AnnotationType,
  DocId,
  EngineAdapter,
  FormField,
  FormFieldKind,
  NewAnnotation,
  OpenOptions,
  PageSize,
  Rect,
  RenderedBitmap,
  Rotation,
  SaveOptions,
  SaveResult,
  StampImage,
} from './adapter';
import type { BinaryRef, BinarySource } from './binary-source';
// 값 import 는 확장자를 적는다(Node 타입 스트리핑으로 시험에서 이 파일을 직접 import 한다)
import { findInChars, type SearchOptions, type TextChar } from './text-search.ts';
import type * as MuPDFTypes from 'mupdf';

type MuPDF = typeof MuPDFTypes;

/** 렌더 비트맵(RGBA) 상한. PDFium 어댑터의 MAX_BITMAP_BYTES 와 같은 값·같은 규칙을 유지한다 */
const MAX_BITMAP_BYTES = 256 * 1024 * 1024;
type PDFDocument = MuPDFTypes.PDFDocument;
type PDFPage = MuPDFTypes.PDFPage;
type PDFAnnotation = MuPDFTypes.PDFAnnotation;
type PDFWidget = MuPDFTypes.PDFWidget;

export interface MupdfAdapterOptions {
  /** WASM 바이트. 없으면 mupdf 기본 로드(Node 테스트용) */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** wasmBinary 대신 BinarySource 에서 받는다(wasmRef 필요) */
  binarySource?: BinarySource;
  wasmRef?: BinaryRef;
}

interface DocEntry {
  pdf: PDFDocument;
  /**
   * 증분 저장의 기준 바이트. 열 때는 원본이고, save() 가 성공할 때마다 그 저장 결과로 갱신된다(재기준화).
   * MuPDF 는 저장하면 "저장된 변경" 추적을 초기화하고 증분 xref 의 위치 계산도 열린 파일 기준이라,
   * 저장 뒤 같은 PDFDocument 로 다시 저장하면 결과가 깨지거나 앞선 변경이 빠진다. 그래서 저장 뒤
   * 이 바이트로 내부 문서를 다시 연다(아래 save() 주석).
   */
  src: Uint8Array;
  password?: string;
  /** 열 때(또는 재기준화 때) 로드 경고 수·복구 여부. 저장 결과 검증의 기준선 */
  warnCount: number;
  repaired: boolean;
  /** 쪽을 삭제했고 그 데이터가 아직 파일에 남아 있을 수 있다 */
  deletedData: boolean;
}

interface Opened {
  pdf: PDFDocument;
  warnings: string[];
  repaired: boolean;
}

const FULL_PAGE_ERR = '모든 페이지를 삭제할 수 없다';

function hex(color: number[] | undefined): string | undefined {
  if (!color || color.length === 0) return undefined;
  let rgb: number[];
  if (color.length === 1) rgb = [color[0], color[0], color[0]];
  else if (color.length === 3) rgb = color;
  else if (color.length === 4) {
    const [c, m, y, k] = color;
    rgb = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  } else return undefined;
  return '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

function parseHex(s: string | undefined): [number, number, number] | undefined {
  if (!s) return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function toRect(r: number[]): Rect {
  return { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] };
}

function fromRect(r: Rect): [number, number, number, number] {
  return [r.x, r.y, r.x + r.width, r.y + r.height];
}

function annotType(t: string): AnnotationType {
  switch (t) {
    case 'Highlight': return 'highlight';
    case 'Square': return 'square';
    case 'Circle': return 'circle';
    case 'Line': return 'line';
    case 'Ink': return 'ink';
    case 'Text': return 'text';
    case 'FreeText': return 'freetext';
    case 'Stamp': return 'stamp';
    default: return 'other';
  }
}

function widgetKind(t: string): FormFieldKind {
  switch (t) {
    case 'text': return 'text';
    case 'checkbox': return 'checkbox';
    case 'radiobutton': return 'radio';
    case 'combobox': return 'combo';
    case 'listbox': return 'list';
    case 'signature': return 'signature';
    default: return 'button';
  }
}

export class MupdfAdapter implements EngineAdapter {
  readonly name = 'mupdf' as const;

  private mupdf: MuPDF | null = null;
  private docs = new Map<DocId, DocEntry>();
  private seq = 0;
  private opts: MupdfAdapterOptions;

  constructor(opts: MupdfAdapterOptions = {}) {
    this.opts = opts;
  }

  async init(): Promise<void> {
    if (this.mupdf) return;
    let wasm = this.opts.wasmBinary;
    if (!wasm && this.opts.binarySource && this.opts.wasmRef) {
      wasm = await this.opts.binarySource.get(this.opts.wasmRef);
    }
    // mupdf.js 는 import 시점에 모듈을 초기화하므로 반드시 import 전에 설정한다.
    if (wasm) {
      const bin = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
      (globalThis as { $libmupdf_wasm_Module?: unknown }).$libmupdf_wasm_Module = { wasmBinary: bin };
    }
    this.mupdf = (await import('mupdf')) as MuPDF;
  }

  // ---------- 내부 ----------
  private lib(): MuPDF {
    if (!this.mupdf) throw new Error('mupdf 가 초기화되지 않았다(init 필요)');
    return this.mupdf;
  }

  private entry(doc: DocId): DocEntry {
    const e = this.docs.get(doc);
    if (!e) throw new Error(`알 수 없는 문서: ${doc}`);
    return e;
  }

  private checkIndex(pdf: PDFDocument, i: number): void {
    const n = pdf.countPages();
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`페이지 범위 초과: ${i} (총 ${n})`);
  }

  /** 페이지를 잠시 열어 fn 을 실행하고 반드시 해제한다 */
  private withPage<T>(doc: DocId, pageIndex: number, fn: (page: PDFPage, pdf: PDFDocument) => T): T {
    const { pdf } = this.entry(doc);
    this.checkIndex(pdf, pageIndex);
    const page = pdf.loadPage(pageIndex);
    try {
      return fn(page, pdf);
    } finally {
      page.destroy();
    }
  }

  private findAnnot(page: PDFPage, id: string): PDFAnnotation {
    for (const a of page.getAnnotations()) {
      if (String(a.getObject().asIndirect()) === id) return a;
    }
    throw new Error(`주석을 찾을 수 없다: ${id}`);
  }

  private readAnnot(a: PDFAnnotation): Annotation {
    const type = annotType(a.getType());
    const extra: Record<string, unknown> = { subtype: a.getType() };
    let color: string | undefined;
    if (type === 'freetext') {
      try {
        const da = a.getDefaultAppearance();
        color = hex(da.color);
        extra.fontSize = da.size;
        extra.font = da.font;
      } catch {
        /* DA 없음 */
      }
    } else {
      color = hex(a.getColor());
    }
    if (a.hasBorder()) extra.borderWidth = a.getBorderWidth();
    if (a.hasInteriorColor()) {
      const ic = hex(a.getInteriorColor());
      if (ic) extra.interiorColor = ic;
    }
    const out: Annotation = {
      id: String(a.getObject().asIndirect()),
      type,
      rect: toRect(a.hasRect() ? a.getRect() : a.getBounds()), // getBounds 는 테두리만큼 부풀어 왕복 시 드리프트
      extra,
    };
    if (color) out.color = color;
    const contents = a.getContents();
    if (contents) out.contents = contents;
    if (a.hasQuadPoints()) out.quadPoints = a.getQuadPoints().map((q) => Array.from(q));
    // MuPDF 는 하이라이트의 /Rect 를 quad 보다 부풀려 만든다(update() 가 여백을 더함). UI 가 rect 를 믿을 수 있도록
    // 읽을 때 quad 들의 경계 상자로 보정한다(파일은 건드리지 않는다).
    if (type === 'highlight' && out.quadPoints && out.quadPoints.length > 0) out.rect = toRect(quadsBounds(out.quadPoints));
    try {
      if (type === 'ink' && a.hasInkList()) extra.strokes = a.getInkList().map((s) => s.flatMap((p) => [p[0], p[1]]));
      if (type === 'line' && a.hasLine()) {
        const [p, q] = a.getLine();
        extra.start = [p[0], p[1]];
        extra.end = [q[0], q[1]];
      }
    } catch {
      /* 점 정보 없음 */
    }
    try {
      const op = a.getOpacity();
      if (op < 1) extra.opacity = op;
    } catch {
      /* 불투명도 없음 */
    }
    return out;
  }

  private moveVertices(a: PDFAnnotation, t: 'line' | 'ink', to: Rect): void {
    const cur = toRect(a.getBounds());
    const same = (u: number, v: number) => Math.abs(u - v) < 0.01;
    if (same(cur.x, to.x) && same(cur.y, to.y) && same(cur.width, to.width) && same(cur.height, to.height)) return;
    const sx = cur.width > 1e-6 ? to.width / cur.width : 1;
    const sy = cur.height > 1e-6 ? to.height / cur.height : 1;
    const f = (p: MuPDFTypes.Point): MuPDFTypes.Point => [to.x + (p[0] - cur.x) * sx, to.y + (p[1] - cur.y) * sy];
    if (t === 'ink') a.setInkList(a.getInkList().map((s) => s.map(f)));
    else {
      const [p, q] = a.getLine();
      a.setLine(f(p), f(q));
    }
  }

  /** 하이라이트 갱신: rect 만 바뀌었으면 저장된 quad 를 새 rect 로 옮기고(평행이동·배율), quad 가 바뀌었으면 quad 가 우선한다 */
  private resolveHighlightQuads(a: PDFAnnotation, d: Annotation): number[][] {
    const stored = a.hasQuadPoints() ? a.getQuadPoints().map((q) => Array.from(q)) : [];
    const given = d.quadPoints && d.quadPoints.length > 0 ? d.quadPoints : null;
    if (given && !sameQuads(given, stored)) return given; // quad 자체를 바꿨다
    const base = given ?? stored;
    if (base.length === 0) return [rectToQuad(d.rect)];
    const b = quadsBounds(base);
    const nx = d.rect.x;
    const ny = d.rect.y;
    const same = (u: number, v: number) => Math.abs(u - v) < 0.01;
    if (same(b[0], nx) && same(b[1], ny) && same(b[2], nx + d.rect.width) && same(b[3], ny + d.rect.height)) return base;
    const sx = b[2] - b[0] > 1e-6 ? d.rect.width / (b[2] - b[0]) : 1;
    const sy = b[3] - b[1] > 1e-6 ? d.rect.height / (b[3] - b[1]) : 1;
    return base.map((q) => q.map((v, i) => (i % 2 === 0 ? nx + (v - b[0]) * sx : ny + (v - b[1]) * sy)));
  }

  private applyAnnot(a: PDFAnnotation, type: AnnotationType, d: NewAnnotation, isNew = true): void {
    const extra = d.extra ?? {};
    const rgb = parseHex(d.color);
    if (type === 'highlight') {
      const quads = isNew
        ? d.quadPoints && d.quadPoints.length > 0
          ? d.quadPoints
          : [rectToQuad(d.rect)]
        : this.resolveHighlightQuads(a, d as Annotation);
      a.setQuadPoints(quads as MuPDFTypes.Quad[]);
      if (rgb) a.setColor(rgb);
    } else {
      a.setRect(fromRect(d.rect));
      if (type === 'square' || type === 'circle') {
        if (rgb) a.setColor(rgb);
        // 갱신에서 borderWidth 가 없으면 기존 값을 유지한다. 새 주석만 기본값 1
        if (typeof extra.borderWidth === 'number') a.setBorderWidth(extra.borderWidth);
        else if (isNew) a.setBorderWidth(1);
        const ic = parseHex(extra.interiorColor as string | undefined);
        if (ic) a.setInteriorColor(ic);
      } else if (type === 'text') {
        if (rgb) a.setColor(rgb);
      } else if (type === 'freetext') {
        const size = typeof extra.fontSize === 'number' ? extra.fontSize : 12;
        a.setDefaultAppearance('Helv', size, rgb ?? [0, 0, 0]);
      }
    }
    if (typeof extra.opacity === 'number') a.setOpacity(extra.opacity);
    // 갱신에서 contents 가 undefined 면 기존 내용을 보존한다(지우려면 '' 를 넘긴다)
    if (d.contents !== undefined) a.setContents(d.contents);
    else if (isNew) a.setContents('');
    a.update();
  }

  // ---------- 문서 ----------
  async open(bytes: ArrayBuffer | Uint8Array, opts?: OpenOptions): Promise<DocId> {
    const src = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0));
    const o = this.openBytes(src, opts?.password);
    const id = `mupdf-${++this.seq}`;
    this.docs.set(id, {
      pdf: o.pdf,
      src,
      password: opts?.password,
      warnCount: o.warnings.length,
      repaired: o.repaired,
      deletedData: false,
    });
    return id;
  }

  /** 저장해 JS 힙으로 복사한 뒤 WASM 쪽 Buffer 를 즉시 해제한다(저장마다 문서 크기만큼 새는 것을 막는다) */
  private saveBytes(pdf: PDFDocument, options: string): Uint8Array {
    const buf = pdf.saveToBuffer(options);
    try {
      return buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
  }

  /** 바이트를 열고 로드 중 경고를 모은다(비밀번호 문서는 인증까지) */
  private openBytes(src: Uint8Array, password?: string): Opened {
    const m = this.lib();
    const warnings: string[] = [];
    m.setLog({ warning: (s) => warnings.push(s), error: (s) => warnings.push(s) });
    try {
      const doc = m.Document.openDocument(src, 'application/pdf');
      const pdf = doc.asPDF();
      if (!pdf) {
        doc.destroy();
        throw new Error('PDF 문서가 아니다');
      }
      try {
        if (pdf.needsPassword()) {
          if (!password || !pdf.authenticatePassword(password)) {
            throw new Error(password ? '비밀번호가 틀렸다' : '비밀번호가 필요하다');
          }
        }
        pdf.countPages(); // 쪽 트리 로드 중 경고도 모은다
        return { pdf, warnings, repaired: pdf.wasRepaired() };
      } catch (e) {
        pdf.destroy(); // asPDF 이후의 어떤 예외에서도 문서를 놓치지 않는다
        throw e;
      }
    } finally {
      m.setLog(null);
    }
  }

  async close(doc: DocId): Promise<void> {
    const e = this.docs.get(doc);
    if (!e) return;
    this.docs.delete(doc);
    e.pdf.destroy();
  }

  async pageCount(doc: DocId): Promise<number> {
    return this.entry(doc).pdf.countPages();
  }

  async pageSize(doc: DocId, pageIndex: number): Promise<PageSize> {
    return this.withPage(doc, pageIndex, (page) => {
      const [x0, y0, x1, y1] = page.getBounds();
      return { width: x1 - x0, height: y1 - y0 };
    });
  }

  async renderPage(doc: DocId, pageIndex: number, scale: number): Promise<RenderedBitmap> {
    const m = this.lib();
    if (!(scale > 0)) throw new Error('scale 은 0보다 커야 한다');
    return this.withPage(doc, pageIndex, (page) => {
      const matrix = m.Matrix.scale(scale, scale);
      const b = m.Rect.transform(page.getBounds(), matrix);
      const bbox: MuPDFTypes.Rect = [Math.floor(b[0]), Math.floor(b[1]), Math.ceil(b[2]), Math.ceil(b[3])];
      const bw = Math.max(1, bbox[2] - bbox[0]);
      const bh = Math.max(1, bbox[3] - bbox[1]);
      if (!Number.isFinite(bw * bh) || bw * bh * 4 > MAX_BITMAP_BYTES) {
        throw new RangeError(
          `렌더 크기가 너무 크다: ${bw}x${bh}px(${Math.round((bw * bh * 4) / 1048576)}MB). 상한은 ${MAX_BITMAP_BYTES / 1048576}MB 이다. 배율을 낮춰 주세요.`,
        );
      }
      // alpha 포함 RGBA pixmap 을 흰색 불투명으로 채운 뒤 주석·위젯 포함 렌더(page.run)
      const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, bbox, true);
      try {
        pix.clear(255);
        const dev = new m.DrawDevice(m.Matrix.identity, pix);
        try {
          page.run(dev, matrix);
          dev.close();
        } finally {
          dev.destroy();
        }
        const w = pix.getWidth();
        const h = pix.getHeight();
        const n = pix.getNumberOfComponents() + pix.getAlpha(); // RGB(3)+A(1)
        const stride = pix.getStride();
        const px = pix.getPixels();
        // 힙 뷰이므로 복사한다. stride 가 w*4 와 같으면 통째로, 아니면 행 단위로.
        const out = new Uint8Array(w * h * 4);
        if (n === 4 && stride === w * 4) out.set(px.subarray(0, w * h * 4));
        else for (let y = 0; y < h; y++) out.set(px.subarray(y * stride, y * stride + w * 4), y * w * 4);
        return { width: w, height: h, data: out.buffer as ArrayBuffer };
      } finally {
        pix.destroy();
      }
    });
  }

  // ---------- 페이지 조작 ----------
  async rotatePage(doc: DocId, pageIndex: number, rotation: Rotation): Promise<void> {
    if (![0, 90, 180, 270].includes(rotation)) throw new Error(`잘못된 회전값: ${rotation}`);
    this.withPage(doc, pageIndex, (page) => {
      page.getObject().put('Rotate', rotation); // 절대값. 상속값을 덮어쓴다
    });
  }

  async deletePages(doc: DocId, pageIndexes: number[]): Promise<void> {
    const { pdf } = this.entry(doc);
    const uniq = [...new Set(pageIndexes)].sort((a, b) => b - a); // 내림차순
    for (const i of uniq) this.checkIndex(pdf, i);
    if (uniq.length >= pdf.countPages()) throw new Error(FULL_PAGE_ERR);
    if (uniq.length === 0) return; // 지운 것이 없으면 '삭제한 데이터가 남음' 표시를 켜지 않는다
    for (const i of uniq) pdf.deletePage(i);
    this.entry(doc).deletedData = true;
  }

  async movePage(doc: DocId, from: number, to: number): Promise<void> {
    const { pdf } = this.entry(doc);
    this.checkIndex(pdf, from);
    this.checkIndex(pdf, to);
    if (from === to) return;
    // to: 이동 후 최종 위치
    const order = Array.from({ length: pdf.countPages() }, (_, i) => i);
    order.splice(from, 1);
    order.splice(to, 0, from);
    pdf.rearrangePages(order);
  }

  async importPages(dest: DocId, src: DocId, srcPageIndexes: number[], at?: number): Promise<void> {
    const d = this.entry(dest).pdf;
    const s = this.entry(src).pdf;
    for (const i of srcPageIndexes) this.checkIndex(s, i);
    let pos = at ?? d.countPages();
    if (!Number.isInteger(pos) || pos < 0 || pos > d.countPages()) throw new Error(`삽입 위치 범위 초과: ${pos}`);
    const map = d.newGraftMap(); // 공유 리소스 중복 복사 방지
    try {
      for (const i of srcPageIndexes) map.graftPage(pos++, s, i);
    } finally {
      map.destroy();
    }
  }

  // ---------- 주석 ----------
  async listAnnotations(doc: DocId, pageIndex: number): Promise<Annotation[]> {
    return this.withPage(doc, pageIndex, (page) =>
      page
        .getAnnotations()
        .filter((a) => a.getType() !== 'Popup') // Text 주석이 만드는 Popup 은 숨김
        .map((a) => this.readAnnot(a)),
    );
  }

  async addAnnotation(doc: DocId, pageIndex: number, annot: NewAnnotation): Promise<Annotation> {
    const kinds: Partial<Record<AnnotationType, MuPDFTypes.PDFAnnotationType>> = {
      highlight: 'Highlight',
      square: 'Square',
      circle: 'Circle',
      text: 'Text',
      freetext: 'FreeText',
      stamp: 'Stamp',
    };
    const sub = kinds[annot.type];
    if (!sub) throw new Error(`추가를 지원하지 않는 주석 유형: ${annot.type}`);
    let image: MuPDFTypes.Image | null = null;
    if (annot.type === 'stamp') {
      const im = annot.extra?.image as StampImage | undefined;
      if (!im || !(im.bytes instanceof Uint8Array) || im.bytes.length === 0) {
        throw new Error('stamp 주석에는 extra.image({bytes, mime})가 필요하다');
      }
      checkStampImage(im);
      image = new (this.lib().Image)(im.bytes);
    }
    // withPage 가 콜백 전에 던져도(문서·쪽 번호 오류) 이미지는 해제한다
    try {
      return this.withPage(doc, pageIndex, (page) => {
        const a = page.createAnnotation(sub);
        try {
          if (image) {
            a.setStampImage(image); // 이미지로 AP 를 만든다. rect 를 바꾸면 AP 가 그 크기로 늘어나 그려진다
            a.setRect(fromRect(annot.rect));
            if (typeof annot.extra?.opacity === 'number') a.setOpacity(annot.extra.opacity);
            a.setContents(annot.contents ?? '');
            a.update();
          } else {
            this.applyAnnot(a, annot.type, annot);
          }
          const res = this.readAnnot(a);
          if (image) res.extra = { ...res.extra, hasImage: true };
          return res;
        } catch (e) {
          page.deleteAnnotation(a); // 반쪽짜리 주석을 남기지 않는다
          throw e;
        }
      });
    } finally {
      image?.destroy();
    }
  }

  async updateAnnotation(doc: DocId, pageIndex: number, annot: Annotation): Promise<void> {
    this.withPage(doc, pageIndex, (page) => {
      const a = this.findAnnot(page, annot.id);
      const t = annotType(a.getType());
      if (t === 'other' || t === 'stamp' || t === 'line' || t === 'ink') {
        // 위치·내용(+ 선·잉크는 색)만 갱신. stamp 는 rect 를 바꾸면 AP 가 새 rect 로 늘어나 그려진다.
        // line·ink 는 /Rect 속성이 없어(setRect 가 던진다) 점들을 현재 경계 상자에서 새 rect 로 옮겨(평행이동·배율) 반영한다.
        if (t === 'line' || t === 'ink') this.moveVertices(a, t, annot.rect);
        else a.setRect(fromRect(annot.rect));
        if (annot.contents !== undefined) a.setContents(annot.contents);
        if (t === 'line' || t === 'ink') {
          const rgb = parseHex(annot.color);
          if (rgb) a.setColor(rgb);
        }
        if (typeof annot.extra?.opacity === 'number') a.setOpacity(annot.extra.opacity);
        a.update();
        return;
      }
      this.applyAnnot(a, t, annot, false);
    });
  }

  async deleteAnnotation(doc: DocId, pageIndex: number, annotId: string): Promise<void> {
    this.withPage(doc, pageIndex, (page) => {
      page.deleteAnnotation(this.findAnnot(page, annotId));
    });
  }

  // ---------- 텍스트 ----------
  async textQuads(doc: DocId, pageIndex: number, from: { x: number; y: number }, to: { x: number; y: number }): Promise<number[][]> {
    return this.withPage(doc, pageIndex, (page) => {
      const st = page.toStructuredText('preserve-whitespace');
      try {
        const quads = st.highlight([from.x, from.y], [to.x, to.y], 2000).map((q) => Array.from(q));
        return mergeLineQuads(quads);
      } finally {
        st.destroy();
      }
    });
  }

  async pageText(doc: DocId, pageIndex: number): Promise<string> {
    return this.withPage(doc, pageIndex, (page) => {
      const st = page.toStructuredText('preserve-whitespace');
      try {
        return st.asText();
      } finally {
        st.destroy();
      }
    });
  }

  async searchPage(doc: DocId, pageIndex: number, needle: string, opts?: SearchOptions): Promise<number[][][]> {
    if (!needle.trim()) return [];
    return this.withPage(doc, pageIndex, (page) => {
      const st = page.toStructuredText('preserve-whitespace');
      try {
        const chars: TextChar[] = [];
        let line = 0;
        st.walk({
          beginLine: () => {
            line++;
          },
          onChar: (c, _origin, _font, _size, quad) => {
            const xs = [quad[0], quad[2], quad[4], quad[6]];
            const ys = [quad[1], quad[3], quad[5], quad[7]];
            const x0 = Math.min(...xs);
            const x1 = Math.max(...xs);
            const y0 = Math.min(...ys);
            const y1 = Math.max(...ys);
            chars.push({ ch: c, box: x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null, line });
          },
        });
        return findInChars(chars, needle, opts);
      } finally {
        st.destroy();
      }
    });
  }

  // ---------- 양식 ----------
  private widgetOnState(w: PDFWidget): string | undefined {
    try {
      const n = w.getObject().getInheritable('AP')?.get('N');
      if (!n || !n.isDictionary()) return undefined;
      let on: string | undefined;
      n.forEach((_v, k) => {
        if (k !== 'Off' && on === undefined) on = String(k);
      });
      return on;
    } catch {
      return undefined;
    }
  }

  private readWidget(w: PDFWidget, pageIndex: number): FormField {
    const kind = widgetKind(w.getFieldType());
    let value: FormField['value'];
    let options: string[] | undefined;
    const raw = w.getValue();
    if (kind === 'checkbox' || kind === 'radio') {
      const on = this.widgetOnState(w);
      const as = w.getObject().get('AS');
      const state = as.isName() ? as.asName() : raw;
      value = state !== 'Off' && state !== '' && state != null;
      if (on) options = [on];
    } else if (kind === 'combo' || kind === 'list') {
      value = raw === '' ? null : raw;
      options = w.getOptions();
    } else if (kind === 'text') {
      value = raw;
    } else {
      value = null;
    }
    const f: FormField = {
      name: w.getName(),
      kind,
      pageIndex,
      rect: toRect(w.getBounds()),
      value,
      readOnly: w.isReadOnly() || kind === 'signature',
    };
    if (options) f.options = options;
    return f;
  }

  async listFormFields(doc: DocId): Promise<FormField[]> {
    const { pdf } = this.entry(doc);
    const out: FormField[] = [];
    const n = pdf.countPages();
    for (let i = 0; i < n; i++) {
      const page = pdf.loadPage(i);
      try {
        for (const w of page.getWidgets()) out.push(this.readWidget(w, i));
      } finally {
        page.destroy();
      }
    }
    return out;
  }

  async setFormFieldValue(doc: DocId, fieldName: string, value: FormField['value']): Promise<void> {
    const { pdf } = this.entry(doc);
    const n = pdf.countPages();
    let found = false;
    let radio = false;
    for (let i = 0; i < n; i++) {
      const page = pdf.loadPage(i);
      try {
        for (const w of page.getWidgets()) {
          if (w.getName() !== fieldName) continue;
          found = true;
          if (widgetKind(w.getFieldType()) === 'radio') radio = true;
          if (this.setWidget(w, value)) return;
        }
      } finally {
        page.destroy();
      }
    }
    if (!found) throw new Error(`양식 필드를 찾을 수 없다: ${fieldName}`);
    // 라디오: 켜짐 값이 맞는 위젯이 없다. false 는 "아무것도 하지 않음" 이라 오류가 아니다(PDFium 과 같은 계약)
    if (radio && value !== false) throw new Error(`양식 필드를 찾을 수 없다(또는 값이 맞지 않는다): ${fieldName}`);
  }

  /** 값을 적용했으면 true(같은 이름의 다른 위젯은 건드리지 않고 끝낼 수 있음) */
  private setWidget(w: PDFWidget, value: FormField['value']): boolean {
    const kind = widgetKind(w.getFieldType());
    if (w.isReadOnly()) throw new Error(`읽기 전용 필드: ${w.getName()}`);
    switch (kind) {
      case 'text':
        w.setTextValue(value == null ? '' : Array.isArray(value) ? value.join('\n') : String(value));
        return true;
      case 'combo':
      case 'list': {
        const v = Array.isArray(value) ? value[0] ?? '' : value == null ? '' : String(value);
        w.setChoiceValue(v); // 다중 선택은 첫 값만(한계)
        return true;
      }
      case 'checkbox': {
        if (typeof value !== 'boolean') throw new TypeError(`checkbox 필드(${w.getName()})의 값은 boolean 이어야 한다`);
        const want = value;
        const cur = this.readWidget(w, 0).value === true;
        if (want !== cur) w.toggle();
        return true;
      }
      case 'radio': {
        // 값: true 또는 켜짐 상태 이름(문자열). 이 위젯의 켜짐 상태와 일치할 때만 선택한다.
        const on = this.widgetOnState(w);
        const want = value === true || (typeof value === 'string' && value === on);
        if (!want) return false;
        if (this.readWidget(w, 0).value !== true) w.toggle();
        return true;
      }
      default:
        throw new Error(`값을 쓸 수 없는 필드 유형: ${kind}`);
    }
  }

  // ---------- 저장 ----------
  //
  // 증분 저장 결함의 원인(실측: scratchpad/inc3.mjs):
  //  - MuPDF 의 saveToBuffer('incremental=yes') 는 "열린 원본 파일 + 변경분" 을 쓰는데, 변경분의 xref 위치는 원본 파일 길이
  //    기준으로 계산하면서 트레일러의 /Prev 는 직전 저장의 startxref 로 갱신한다. 같은 PDFDocument 로 두 번째 증분 저장을
  //    하면 /Prev 가 결과 바이트에 없는 오프셋(첫 저장의 xref)을 가리킨다 → "xref section recursion" 으로 열리지 않는다.
  //    (접두는 원본과 같으니 접두 검사는 통과한다)
  //  - 저장하면 "저장되지 않은 변경" 표시(hasUnsavedChanges)가 지워진다. 그래서 전체 저장 뒤의 증분 저장은 그 전 변경을
  //    "이미 저장됨" 으로 보고 빠뜨린다.
  // 해결: 저장이 끝나면 저장 결과 바이트로 내부 PDFDocument 를 다시 열고 src 를 그 바이트로 바꾼다(재기준화).
  //  - DocId 는 유지된다(같은 id 로 계속 쓴다). 페이지·주석 핸들은 호출마다 열고 닫으므로 영향이 없다.
  //  - 주석 id(객체 번호)는 증분 저장·garbageCollect 없는 전체 저장에서는 유지된다. garbageCollect 전체 저장은 객체를
  //    다시 번호 매길 수 있으므로 id 가 바뀔 수 있다 → 호출자는 garbageCollect 저장 뒤 listAnnotations 를 다시 불러야 한다.
  //  - 이후 증분 저장의 접두 기준은 "마지막 저장 결과" 다(원본이 아니다).
  //  - flatten 저장은 라이브 문서를 건드리지 않는다(굽기 전 상태가 재기준이 된다).
  // 반환 전 정합성 검사: 결과를 다시 열어 쪽 수 일치·접두 보존·새 로드 경고 없음을 확인하고, 증분 결과가 실패하면
  // fullFallback=true 로 전체 저장으로 내려간다.

  /** 저장 결과를 열어 검사한다. 열린 문서는 호출자가 인수(adopt)하거나 destroy 한다 */
  private checkResult(
    e: DocEntry,
    bytes: Uint8Array,
    wantPages: number,
    prefix: Uint8Array | null,
  ): { ok: boolean; hard: boolean; opened: Opened | null; problems: string[] } {
    const problems: string[] = [];
    let hard = false;
    if (prefix && !hasPrefix(bytes, prefix)) {
      problems.push('원본 접두가 보존되지 않았다');
      hard = true;
    }
    let opened: Opened | null = null;
    try {
      opened = this.openBytes(bytes, e.password);
    } catch (err) {
      problems.push(`결과를 다시 열 수 없다: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, hard: true, opened: null, problems };
    }
    try {
      const n = opened.pdf.countPages();
      if (n !== wantPages) {
        problems.push(`쪽 수가 다르다(${n} ≠ ${wantPages})`);
        hard = true;
      }
    } catch (err) {
      problems.push(`쪽 트리를 읽을 수 없다: ${err instanceof Error ? err.message : String(err)}`);
      hard = true;
    }
    if (opened.warnings.length > e.warnCount) problems.push(`로드 경고 ${opened.warnings.length}건: ${opened.warnings[0]}`);
    if (opened.repaired && !e.repaired) problems.push('결과가 손상된 것으로 복구되어 열렸다');
    return { ok: problems.length === 0, hard, opened, problems };
  }

  /** 서명된 서명 필드가 있는가(전체 저장 시 서명이 무효가 됨을 알리는 용) */
  private hasSignedSignature(pdf: PDFDocument): boolean {
    try {
      const n = pdf.countPages();
      for (let i = 0; i < n; i++) {
        const page = pdf.loadPage(i);
        try {
          for (const w of page.getWidgets()) {
            if (w.getFieldType() !== 'signature') continue;
            const v = w.getObject().getInheritable('V');
            if (v && !v.isNull()) return true;
          }
        } finally {
          page.destroy();
        }
      }
    } catch {
      /* 판정 실패는 무시 */
    }
    return false;
  }

  async save(doc: DocId, opts: SaveOptions): Promise<SaveResult> {
    const e = this.entry(doc);
    const wantPages = e.pdf.countPages();
    const notes: string[] = [];
    const fullOpts = opts.garbageCollect ? 'garbage=compact' : '';
    const signed = this.hasSignedSignature(e.pdf);

    // 1) 저장본 만들기(증분이 안 되거나 검사에 실패하면 전체 저장)
    let bytes: Uint8Array | null = null;
    let adopted: Opened | null = null;
    let fullFallback = false;
    let incremental = false;
    const failReasons: string[] = [];

    if (opts.incremental) {
      try {
        if (e.pdf.canBeSavedIncrementally()) {
          const inc = this.saveBytes(e.pdf, 'incremental=yes');
          const chk = this.checkResult(e, inc, wantPages, e.src);
          if (chk.ok && chk.opened) {
            bytes = inc;
            adopted = chk.opened;
            incremental = true;
          } else {
            failReasons.push(...chk.problems);
            chk.opened?.pdf.destroy();
          }
        } else {
          failReasons.push('이 문서는 증분 저장을 할 수 없다');
        }
      } catch (err) {
        failReasons.push(`증분 저장 오류: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!bytes) fullFallback = true;
    }
    if (!bytes) {
      const full = this.saveBytes(e.pdf, fullOpts);
      const chk = this.checkResult(e, full, wantPages, null);
      if (!chk.opened || chk.hard) {
        chk.opened?.pdf.destroy();
        throw new Error(`저장 결과 검증에 실패했다: ${chk.problems.join('; ')}`);
      }
      if (!chk.ok) notes.push(`저장 결과 경고: ${chk.problems.join('; ')}`);
      bytes = full;
      adopted = chk.opened;
    }

    // 2) 재기준화: 내부 문서를 저장 결과로 교체한다(이후 저장의 기준이 된다)
    const saved = bytes;
    const old = e.pdf;
    e.pdf = adopted!.pdf;
    e.src = saved.slice(); // 호출자가 bytes 를 transfer 해도 기준이 유지되도록 사본
    e.warnCount = Math.max(e.warnCount, adopted!.warnings.length);
    e.repaired = e.repaired || adopted!.repaired;
    old.destroy();
    const deletedBefore = e.deletedData;
    if (!incremental && opts.garbageCollect) e.deletedData = false;

    // 3) 평탄화: 라이브 문서를 굽지 않도록 저장본을 다시 열어 bake 한다
    let out = saved;
    if (opts.flatten) {
      const tmp = this.openBytes(saved, e.password).pdf;
      try {
        tmp.bake(true, true);
        let flat: Uint8Array | null = null;
        if (incremental) {
          try {
            if (tmp.canBeSavedIncrementally()) {
              const inc = this.saveBytes(tmp, 'incremental=yes');
              const chk = this.checkResult(e, inc, wantPages, saved);
              chk.opened?.pdf.destroy();
              if (chk.ok) flat = inc;
            }
          } catch {
            flat = null;
          }
          if (!flat) {
            fullFallback = true;
            incremental = false;
          }
        }
        if (!flat) {
          flat = this.saveBytes(tmp, fullOpts);
          const chk = this.checkResult(e, flat, wantPages, null);
          chk.opened?.pdf.destroy();
          if (!chk.opened || chk.hard) throw new Error(`평탄화 결과 검증에 실패했다: ${chk.problems.join('; ')}`);
        }
        out = flat;
      } finally {
        tmp.destroy();
      }
      notes.push('주석·양식을 내용에 구운 사본이다(편집 중인 문서에는 반영되지 않는다).');
    }

    // 4) 비고
    if (opts.incremental && fullFallback) {
      notes.unshift(
        '증분 저장을 할 수 없어 전체 저장으로 대체했다' +
          (signed ? '(디지털 서명이 무효가 되었을 수 있다)' : '') +
          (failReasons.length ? `: ${failReasons[0]}` : ''),
      );
    } else if (!opts.incremental && signed) {
      notes.unshift('전체 저장이라 기존 디지털 서명이 무효가 되었을 수 있다(서명을 보존하려면 증분 저장).');
    }
    if (incremental && deletedBefore) {
      notes.push('삭제한 쪽의 데이터가 파일에 남음(증분 저장은 원본을 보존하므로 정리하지 않는다. 정리하려면 전체 저장 + 정리 옵션).');
    } else if (!incremental && deletedBefore && !opts.garbageCollect) {
      notes.push('삭제한 쪽의 데이터가 파일에 남아 있을 수 있다(정리 옵션을 켜면 제거된다).');
    }
    return { bytes: out, fullFallback, notes: notes.length ? notes : undefined };
  }
}

function rectToQuad(r: Rect): number[] {
  const [x0, y0, x1, y1] = fromRect(r);
  return [x0, y0, x1, y0, x0, y1, x1, y1];
}

/** 선언한 mime 과 실제 매직 바이트가 맞는지 검사한다 */
function checkStampImage(im: StampImage): void {
  const b = im.bytes;
  const png = b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (im.mime === 'image/png' ? !png : im.mime === 'image/jpeg' ? !jpg : true) {
    throw new Error(`이미지 형식이 mime(${String(im.mime)})과 맞지 않는다(PNG·JPEG 만 지원)`);
  }
}

/** quad 들의 경계 상자 [x0,y0,x1,y1] */
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
 * 같은 줄에 걸친 조각 quad 들을 줄 단위 하나로 합친다(MuPDF 는 글꼴·크기가 바뀌는 곳마다 quad 를 끊는다).
 * 축 정렬(가로쓰기) quad 만 합치고, 기울어진 글자는 그대로 둔다.
 */
function mergeLineQuads(quads: number[][]): number[][] {
  const out: number[][] = [];
  let cur: [number, number, number, number] | null = null;
  const flush = () => {
    if (cur) out.push([cur[0], cur[1], cur[2], cur[1], cur[0], cur[3], cur[2], cur[3]]);
    cur = null;
  };
  for (const q of quads) {
    const axis = Math.abs(q[1] - q[3]) < 0.01 && Math.abs(q[5] - q[7]) < 0.01 && Math.abs(q[0] - q[4]) < 0.01;
    if (!axis) {
      flush();
      out.push(q);
      continue;
    }
    const b: [number, number, number, number] = [q[0], q[1], q[6], q[7]];
    if (cur) {
      const overlap = Math.min(cur[3], b[3]) - Math.max(cur[1], b[1]);
      const minH = Math.min(cur[3] - cur[1], b[3] - b[1]);
      if (minH > 0 && overlap >= minH * 0.5 && b[0] >= cur[0] - 0.5) {
        cur = [Math.min(cur[0], b[0]), Math.min(cur[1], b[1]), Math.max(cur[2], b[2]), Math.max(cur[3], b[3])];
        continue;
      }
      flush();
    }
    cur = b;
  }
  flush();
  return out;
}

function hasPrefix(out: Uint8Array, base: Uint8Array): boolean {
  if (out.length < base.length) return false;
  for (let i = 0; i < base.length; i++) if (out[i] !== base[i]) return false;
  return true;
}

export function createMupdfAdapter(opts?: MupdfAdapterOptions): EngineAdapter {
  return new MupdfAdapter(opts);
}
