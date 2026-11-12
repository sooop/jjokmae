// 주석·양식 편집 화면의 공유 상태(도구·색·선택)와 App 이 제공하는 편집 API 형태.
import type { Annotation, FormField, NewAnnotation, PagePoint, Rect } from '../engine/adapter';
import type { EngineKind } from '../engine/protocol';
import { DEFAULT_COLORS, DEFAULT_FONT_SIZE, type Tool } from './annot-geom';
import type { PreparedImage } from './stamp-image';

export type ColorTool = keyof typeof DEFAULT_COLORS;

export interface Selection {
  page: number;
  annot: Annotation;
}

export class AnnotUi {
  tool = $state<Tool>('select');
  colors = $state<Record<ColorTool, string>>({ ...DEFAULT_COLORS });
  fontSize = $state(DEFAULT_FONT_SIZE);
  sel = $state<Selection | null>(null);
  stamp = $state<PreparedImage | null>(null);
  /** 값이 바뀌면 모든 쪽 주석 목록을 다시 읽는다(저장 뒤 등) */
  epoch = $state(0);
  /** 쪽별로 마지막으로 그려진 무효화 키. 양식 입력이 엔진 그림에 반영된 뒤에 HTML 을 걷는다 */
  drawn = $state<Record<number, number>>({});
  /** 속성 패널의 내용 입력칸에 포커스를 달라는 신호 */
  focusContent = $state(0);

  /** 지금 도구에 해당하는 색 키(선택 도구·이미지는 없음) */
  get colorKey(): ColorTool | null {
    switch (this.tool) {
      case 'highlight':
      case 'square':
      case 'circle':
      case 'memo':
      case 'freetext':
        return this.tool;
      default:
        return null;
    }
  }

  setTool(t: Tool) {
    this.tool = t;
    if (t !== 'select') this.sel = null;
  }

  select(page: number, annot: Annotation) {
    this.sel = { page, annot };
  }

  clearSelection() {
    this.sel = null;
  }

  /** 쪽 목록을 다시 읽은 뒤 선택을 맞춘다: 같은 id 가 있으면 갱신, 없으면 해제 */
  syncSelection(page: number, list: Annotation[]) {
    const s = this.sel;
    if (!s || s.page !== page) return;
    const found = list.find((a) => a.id === s.annot.id);
    if (found) this.sel = { page, annot: found };
    else this.sel = null;
  }

  reset() {
    this.sel = null;
    this.drawn = {};
  }
}

/** App 이 구현하는 편집 API. 모든 쓰기는 되돌리기 대상이며 쪽 단위로만 다시 그린다 */
export interface AnnotApi {
  /** 지금 엔진 이름 */
  engine(): EngineKind | null;
  list(page: number): Promise<Annotation[]>;
  add(page: number, a: NewAnnotation): Promise<Annotation | null>;
  addStamp(page: number, rect: Rect, img: PreparedImage): Promise<Annotation | null>;
  update(page: number, a: Annotation): Promise<boolean>;
  remove(page: number, id: string): Promise<boolean>;
  quads(page: number, from: PagePoint, to: PagePoint): Promise<number[][]>;
  hasText(page: number): Promise<boolean>;
  setForm(field: FormField, value: FormField['value']): Promise<boolean>;
}
