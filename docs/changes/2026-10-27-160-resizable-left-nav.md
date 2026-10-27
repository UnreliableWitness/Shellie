# The left nav can be resized

Issue #160, branch `agent/issues/160-user-should-be-able-to-make-the-left-dra` (2026-10-27). The left task nav was always 240px wide, so long task titles were cut off and there was no way to give it more room.

A thin handle now sits on the nav's right border (`.leftnav-resize` in `src/renderer/styles/shell.css`, a `role="separator"` in `TaskNav`). Dragging it resizes the nav between 160 and 480px. The width follows the pointer during the drag and is stored when the pointer is released. With the handle focused, ArrowLeft and ArrowRight change the width in 16px steps, and a double-click resets it to 240px.

The width is kept in localStorage under `shellie.ui.navWidth` (`readNavWidth` / `writeNavWidth` in `src/renderer/uiPrefs.ts`), so it is per machine. A missing or unreadable value gives 240px, and stored values are clamped to the range. The store holds it as `navWidth` with `setNavWidth`. The collapsed rail is unchanged: it stays 48px wide and has no handle. No telemetry events change.

Not in this change: resizing other panels, syncing the width across machines, snapping to the rail when dragged narrow. Tested with Vitest (jsdom) on macOS only. The drag was not tried in the running app, and not checked on Windows.
