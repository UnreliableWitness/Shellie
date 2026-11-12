# The reading list and nudges in Shellie

Asked for: "A prioritized reading list with progression" and "I lost engagement. Could you nudge a user in Shellie?" ("Not on the Phone"). This is project 2 of 3, built last in the owner's order 1, 3, 2: project 1 made the brain write long reads and letters (`2026-11-11-brain-long-reads.md`), project 3 put them on the phone (`2026-11-11-phone-reader.md`). Spec: `docs/superpowers/specs/2026-11-11-reading-list-design.md`; plan: `docs/superpowers/plans/2026-11-11-reading-list.md`.

The owner said "Ok go" and had skipped the design questions, so the open points were decided while building. They are marked **(call)** in the spec and listed under "Decided without the owner" below.

The finished thing in the dev app, on a made-up brain: `assets/2026-11-11-reading-list/01-home.png` (Home's Reading band and the dot on the brain), `02-long-reads.png` (the reading list), `03-notice.png` (the notice after a build), `04-before-you-start.png` (a task's Brain tab), `05-settings.png` (the switch).

## What changed

- **A long read now knows the work it bears on** (`src/main/reading/work.ts`). Nothing in a brain links a page to a work item, so the link is made by words, the way the task's Brain tab finds its relevant pages: 2 for each word of the item's title in the long read's title, 1 for each in its summary, 1 for each of the item's most relevant pages the long read was written from. The best long read with 3 or more is the item's; otherwise it has none. The work is the work items of your open tasks plus the items assigned to you in your current sprints (Home's snapshot), completed and removed ones left out, in the brain of the item's connection and project. No AI is involved.
- **`reading:get`** (`src/main/reading/ReadingService.ts`): per brain that is not archived and has a long read or letter, its chapters, long reads (each with `work`), letters and read marks. Main keeps what it read of a brain's files until `brain:changed` or five minutes. The phone's push asks the same service, so the shelf on the phone carries the same links (`ReaderRead.work`, there since #277 and empty until now).
- **Brain › Read › Long reads is a reading list** (`BrainLongReads.tsx`): a bar and "3 of 5 read · about 2 min left", then "For your work this sprint" (each row names the work item), "Changed since you read it", "Foundations" (the book's chapters in order with "2 of 3 read"; a chapter without a long read keeps its Write button), "Later" (topics, and the field to ask for one) and "Letters" (those not under "Changed"). The order and counts come from `readingList` in `src/shared/reader.ts`, the function the phone site uses. An unread long read for your work is no longer listed under "Later" too; in the book it keeps its place. A long read you read that was written again still counts as read and says "read, changed since".
- **Home › Reading** (`ReadingBand.tsx`, right under "My tasks"): per brain with something up next, its name, the progress line and at most three rows, each with why it is there ("for #418 …", "a letter: … changed", "next in the book"). A brain with nothing up next is not listed; with no such brain the band is absent.
- **A dot on the brain in the sidebar** while its list has something for your work or something that changed. Unread foundations make no dot.
- **"Before you start"** (`BeforeYouStart.tsx`) on a task's setup page and its Brain tab: the long reads its work item bears on that you have not read, or that changed since, with their minutes.
- **A notice when a build brings something to read** (`ReadingNotice.tsx`, bottom right like the update notice): "Something you read no longer holds" (a letter), "Something you read was brought up to date" (the long read itself) or "A long read for your work". It names the piece and its minutes, has "Read", leaves after 20 seconds and comes once per text.
- **One copy for the whole app** (`useReadingFeed.ts`, the store's `reading`): fetched at launch and, a moment after the last of a burst, when a brain changes, a mark changes (here or from the phone), Home's snapshot is rebuilt or a task with a work item opens or closes.
- **The switch**: Settings › User › Appearance › "Reading nudges" (`readingNudges`, on by default). Off: no band, no dot, no "Before you start", no notice. The reading list on the Long reads page stays.
- **Telemetry** (`docs/telemetry.md`): `reading.nudge` (`kind`: `task`, `changed`, `work`) and `reading.open` (`from`, `why`, `kind`); `home.clicked` gained the band `reading`. Never a title, topic, path, work item id or brain name.

## Decided without the owner

- The work link is made by words in titles, summaries and pages, with one long read per work item at most.
- "The work in front of you" is your open tasks' work items plus the sprint items assigned to you that are not completed or removed.
- Up next is three rows a brain: work first, then changes, then one foundation (the next unread chapter). "Later" is never up next.
- An unread long read for your work is not listed under "Later" as well. This also changes the phone's list once the site is deployed again.
- Home's band sits right under "My tasks", above reviews, pull requests and sprints, and is absent when no brain has something up next.
- The dot is for work and changes only, not for unread foundations.
- "Before you start" also lists a long read that changed since you read it, and looks only at brains of the task's connection.
- The notice: three headings, 20 seconds, once per text, nothing for what was there at launch, and nothing for a long read that was already there and only now bears on your work (it shows in the band and the list).
- A long read read once and written again counts as read in the progress; its row says "read, changed since".
- One switch for all nudges, in Appearance, on by default.
- The Long reads page keeps a "Letters" section for letters that are not a change to something you read.

## Verified

`npm test`, `npm run typecheck`, `npm run lint`, all green.

In the running dev app (`SHELLIE_USER_DATA=<scratch> npm start -- -- --remote-debugging-port=<port> --use-mock-keychain`, raw CDP) on a made-up brain "Northwind" with four long reads, against a stand-in Azure DevOps on loopback with a sprint of two items assigned to me:

- Home showed the Reading band by itself once the sprint was loaded: the two long reads the items bear on, each with its work item, and the brain had its dot.
- The Long reads page showed the bar, "For your work this sprint" with the work items named, and "Foundations" with its count.
- An update job (`/write update` through a stand-in `claude` that writes a letter) ended, and the notice came up by itself: "Something you read no longer holds", the letter's title, the long read it is about, the brain. The letter was then under "Changed since you read it" and in Home's band.
- A task made for one of the sprint items showed "Before you start" on its Brain tab; the row opened the long read in the brain's Read view. "Mark as read" there moved Home's band from 2 to 3 read and took the row away without a reload.
- With "Reading nudges" off the band and the dot were gone; back on, they returned.

The dev check needed the app to accept a loopback Azure DevOps address; that was a temporary local edit and is not in this change.

## Known gaps

- **The work link is a guess from words.** A work item titled with words no page uses finds nothing; one with common words may find the wrong long read. Only real sprint items and a real brain will show how often.
- **Not run on Windows**, where the owner's brain lives; unit tests only (CI runs them there). Not tried on a real brain or a real sprint: the content above was made up, and the long reads were hand-written files, not `/write` output.
- **The phone site on aktse is the build of #277.** Until it is deployed again (`docs/deploy-aktse.md`), a long read for your work is listed on the phone under "For your work this sprint" and under "Later" too.
- A completed state is told by its name, since main has no work item type metadata there.
- Main keeps what it read of a brain for five minutes or until a job ends or the brain's options, files or existence change in Shellie (not on a job's status change, #280), so a long read edited by hand in the brain's folder shows up to five minutes late.
- The phone learns a new work link at Shellie's next push (within 15 minutes).
- "Before you start" on the task's setup page was not seen in the dev check (the task had no setup steps, so the page was skipped); `SetupScreen.test.tsx` covers it.
- The notice names one piece and counts the others; there is no list of them besides the reading list itself.
