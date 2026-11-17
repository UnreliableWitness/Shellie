# Terminals reload their renderer on a screen with other scaling

Issue #315, branch `agent/issues/315-shellie-s-ui-fully-freezes-when-drag-an`.

On Windows, dragging the window from a 100% screen to a 150% one while a terminal (OpenCode) was open froze the whole UI until Shellie was killed. A change of scale factor changes `devicePixelRatio`, which makes xterm's WebGL renderer rebuild its canvas and glyph atlas while the ResizeObserver refits the terminal and resizes the pty. Nothing reacted to the scale change itself, and the only recovery (`onContextLoss`) does not fire when the renderer hangs rather than loses its context. This cause is read from the code, not reproduced.

## What changed

- `onScaleChange` in `terminalSetup.ts` watches `matchMedia('(resolution: <ratio>dppx)')` and asks again for the new ratio after each change.
- `TerminalView` drops the WebGL renderer when the scale factor changes (xterm falls back to its DOM renderer), refits on the next animation frame, then loads WebGL again and redraws, only while the terminal is shown and the view is mounted. The listener is removed on unmount.
- Telemetry: no change.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests: `onScaleChange` re-arms for the new ratio and unsubscribes (`terminalSetup.test.ts`); `TerminalView` disposes WebGL, refits, loads it again after the frame, does not load it for a hidden terminal, and removes the listener on unmount (`TerminalView.test.tsx`).

## Known gaps

- The root cause is unconfirmed: not run in the app, nor on Windows with mixed scaling (the reporter's setup).
- If the freeze remains, the next step is the DOM renderer for all terminals on Windows with mixed DPI.
