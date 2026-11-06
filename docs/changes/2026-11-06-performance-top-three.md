# Performance: the three worst offenders

A read-only audit of the main process, the IPC handlers and the renderer ranked about eighteen hot spots. This change fixes the three that cost the most in everyday use.

## 1. Terminal output reached every terminal's listener

Every mounted `TerminalView` added its own bridge listener for `terminal:data`, `terminal:exit`, `terminal:reset` and `terminal:leak`, then dropped the chunks for other terminals. Running tasks keep their terminals mounted, so with 30 tasks of 4 terminals each, one pty chunk crossed the context bridge about 120 times. Busy agents send hundreds of chunks a second.

`src/renderer/terminalEvents.ts` now holds one bridge listener per event and routes by terminal id. `TerminalView` and `EnvironmentBand` subscribe through it. The bridge listener goes away when the last terminal unsubscribes.

## 2. The Changes badge ran the full review listing on every file event

`useChangeCount` called `review:files` only to count files. That listing runs about 7 to 9 git processes per repo, hashes every changed file, reads every untracked file and, with stored secrets, runs a full leak diff. It ran after every `docs:changed` or `review:changed` burst, which happens constantly during builds and agent edits.

The new `review:count` channel (`ReviewService.count`, `countFiles` in `reviewGit.ts`) runs only `git diff --name-status` against the base and `git ls-files --others`. That is two git processes per repo and no file reads. A repo that fails, for example one with no base, counts zero, as it did before: the full listing gave such a repo no files.

## 3. budget.json was rewritten every 30 seconds while any agent worked

Any appended transcript line moves a cursor, so each budget pass cloned, zod-parsed, stringified and atomically wrote the whole file. On the owner's data that is 2.5 MB and about 30 ms of main-process work per pass.

`JsonFileStore.update` takes a `writeWithinMs` option. The change is applied in memory at once, without the schema parse, and written within that time, by the next plain update, or by `flush()`. `BudgetStore.apply` uses a 2-minute window. `markAlert` still writes at once and takes the pending change with it. On quit, `stopBudget` flushes and `will-quit` waits for that write.

Losing the window on a crash is safe. The cursors are saved in the same file as the rows and the `seen` dedupe set, so the next launch rereads those requests and counts them once.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests cover the dispatcher (`terminalEvents.test.ts`), the delayed writes (`JsonFileStore.test.ts`) and the count matching the full listing against a real git repo (`ReviewService.test.ts`). The badge hook tests now assert on `review:count`.
- The app starts on a fresh `SHELLIE_USER_DATA` folder with no errors.

## Known gaps

- The quit-time flush was not seen in a live run: nothing was pending when the dev app was stopped. The unit tests cover `flush()`.
- Main still sends one IPC message per pty chunk. Batching there could reorder output around `terminal:reset`, so it was left alone.
- The badge still refreshes for writes to git-ignored folders such as `dist/`. Each refresh is now cheap.

## Not fixed, ranked by the audit

- Every running task's xterms are created and their buffers replayed at boot. Mounting a task's terminals the first time it is shown would avoid that.
- `tasks:gitSummary` polls every 5 s even when the window is hidden or unfocused.
- `tasks:scanWorkspaces` runs `git worktree list` serially for every sibling repo, every 2 minutes.
- The ledger hashes every record synchronously at startup (183 ms for 58k records) and re-sweeps all records every 30 s even when nothing changed.
- OpenCode's database is scanned without an index on `time_updated`, synchronously, twice per pass.
- The cost sender's resend is O(n²) and rewrites `sent.json` per batch.
- `usage:changed` fires per request and fans out to several full `usage:task` summaries.
- The Markdown view re-parses on every Docs render, including each filter keystroke.
- All `TerminalTabs` re-render on every attention snapshot and `tasks:changed`.
- The Changes tab writes each comment keystroke to the global store.
