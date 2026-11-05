# Hidden task terminals are lighter, switching back is cheaper

Issue #236, branch `agent/issues/236-performance-issues-when-working-on-multi`. With three tasks running OpenCode (Windows, v1.82.0), switching back to a task made its terminal very laggy for about a minute. Every running task keeps its `TerminalView` mounted and only hidden (remounting garbles TUIs, see `TaskScreen.tsx`), and each hidden one kept its own WebGL renderer and parsed every output chunk as it came.

## What changed

- **WebGL only while shown** (`terminalSetup.ts`, `TerminalView.tsx`): `loadRenderer` loads only the Unicode 11 widths now. The new `loadWebgl` returns a handle that is safe to dispose twice (a lost GPU context disposes it too). A hidden terminal releases its WebGL addon, which frees its GPU context and glyph atlas, and xterm falls back to its DOM renderer, which does not draw while hidden. When the terminal is shown again, the addon is loaded once more and the screen refreshed once. A terminal that opens hidden gets WebGL the first time it is shown.
- **Hidden output in batches**: while hidden, live `terminal:data` chunks are gathered and written with one `t.write` every 100 ms. On show they are written at once, before the refit. A reset from main drops what was gathered, because that output belongs to the old process.
- **Resize only on a change**: `sendSize` sends `terminals:resize` only when cols or rows differ from the last size sent, so a plain switch no longer makes OpenCode redraw its whole screen. A reset by main and a Restart still force the size (#105, #162).
- **Dev builds**: a `performance.measure` named `terminal shown <id>` covers the time from the switch to the first frame after the refit, so the remaining cost can be seen in the DevTools Performance panel.

No telemetry changes.

## Verified

`npm test`, `npm run typecheck` and `npm run lint` are green. New tests in `TerminalView.test.tsx`: the WebGL addon is disposed on hide, and a new one is loaded on show with a single refresh. Hidden output is not written per chunk and arrives in one write, in order, on show. Hidden output is also written by itself after a short while. Showing the terminal again at the same size sends no resize.

## Not verified

- The real gain on Windows. CI cannot run the app, and the cause was not profiled. Someone needs to check by hand with 3 or more tasks, each running OpenCode, switching between them (the dev-build measure helps here).
- Unmounting hidden terminals, a lower scrollback or `BUFFER_LIMIT`, and batching in main are out of scope.
