# Flaky Windows tests: hook timeouts and terminal waits

The Windows CI jobs failed about one run in three on tests this code never touched, and a re-run passed.

## Cause

- **Hooks kept vitest's 10 s default.** `vitest.config.mts` gave the main tests 60 s on Windows (real git is slow there), but not their hooks. A `beforeEach` that scaffolds a brain or builds a repo is several git calls, and on a busy runner that passes 10 s. A throwaway diagnostic branch ran the git-heavy files (`src/main/brain`, `handlers.part4`) 5 times on 4 Windows runners, with a process dump for any git call over 15 s. It got 7 failures, all "Hook timed out in 10000ms", and no git call took over 15 s, so this is slowness, not a hung git.
- **Terminal waits at 1 s.** In `handlers.part6.test.ts`, 12 `vi.waitFor` calls that wait on a real terminal spawning, stopping or respawning used the 1 s default instead of the harness's `PTY_WAIT` (10 s).
- **A tab listed after its run ended.** `openRunTab` spawns the run tab first and records it in the task's terminals after, so `shellie run show` can return before the tab is listed. The test read the list once.

## What changed

- `hookTimeout` matches `testTimeout` in the main project: 60 s on Windows, 20 s elsewhere.
- The 12 waits use `PTY_WAIT`. The `show` test waits for its tab to be listed.

## Verified

The same diagnostic loop with the fix, plus `handlers.part6`, ran 20 rounds with 0 failures. `npm test` passes on macOS.

## Known gaps

On 2026-11-06 one main run had two tests time out at 60 s, leaving the brain folder busy. That points to a single long git call. It did not come back in 40 rounds. Local git calls in `GitClient.run` still have no deadline. If it returns, the diagnostic (a process dump when a git call passes 15 s) is in this note's commit history.
