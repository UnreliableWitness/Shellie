# Reading list and phone push: read a brain again only when its files can have changed

Issue #280, branch `agent/issues/280-reading-list-and-phone-push-re-read-a-br`.

## What changed

Every `brain:changed` sent to the window used to drop the reading list's cache for that brain and schedule a phone push. The job runner sends `brain:changed` on every status change too (queued, held, released, resumed, paused, running), though none of these touches a file. Each one made the next `reading:get` read every wiki page, long read, letter and the book again, and a push follow 20 s later. A batch of captures did this several times per job, adding to the main-process stalls in #271.

Now:

- The job runner's status changes only send `brain:changed` to the window, so Activity still updates on every one.
- A job that ended (done or failed) drops the cache and asks for a push, since it may have written files.
- Edits, options, archive, removal and settle records still go through `broadcast`, which drops the cache and asks for a push as before.

The split lives in `src/main/brain/brainEvents.ts` (`broadcastEvent`, `jobEvents`), tested in `brainEvents.test.ts`. The renderer still refetches the list on every `brain:changed`; that is cheap now that main keeps what it read.

## Not verified

- Not run in the app or on Windows; unit tests only.
- The number of reads saved was not measured.
