# Brain Health: outside edits no longer read the whole history

Date: 2026-11-28. Issue #402, found by the nightly agent. Branch: `agent/issues/402-brain-health-now-lists-every-file-of-eve`.

## What changed

- `outsideEdits` (`src/main/brain/health.ts`) finds the last /sync first, without file names
  (`git log --format=%H%x01%s -E --grep='^Brain: sync( |$)'`, the subject checked with `isSyncCommit` since
  `--grep` also matches body lines). It then lists only the commits after it that touched `wiki/`
  (`git log <sync>..HEAD --name-only -- wiki/`, the whole history with `-- wiki/` when there is no sync).
- Before, every brain:get and needsSync check made git write out every file of every commit, so the cost grew with
  the brain's history even when the newest commit was a /sync.

## Why

#395 dropped the `-- wiki/` pathspec so that a /sync that changed no page still ends the list. Finding the sync in
its own call keeps that fix and brings the pathspec back. What users see is unchanged.

## Verified

- New cases in `health.test.ts`: an edit after the sync is listed and one before it not; with no sync every outside
  edit is listed; a commit naming a sync only in its body does not end the list; no `--name-only` log runs without
  the `wiki/` pathspec. The #395 case (a sync with no page change) still passes.
- `npm test`, `npm run typecheck`, `npm run lint`.

## Known gaps

- Not run in the app, nor on Windows. Not measured on a large brain; whether it explains #401 is not shown.
