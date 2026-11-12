// single(file://): 모듈 워커를 Blob/data URL 로 만들면 Chrome 에서 'worker error' 가 난다.
// 그래서 엔진 워커의 ES 모듈 번들(최상위 await 포함) 텍스트를 클래식 Blob 워커의 소스에 실어 보내고,
// 워커 안에서 Blob URL 을 만들어 import() 한다. (페이지에서 만든 blob:null URL 은 워커에서
// 'Failed to fetch dynamically imported module' 로 실패하므로 URL 은 반드시 워커 안에서 만든다.)
// 모듈 로드 전에 도착한 메시지는 loader 가 큐잉했다가 넘긴다.
import engineWorkerCode from 'virtual:engine-worker-code';

export function spawnEngineWorker(): Worker {
  const loader = [
    'const q=[];',
    'self.onmessage=(e)=>q.push(e);',
    `const u=URL.createObjectURL(new Blob([${JSON.stringify(engineWorkerCode)}],{type:'text/javascript'}));`,
    'import(u)',
    '.then(()=>{const h=self.onmessage;for(const e of q)h&&h(e);})',
    '.catch((e)=>{setTimeout(()=>{throw e;});});',
  ].join('');
  return new Worker(URL.createObjectURL(new Blob([loader], { type: 'text/javascript' })));
}
