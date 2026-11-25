# Changes is always a tab in the task's row

Date: 2026-11-25. Issue #386, branch `agent/issues/386-changes-tab`.

Since #362 the view tabs open on demand, so Changes was only in the row after the task menu or the palette opened
it. Users found it more convenient as a tab that is simply there.

## What changed

- **Changes is always in the row** of a ready task with a worktree and a repo, first among the view tabs, after the
  terminals. It keeps its file-count badge, which still does not refresh while Changes is open.
- **It cannot be closed.** `ClosableTab` has a `pinned` prop that hides the close button and ignores middle click.
- **Opening stays a click.** The default tab is still the first terminal; the task menu's Show changes and the
  palette entry only select the tab. `shownTabsByTask`, `closeTab` and `shownWith` are unchanged, so an old stored
  `changes` entry just does not add a second tab.
- Usage, Docs and Brain still open on demand (#362). No telemetry change.

## Not verified

- Not run in the app; only the unit tests in `TaskScreen.test.tsx`. Not checked on Windows (CI runs the tests there).
