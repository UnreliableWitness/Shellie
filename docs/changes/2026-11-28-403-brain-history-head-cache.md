# Brain History reads the long log only when HEAD moved

Date: 2026-11-28. Issue #403, branch `agent/issues/403-brain-history-reruns-a-600-commit-git-lo`.

## What changed

- `brainActivity` (`src/main/brain/activity.ts`) first runs `git rev-parse HEAD` and keeps its last result per brain
  folder, by that HEAD, the person reading (the `installId`-derived email) and the limit. When all three match, the
  kept entries are returned (as a copy) and the 600-commit `git log --name-status` is not run.
- No HEAD (an empty repo, rev-parse failing): nothing is kept, the log is read as before.
- Deleting a brain drops its kept history (`forgetBrainActivity`, called from `deleteBrain`).

## Why

While the Brain page is open, every `brain:changed` (a job queued, running or done, a sync, an index rebuild) makes
the renderer call `brain:activity`. Most of those make no commit, yet each ran the long log, alongside `brain:get`'s
own git work (#401, #402).

The renderer, the IPC contract, what History shows, `READ` and `ACTIVITY_LIMIT` are unchanged. Nothing is kept on
disk. No telemetry events change.

## Verified

- `npx vitest run src/main/brain/activity.test.ts`: the log runs once for two reads at the same HEAD, again for
  another reader or a new commit, and again after the brain is forgotten. `npm test`, `npm run typecheck`,
  `npm run lint`.

## Known gaps

- The app was not run; Windows only through CI.
