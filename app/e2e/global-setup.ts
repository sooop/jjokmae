import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFormPdf, FIVE, makeBig, makePdf, makePng, makeTagged, withRotate } from './fixtures/synth.ts';
import { APP_ROOT, GEN, GENERATED as G, SAMPLES } from './fixtures/paths.ts';

/** 합성 시험 PDF 를 만든다(매 실행마다 새로 만들므로 저장소에는 두지 않는다) */
export default function globalSetup() {
  mkdirSync(GEN, { recursive: true });
  // dist-single 은 한 파일이라 사본을 만들어 쓴다. 다른 작업이 npm run build 를 돌려도 이번 실행에는 영향이 없다.
  const single = join(APP_ROOT, 'dist-single', 'index.html');
  if (!existsSync(single) || statSync(single).size < 100_000) throw new Error('dist-single/index.html 이 없습니다. 먼저 npm run build 를 실행하세요.');
  const snap = join(GEN, 'single-index.html');
  copyFileSync(single, snap);
  process.env.E2E_SINGLE_HTML = snap;
  const w = (path: string, data: Uint8Array | string) => writeFileSync(path, data);
  w(G.five, makePdf(FIVE));
  w(G.docA, makePdf(FIVE.map((s) => ({ ...s, rotate: 0, text: s.text.replace('PAGE', 'A') }))));
  w(G.docB, makeTagged('B', 4, 20));
  w(G.docC, makeTagged('C', 3, 40));
  w(G.p24, makeTagged('P', 24, 0));
  const ko = new Uint8Array(readFileSync(SAMPLES.koEmbedded));
  w(G.koRot90, withRotate(ko, 90));
  w(G.koRot270, withRotate(ko, 270));
  w(G.big300, makeBig([SAMPLES.koEmbedded, SAMPLES.koNonEmbedded, SAMPLES.scan].map((p) => new Uint8Array(readFileSync(p))), 300));
  w(G.formAll, buildFormPdf());
  w(G.stampPng, makePng(120, 60));
  w(G.broken, 'not a pdf at all');
  w(G.note, 'hello');
  w(G.fakePng, 'not an image');
}
