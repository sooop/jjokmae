import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, defineConfig, type Plugin, type PluginOption } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';

type Target = 'dev' | 'static' | 'single';

const root = dirname(fileURLToPath(import.meta.url));
const pkgDir = (name: string) => join(root, 'node_modules', name);

/** 별도 바이너리 방침: static 은 engines/ 로 복사, dev 는 같은 경로로 서빙. single 에는 없다. */
const ENGINE_FILES: Record<string, () => string> = {
  'mupdf-wasm.wasm': () => join(pkgDir('mupdf'), 'dist', 'mupdf-wasm.wasm'),
  'pdfium.wasm': () => join(pkgDir('@embedpdf/pdfium'), 'dist', 'pdfium.wasm'),
};

function engineBinaries(target: Target): Plugin {
  return {
    name: 'engine-binaries',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/engines\/([^/?#]+)/.exec(req.url ?? '');
        // 'constructor'·'__proto__' 같은 상속 키가 함수로 잡히지 않도록 자기 속성만 본다
        const src = m && Object.hasOwn(ENGINE_FILES, m[1]) ? ENGINE_FILES[m[1]] : null;
        if (!src) return next();
        res.setHeader('Content-Type', 'application/wasm');
        res.end(readFileSync(src()));
      });
    },
    generateBundle() {
      if (target !== 'static') return;
      for (const [name, src] of Object.entries(ENGINE_FILES)) {
        this.emitFile({ type: 'asset', fileName: `engines/${name}`, source: readFileSync(src()) });
      }
    },
  };
}

/**
 * mupdf-wasm.js / pdfium(index.browser.js) 는 new URL("*.wasm", import.meta.url) 를 쓰므로 번들러가 WASM 을
 * 에셋으로 인라인/복사해 버린다. WASM 은 별도 바이너리로 주입(wasmBinary)하므로 상수 문자열로 치환한다.
 */
function mupdfNoWasmAsset(): Plugin {
  const rules: { file: RegExp; re: RegExp; to: string }[] = [
    {
      file: /mupdf[\/\\]dist[\/\\]mupdf-wasm\.js/,
      re: /new URL\("mupdf-wasm\.wasm",import\.meta\.url\)\.href/g,
      to: '"mupdf-wasm.wasm"',
    },
    {
      file: /@embedpdf[\/\\]pdfium[\/\\]dist[\/\\]index\.browser\.js/,
      re: /new URL\('pdfium\.wasm', import\.meta\.url\)\.href/g,
      to: "'pdfium.wasm'",
    },
  ];
  return {
    name: 'mupdf-no-wasm-asset',
    enforce: 'pre',
    transform(code, id) {
      for (const r of rules) {
        if (!r.file.test(id)) continue;
        const out = code.replace(r.re, r.to);
        if (out === code) {
          // 라이브러리 업데이트로 패턴이 바뀌면 WASM 이 조용히 에셋으로 인라인/복사된다 → 빌드를 실패시켜 알린다
          this.error(`mupdf-no-wasm-asset: ${id} 에서 WASM URL 패턴(${r.re.source})을 찾지 못했다. 라이브러리 버전이 바뀌어 치환 규칙을 갱신해야 한다.`);
        }
        return { code: out, map: null };
      }
      return null;
    },
  };
}

/**
 * single 전용: 엔진 워커를 ES 모듈(최상위 await 허용)로 따로 빌드해 텍스트로 넘긴다.
 * 런타임에서 클래식 Blob 워커가 import(blobUrl) 로 로드한다(worker-client.ts).
 */
function engineWorkerCode(target: Target): Plugin {
  const ID = 'virtual:engine-worker-code';
  return {
    name: 'engine-worker-code',
    resolveId: (id) => (id === ID ? '\0' + ID : null),
    async load(id) {
      if (id !== '\0' + ID) return null;
      if (target !== 'single') return 'export default "";';
      const entry = join(root, 'src/engine/worker.ts');
      this.addWatchFile(entry);
      const out = await build({
        root,
        configFile: false,
        logLevel: 'warn',
        plugins: [mupdfNoWasmAsset()],
        define: { __TARGET__: JSON.stringify(target) },
        build: {
          write: false,
          minify: true,
          lib: { entry, formats: ['es'], fileName: 'engine-worker' },
          rollupOptions: { output: { inlineDynamicImports: true } },
        },
      });
      const outputs = Array.isArray(out) ? out.flatMap((o) => ('output' in o ? o.output : [])) : 'output' in out ? out.output : [];
      const chunk = outputs.find((o) => o.type === 'chunk');
      if (!chunk || chunk.type !== 'chunk') throw new Error('엔진 워커 번들 생성 실패');
      return `export default ${JSON.stringify(chunk.code)};`;
    },
  };
}

/** single 전용: vite-plugin-singlefile 이 <link rel="icon"> 은 인라인하지 않으므로 favicon 을 data URI 로 바꿔 넣는다. */
function inlineFavicon(): Plugin {
  return {
    name: 'inline-favicon',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(/(<link rel="(?:icon|apple-touch-icon)"[^>]*?href=")(\/src\/assets\/[^"]+\.png)(")/g, (_m, a, path: string, c) => {
          const b64 = readFileSync(join(root, path)).toString('base64');
          return `${a}data:image/png;base64,${b64}${c}`;
        });
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const target: Target = mode === 'static' || mode === 'single' ? mode : 'dev';
  const plugins: PluginOption[] = [svelte(), mupdfNoWasmAsset(), engineWorkerCode(target), engineBinaries(target)];
  if (target === 'single') plugins.push(inlineFavicon(), viteSingleFile());

  return {
    base: target === 'dev' ? '/' : './',
    plugins,
    resolve: {
      alias: {
        'engine-spawn-impl': join(
          root,
          target === 'single' ? 'src/engine/worker-spawn-inline.ts' : 'src/engine/worker-spawn-module.ts',
        )
          .split('\\')
          .join('/'),
      },
    },
    define: { __TARGET__: JSON.stringify(target) },
    // 엔진 라이브러리는 워커에서만 import 되어 시작 스캔에 잡히지 않는다. 미리 넣어 두지 않으면 dev 에서 엔진을 처음 띄울 때
    // "새 의존성 발견 → 페이지 전체 새로고침"이 일어나 열던 문서가 사라진다.
    optimizeDeps: { include: ['mupdf', '@embedpdf/pdfium'] },
    // mupdf.js 에 최상위 await 가 있어 iife 불가 → es. single 은 위 플러그인이 별도로 처리한다.
    worker: { format: 'es' as const, plugins: () => [mupdfNoWasmAsset()] },
    build: {
      outDir: target === 'single' ? 'dist-single' : 'dist-static',
      emptyOutDir: true,
      // single: 모든 에셋을 인라인. static: WASM 등 큰 파일은 별도 파일로 둔다.
      assetsInlineLimit: target === 'single' ? 100_000_000 : 4096,
      cssCodeSplit: target !== 'single',
    },
  };
});
