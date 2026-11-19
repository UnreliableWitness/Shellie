# PR description skips commits merged in from main

Issue #338, branch `agent/issues/338-merging-in-main-causes-a-lot-of-unrelate`.

After main was merged into a task branch, the PR description and the Finish summary listed every commit that
came in from main, and counted them. The range was `<baseSha>..HEAD`, and the merge puts main's newer commits
in HEAD's history but not in the recorded fork point's.

`GitClient.finishSummary` and `GitClient.branchChanges` (`src/main/services/GitClient.ts`) now use a private
`ownRange`: the log and count also exclude the merge base of `baseRef` and HEAD, and the diff runs from that
merge base, so main's files no longer show in the stat or in the AI summary's input. The "Merge branch 'main'"
commit itself stays in the list, as the branch's own commit. When the branch is already merged into `baseRef`
(a completed PR, main pulled), the old `<baseSha>..HEAD` range is kept, else nothing would be left. In that
case a branch that had main merged in before it completed lists main's commits again. When `baseRef` does not
resolve, nothing changes. `resolveBase` and how `baseSha` is recorded are unchanged. No telemetry events
change.

Tests: `GitClient.test.ts` (main merged into a branch: only the branch's commit and the merge commit, one file
changed, and no main commits or files in `branchChanges`).

Not changed: the Review screen's commit list (`src/main/review/reviewGit.ts`) still uses `<base>..HEAD` and
may show the same symptom; a follow-up if so. Not verified: the running app, and Windows (tested through
Vitest on macOS only).
