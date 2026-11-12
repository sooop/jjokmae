// 엔진 워커 클라이언트. EngineAdapter 와 같은 시그니처의 프록시를 돌려준다.
// 워커 생성은 타깃별로 vite 별칭(engine-spawn-impl)이 고른다(vite.config.ts 참고). 본체는 worker-client-core.ts.
import { spawnEngineWorker } from 'engine-spawn-impl';
import { ADAPTER_METHODS } from './protocol';
import { createEngineClientOn, type EngineClient, type EngineClientOptions } from './worker-client-core';

export type { EngineClient, EngineClientOptions };

export function createEngineWorker(): Worker {
  return spawnEngineWorker();
}

/** 워커를 띄우고 엔진을 초기화한 뒤 프록시를 돌려준다. 실패하면 워커를 정리하고 reject 한다 */
export function createEngineClient(opts: EngineClientOptions): Promise<EngineClient> {
  return createEngineClientOn(createEngineWorker(), opts, ADAPTER_METHODS);
}
