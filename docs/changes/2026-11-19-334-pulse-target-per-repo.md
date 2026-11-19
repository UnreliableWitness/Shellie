# The pulse finds each repo's PR target once per refresh

Issue #334, branch `agent/issues/334-each-pulse-refresh-spawns-two-git-proces`.

Since the task lifecycle groups (#330), every pulse refresh (every 180 s while focused, on focus, after Finish and Create PR) called `prContext` for each open workspace. That ran `git remote` and `git remote get-url origin` on the workspace's repo and also worked out the work item linking, which the pulse ignores. Workspaces on the same repo repeated the same two git processes, adding to the git load behind #332.

## What changed

- `prTargetOf(repoId)` in `handlers.ts` reads the repo's connection and `origin` and returns them with `prAvailability`. `prContext` (Create PR) uses it, so its result is unchanged.
- The pulse's `workspaces()` items carry `repoId`, and its `target` dep takes a repo id and calls `prTargetOf`, no longer `prContext`.
- `TaskPulseService` keeps a `Map<repoId, Promise>` per refresh, so each repo is looked up once per refresh. A failed lookup is still caught per workspace. Nothing is cached across refreshes, so a changed remote shows on the next one.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests (`TaskPulseService.test.ts`): three workspaces on repo A and one on B call `target` twice and still look up all four PRs; a second refresh asks again; a failing repo only drops its own workspaces.

## Known gaps

- Not run in the app or on Windows.
- No handlers-level test counting `git remote` calls.
