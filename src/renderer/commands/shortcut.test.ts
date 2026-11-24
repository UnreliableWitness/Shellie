import { describe, expect, it } from 'vitest';
import { matches, shortcutLabel } from './shortcut';

const key = (over: Partial<KeyboardEvent>) => ({
  code: 'KeyP',
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  ...over,
});

describe('matches', () => {
  it('needs the platform mod key', () => {
    const s = { code: 'KeyP', shift: true };
    expect(matches(key({ ctrlKey: true, shiftKey: true }), s, false)).toBe(
      true,
    );
    expect(matches(key({ ctrlKey: true, shiftKey: true }), s, true)).toBe(
      false,
    );
    expect(matches(key({ metaKey: true, shiftKey: true }), s, true)).toBe(true);
    expect(matches(key({ shiftKey: true }), s, false)).toBe(false);
  });

  it('takes a letter as the layout types it, and the physical key where the layout has no Latin letter', () => {
    const w = { code: 'KeyW', shift: true };
    const held = { ctrlKey: true, shiftKey: true };
    // AZERTY: W is printed where QWERTY has Z, and that key's place types Z.
    expect(matches(key({ ...held, code: 'KeyZ', key: 'W' }), w, false)).toBe(
      true,
    );
    expect(matches(key({ ...held, code: 'KeyW', key: 'Z' }), w, false)).toBe(
      false,
    );
    expect(matches(key({ ...held, code: 'KeyW', key: 'w' }), w, false)).toBe(
      true,
    );
    // Cyrillic: the key types no Latin letter, so its place counts.
    expect(matches(key({ ...held, code: 'KeyW', key: 'ц' }), w, false)).toBe(
      true,
    );
  });

  it('needs Shift to be exactly as asked', () => {
    expect(
      matches(key({ ctrlKey: true }), { code: 'KeyP', shift: true }, false),
    ).toBe(false);
    expect(
      matches(key({ ctrlKey: true, shiftKey: true }), { code: 'KeyP' }, false),
    ).toBe(false);
  });

  it('never matches with Alt down', () => {
    expect(
      matches(key({ ctrlKey: true, altKey: true }), { code: 'KeyP' }, false),
    ).toBe(false);
  });

  it('takes the numpad digit for a digit', () => {
    expect(
      matches(
        key({ ctrlKey: true, code: 'Numpad3' }),
        { code: 'Digit3' },
        false,
      ),
    ).toBe(true);
    expect(
      matches(
        key({ ctrlKey: true, code: 'Numpad4' }),
        { code: 'Digit3' },
        false,
      ),
    ).toBe(false);
  });
});

describe('shortcutLabel', () => {
  it('names the keys', () => {
    expect(shortcutLabel({ code: 'KeyP', shift: true }, 'Ctrl')).toBe(
      'Ctrl+Shift+P',
    );
    expect(shortcutLabel({ code: 'Digit0' }, 'Cmd')).toBe('Cmd+0');
  });
});
