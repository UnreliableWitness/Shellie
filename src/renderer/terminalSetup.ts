import type { ITerminalOptions, Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { api } from './api';
import { currentColorScheme, onColorSchemeChange } from './colorScheme';
import type { ColorScheme } from '../shared/theme';
import { MIN_CONTRAST, terminalTheme } from './terminalTheme';

/**
 * The system's own terminal fonts (Windows Terminal's Cascadia Mono, then Consolas; SF Mono or Menlo on macOS), nothing
 * bundled or preferred by Shellie. Each has its own bold, so bold text never falls back to a font with another baseline.
 */
export const TERMINAL_FONT =
  "'Cascadia Mono', Consolas, 'SF Mono', Menlo, monospace";
const FONT_SIZE = 13;

export function terminalOptions(windowsBuild: number | null): ITerminalOptions {
  return {
    fontFamily: TERMINAL_FONT,
    fontSize: FONT_SIZE,
    theme: terminalTheme(currentColorScheme()),
    minimumContrastRatio: MIN_CONTRAST[currentColorScheme()],
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    // Box-drawing and block characters (Claude Code's logo, TUI borders) drawn as pixel-exact shapes, not font glyphs.
    customGlyphs: true,
    // Tells xterm the pty is ConPTY, so it leaves line wrapping and reflow to ConPTY instead of fighting its redraws.
    ...(windowsBuild
      ? {
          windowsPty: { backend: 'conpty' as const, buildNumber: windowsBuild },
        }
      : {}),
  };
}

/**
 * Re-colours the terminal whenever the colour scheme changes, then calls `changed` (TerminalView tells the program,
 * see TerminalManager.reportScheme); returns the unsubscribe.
 */
export function followColorScheme(
  t: Pick<Terminal, 'options'>,
  changed?: (s: ColorScheme) => void,
): () => void {
  return onColorSchemeChange((s) => {
    t.options.theme = terminalTheme(s);
    t.options.minimumContrastRatio = MIN_CONTRAST[s];
    changed?.(s);
  });
}

let info: Promise<number | null> | null = null;
/** The Windows build number, asked once per window. */
export function windowsBuild(): Promise<number | null> {
  info ??= api()
    .invoke('app:info')
    .then((i) => i.windowsBuild ?? null)
    .catch(() => null);
  return info;
}

/** Wide-character widths per Unicode 11 (emoji, CJK). */
export function loadRenderer(t: Terminal): void {
  try {
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = '11';
  } catch {
    /* keep the default widths */
  }
}

/**
 * The WebGL renderer when the GPU allows it; the DOM renderer otherwise (null). Disposing it, or losing the GPU context,
 * returns the terminal to the DOM renderer; disposing twice is harmless.
 */
export function loadWebgl(t: Terminal): { dispose(): void } | null {
  try {
    const webgl = new WebglAddon();
    let gone = false;
    const dispose = () => {
      if (gone) return;
      gone = true;
      webgl.dispose();
    };
    webgl.onContextLoss(dispose);
    t.loadAddon(webgl);
    return { dispose };
  } catch {
    /* no WebGL: the DOM renderer stays */
    return null;
  }
}
