import { clampZoom } from './settings';

export const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** 현재 값에서 한 단계 위/아래 프리셋. 범위를 넘지 않는다 */
export function stepZoom(current: number, dir: 1 | -1): number {
  if (dir > 0) return clampZoom(ZOOM_PRESETS.find((z) => z > current + 0.001) ?? current);
  return clampZoom([...ZOOM_PRESETS].reverse().find((z) => z < current - 0.001) ?? current);
}
