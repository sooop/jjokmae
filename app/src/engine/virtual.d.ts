declare module 'virtual:engine-worker-code' {
  /** single 타깃: 엔진 워커의 ES 모듈 번들 텍스트. 그 밖의 타깃: 빈 문자열 */
  const code: string;
  export default code;
}

declare module 'engine-spawn-impl' {
  export function spawnEngineWorker(): Worker;
}
