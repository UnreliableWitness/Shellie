# Cleanup: a branch another worktree holds is left, not retried forever

Date: 2026-11-28. Issue #400 (regression of #379), branch `agent/issues/400-cleanup-branch-d-still-fails-branch-held`.

## What was seen

On 1.130.0 and 1.132.0, after #379 was closed, App Insights showed the background cleanup failing 12 times in 24 h
(2 sessions) with `git branch -D ... used by worktree`, each time with the log line "branch held by ...; the task's
folder is gone". The #379 fix only frees a branch when the worktree holding it is the task's own (`samePath`), so
these were either another worktree really holding the branch or the same folder under another path form. The
redacted log could not tell which, and the retry went on every 3 minutes.

## What changed

- `sameFolder` (`src/main/paths.ts`): `samePath`, or the same folder once both paths resolve (`realpathSync.native`:
  links, junctions, /private/var, 8.3 names on Windows). `removeWorkspace` uses it to decide the holder is the task's
  own worktree, so a path-form mismatch is freed as #379 meant. Still never matched by branch alone.
- The log line no longer prints paths, only a diagnosis: `holderListed`, `listFailed`, `own`, `sameAfterCase`
  (equal ignoring case and slashes), `holderExists`, `holderIsMain` (the repo's main checkout), `taskExists`.
- A branch held by another worktree that is there comes back `final`. The next background retry confirms it, sends
  `cleanup.gaveUp` with `reason: other-worktree`, gives one notice naming the branch, and stops retrying. A holder that
  is not listed or whose folder is gone keeps being retried, up to 10 `branch-in-use` attempts, then the same with
  `reason: attempts`.
- `PendingCleanup` gets an optional `final` field (no migration). The entry stays, so the Done page shows "Shellie
  stopped trying to delete the branch: another worktree still has it checked out." Retry now there still tries it.

## Not verified

- Which of the two cases happens in the field is still unconfirmed; the new log line should show it.
- Windows (case, 8.3 names, junctions) only through CI. The app was not run.
- A final leftover of a discarded task stays in that list, since it has no Done page to clear it from.
