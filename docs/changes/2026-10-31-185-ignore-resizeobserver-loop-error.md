# The harmless ResizeObserver loop notice is no longer reported as an error

Shellie no longer reports "ResizeObserver loop completed with undelivered notifications." as a renderer error (issue #185, 2026-10-31, `agent/issues/185-resizeobserver-loop-completed-with-undel`). Chromium raises this notice as a window `error` event when a ResizeObserver callback (the terminal, diff and Settings views have one) causes another resize in the same frame; the remaining notifications arrive in the next frame and nothing breaks. `installErrorTracking` in `src/renderer/telemetry.ts` now skips events whose message starts with "ResizeObserver loop" (also covering the older "loop limit exceeded" wording) through `isBenignResizeObserverError`. Every other uncaught error is still reported. No telemetry events are added or removed.

Not verified: on Windows, and in the app itself (only through the unit tests). Not in this change: the ResizeObserver callbacks themselves, which are unchanged.
