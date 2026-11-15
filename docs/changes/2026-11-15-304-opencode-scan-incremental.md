# The workspace scan reads only new OpenCode parts

Issue #304, branch `agent/issues/304-workspace-scan-rereads-a-task-s-whole-op`.

Since OpenCode detection (#302), every workspace scan of a task with an OpenCode tab opened `opencode.db` in a new `OpenCodeReader` and read every edit, write, patch and bash part the task's sessions had ever made, in synchronous SQLite on the main thread, then ran git (`resolveCandidate`) again for every outside path. The task page scans every 2 minutes while focused, so the work grew with the session. The Claude log path already reads only new lines (`SessionLogReader.readNew`).

## What changed

- `writtenPaths` in `budget/openCode.ts` takes a `sincePart` bound (`part.time_updated > ?`) and returns `{ paths, watermark }`, the watermark being the latest part update it read (`sincePart` when none).
- The bound is on the part's update time, not its creation time as the issue suggested: OpenCode creates a tool part before it has its input, so a part created before a scan may get its path after it.
- `WorkspaceDetector` keeps one watermark per task in memory and passes it on the next scan, so paths from earlier scans no longer reach git. On a read error the old watermark stays.
- The watermark goes with the task's folder list: when a worktree joins, its folders bring sessions in, and the next scan reads from the start once.
- The detector builds one `OpenCodeReader` (or takes one as `openCodeReader`) instead of one per scan.
- Users see no change: the same worktrees get joined.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests: `writtenPaths` with `sincePart` skips earlier parts and returns the right watermark, also with no new rows (`openCode.test.ts`); a scan after nothing new passes the watermark and resolves no path again, and a later part only resolves and joins its own worktree (`WorkspaceDetector.test.ts`).

## Known gaps

- The watermark is in memory: the first scan after the app starts reads everything once.
- Watermarks of finished or deleted tasks are not dropped (a few bytes per task until restart); the detector has no cleanup spot.
- The read is still synchronous SQLite on the main thread, only smaller.
- Not run in the app or on Windows.
