import type { Shortcut } from './types';

type Key = Pick<
  KeyboardEvent,
  'code' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'
> & { key?: string };

/**
 * Whether a key press is this shortcut: the platform's mod key, Shift exactly as asked, no Alt. A letter is the
 * letter the layout types (on AZERTY, W and M are not where QWERTY has them); when the layout types no Latin
 * letter there (Cyrillic, Greek), and for digits, it is the physical key.
 */
export function matches(e: Key, s: Shortcut, mac: boolean): boolean {
  if (!(mac ? e.metaKey : e.ctrlKey) || e.altKey) return false;
  if (e.shiftKey !== !!s.shift) return false;
  if (s.code.startsWith('Key') && e.key && /^[a-z]$/i.test(e.key))
    return e.key.toUpperCase() === s.code.slice(3);
  return e.code === s.code || e.code === s.code.replace(/^Digit/, 'Numpad');
}

/** The shortcut as shown to the user: "Ctrl+Shift+P". */
export function shortcutLabel(s: Shortcut, mod: 'Cmd' | 'Ctrl'): string {
  const key = s.code.replace(/^(Key|Digit)/, '');
  return `${mod}+${s.shift ? 'Shift+' : ''}${key}`;
}
