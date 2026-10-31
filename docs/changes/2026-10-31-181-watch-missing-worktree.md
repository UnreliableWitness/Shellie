# Changes and Docs watchers fall back to polling when the worktree is gone

Opening the Changes or Docs view of a task whose worktree folder is no longer on disk no longer raises "The worktree is missing" (issue #181, 2026-10-31, `agent/issues/181-the-worktree-is-missing`). `review:watch` and `docs:watch` used to throw from `requireWorktree`, which rejected the IPC call and was logged as a handler error in main. Both now go through `watchableWorkspace` in `src/main/workspaces/existing.ts`, which returns null when the task is not ready or its folder is gone; the handlers then answer `{ live: false }` without starting any watcher, and the views fall back to polling. The other review and docs channels still throw, so the Changes view keeps showing the missing-worktree message per repo. Telemetry is unchanged.

Not verified: on Windows, and in the app itself (only through the handler tests). Not in this change: finding out why the worktree went missing, and recreating or repairing it.
