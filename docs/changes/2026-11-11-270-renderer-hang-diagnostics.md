# Telemetry: what the renderer held when the window hung

Issue #270, branch `agent/issues/270-renderer-ran-out-of-memory-and-the-windo`. One session on 1.89.0 had its window go unresponsive twice and then lost its renderer to out-of-memory. Telemetry could not say why: `window.unresponsive` carried nothing, and the nearest memory figure was the `app.health` snapshot up to 10 minutes away. This change only measures; it fixes nothing yet.

## What changed

- `window.unresponsive` and `window.responsive` now carry `rendererMemoryMb` (working set of the renderer processes, read at that moment), `terminals` (open terminals) and `rendererHeapMb` (the renderer's last known JS heap) when known. A failed read sends the event without them.
- `app.health` gains `rendererHeapMb`, left out when the renderer has not answered yet.
- Main reads the heap (`performance.memory.usedJSHeapSize`) from the main window once a minute. While a read is still pending, no new one is started, so a hung renderer keeps its last value, which is the figure from just before the hang.
- `rendererMemoryMb` in `src/main/telemetry/health.ts` is the one place that sums the `Tab` processes, used by both events.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests in `health.test.ts`: `rendererHeapMb` rounded to MB and left out when unknown; `rendererMemoryMb` sums only `Tab` processes.

## Not verified

- Not run in the app: the heap read through `executeJavaScript` and the hang events are untested by unit tests, and not seen on Windows.
- Not in this change: capping terminal scrollback, the Docs and diff views, crash dumps, the `Render frame was disposed` error. Those wait for what the new numbers show. Main-process stalls are #271.
