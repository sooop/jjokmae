// 확대 슬라이더 눈금(로그). 주의: erasable 문법만 쓴다(시험에서 직접 import).
const ZOOM_LO = 0.25;
const ZOOM_HI = 4;

/** 슬라이더 눈금(0..1000)과 배율의 로그 대응: 25% → 0, 100% → 500, 400% → 1000 */
export const ZOOM_SLIDER_MAX = 1000;
export const zoomToSlider = (z: number): number => Math.round((Math.log(Math.max(ZOOM_LO, Math.min(ZOOM_HI, z)) / ZOOM_LO) / Math.log(ZOOM_HI / ZOOM_LO)) * ZOOM_SLIDER_MAX);
export const sliderToZoom = (v: number): number => {
  const z = ZOOM_LO * Math.pow(ZOOM_HI / ZOOM_LO, Math.max(0, Math.min(ZOOM_SLIDER_MAX, v)) / ZOOM_SLIDER_MAX);
  return Math.min(ZOOM_HI, Math.max(ZOOM_LO, Math.round(z * 100) / 100));
};
