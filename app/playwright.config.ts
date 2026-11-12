import { defineConfig } from '@playwright/test';

// 빌드 결과물(dist-static, dist-single)을 대상으로 하는 e2e. 개발 서버는 쓰지 않는다.
//   npm run build && npm run e2e
// 브라우저는 시스템 Chrome 을 쓴다(브라우저 다운로드 없음). E2E_CHANNEL=msedge 로 바꿀 수 있다.
const channel = process.env.E2E_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  outputDir: './e2e-results/artifacts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? 3),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: './e2e-results/report', open: 'never' }]],
  use: {
    channel,
    headless: true,
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  // static 프로젝트용: 빈 포트에 뜬 서버 주소에서 포트를 읽어 E2E_PORT 로 넘긴다.
  webServer: {
    command: 'node e2e/serve.mjs',
    wait: { stdout: /e2e-static listening http:\/\/127\.0\.0\.1:(?<E2E_PORT>\d+)/ },
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: 'static', metadata: { build: 'static' } },
    { name: 'single', metadata: { build: 'single' } },
  ],
});
