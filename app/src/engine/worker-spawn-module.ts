// dev/static: http(s) 출처의 모듈 워커. 번들러가 worker.ts 를 별도 ES 파일로 낸다.
export function spawnEngineWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}
