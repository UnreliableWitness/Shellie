# OpenCode's edits in another repo join the task

Issue #291, branch `agent/issues/291-code-changes-do-not-show-up-if-agent-edi`.

The multi-repo detection (#48) read only Claude Code's session logs, and only for Claude tabs with a session id. When OpenCode edited a second repo in a worktree on a different branch, the task never picked that repo up: Changes said "No changes since the task started" and no chip for that repo appeared. The branch scan only finds worktrees already on the task branch.

## What changed

- `WorkspaceDetector` now also reads OpenCode's database, but only when the task has an OpenCode tab (open or closed). Edit, write, multiedit, patch and apply_patch calls count, and so do bash calls with `git worktree add` or a git command that writes. They go through the same rules as the Claude log hits: paths in the home worktree are left out, each worktree is resolved once, joins are decided by `joinVerdict`, and the `workspace.joined` event carries source `log`.
- Only top-level sessions in one of the task's worktree folders (and their real paths) that were created since the task count. Shellie's own brain and PR runs are left out. OpenCode tabs still have no session id.
- `OpenCodeReader.writtenPaths` opens the database read-only. Its SQL selects only the tool parts and their input, so tool output never reaches JS. A missing or unreadable database adds nothing.
- `writeHitsFromOpenCodeTool` in `sessionLog.ts` maps one OpenCode tool call to the paths it writes. Bash commands go through the same parser as Claude's. Relative paths resolve against the bash call's `workdir`, or else the session's folder.
- No telemetry change.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests: a session in the task's worktree that edits another repo's worktree joins that repo, with no Claude tab. Edits and commits in the task's own worktree add nothing, and a missing database adds nothing and does not throw (`WorkspaceDetector.test.ts`). The reader returns the paths of edits, patches and writing git commands, and leaves out reads, older sessions, other folders and brain jobs (`openCode.test.ts`).

## Known gaps

- An OpenCode edit in a repo's main checkout still only adds the existing main-checkout note. It does not attach the repo.
- The tool input shapes (`filePath`, `patchText`, `workdir`) come from OpenCode's tools. They were not checked against a real opencode.db from the issue.
- Not run in the app or on Windows.
