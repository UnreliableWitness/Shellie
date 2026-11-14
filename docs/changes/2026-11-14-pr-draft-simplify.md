# PR draft: simplify pass

Simplify pass over the "PR description from the session" change (#300), 2026-11-14,
`chore/simplify-pr-draft`. Behaviour is unchanged apart from the cheaper reads.

## What changed

- A task's PR drafts are forgotten where a task actually ends (`markDone`, and in discard next to the other
  cleanup). This replaces the wrapper that patched `tasks:finish`/`tasks:discard` after the handlers were built.
- One rule decides whether a tab may be typed into (`tabVerdict` in `pickTab.ts`). It covers both picking the tab
  and the last check before typing; before, `canType` was a second, looser copy.
- `prPick` checks whether a tab runs and isn't paused before reading its session, then reads the tabs' sessions in
  parallel instead of one after the other.
- Shellie's own PR requests are dropped where sessions are read (`claudeSessionTurns`, `opencodeSessionTurns`), so
  no reader of a task's turns can see them.
- OpenCode:
  - one `taskSessions` filter serves `topSessions` and `latestSession`;
  - text reads run a plain `LIKE '%"type":"text"%'` first, so SQLite parses JSON only for parts that may be text.
- Smaller cleanups:
  - a shared `blankPrDraft()`, used by `PrDrafts` and the Finish page;
  - `prDraftBusy` and a key prefix helper in `PrDrafts`;
  - `TabView.stateAt` dropped, since nothing read it;
  - the transcript size is read with `fs.stat`;
  - `prHeading` is reused for the PR description heading.

## Verified

`npm test` (4974 passed), `npm run typecheck`, `npm run lint`.

## Left on purpose

- `TabActivity` and `ClaudeRetheme` still each track tab state. Merging them changes when the theme restart fires:
  arrows would then count as unsent text.
- `prHeadless`/`prPick` stay in `handlers.ts` and were not moved into `src/main/prDraft/`. That is a bigger move than
  this pass.
- Not changed:
  - `runWithInput`'s Claude-worded "not found" message, shared with the brain jobs;
  - one shared "Shellie " title prefix, which would hide a person's own sessions titled "Shellie …";
  - an incremental transcript poll;
  - reading transcripts backwards for the headless prompt;
  - merging `askTab`'s timers into one check;
  - one helper for typing a line and sending Enter, shared with `brainTerminal`.
