import { describe, expect, it, vi } from 'vitest';
import {
  attachClipboardKeys,
  clipboardAction,
  type KeyLike,
} from './terminalClipboard';

const key = (
  k: string,
  mods: Partial<KeyLike> = {},
  type = 'keydown',
): KeyLike => ({
  type,
  key: k,
  code: `Key${k.toUpperCase()}`,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const ctrl = (k: string, more: Partial<KeyLike> = {}) =>
  key(k, { ctrlKey: true, ...more });
const cmd = (k: string, more: Partial<KeyLike> = {}) =>
  key(k, { metaKey: true, ...more });

describe('clipboardAction on Windows and Linux', () => {
  it('Ctrl+C copies a selection and is SIGINT without one', () => {
    expect(clipboardAction(ctrl('c'), false, true)).toBe('copy');
    expect(clipboardAction(ctrl('c'), false, false)).toBe('passthrough');
  });
  it('Ctrl+V always pastes', () => {
    expect(clipboardAction(ctrl('v'), false, false)).toBe('paste');
    expect(clipboardAction(ctrl('v'), false, true)).toBe('paste');
  });
  it('Ctrl+X cuts a selection and passes through without one', () => {
    expect(clipboardAction(ctrl('x'), false, true)).toBe('cut');
    expect(clipboardAction(ctrl('x'), false, false)).toBe('passthrough');
  });
  it('Ctrl+Shift+C copies (never SIGINT) and Ctrl+Shift+V pastes', () => {
    expect(clipboardAction(ctrl('C', { shiftKey: true }), false, true)).toBe(
      'copy',
    );
    expect(clipboardAction(ctrl('C', { shiftKey: true }), false, false)).toBe(
      'copy',
    );
    expect(clipboardAction(ctrl('V', { shiftKey: true }), false, false)).toBe(
      'paste',
    );
  });
  it('leaves Alt, Cmd/Win and other letters alone', () => {
    expect(clipboardAction(ctrl('c', { altKey: true }), false, true)).toBe(
      'passthrough',
    );
    expect(clipboardAction(cmd('c'), false, true)).toBe('passthrough');
    expect(clipboardAction(ctrl('d'), false, true)).toBe('passthrough');
    expect(clipboardAction(key('c'), false, true)).toBe('passthrough');
  });
  it('acts on keydown only', () => {
    expect(clipboardAction(ctrl('v', { type: 'keyup' }), false, false)).toBe(
      'passthrough',
    );
  });
  it('uses the physical key when the layout has no Latin letter (Cyrillic)', () => {
    expect(clipboardAction(ctrl('м', { code: 'KeyV' }), false, false)).toBe(
      'paste',
    );
  });
  it('follows the layout letter, not the position (AZERTY keeps C on KeyC)', () => {
    // On Dvorak the physical KeyI types "c".
    expect(clipboardAction(ctrl('c', { code: 'KeyI' }), false, true)).toBe(
      'copy',
    );
  });
});

describe('clipboardAction on macOS', () => {
  it('Cmd+C copies, Cmd+V pastes, Cmd+X cuts', () => {
    expect(clipboardAction(cmd('c'), true, true)).toBe('copy');
    expect(clipboardAction(cmd('v'), true, false)).toBe('paste');
    expect(clipboardAction(cmd('x'), true, true)).toBe('cut');
  });
  it('Cmd+C and Cmd+X without a selection do nothing rather than reach the shell', () => {
    expect(clipboardAction(cmd('c'), true, false)).toBe('copy');
    expect(clipboardAction(cmd('x'), true, false)).toBe('cut');
  });
  it('Ctrl+C stays SIGINT, even with a selection; Ctrl+V and Ctrl+X go to the program', () => {
    expect(clipboardAction(ctrl('c'), true, true)).toBe('passthrough');
    expect(clipboardAction(ctrl('v'), true, false)).toBe('passthrough');
    expect(clipboardAction(ctrl('x'), true, true)).toBe('passthrough');
  });
  it('leaves Cmd+Alt and Cmd+Ctrl alone', () => {
    expect(clipboardAction(cmd('c', { altKey: true }), true, true)).toBe(
      'passthrough',
    );
    expect(clipboardAction(cmd('v', { ctrlKey: true }), true, true)).toBe(
      'passthrough',
    );
  });
});

function fakeTerminal(selection: string) {
  let handler: ((e: KeyboardEvent) => boolean) | undefined;
  let sel = selection;
  const t = {
    attachCustomKeyEventHandler: (h: (e: KeyboardEvent) => boolean) => {
      handler = h;
    },
    hasSelection: () => sel !== '',
    getSelection: () => sel,
    clearSelection: vi.fn(() => {
      sel = '';
    }),
    paste: vi.fn(),
    input: vi.fn(),
  };
  const press = (k: KeyLike) => {
    const e = { ...k, preventDefault: vi.fn() };
    const result = handler!(e as unknown as KeyboardEvent);
    return { result, prevented: e.preventDefault.mock.calls.length > 0 };
  };
  return { t, press };
}

describe('attachClipboardKeys', () => {
  const clip = (text = 'clip') => ({
    readText: vi.fn(async () => text),
    writeText: vi.fn(async () => undefined),
  });

  it('copies the selection, clears it and keeps the key from xterm and the page', async () => {
    const { t, press } = fakeTerminal('hello');
    const c = clip();
    attachClipboardKeys(t, false, c);
    expect(press(ctrl('c'))).toEqual({ result: false, prevented: true });
    expect(c.writeText).toHaveBeenCalledWith('hello');
    expect(t.clearSelection).toHaveBeenCalled();
  });

  it('lets Ctrl+C reach the shell when nothing is selected', () => {
    const { t, press } = fakeTerminal('');
    const c = clip();
    attachClipboardKeys(t, false, c);
    expect(press(ctrl('c'))).toEqual({ result: true, prevented: false });
    expect(c.writeText).not.toHaveBeenCalled();
  });

  it('pastes the clipboard through xterm so bracketed paste applies', async () => {
    const { t, press } = fakeTerminal('');
    const c = clip('pasted text');
    attachClipboardKeys(t, true, c);
    expect(press(cmd('v'))).toEqual({ result: false, prevented: true });
    await vi.waitFor(() => expect(t.paste).toHaveBeenCalledWith('pasted text'));
  });

  it('pastes text with Ctrl+V and does not send ^V', async () => {
    const { t, press } = fakeTerminal('');
    const c = clip('abc');
    attachClipboardKeys(t, false, c);
    press(ctrl('v'));
    await vi.waitFor(() => expect(t.paste).toHaveBeenCalledWith('abc'));
    expect(t.input).not.toHaveBeenCalled();
  });

  it('sends ^V to the program when the clipboard has no text (an image), so it can paste it', async () => {
    const { t, press } = fakeTerminal('');
    const c = clip('');
    attachClipboardKeys(t, false, c);
    expect(press(ctrl('v'))).toEqual({ result: false, prevented: true });
    await vi.waitFor(() => expect(t.input).toHaveBeenCalledWith('\x16', true));
    expect(t.paste).not.toHaveBeenCalled();
  });

  it('sends ^V when reading the clipboard fails', async () => {
    const { t, press } = fakeTerminal('');
    const c = {
      readText: vi.fn(async () => {
        throw new Error('no text');
      }),
      writeText: vi.fn(async () => undefined),
    };
    attachClipboardKeys(t, false, c);
    press(ctrl('v'));
    await vi.waitFor(() => expect(t.input).toHaveBeenCalledWith('\x16', true));
    expect(t.paste).not.toHaveBeenCalled();
  });

  it('pastes nothing for an empty clipboard with Ctrl+Shift+V or Cmd+V', async () => {
    for (const [k, mac] of [
      [ctrl('V', { shiftKey: true }), false],
      [cmd('v'), true],
    ] as const) {
      const { t, press } = fakeTerminal('');
      attachClipboardKeys(t, mac, clip(''));
      press(k);
      await Promise.resolve();
      await Promise.resolve();
      expect(t.paste).not.toHaveBeenCalled();
      expect(t.input).not.toHaveBeenCalled();
    }
  });

  it('cut copies and clears, since terminal output cannot be deleted', () => {
    const { t, press } = fakeTerminal('out');
    const c = clip();
    attachClipboardKeys(t, false, c);
    expect(press(ctrl('x'))).toEqual({ result: false, prevented: true });
    expect(c.writeText).toHaveBeenCalledWith('out');
    expect(t.clearSelection).toHaveBeenCalled();
  });

  it('swallows Cmd+C with no selection without writing the clipboard', () => {
    const { t, press } = fakeTerminal('');
    const c = clip();
    attachClipboardKeys(t, true, c);
    expect(press(cmd('c'))).toEqual({ result: false, prevented: true });
    expect(c.writeText).not.toHaveBeenCalled();
  });
});
