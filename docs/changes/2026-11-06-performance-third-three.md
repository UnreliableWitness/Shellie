# Performance: the third three offenders

This follows `2026-11-06-performance-next-three.md` and takes the next three items from that audit's ranked list.

## 1. OpenCode's database was fully scanned twice per 30 s pass

The budget and the ledger each open OpenCode's SQLite database on every pass and query `message WHERE time_updated >= ?`. The table has no index on `time_updated`, so each query reads the whole table, synchronously, on the main process. Shellie cannot add an index to OpenCode's database.

`OpenCodeReader` now fingerprints the database and its write-ahead log by size and modification time before each read. When the files match the fingerprint taken before the last read that reached the end, and the cursor is the one that read returned, it answers with no records without opening the database. That repeat query would only have returned rows the stores already have. A paged read keeps the fingerprint of its first page and the newest cursor of all its pages.

## 2. A cost server resend was quadratic

For every 500-record batch, the sender:

- listed the dirty records, which filters and sorts the whole ledger;
- marked them sent, which copied the whole sent map and rewrote all of `sent.json`.

At 58k records that meant 116 batches, about 3 s of main-process CPU and about 260 MB written.

- `CostSender` now lists the dirty records once per pass and walks that list in batches. A record that changes during the pass gets a new hash, stays dirty, and goes in the next pass, which the ledger's `changed` kick starts.
- `LedgerStore.markSent` updates the sent map in place. It writes `sent.json` within 5 s, at the end of each send pass (`flushSent`) and at quit. A crash in between only resends records the server already accepted. `resetSent` still writes at once.

## 3. Usage changes reached the renderer once per AI request

- The ledger handed each task-attributed OpenCode record to the usage store separately. Each one meant its own file append and its own `usage:changed`. On a first backfill that meant one of each per record. It now hands them over in one batch per pass.
- `usage:changed` now goes through `throttleByKey` (`src/main/ipc/throttleByKey.ts`). A task's first change is broadcast at once, and further changes within 250 ms merge into one broadcast when the window closes. A busy agent's 2 s exports, and several agents on one task, no longer each trigger the renderer's usage summary refetches.

The renderer side was already batched by the whole-app simplify (#239): the task list uses one `usage:costs` query.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests:
  - the OpenCode reader skips unchanged files, sees the next write, and queries a different cursor; a paged read with an empty last page keeps its newest cursor (`openCode.test.ts`);
  - the sender lists dirty records once per pass and flushes once (`CostSender.test.ts`);
  - sent marks are only in memory until flushed, and the timer writes them without a flush (`LedgerStore.test.ts`);
  - the throttle behaves as described (`throttleByKey.test.ts`);
  - the ledger hands OpenCode usage over as one batch (`LedgerService.test.ts`).
- The app starts on a fresh `SHELLIE_USER_DATA` folder, and the ledger backfills with no errors.

## Known gaps

- The first OpenCode backfill still pages through a table without an index, so each page is a full scan. That happens once per install.
- The fingerprint assumes every OpenCode write changes the size or modification time of the database or its write-ahead log. A write that changes neither is read on the next change.
- The sender still saves its last-sent time after every batch. That file is small.
- No new profiling: the time savings come from the audit.

## Still open from the audit

- The Markdown view re-parses on every Docs render, including each filter keystroke.
- All `TerminalTabs` re-render on every attention snapshot and `tasks:changed`.
- The Changes tab writes each comment keystroke to the global store.
