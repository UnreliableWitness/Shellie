# No git status polls for a missing worktree

Issue #332, branch `agent/issues/332-git-status-failures-jumped-to-73-in-24-h`.

Failed `git.ms` status calls jumped from 0.1% to 2.1% in a day. The task screen polls `tasks:gitSummary`
every 5 seconds (`useGitSummary`), and it kept polling when the task's worktree folder was missing: the
`worktreeMissing` flag only re-ran the effect. The handler then ran `git status` in a folder that does not
exist, which fails with spawn ENOENT and is counted as a failed `git.ms` status on every poll.

`useGitSummary` (`src/renderer/hooks/useGitSummary.ts`) now asks nothing while `worktreeMissing` is set: no
first call, no interval, no focus listener, and the git state is cleared. The `tasks:gitSummary` handler
(`src/main/ipc/handlers.ts`) checks the folder first and fails without spawning git when it is missing. That
also covers an extra workspace folder that is gone while the home exists, which the renderer flag does not
know about. The renderer still hides the git state in both cases. The empty summary for a folder that lost
its `.git` (#184) is unchanged.

`git.ms` status failures should drop back towards the old rate. No telemetry events or dimensions change;
the optional failure kind from the spec was left out.

Tests: `useGitSummary.test.tsx` (polls when present, zero calls when missing) and `handlers.part2.test.ts`
(a gone extra workspace rejects without calling the git client's `summary`).

Not verified: that this was the source of the jump (the telemetry does not say which tasks failed), the
running app, and Windows (tested through Vitest on macOS only). rev-parse failures are a separate matter.
