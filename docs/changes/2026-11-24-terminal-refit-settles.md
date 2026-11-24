# Terminals refit once the window has settled

Branch `UnreliableWitness/koi`, 2026-11-24. Follows #315 (`2026-11-17-315-scale-change-terminal-renderer.md`), which did not end the problem.

## Why

A Windows user reported that Shellie crashed while its window was dragged from one screen to another and resized. No crash files were available. Application Insights shows the same picture three times in a week for that user (2026-11-18, 2026-11-23, 2026-11-24, on v1.110 to v1.119, so after #315): the renderer's working set goes from about 140 MB to over 4 GB within a minute, `window.unresponsive` follows, and the app is closed and started again. The main process stays healthy. Every time, OpenCode terminals were open; that user runs nothing else.

## Cause, as far as it is known

`TerminalView` refitted its terminal on every ResizeObserver notification, so on every frame of a window move or resize, and loaded a new WebGL renderer on the frame after every change of scale factor. Each refit resizes the pty. A full-screen program repaints its whole screen for each resize, and OpenCode's repaint is heavy.

Measured in the dev app on macOS, with the window's zoom factor flipped between 100% and 150% every 30 ms for 40 seconds (a stand-in for a window between two screens):

| Open in the terminal | Changes the renderer kept up with, before | After |
| --- | --- | --- |
| a shell prompt | about 1060 | not measured |
| vim | about 1250 | not measured |
| OpenCode | 330 | 1290 |

With OpenCode open the renderer was saturated by the repaints. On macOS its memory stayed bounded, so the runaway to 4 GB itself was not reproduced; on Windows ConPTY repaints as well, and the working assumption is that output then arrives faster than the renderer can draw it and queues up. That last step is an assumption, not a measurement.

## What changed

- `TerminalView` refits once the terminal's box has kept its size and scale for 100 ms (`REFIT_SETTLE_MS`), instead of on every notification. A burst of any length costs one refit and one pty resize. Refits asked for directly (shown, restarted, reset, first opened) stay immediate.
- On a change of scale factor the WebGL renderer is still dropped at once, and is loaded again once, after the settle. It is loaded before the fit: the DOM renderer's cells are a little wider, and fitting first left the terminal too narrow (148 columns where 166 fit).
- `.termview-xterm` cuts off what does not fit (`overflow: hidden`). Until it is refitted, a terminal in a box that shrank is larger than the box, and nothing clipped it: the page itself became scrollable.
- Telemetry: `window.unresponsive` and `window.responsive` carry `windowResizes30s`, `scaleChanges30s` and `terminalOutputKb30s` (`src/main/telemetry/recent.ts`), so the next hang says whether the window was resizing, changing scale, or the terminals were flooding. `docs/telemetry.md` is updated.

## Verified

- `npm test`, `npm run typecheck`, `npm run lint`.
- New tests: a burst of size changes refits once; a burst of scale changes loads WebGL once and refits once; nothing refits after unmount (`TerminalView.test.tsx`); `RecentCount` (`recent.test.ts`).
- In the dev app on macOS: the table above; after each zoom change the terminal fills its box again and the page has no overflow.

## Known gaps

- Not run on Windows, and not with two screens of different scaling. The reporter's exact trigger is unconfirmed.
- While a window is being resized by hand, the terminal now follows a moment after the drag pauses, not during it.
- If the hang returns, the three new measurements on `window.unresponsive` are the first thing to read. A next step would be backpressure on terminal output towards the renderer.
