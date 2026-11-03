import type { Terminal } from '@xterm/xterm';

export type ClipboardAction = 'copy' | 'cut' | 'paste' | 'passthrough';

export type KeyLike = Pick<
  KeyboardEvent,
  'type' | 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
>;

export const isMac =
  typeof navigator !== 'undefined' &&
  /Mac/.test(navigator.platform || navigator.userAgent);

/** The letter the key types on the user's layout, or its physical key when that is not a Latin letter (Cyrillic, Greek). */
function letter(e: KeyLike): string {
  const k = e.key.toLowerCase();
  if (/^[a-z]$/.test(k)) return k;
  const m = /^Key([A-Z])$/.exec(e.code);
  return m ? m[1].toLowerCase() : '';
}

/**
 * What a key does in a terminal, the way VS Code's and Windows Terminal's terminals do it.
 * macOS: Cmd+C, Cmd+V and Cmd+X; Ctrl+C is always SIGINT.
 * Windows and Linux: Ctrl+C copies a selection and is SIGINT otherwise; Ctrl+X copies a selection (output cannot be
 * deleted) and passes through otherwise; Ctrl+V pastes; Ctrl+Shift+C and Ctrl+Shift+V copy and paste.
 * A copy or cut with nothing selected does nothing, except where the key passes through.
 */
export function clipboardAction(
  e: KeyLike,
  mac: boolean,
  hasSelection: boolean,
): ClipboardAction {
  if (e.type !== 'keydown' || e.altKey) return 'passthrough';
  const l = letter(e);
  if (mac) {
    if (!e.metaKey || e.ctrlKey || e.shiftKey) return 'passthrough';
    if (l === 'c') return 'copy';
    if (l === 'v') return 'paste';
    if (l === 'x') return 'cut';
    return 'passthrough';
  }
  if (!e.ctrlKey || e.metaKey) return 'passthrough';
  if (e.shiftKey) {
    if (l === 'c') return 'copy';
    if (l === 'v') return 'paste';
    return 'passthrough';
  }
  if (l === 'v') return 'paste';
  if (l === 'c' && hasSelection) return 'copy';
  if (l === 'x' && hasSelection) return 'cut';
  return 'passthrough';
}

type ClipboardTerminal = Pick<
  Terminal,
  | 'attachCustomKeyEventHandler'
  | 'hasSelection'
  | 'getSelection'
  | 'clearSelection'
  | 'paste'
  | 'input'
>;
type TextClipboard = Pick<Clipboard, 'readText' | 'writeText'>;

/**
 * Copy, cut and paste keys for one xterm. Without this xterm turns Ctrl+V into ^V and Ctrl+C into ^C, and packaged
 * Windows builds have no Edit menu whose accelerators could step in. Handled keys are kept from xterm and the page
 * (so a menu accelerator does not run them a second time); paste goes through xterm so bracketed paste applies.
 */
export function attachClipboardKeys(
  t: ClipboardTerminal,
  mac: boolean,
  clipboard: TextClipboard,
): void {
  t.attachCustomKeyEventHandler((e) => {
    const action = clipboardAction(e, mac, t.hasSelection());
    if (action === 'passthrough') return true;
    e.preventDefault();
    if (action === 'paste') {
      // With no text (an image) plain Ctrl+V reaches the program as ^V, as in Windows Terminal, so TUIs such as
      // opencode can read the image from the clipboard themselves. Cmd+V and Ctrl+Shift+V never send ^V.
      const sendKey = !mac && !e.shiftKey;
      void clipboard
        .readText()
        .then((text) => {
          if (text) t.paste(text);
          else if (sendKey) t.input('\x16', true);
        })
        .catch(() => {
          if (sendKey) t.input('\x16', true);
        });
    } else if (t.hasSelection()) {
      void clipboard.writeText(t.getSelection()).catch(() => undefined);
      t.clearSelection();
    }
    return false;
  });
}
