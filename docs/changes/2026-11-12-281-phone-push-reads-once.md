# The phone push reads a brain's reading files once

Issue #281, branch `agent/issues/281-phone-push-reads-each-brain-s-long-reads`.

For every brain sent to the phone, one push read the same files several times: the reading list's `ReadingService` read the long reads, letters, record and the book (and the book a second time on its own), and then `buildBrain` read all of that again and each long read's and letter's file a third time for its text. The book means reading every wiki page, so a brain's wiki was read three times per push, also on the 15-minute tick when nothing changed.

## What changed

- `brainReadsAndPages` also returns the book it loaded and each long read's and letter's text. `ReadingService` takes the chapters from that book instead of reading it again; `chaptersOf(book)` in `book.ts` is the one place that picks the chapters with pages.
- `ReadingService.forPhone(brain)` gives the push the files it read (from its cache when it has them) and the work links. `work()` is a thin wrapper over it.
- `buildBrain` takes those files (`PhoneFiles`) instead of reading them; only the pages and sources the texts cite are read there. `ReaderSync`'s `work` dependency became `files`; when it is missing or fails, the push reads the files once itself (`phoneFiles`) and goes without the work links, as before.
- What the phone gets is unchanged: the same shelf, item ids and hashes, so nothing is sent again.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests:
  - a golden check that the shelf id, shelf hash and every piece's id and hash are the ones the old code built, from both the push's own read and the reading list's files (`build.test.ts`);
  - `forPhone` followed by `buildBrain` reads `book.json` once and the long read's file once (`ReadingService.test.ts`);
  - `brainReadsAndPages` returns the book and the texts (`reads.test.ts`).

## Known gaps

- Not run in the app or on Windows.
- A push within five minutes of the reading list's last read uses what it read then, where it used to read the files afresh. A change made through Shellie clears that cache (`brain:changed`); a file edited outside Shellie reaches the phone at the next read after the cache expires.
- The cache now also holds each long read's and letter's text in memory.
