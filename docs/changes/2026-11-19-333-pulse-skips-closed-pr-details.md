# Pulse skips CI, statuses and threads for closed PRs

Issue #333, branch `agent/issues/333-pulse-fetches-ci-statuses-and-threads-fo`.

Every pulse refresh made three Azure DevOps calls (policy evaluations, PR statuses, PR threads) for each
workspace whose PR was found, also when that PR was already completed or abandoned. The task list reads CI,
review and comment data only for active PRs (`troubleOf` and `storyOf` in `src/shared/pulse.ts`), so those
calls were wasted.

`TaskPulseService.build()` (`src/main/pulse/TaskPulseService.ts`) now makes the three detail calls only when
the PR is active. A merged or abandoned PR costs one call per refresh (the branch lookup) instead of four, and
gets ci `none`, no conflict, review from reviewers only and 0 unanswered, as before for a PR without data.
The PR ref is still linked when its status changes. Users see no difference. No telemetry events change.

Tests: `TaskPulseService.test.ts` (an active PR makes the three calls; a completed and an abandoned PR make
none and are still linked).

Not verified: the running app against Azure DevOps, and Windows (tested through Vitest on macOS only).
