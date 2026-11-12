// 사용하는 바이너리 레지스트리. 해시·크기는 npm 패키지 파일에서 계산했고 CDN 바이트와 일치함을 확인했다.
// static 타깃은 빌드가 `engines/<파일명>` 위치에 파일을 복사해야 한다.
import type { BinaryRef } from './binary-source';

const JSDELIVR = 'https://cdn.jsdelivr.net/npm';

export const MUPDF_WASM: BinaryRef = {
  id: 'mupdf-wasm.wasm',
  path: 'engines/mupdf-wasm.wasm',
  cdnUrl: `${JSDELIVR}/mupdf@1.28.6/dist/mupdf-wasm.wasm`,
  sha256: '931bc5fd7bda904582289e4f1428d0c89d95a90d2bba0be99a773cdbb446e027',
  size: 10416688,
  reason: '편집 엔진(MuPDF) 실행 파일입니다. 처음 한 번만 내려받고 이 브라우저에 저장합니다.',
};

export const PDFIUM_WASM: BinaryRef = {
  id: 'pdfium.wasm',
  path: 'engines/pdfium.wasm',
  cdnUrl: `${JSDELIVR}/@embedpdf/pdfium@2.15.1/dist/pdfium.wasm`,
  sha256: '5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa',
  size: 4646932,
  reason: '화면 표시 엔진(PDFium) 실행 파일입니다. 처음 한 번만 내려받고 이 브라우저에 저장합니다.',
};

// TODO(한글 폰트): 후보 URL 만 기록. 실제 파일을 확정·내려받아 해시를 계산하기 전에는 레지스트리에 넣지 않는다.
//   예: https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-kr@<버전>/files/noto-sans-kr-korean-400-normal.woff2
//   (woff2 를 엔진이 그대로 쓸 수 있는지도 확인 필요)

export const ALL_BINARIES: readonly BinaryRef[] = [MUPDF_WASM, PDFIUM_WASM];
