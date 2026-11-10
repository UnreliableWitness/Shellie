# OpenCode database reads moved off the main process

## Why

Stall profiles from a Windows machine showed the main process blocked for about 1.1 s in OpenCode's `SELECT` (`node:sqlite`'s `all`, called from `BudgetService.run`). OpenCode's `message` table has no index on `time_updated`, so every read scans the whole table, and `node:sqlite` is synchronous. Paging does not help, because each page is its own full scan.

## How it works

`src/main/budget/openCodeRemote.ts` runs the budget's and the ledger's reads in one worker thread (`src/openCodeWorker.ts`, built next to `main.cjs`). The worker keeps a reader per database and options, so each job's "nothing changed" shortcut still works. It starts on the first read. If it dies, waiting reads reject (both jobs already treat that as "not readable this pass") and the next read starts a new one.

## Verified

- Unit tests for the client and the worker's handler, plus async reads in both jobs.
- The packaged-app smoke check now loads the worker from the package and needs its answer.

## Known gaps

- The brain's OpenCode session lookups (`openCodeSessions` in `src/main.ts`) stay synchronous on the main process. They are rare and were not in any stall profile.
- Not yet observed on an installed Windows app.
