import type { Settings } from './settings';

/** 'system' 이면 data-theme 을 지워 prefers-color-scheme 을 따른다 */
export function applyTheme(theme: Settings['theme']): void {
  const el = document.documentElement;
  if (theme === 'system') delete el.dataset.theme;
  else el.dataset.theme = theme;
}
