# Reading list: read the brains at the same time, and time it

Issue #294, branch `agent/issues/294-reading-get-mean-rose-from-128-ms-to-abo`.

## What changed

Telemetry showed `reading:get` at a mean of about 2 s (128 ms before) and a max of 48 s. `ReadingService.list()` awaited the work items first and then read each brain one after another, so the cold reads of all brains (every wiki page, long read, letter and the book) added up. Also, when a brain's kept files had expired, every caller that asked at the same time started its own read.

Now:

- `list()` asks for the work items and reads every brain that is not archived at the same time (`Promise.all`), then builds the list in the brains' own order. A brain whose folder cannot be read is still left out; what `list()` returns is unchanged.
- The cache keeps the time a read started next to its promise and checks it synchronously, so callers that find an expired entry together share one new read.
- Each list sends a `reading.listed` event with measurements `ms`, `workItemsMs`, `coldBrains` and `coldMs` (see `docs/telemetry.md`), to show which part is slow.

The work items are not the cause: they come from the open tasks and the saved Home snapshot on disk, not from Azure DevOps.

## Not verified

- Not run in the app or on Windows; unit tests only. The time saved was not measured.
- The cause of the 48 s max is not confirmed (event-loop stalls from #271 or slow disks are other candidates). Check `reading.listed` and `ipc.ms reading:get` on the next release, and reopen if the mean stays above about 500 ms.
