# Cleanup retry frees a branch held by its own worktree

Date: 2026-11-25. Issue #379, branch `agent/issues/379-cleanup-retry-branch-d-fails-because-a-w`.

The nightly health check saw the background cleanup fail six times in one session on 1.122.0 with
`git branch -D ... cannot delete branch ... used by worktree at ...`. The branch stayed, and every retry tried the
same thing again.

## What changed

- **A branch its own worktree still holds is freed.** `removeWorkspace` prunes and then deletes the branch.
  `git worktree prune` only drops registrations whose folder is gone, so a registration whose folder is still there
  (half-removed on Windows) or that git lists under another path form still has the branch checked out. When
  `branch -D` fails that way, the cleanup now reads `git worktree list`; if the worktree holding the branch is the
  task's own (`samePath`), it runs `worktree remove --force` on it again, prunes and deletes the branch once more.
- **Any other worktree is left alone.** A branch held by a different worktree may belong to a reopened or live task:
  nothing is removed, and the leftover is kept with the new code `branch-in-use`.
- **`branch-in-use` is a code of its own.** `cleanupErrorCode` tells it from `git`, so it shows in `cleanup.deferred`,
  `cleanup.done` and `cleanup.gaveUp` and on the Done page.
- **A local log line** says which worktree held the branch and whether the task's folder still existed.

The same prune-then-delete steps in the IPC handlers (Finish, Discard) are unchanged.

## Not verified

- Which of the two cases happens in the field is not confirmed; the log line is there to tell.
- On Windows: only the unit tests with a fake git ran; CI runs them on Windows.
