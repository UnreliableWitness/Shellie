# Keys for the big places

Date: 2026-11-24. Asked by the owner in a session: shortcuts for the big features like Sprint, Dreams, Brain,
Week. Builds on the palette's commands (`2026-11-23-quiet-shell-palette.md`).

## What changed

| Key (Cmd on macOS, Ctrl elsewhere) | Goes to |
| --- | --- |
| Mod+Shift+H | Home |
| Mod+Shift+S | Sprint |
| Mod+Shift+W | Week |
| Mod+Shift+M | Dreams (M for its moon; D is a task's Docs tab) |
| Mod+Shift+B | The project's brain (the first, when there are more) |
| Mod+Shift+N | New task |

The palette shows each key beside its row, which is where they are learned. They work everywhere, also with a
terminal focused and in Focus mode, and not while the palette is open.

Inside a task that has a Brain tab, Mod+Shift+B keeps opening that tab, as before: the brain's key means "the
brain" in both places, and the palette then shows the key on "Show brain" only. Dreams has its key only in a
project that has Dreams.

## How it works

- Every key is Mod+Shift and a letter: Mod and a letter alone belongs to the shell on Windows (Ctrl+S, Ctrl+W)
  and to the window on macOS (Cmd+W, Cmd+H). C, V (terminal copy and paste), I, R and Z (dev tools, reload, redo)
  were left alone.
- Home, Sprint, Week and New task are a fixed list in `src/renderer/commands/global.ts` (`PLACES`); the palette's
  rows and the shortcut handler's commands are made from it. The handler's list is built once and reads the store
  when a command runs, so a key press with the mod key down still builds nothing.
- Dreams and the brain get their key in `usePlaceCommands`, which already knows whether the project has them.
- A letter key is now the letter the keyboard layout types, not its place on a QWERTY keyboard (`matches` in
  `commands/shortcut.ts`): on AZERTY, W and M sit elsewhere. This also holds for the older keys (P, F, D, B),
  which sit in the same place on both. A layout without Latin letters (Cyrillic) and the digits keep the place.
- `shortcutCommands()` puts what components offer before the places, so a task's own command wins a shared key.

## Verified

- `npm run typecheck`, `npm run lint` and the renderer tests pass; tests cover each key, the key without Shift
  being left to the shell, and a task's command winning.

## Known gaps

- Not tried in the running app, nor on Windows or a real AZERTY keyboard.
- The keys cannot be changed, and nothing but the palette shows them.
- Project, Settings and Secrets have no key.
