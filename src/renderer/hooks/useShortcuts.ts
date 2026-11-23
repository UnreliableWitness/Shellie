import { useEffect } from 'react';
import { shortcutCommands } from '../commands/registry';
import { matches } from '../commands/shortcut';
import type { Shortcut } from '../commands/types';
import { useStore } from '../store';

const isMac =
  typeof navigator !== 'undefined' &&
  /Mac/.test(navigator.platform || navigator.userAgent);

const MODIFIERS = new Set(['Control', 'Meta', 'Shift', 'Alt']);

/** Opens and closes the command palette. Not Mod+K: Ctrl+K deletes to the end of the line in a shell. */
export const PALETTE_SHORTCUT: Shortcut = { code: 'KeyP', shift: true };

/**
 * The app's shortcuts: the palette's own key, and every command that has one (`allCommands`). The listener runs in
 * the capture phase on window so it fires before xterm sees the key, and it stops the event only when it acts.
 * A command exists only while it applies (a task's tabs while that task is shown), so no key needs a check here.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.altKey) return;
      // The mod key itself, and a key held down: nothing to run, and this is every key press in a shell.
      if (e.repeat || MODIFIERS.has(e.key)) return;
      const { paletteOpen, setPaletteOpen } = useStore.getState();
      if (matches(e, PALETTE_SHORTCUT, isMac)) setPaletteOpen(!paletteOpen);
      else {
        // The palette has the keyboard while it is open.
        if (paletteOpen) return;
        const command = shortcutCommands().find(
          (c) => c.shortcut && matches(e, c.shortcut, isMac),
        );
        if (!command) return;
        command.run();
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}
