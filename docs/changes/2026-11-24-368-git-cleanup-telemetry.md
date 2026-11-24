# Git cleanup telemetry: one sample per worktree removal, `branch show-current` on its own

Date: 2026-11-24. Issue #368, branch `agent/issues/368-worktree-cleanup-git-worktree-remove-and`.

The nightly health check saw `git.ms` fail for 40 of 47 `worktree remove` calls and 334 of 345 `branch` calls in a
day, and read it as worktree cleanup being broken. Most of those failures were how they were counted, not git failing.

## What changed

- **`worktree remove` counts once per removal.** `GitClient.worktreeRemove` retries a folder Windows still holds up to
  eight times in about 5 s, and every try was its own `git.ms` sample: one held folder showed as up to eight failures
  beside the one success that ended it. The retries now run untimed (`run(..., { timed: false })`) and the whole
  removal is one sample, `ok` or `failed`.
- **`branch --show-current` is `branch show-current`.** `gitOperation` put it in `branch` together with `branch -D`.
  `currentBranch` is asked of worktree folders named by tasks and session logs, often already gone, and it treats
  the error as "no branch". It now has its own name, and a call on a folder that no longer exists counts as `ok`.
- **A log line per failed background retry.** `WorktreeCleanup` writes `[cleanup] attempt N left <path> (<code>)`
  to the local log when a retry leaves a folder behind, so a held folder (EBUSY, `in-use`) can be told from other
  failures. Local log only, not telemetry.

Nothing about when `worktree remove` or `branch -D` run, the retry timing or the dream sweep changed.

## What this means for the numbers

The old `worktree remove` and `branch` failure rates were inflated; compare from 2026-11-24 on only. The real cleanup
problem is what `cleanup.deferred` and `cleanup.gaveUp` with `EBUSY` show: a process on Windows holding a file in
the folder. That is rare and is not fixed here.

## Not verified

- On Windows: the held-folder retry was only exercised with a fake runner; the effect on the live counts shows in
  App Insights after a release.
