// 큰 바이너리(WASM·폰트) 공급. 빌드 상수 __TARGET__ 으로 구현을 고른다.
// - static: 같은 출처 fetch (+ IndexedDB 캐시)
// - single: 버전 고정 CDN fetch → SHA-256 대조 → 일치할 때만 IndexedDB 저장

export interface BinaryRef {
  /** 논리 이름. 예: 'pdfium.wasm', 'NotoSansKR-subset.otf' */
  id: string;
  /** 같은 출처 상대 경로(static) */
  path: string;
  /** 버전 고정 CDN URL(single) */
  cdnUrl: string;
  /** 기대 SHA-256(hex, 소문자). 일치할 때만 저장한다 */
  sha256: string;
  /** 사용자에게 보여 줄 대략적 크기(bytes) */
  size: number;
  /** 내려받기 전 안내할 이유(한국어 한 줄) */
  reason: string;
}

export interface BinaryProgress {
  id: string;
  loaded: number;
  total: number;
}

export interface BinaryGetOptions {
  onProgress?: (p: BinaryProgress) => void;
  /** 네트워크 내려받기 직전(캐시에 없을 때만, single)에 호출. false 면 중단한다 */
  confirmDownload?: (ref: BinaryRef) => boolean | Promise<boolean>;
}

export interface BinarySource {
  /** IndexedDB 에 해시 일치 저장본이 있어 네트워크가 필요 없는가 */
  has(ref: BinaryRef): Promise<boolean>;
  /** 바이트를 반환. 해시 불일치·검증 불가 시 reject(저장하지 않음) */
  get(ref: BinaryRef, options?: BinaryGetOptions): Promise<ArrayBuffer>;
}

export type BinaryErrorCode = 'declined' | 'http' | 'hash-mismatch' | 'no-subtle' | 'network';

export class BinaryError extends Error {
  readonly code: BinaryErrorCode;
  constructor(code: BinaryErrorCode, message: string) {
    super(message);
    this.name = 'BinaryError';
    this.code = code;
  }
}

export interface BinaryStore {
  get(key: string): Promise<ArrayBuffer | null>;
  /** 저장 성공 여부 */
  put(key: string, value: ArrayBuffer): Promise<boolean>;
  /** 오염된 항목 제거(선택). 없으면 무시된 채 네트워크 경로로 내려간다 */
  delete?(key: string): Promise<void>;
}

/** 테스트·확장을 위한 주입 지점. 생략하면 브라우저 전역을 쓴다. */
export interface BinarySourceDeps {
  target?: 'dev' | 'static' | 'single';
  store?: BinaryStore;
  fetch?: typeof fetch;
  /** crypto.subtle 대체. null 이면 '없음'을 강제한다 */
  subtle?: Pick<SubtleCrypto, 'digest'> | null;
  /** static 상대 경로 해석 기준 */
  baseUrl?: string;
}

// 키에 해시를 포함하므로 레지스트리 해시가 바뀌면 이전 저장본은 자동으로 무시된다.
const cacheKey = (ref: BinaryRef) => `${ref.id}@${ref.sha256}`;

async function defaultStore(): Promise<BinaryStore> {
  // 동적 import: 테스트(Node)는 저장소를 주입하므로 idb 를 로드하지 않는다.
  const { idbGet, idbPut, idbDelete } = await import('../lib/idb');
  return { get: idbGet, put: idbPut, delete: idbDelete };
}

function toHex(buf: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, '0');
  return s;
}

async function readWithProgress(
  res: Response,
  ref: BinaryRef,
  onProgress?: (p: BinaryProgress) => void,
): Promise<ArrayBuffer> {
  const headerLen = Number(res.headers.get('content-length'));
  const total = headerLen > 0 ? headerLen : ref.size;
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress?.({ id: ref.id, loaded: buf.byteLength, total: buf.byteLength });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ id: ref.id, loaded, total: Math.max(total, loaded) });
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

export function createBinarySource(deps: BinarySourceDeps = {}): BinarySource {
  const target = deps.target ?? __TARGET__;
  const isSingle = target === 'single';
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const subtle = deps.subtle !== undefined ? deps.subtle : (globalThis.crypto?.subtle ?? null);
  let storePromise: Promise<BinaryStore> | null = null;
  const getStore = () => (storePromise ??= deps.store ? Promise.resolve(deps.store) : defaultStore());

  // 캐시 히트도 SHA-256 으로 다시 대조한다(IndexedDB 는 오염·잘림 가능). 불일치·빈 값이면 키를 지운다.
  // subtle 이 없으면 검증할 수 없으므로 single(CDN 경로)은 캐시를 거부하고, static 은 그대로 쓴다.
  const readCache = async (ref: BinaryRef): Promise<ArrayBuffer | null> => {
    let store: BinaryStore;
    let cached: ArrayBuffer | null;
    try {
      store = await getStore();
      cached = await store.get(cacheKey(ref));
    } catch {
      return null;
    }
    if (cached === null || cached === undefined) return null;
    let ok = false;
    if (cached.byteLength > 0) {
      if (subtle) {
        try {
          ok = toHex(await subtle.digest('SHA-256', cached)) === ref.sha256.toLowerCase();
        } catch {
          ok = false;
        }
      } else {
        return isSingle ? null : cached;
      }
    }
    if (ok) return cached;
    try {
      await store.delete?.(cacheKey(ref));
    } catch {
      /* 삭제 실패는 무시 */
    }
    return null;
  };

  return {
    async has(ref) {
      return (await readCache(ref)) !== null;
    },

    async get(ref, options = {}) {
      const cached = await readCache(ref);
      if (cached) {
        options.onProgress?.({ id: ref.id, loaded: cached.byteLength, total: cached.byteLength });
        return cached;
      }

      let url: string;
      if (isSingle) {
        if (options.confirmDownload && !(await options.confirmDownload(ref))) {
          throw new BinaryError('declined', `${ref.id} 내려받기를 취소했습니다.`);
        }
        url = ref.cdnUrl;
      } else {
        const base = deps.baseUrl ?? (globalThis as { location?: Location }).location?.href;
        url = new URL(ref.path, base).href;
      }

      let bytes: ArrayBuffer;
      try {
        const res = await doFetch(url);
        if (!res.ok) throw new BinaryError('http', `${ref.id} 내려받기 실패: HTTP ${res.status} (${url})`);
        bytes = await readWithProgress(res, ref, options.onProgress);
      } catch (e) {
        if (e instanceof BinaryError) throw e;
        throw new BinaryError('network', `${ref.id} 내려받기 실패: 네트워크 오류 (${url})`);
      }

      if (!subtle) {
        if (isSingle) {
          throw new BinaryError(
            'no-subtle',
            `${ref.id} 무결성(SHA-256)을 확인할 수 없어 사용하지 않습니다. 보안 컨텍스트(https 등)가 필요합니다.`,
          );
        }
        // static: 같은 출처 파일이므로 검증 없이 쓰되 저장하지 않는다.
        return bytes;
      }

      const actual = toHex(await subtle.digest('SHA-256', bytes));
      if (actual !== ref.sha256.toLowerCase()) {
        throw new BinaryError(
          'hash-mismatch',
          `${ref.id} 해시가 일치하지 않아 저장하지 않았습니다. (기대 ${ref.sha256.slice(0, 12)}…, 실제 ${actual.slice(0, 12)}…)`,
        );
      }

      try {
        await (await getStore()).put(cacheKey(ref), bytes);
      } catch {
        /* 저장 실패는 치명적이지 않다 */
      }
      return bytes;
    },
  };
}
