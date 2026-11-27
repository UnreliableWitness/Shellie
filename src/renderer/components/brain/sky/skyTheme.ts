import { currentColorScheme } from '../../../colorScheme';

/** What the scene needs to know of the app's theme: the page's background, and whether it is a light one. */
export type SkyTheme = { light: boolean; background: number };

export const DARK_SKY: SkyTheme = { light: false, background: 0x201f1e };
const LIGHT_SKY: SkyTheme = { light: true, background: 0xfaf9f8 };

/** The theme as the app shows it now: the scheme, and `--sky` as the styles give it to `el` (a `#rrggbb`). */
export function skyTheme(el: Element | null): SkyTheme {
  const base = currentColorScheme() === 'light' ? LIGHT_SKY : DARK_SKY;
  const written = el
    ? getComputedStyle(el).getPropertyValue('--sky').trim()
    : '';
  const hex = /^#([0-9a-f]{6})$/i.exec(written);
  return hex ? { ...base, background: Number.parseInt(hex[1], 16) } : base;
}
