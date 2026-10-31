# The header's git summary no longer fails for a worktree folder with no .git

The header's git summary no longer raises "not a git repository" for a task whose worktree folder is still on disk but has no `.git` (issue #184, 2026-10-31, `agent/issues/184-not-a-git-repository-or-any-of-the-paren`). `tasks:gitSummary` passed the `git status` failure straight back, so the renderer's 5-second poll logged a `GitError` in main every time. It now answers an empty summary (no branch, no files, nothing ahead or behind) when `<worktree>/.git` is gone, the same check `tasks:finishChecks` already makes (#115). When `.git` is there and git still fails, the error is passed on as before. Telemetry is unchanged.

Not verified: on Windows, and in the app itself (only through the handler tests). Not in this change: finding out why the worktree lost its `.git`, repairing it, and telling the user about it in the header.
