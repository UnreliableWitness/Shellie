# Performance: the next three offenders

This follows `2026-11-06-performance-top-three.md` and takes the next items from that audit's ranked list.

The audit's second item was the 5 s git summary poll running while the window is hidden. The whole-app simplify (#239) already fixed it: `useGitSummary` polls only while the window has focus. The other git summary polls run only while the repos menu or the task details dialog is open. This change takes the next item on the list instead, the cost ledger.

## 1. Every running task's terminals were created at launch

`TaskTerminals` mounted a `TerminalTabs` for every ready or finishing task. At launch each one created an xterm per terminal and replayed up to 200k characters of main's buffer into it, plus about a dozen IPC calls per task. That happened for tasks the user might not open in that session.

A task's terminals now mount the first time it is shown and stay mounted while it runs, so switching back never replays. A task that stops running drops out and mounts afresh if it runs again. A brain set to `openBrainTerminalOnStart` now opens its terminal on the task's first view, still once per session. "Send to terminal" only targets the task on screen, so it is unaffected.

## 2. The workspace scan ran `git worktree list` serially for every sibling repo

`scanBranch` ran one `git worktree list` per registered repo and per sibling folder holding a `.git`, one after another. That happens every 2 minutes while a task page is focused, and on every Finish check. Ten registered repos in a folder of 50 meant 50 serial git processes.

`mayHaveBranch` (`src/main/workspaces/resolve.ts`) reads `.git/HEAD` and `.git/worktrees/*/HEAD` first. Only a repo with a checkout on the task branch gets the git call. It answers true when it cannot tell: a `.git` file, a missing folder or an unreadable HEAD. The scan runs 8 repos at a time and keeps the result in input order. The sibling `.git` checks run in parallel.

## 3. The cost ledger froze at startup and re-walked every record every 30 s

- **Startup:** `LedgerStore.load` hashed every record in one loop that never yielded. On the owner's 58k records that was 183 ms of frozen main process, growing with the ledger. It now yields every 2000 records, like the parse loop above it. The hash is unchanged, so `sent.json` stays valid.
- **The sweep:** each pass walked every stored record to re-apply attribution, billable and the developer email, even when none of their inputs had changed. That was about 45 ms of CPU per pass on the owner's data. `UsageStore.billableVersion()` now counts billable flag changes. The ledger skips the stored-record sweep when the attribution context key, the developer and that count are all unchanged. The first pass of a launch always sweeps. Without a `billableVersion` dependency, as in older tests, every pass still sweeps.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests:
  - a task's terminals mount on first view and are not mounted again on return (`TaskScreen.test.tsx`);
  - repos without the branch run no git, and the scan keeps order (`resolve.test.ts`);
  - the HEAD-file check covers the main checkout, linked worktrees, a `.git` file and a missing folder;
  - the ledger skips the sweep while nothing changed, and re-applies billable after a version bump and the developer after an email change (`LedgerService.test.ts`);
  - the version counter moves on `setBillable` (`UsageStore.test.ts`).
- The app starts on a fresh `SHELLIE_USER_DATA` folder, and the ledger backfilled from the real transcripts with no errors.

## Known gaps

- The time savings come from the audit's estimates and measurements, not from new profiling.
- The ledger still rebuilds the Copilot and PR-summary records from the usage store on every pass.
- The workspace scan still stats each session id in every `~/.claude/projects` folder.

## Still open from the audit

- OpenCode's database is scanned without an index on `time_updated`, synchronously, twice per pass.
- The cost sender's resend is O(n²) and rewrites `sent.json` per batch.
- `usage:changed` fires per request and fans out to several full `usage:task` summaries.
- The Markdown view re-parses on every Docs render, including each filter keystroke.
- All `TerminalTabs` re-render on every attention snapshot and `tasks:changed`.
- The Changes tab writes each comment keystroke to the global store.
