// 자동(iframe) 인쇄의 취소 시험: 불러온 뒤와 print() 직전에 취소 확인을 하고, 취소면 iframe·URL 을 거두고 PrintCancelled 로 끝난다.
// DOM 은 시험용 최소 대역으로 대신한다. 실행: cd app && node --test test/print-cancel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// print-run.ts 는 './print' 처럼 확장자 없는 상대 경로를 쓴다(번들러 기준). node 가 .ts 로 찾도록 해석 훅을 건다
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(spec, ctx, next) {
        try { return await next(spec, ctx); }
        catch (e) { if (e && e.code === 'ERR_MODULE_NOT_FOUND' && spec.startsWith('.')) return next(spec + '.ts', ctx); throw e; }
      }`,
    ),
);

/** 최소 DOM 대역. loadAfter(ms): iframe 을 붙이면 그 시간 뒤에 load 를 낸다(null 이면 내지 않는다) */
function stubDom({ loadAfter = 5 } = {}) {
  const st = { prints: 0, removed: 0, revoked: [], frames: [] };
  const origRevoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (u) => {
    st.revoked.push(u);
    origRevoke(u);
  };
  globalThis.location = { protocol: 'http:', origin: 'http://localhost' };
  globalThis.window = {
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
    setInterval: (...a) => setInterval(...a),
    clearInterval: (...a) => clearInterval(...a),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = {
    createElement() {
      const l = {};
      const f = {
        style: {},
        dataset: {},
        tabIndex: 0,
        setAttribute() {},
        addEventListener(t, fn) {
          (l[t] ??= []).push(fn);
        },
        remove() {
          st.removed++;
        },
        contentWindow: {
          focus() {},
          print() {
            st.prints++;
          },
          addEventListener() {},
          removeEventListener() {},
        },
        _fire: (t) => (l[t] ?? []).forEach((fn) => fn()),
      };
      st.frames.push(f);
      return f;
    },
    body: {
      appendChild(el) {
        if (loadAfter != null) setTimeout(() => el._fire('load'), loadAfter);
      },
    },
  };
  st.restore = () => {
    URL.revokeObjectURL = origRevoke;
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.location;
  };
  return st;
}

const { printViaIframe, PrintCancelled, cleanupPrint } = await import('../src/lib/print-run.ts');
const bytes = new Uint8Array([37, 80, 68, 70]);

test('취소 확인을 넘기지 않으면 기존대로 print() 까지 간다', async () => {
  const st = stubDom();
  try {
    await printViaIframe(bytes);
    assert.equal(st.prints, 1);
    assert.equal(st.removed, 0); // 인쇄 창이 뜬 뒤 정리는 afterprint 몫이다
  } finally {
    cleanupPrint();
    st.restore();
  }
});

test('불러오기 전에 이미 취소가 서 있으면 print() 없이 iframe·URL 을 거두고 PrintCancelled', async () => {
  const st = stubDom();
  try {
    await assert.rejects(printViaIframe(bytes, { value: true }), PrintCancelled);
    assert.equal(st.prints, 0);
    assert.equal(st.removed >= 1, true);
    assert.equal(st.revoked.length >= 1, true);
  } finally {
    st.restore();
  }
});

test('불러오는 중(시간 초과를 기다리지 않고) 취소하면 바로 PrintCancelled', async () => {
  const st = stubDom({ loadAfter: null }); // load 가 오지 않는다
  const cancel = { value: false };
  try {
    const t0 = Date.now();
    const p = printViaIframe(bytes, cancel);
    setTimeout(() => (cancel.value = true), 50);
    await assert.rejects(p, PrintCancelled);
    assert.ok(Date.now() - t0 < 2000, '취소가 시간 초과(8초)까지 기다리지 않는다');
    assert.equal(st.prints, 0);
    assert.equal(st.removed >= 1, true);
  } finally {
    st.restore();
  }
});

test('불러온 뒤 뷰어를 기다리는 사이에 취소하면 print() 를 부르지 않는다', async () => {
  const st = stubDom();
  const cancel = { value: false };
  try {
    const p = printViaIframe(bytes, cancel);
    setTimeout(() => (cancel.value = true), 150); // load(5ms) 뒤, 대기(400ms) 안
    await assert.rejects(p, PrintCancelled);
    assert.equal(st.prints, 0);
    assert.equal(st.removed >= 1, true);
    assert.equal(st.revoked.length >= 1, true);
  } finally {
    st.restore();
  }
});
