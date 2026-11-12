// 엔진 어댑터 인터페이스. UI 는 이 인터페이스만 안다. (작업지시서 '방침')

export type DocId = string;
export type Rotation = 0 | 90 | 180 | 270;

export interface PageSize {
  /** PDF 포인트(1/72 inch), 회전 반영 후 */
  width: number;
  height: number;
}

export interface RenderedBitmap {
  width: number;
  height: number;
  /** RGBA 8bit, transfer 가능 */
  data: ArrayBuffer;
}

export type AnnotationType =
  | 'highlight'
  | 'square'
  | 'circle'
  | 'line'
  | 'ink'
  | 'text'
  | 'freetext'
  | 'stamp'
  | 'other';

/** 좌표 규약: 페이지 공간. 원점은 좌상단, y 는 아래로 증가, 회전 반영 후, 단위 pt(1/72 inch). 모든 어댑터가 이 규약을 따른다 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Annotation {
  /** 페이지 안에서 안정적인 식별자(엔진이 주는 인덱스/객체 번호) */
  id: string;
  type: AnnotationType;
  /** 페이지 공간 좌표(Rect 규약) */
  rect: Rect;
  color?: string;
  contents?: string;
  /** highlight 등 사각형 묶음. 페이지 공간 좌표 [x1,y1,x2,y2,...] */
  quadPoints?: number[][];
  /** 엔진별 부가 속성 */
  extra?: Record<string, unknown>;
}

export type NewAnnotation = Omit<Annotation, 'id'>;

/**
 * 이미지 스탬프. NewAnnotation({type:'stamp'}).extra.image 로 넘긴다. rect 는 페이지 공간 좌표이며 이미지는 rect 크기로 늘려 그린다
 * (종횡비 유지는 호출자가 rect 를 정한다). 읽을 때는 type 'stamp', extra.hasImage=true 로 노출되고 바이트는 돌려주지 않는다.
 * PNG 의 알파는 보존된다. 엔진이 지원하지 않으면 '이 엔진은 이미지 스탬프를 지원하지 않습니다' 오류.
 */
export interface StampImage {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
}

/** 페이지 공간 점(Rect 규약과 같은 좌표계) */
export interface PagePoint {
  x: number;
  y: number;
}

export type FormFieldKind = 'text' | 'checkbox' | 'radio' | 'combo' | 'list' | 'button' | 'signature';

/**
 * 양식 필드. 두 엔진 어댑터가 같은 계약을 따른다.
 * - text: value 문자열. combo: 문자열|null, options = 선택지. list: 선택된 문자열 배열, options = 선택지. button/signature: value null.
 * - checkbox: value boolean(켜짐 여부). options[0] = 켜짐 상태 이름(없을 수 있음).
 *   set: boolean 만 받는다(그 밖은 TypeError).
 * - radio: **위젯 하나가 필드 하나**다. 같은 그룹의 위젯들은 name 이 같고(이름만으로 위젯을 구분할 수 없다) 목록에 위젯 수만큼 나온다
 *   (페이지·위젯 순서). value 는 boolean(이 위젯이 선택됐는가), options[0] = 이 위젯의 켜짐 값(그룹 안에서 유일).
 *   set(name, value): 문자열은 그 켜짐 값을 가진 위젯을 선택한다(같은 그룹의 다른 위젯은 해제됨). true 는 이름이 같은 첫 위젯 선택.
 *   false 는 아무것도 하지 않는다(라디오는 끌 수 없다). 일치하는 위젯이 없으면 오류. UI 는 `setFormFieldValue(name, field.options[0])` 로 호출한다.
 * - 이름이 같은 비라디오 위젯은 첫 번째만 필드로 나온다.
 */
export interface FormField {
  name: string;
  kind: FormFieldKind;
  pageIndex: number;
  rect: Rect;
  value: string | boolean | string[] | null;
  options?: string[];
  readOnly?: boolean;
}

export interface SaveOptions {
  /** true: 증분 저장 시도(서명 값(ByteRange)·메타데이터 보존. 편집이 있으면 서명 이후 변경으로 표시될 수 있음). 엔진이 못 하면 SaveResult.fullFallback 이 true */
  incremental: boolean;
  /** 삭제된 페이지의 남은 객체 정리 */
  garbageCollect?: boolean;
  /** 주석·양식을 내용에 굽기 */
  flatten?: boolean;
}

export interface SaveResult {
  bytes: Uint8Array;
  /** 증분을 요청했으나 전체 저장으로 내려갔는가(사용자에게 한 번 알린다) */
  fullFallback: boolean;
  /** 사용자에게 알릴 저장 비고(예: 증분 저장은 삭제된 쪽의 객체를 정리하지 않음) */
  notes?: string[];
}

export interface OpenOptions {
  password?: string;
}

export interface EngineAdapter {
  readonly name: 'pdfium' | 'mupdf';

  /** 엔진 초기화(WASM 로드). BinarySource 에서 바이너리를 받는다 */
  init(): Promise<void>;

  // 문서
  open(bytes: ArrayBuffer | Uint8Array, opts?: OpenOptions): Promise<DocId>;
  close(doc: DocId): Promise<void>;
  pageCount(doc: DocId): Promise<number>;
  pageSize(doc: DocId, pageIndex: number): Promise<PageSize>;

  /** scale: 1 = 72dpi. 호출자가 devicePixelRatio·확대를 곱해 넘긴다 */
  renderPage(doc: DocId, pageIndex: number, scale: number): Promise<RenderedBitmap>;

  // 페이지 조작
  rotatePage(doc: DocId, pageIndex: number, rotation: Rotation): Promise<void>;
  deletePages(doc: DocId, pageIndexes: number[]): Promise<void>;
  movePage(doc: DocId, from: number, to: number): Promise<void>;
  /** src 의 페이지들을 dest 의 at 위치(생략 시 끝)에 복사한다 */
  importPages(dest: DocId, src: DocId, srcPageIndexes: number[], at?: number): Promise<void>;

  // 주석
  listAnnotations(doc: DocId, pageIndex: number): Promise<Annotation[]>;
  addAnnotation(doc: DocId, pageIndex: number, annot: NewAnnotation): Promise<Annotation>;
  updateAnnotation(doc: DocId, pageIndex: number, annot: Annotation): Promise<void>;
  deleteAnnotation(doc: DocId, pageIndex: number, annotId: string): Promise<void>;

  // 텍스트
  /**
   * 페이지 공간의 드래그 시작·끝 사이의 글자들을 줄 단위 quad([x1,y1,x2,y2,x3,y3,x4,y4] = 좌상·우상·좌하·우하)로 돌려준다.
   * 읽기 순서 기준이라 from/to 를 뒤바꿔도 같다. 글자가 없으면(스캔본) 빈 배열. 결과를 highlight 주석의 quadPoints 로 그대로 쓸 수 있다.
   */
  textQuads(doc: DocId, pageIndex: number, from: PagePoint, to: PagePoint): Promise<number[][]>;
  /** 쪽의 텍스트 전체(디버그·시험용) */
  pageText(doc: DocId, pageIndex: number): Promise<string>;

  // 양식
  listFormFields(doc: DocId): Promise<FormField[]>;
  setFormFieldValue(doc: DocId, fieldName: string, value: FormField['value']): Promise<void>;

  // 저장: 항상 새 바이트를 반환(원본 덮어쓰지 않음)
  save(doc: DocId, opts: SaveOptions): Promise<SaveResult>;
}
