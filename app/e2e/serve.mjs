// 테스트 전용 정적 서버: dist-static 을 빈 포트(0)로 서빙하고 주소를 stdout 한 줄로 알린다.
// playwright.config.ts 의 webServer.wait.stdout 이 이 줄에서 포트를 읽어 E2E_PORT 환경 변수로 넘긴다.
import http from 'node:http';
import { createReadStream, cpSync, rmSync, statSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist-static');
if (!existsSync(join(src, 'index.html'))) {
  console.error(`dist-static/index.html 이 없습니다. 먼저 npm run build:static 을 실행하세요: ${src}`);
  process.exit(1);
}
// 다른 작업이 npm run build 로 dist-static 을 지우고 다시 만들어도 이번 실행에 영향이 없도록 사본을 서빙한다.
// 복사 도중 빌드와 겹쳐 불완전하면(engines 의 WASM 이 없거나 크기가 0) 잠시 뒤 다시 복사한다.
const complete = (dir) => {
  try {
    return existsSync(join(dir, 'index.html')) && readdirSync(join(dir, 'engines')).filter((f) => f.endsWith('.wasm')).length >= 2 && readdirSync(join(dir, 'engines')).every((f) => statSync(join(dir, 'engines', f)).size > 0);
  } catch {
    return false;
  }
};
// 이전 실행이 강제 종료되어 남긴 사본(10분 넘은 것)을 치운다
for (const d of readdirSync(tmpdir())) {
  if (!d.startsWith('pdfedit-e2e-static-')) continue;
  try {
    if (Date.now() - statSync(join(tmpdir(), d)).mtimeMs > 10 * 60_000) rmSync(join(tmpdir(), d), { recursive: true, force: true });
  } catch {}
}
const root = mkdtempSync(join(tmpdir(), 'pdfedit-e2e-static-'));
for (let attempt = 0; ; attempt++) {
  cpSync(src, root, { recursive: true, force: true });
  if (complete(root)) break;
  if (attempt >= 10) {
    console.error('dist-static 사본이 완전하지 않습니다(빌드 중일 수 있음)');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
const cleanup = () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanup);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = normalize(join(root, path === '/' ? 'index.html' : path));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`e2e-static listening http://127.0.0.1:${port}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
