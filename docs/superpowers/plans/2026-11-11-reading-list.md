# Reading list and nudges in Shellie Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shellie says what to read next in a brain, how far you are and when something you read changed: the brain's Long reads page is a prioritised reading list with progress, "For your work this sprint" has content (in Shellie and on the phone), and three nudges point at real events: a band on Home with a dot on the brain, "Before you start" on a task, and a notice when a build brings something to read.

**Architecture:** Main links work items to long reads by words (`src/main/reading/work.ts`, on top of `taskWords` / `relevantPages` from the task's Brain tab) and answers `reading:get` with every brain's chapters, long reads (each with `work`), letters and marks (`ReadingService`). The work is the open tasks' work items plus the items assigned to you in Home's snapshot. The phone's push asks the same service, so its shelf carries the same links. The renderer keeps one copy in the store (`useReadingFeed`), orders it with `readingList` from `src/shared/reader.ts` (the function the phone site uses) and derives the nudges from it (`src/renderer/readingFeed.ts`).

**Tech Stack:** Electron, React 19, TypeScript, zustand, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-11-reading-list-design.md`. Project 2 of 3, built last in the owner's order 1, 3, 2 (project 1: #276, project 3: #277).

## Global Constraints

- A nudge points at something that happened (work in your sprint, a task you start, a change in something you read). Nothing counts days, streaks or points, and nothing nudges for unread foundations.
- "Up next" is three rows at most per brain; "Later" is never up next.
- A notice comes once per text and never for what was there when Shellie started.
- No nudge on the phone: the phone only gets the work links in its shelf.
- No AI in the matching, so no cost.
- One switch (`readingNudges`, on by default) turns the band, the dot, "Before you start" and the notice off; the reading list on the Long reads page stays.
- Telemetry: `reading.nudge` and `reading.open` with kinds only; never a title, topic, path, work item id or brain name. `docs/telemetry.md` lists them.
- Checks: `npm test`, `npm run typecheck`, `npm run lint` (oxfmt).

## Review Focus

- An item gets one long read or none, from a score of 3 on; a tie goes to the long read written from more of the item's pages, then by title (Task 1 tests).
- `reading:get` leaves out archived brains and brains without a long read or letter, still answers when the work cannot be had, and reads a brain's files again only after `brain:changed` or five minutes (Task 2 tests).
- The list: an unread long read for the work is not under "Later" too and keeps its place in the book; `upNext` gives work, then changes, then one foundation (Task 3 tests).
- `freshNudge`: silent at the first look, once per text, silent for a long read that only gained a work link and for a new long read without work behind it (Task 4 tests).
- With the switch off the list is still kept and nothing is said (Tasks 4 to 6 tests).

---

### Task 1: Which long read bears on which work (`src/main/reading/work.ts`)

**Files:** Create `src/main/reading/work.ts`, `work.test.ts`, `src/shared/reading.ts`, `reading.test.ts`; Modify `src/main/brain/reads.ts` (the pages a long read was written from).

- [x] `WorkRef`, `ReadWork`, `ReadingBrain`, `brainReadingList`, `progressLine`, `entryKey`, `readsForWork` in `src/shared/reading.ts`.
- [x] `workFor(items, reads, under, rows)`: 2 per word in the title, 1 per word in the summary, 1 per relevant page the long read was written from; best from 3 on.

### Task 2: The list from main (`reading:get`)

**Files:** Create `src/main/reading/ReadingService.ts`, `ReadingService.test.ts`; Modify `src/shared/ipc.ts`, `src/main/ipc/handlers.ts`, `handlers.part2.test.ts`, `src/main.ts`, `src/main/reader/{ReaderSync,readerHandlers,build}.ts` and their tests, `src/renderer/test-helpers/fakeApi.ts`.

- [x] `ReadingService.list()` per brain; `work(brain)` for the phone's push; `brainChanged(brainId)` drops what was kept.
- [x] The work: open tasks' work items and the items assigned to you in Home's snapshot, completed and removed ones left out, per connection and project.
- [x] The phone's shelf carries `work` on its long reads (`build.ts`).

### Task 3: The list's order (`src/shared/reader.ts`)

**Files:** Modify `src/shared/reader.ts`, `reader.test.ts`.

- [x] `readingList` generic over Shellie's and the phone's rows; `upNext(list, 3)` with one foundation.
- [x] An unread long read for the work is not under "Later".

### Task 4: One copy in the renderer, and the news (`useReadingFeed`)

**Files:** Create `src/renderer/readingFeed.ts`, `readingFeed.test.ts`, `src/renderer/hooks/useReadingFeed.ts`, `useReadingFeed.test.tsx`, `src/renderer/test-helpers/readingFixture.ts`; Modify `src/renderer/store.ts`, `src/renderer/App.tsx`, `src/shared/usage.ts` (`readingNudges`), `src/renderer/components/brain/useReadMarks.ts`.

- [x] Store: `reading`, `readingNudge`, `openInBrain(brainId, path)` (screen `brain` with `open: { path, n }`).
- [x] Fetch at launch and, 1.5 s after the last of a burst, on `brain:changed`, `reader:marksChanged`, `home:updated`, a change in the open tasks' work items, and a mark set in the Read view.
- [x] `freshNudge(seen, reading)`, `hasEvent`, `workKey`; `reading.nudge` and `reading.open` telemetry.

### Task 5: The reading list page (`BrainLongReads.tsx`)

**Files:** Modify `src/renderer/components/brain/BrainLongReads.tsx` and its test, `BrainRead` test, `src/renderer/screens/BrainScreen.tsx` and its test, `src/renderer/styles/brain.css`.

- [x] Bar and progress line; "For your work this sprint" (rows name the work item), "Changed since you read it", "Foundations" with "2 of 3 read", "Later", "Letters".
- [x] A long read that was read and written again says "read, changed since".
- [x] The brain screen opens a piece asked for from elsewhere (`open`).

### Task 6: The nudges

**Files:** Create `src/renderer/components/reading/{ReadingBand,BeforeYouStart,ReadingNotice}.tsx` and tests; Modify `src/renderer/screens/{HomeScreen,SetupScreen}.tsx`, `src/renderer/components/{Notices,TaskNav}.tsx`, `src/renderer/components/brain/BrainTab.tsx`, `src/renderer/screens/settings/AppearanceCategory.tsx`, `src/renderer/styles/{home,shell,brain}.css`, the tests of the screens touched.

- [x] Home › Reading under "My tasks": per brain with something up next, the progress line and the rows with why.
- [x] The dot on a brain in the sidebar while its list has work or a change.
- [x] "Before you start" on the task's setup page and Brain tab, for brains of the task's connection.
- [x] The notice: once per text, "Read", leaves after 20 seconds.
- [x] Settings › User › Appearance › "Reading nudges".

### Task 7: Docs and the check in the running app

**Files:** Modify `docs/telemetry.md`; Create `docs/changes/2026-11-11-reading-list.md`, `docs/changes/assets/2026-11-11-reading-list/`.

- [x] Dev app on a scratch data folder with a made-up brain and a stand-in Azure DevOps on loopback: the band, the dot, the list, the notice after a real update job, "Before you start", the switch.
- [x] Change note with what was decided without the owner and the known gaps.
