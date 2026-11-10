import { useSyncExternalStore } from 'react';
import type { ColorScheme } from '../shared/theme';

/** Main sets nativeTheme.themeSource from Settings, so this query is the one answer to "light or dark?". */
const QUERY = '(prefers-color-scheme: light)';

export function currentColorScheme(): ColorScheme {
  return window.matchMedia(QUERY).matches ? 'light' : 'dark';
}

/** For code outside React (terminals, Monaco); returns the unsubscribe. */
export function onColorSchemeChange(cb: (s: ColorScheme) => void): () => void {
  const q = window.matchMedia(QUERY);
  const h = () => cb(currentColorScheme());
  q.addEventListener('change', h);
  return () => q.removeEventListener('change', h);
}

export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(onColorSchemeChange, currentColorScheme);
}

/** The Monaco theme for a scheme (defined in review/monacoSetup.ts). */
export const monacoTheme = (s: ColorScheme) => `shellie-${s}`;
