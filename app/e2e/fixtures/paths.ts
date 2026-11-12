// 시험용 PDF 경로. 샘플은 저장소의 harness 폴더를 그대로 쓰고, 합성 PDF 는 globalSetup 이 e2e/.generated 에 만든다.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(here, '..', '..');
export const HARNESS = resolve(APP_ROOT, '..', 'harness');
export const GEN = join(APP_ROOT, 'e2e', '.generated');

export const SAMPLES = {
  koEmbedded: join(HARNESS, 'samples', 'ko_embedded.pdf'),
  koNonEmbedded: join(HARNESS, 'samples', 'ko_nonembedded.pdf'),
  scan: join(HARNESS, 'samples', 'scan.pdf'),
  signed: join(HARNESS, 'out2', 'fixtures', 'signed.pdf'),
  formKo: join(HARNESS, 'out2', 'fixtures', 'form.pdf'),
};

export const GENERATED = {
  five: join(GEN, 'five.pdf'),
  docA: join(GEN, 'docA.pdf'),
  docB: join(GEN, 'docB.pdf'),
  docC: join(GEN, 'docC.pdf'),
  p24: join(GEN, 'docP.pdf'),
  big300: join(GEN, 'big300.pdf'),
  formAll: join(GEN, 'form-all.pdf'),
  stampPng: join(GEN, 'stamp.png'),
  koRot90: join(GEN, 'ko-rot90.pdf'),
  koRot270: join(GEN, 'ko-rot270.pdf'),
  broken: join(GEN, 'broken.pdf'),
  note: join(GEN, 'note.txt'),
  fakePng: join(GEN, 'fake.png'),
};
