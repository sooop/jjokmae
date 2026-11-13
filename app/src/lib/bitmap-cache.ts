// 쪽 비트맵 캐시(문서 공통, LRU). 열쇠는 쪽 번호가 아니라 "쪽 내용 id(cid)" 다: 순서 바꾸기·삭제·복제처럼 쪽 그림이
// 그대로인 조작 뒤에는 화면이 다시 만들어져도 엔진에 다시 그리게 하지 않고 캐시에서 바로 그린다. 내용이 바뀌는
// 조작(주석·양식·회전)은 그 쪽에 새 cid 를 준다(옛 항목은 쓰이지 않다가 밀려난다).
// 주의: erasable 문법만 쓴다(Node 타입 스트리핑으로 시험에서 직접 import). 모듈 최상위에서 DOM 을 건드리지 않는다.

/** 캐시에 담는 그림: 브라우저에서는 ImageBitmap. 시험에서는 같은 모양의 가짜를 넣는다 */
export interface CachedBitmap {
  readonly width: number;
  readonly height: number;
  close(): void;
}

interface Entry<B extends CachedBitmap> {
  cid: number;
  scale: number;
  bmp: B;
  px: number;
}

let seq = 0;
/** 새 쪽 내용 id */
export const newCid = (): number => ++seq;
export const freshCids = (n: number): number[] => Array.from({ length: n }, newCid);

export class BitmapCache<B extends CachedBitmap = ImageBitmap> {
  private lru = new Map<string, Entry<B>>();
  private byCid = new Map<number, Entry<B>[]>();
  private total = 0;
  private maxPx: number;
  private maxEntryPx: number;

  /**
   * maxPx: 전체 상한(픽셀. RGBA 로 약 4배 바이트). maxEntryPx: 이보다 큰 비트맵은 넣지 않는다(크게 확대한 쪽은 다시 그린다)
   */
  constructor(maxPx = 40_000_000, maxEntryPx = 6_000_000) {
    this.maxPx = maxPx;
    this.maxEntryPx = maxEntryPx;
  }

  private static key(cid: number, scale: number) {
    return `${cid}@${scale}`;
  }

  private evict(k: string, e: Entry<B>) {
    this.lru.delete(k);
    this.total -= e.px;
    const list = this.byCid.get(e.cid);
    if (list) {
      const i = list.indexOf(e);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.byCid.delete(e.cid);
    }
    try {
      e.bmp.close();
    } catch {
      // 이미 닫힘
    }
  }

  /** 같은 내용·같은 배율의 비트맵(있으면 최근 사용으로 올린다) */
  get(cid: number, scale: number): B | null {
    const k = BitmapCache.key(cid, scale);
    const e = this.lru.get(k);
    if (!e) return null;
    this.lru.delete(k);
    this.lru.set(k, e);
    return e.bmp;
  }

  /** 같은 내용의 다른 배율 비트맵 가운데 요청 배율에 가장 가까운 것(새로 그려질 때까지 임시로 보여 줄 용도) */
  nearest(cid: number, scale: number): B | null {
    const list = this.byCid.get(cid);
    if (!list || !list.length) return null;
    const dist = (e: Entry<B>) => Math.abs(Math.log(e.scale / scale));
    let best = list[0];
    for (const e of list) if (dist(e) < dist(best)) best = e;
    return best.bmp;
  }

  /** 캐시에 넣는다. true 면 캐시가 비트맵을 갖는다(호출자는 닫지 않는다). false 면 호출자가 닫는다 */
  put(cid: number, scale: number, bmp: B): boolean {
    const px = bmp.width * bmp.height;
    if (!px || px > this.maxEntryPx) return false;
    const k = BitmapCache.key(cid, scale);
    const old = this.lru.get(k);
    if (old) this.evict(k, old);
    const e: Entry<B> = { cid, scale, bmp, px };
    this.lru.set(k, e);
    const list = this.byCid.get(cid);
    if (list) list.push(e);
    else this.byCid.set(cid, [e]);
    this.total += px;
    for (const [k2, e2] of this.lru) {
      if (this.total <= this.maxPx) break;
      if (e2 !== e) this.evict(k2, e2);
    }
    return true;
  }

  stats() {
    return { entries: this.lru.size, px: this.total };
  }
}

/** 앱 전체가 쓰는 캐시 */
export const pageBitmaps = new BitmapCache();
(globalThis as { __pdfeditCache?: () => { entries: number; px: number } }).__pdfeditCache = () => pageBitmaps.stats();
