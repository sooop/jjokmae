// 문서 안에서 찾기의 상태. 찾는 일(쪽마다 엔진에 묻기)은 App 이 넘겨주는 search 함수가 하고, 여기서는 순서·취소·
// 결과 모으기·현재 항목 이동만 맡는다. 결과는 쪽별 일치 목록(일치마다 줄 단위 quad 목록)이다.

export interface FindTarget {
  /** 같은 문서·같은 쪽 구성인지 가리는 값. 같으면 다시 찾는 동안 옛 표시를 그대로 둔다 */
  scope: string;
  total: number;
  /** 여기서부터 찾기 시작한다(지금 보고 있는 쪽): 가까운 결과가 먼저 나온다 */
  start: number;
  search(page: number): Promise<number[][][]>;
}

export interface ActiveHit {
  page: number;
  /** 그 쪽 안에서 몇 번째 일치인가 */
  k: number;
}

export class FindState {
  open = $state(false);
  query = $state('');
  matchCase = $state(false);
  /** 쪽별 일치(일치가 있는 쪽만) */
  byPage = $state.raw<Map<number, number[][][]>>(new Map());
  active = $state.raw<ActiveHit | null>(null);
  /** 아직 찾는 중인가 */
  busy = $state(false);
  /** 입력칸에 포커스를 달라는 신호 */
  focusSeq = $state(0);

  private seq = 0;
  private lastKey = '';

  /** 일치가 있는 쪽 번호(오름차순) */
  pages = $derived([...this.byPage.keys()].sort((a, b) => a - b));
  count = $derived.by(() => {
    let n = 0;
    for (const h of this.byPage.values()) n += h.length;
    return n;
  });
  /** 현재 항목이 전체에서 몇 번째인가(1부터, 없으면 0) */
  index = $derived.by(() => {
    const a = this.active;
    if (!a || !this.byPage.get(a.page)?.[a.k]) return 0;
    let n = 0;
    for (const p of this.pages) {
      if (p >= a.page) break;
      n += this.byPage.get(p)!.length;
    }
    return n + a.k + 1;
  });

  show() {
    this.open = true;
    this.focusSeq++;
  }

  /** 찾기를 닫고 결과를 지운다 */
  close() {
    this.seq++;
    this.open = false;
    this.busy = false;
    this.byPage = new Map();
    this.active = null;
    this.lastKey = '';
  }

  /**
   * 찾는다. 앞선 찾기는 버린다. 같은 문서에서 같은 말을 다시 찾는 경우(편집으로 내용이 바뀐 뒤)에는
   * 끝날 때까지 옛 표시와 현재 항목을 그대로 두었다가 한 번에 바꾼다(표시가 깜박이지 않는다).
   */
  async run(t: FindTarget) {
    const seq = ++this.seq;
    const q = this.query;
    const key = `${t.scope}\n${this.matchCase}\n${q}`;
    const keep = key === this.lastKey;
    this.lastKey = key;
    if (!q.trim() || !t.total) {
      this.byPage = new Map();
      this.active = null;
      this.busy = false;
      return;
    }
    this.busy = true;
    if (!keep) {
      this.byPage = new Map();
      this.active = null;
    }
    const next = new Map<number, number[][][]>();
    const start = Math.min(Math.max(0, t.start), t.total - 1);
    for (let n = 0; n < t.total; n++) {
      const page = (start + n) % t.total;
      let hits: number[][][] = [];
      try {
        hits = await t.search(page);
      } catch {
        // 그 사이 문서가 바뀌었다: 바뀐 뒤의 상태로 다시 찾게 되므로 이 쪽은 넘어간다
      }
      if (seq !== this.seq) return;
      if (!hits.length) continue;
      next.set(page, hits);
      if (!keep) {
        this.byPage = new Map(next);
        // 처음 나온 결과(보던 쪽에서 가장 가까운 뒤쪽)를 현재 항목으로
        if (!this.active) this.active = { page, k: 0 };
      }
    }
    if (seq !== this.seq) return;
    if (keep) {
      this.byPage = next;
      const a = this.active;
      if (!a || !next.get(a.page)?.[a.k]) this.active = this.nearest(a?.page ?? start);
    }
    this.busy = false;
  }

  /** from 쪽이나 그 뒤의 첫 일치(없으면 맨 처음 일치) */
  private nearest(from: number): ActiveHit | null {
    const pages = [...this.byPage.keys()].sort((a, b) => a - b);
    if (!pages.length) return null;
    return { page: pages.find((p) => p >= from) ?? pages[0], k: 0 };
  }

  /** 다음(1)·이전(-1) 일치로. 끝에서는 처음으로 돌아간다 */
  step(dir: 1 | -1) {
    const pages = this.pages;
    if (!pages.length) return;
    const a = this.active;
    if (!a || !this.byPage.get(a.page)) {
      const p = dir > 0 ? pages[0] : pages[pages.length - 1];
      this.active = { page: p, k: dir > 0 ? 0 : this.byPage.get(p)!.length - 1 };
      return;
    }
    const here = this.byPage.get(a.page)!;
    const k = a.k + dir;
    if (k >= 0 && k < here.length) {
      this.active = { page: a.page, k };
      return;
    }
    const pi = pages.indexOf(a.page);
    const p = pages[(pi + dir + pages.length) % pages.length];
    this.active = { page: p, k: dir > 0 ? 0 : this.byPage.get(p)!.length - 1 };
  }
}
