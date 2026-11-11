# Brain long reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The brain writes for the people who work with it: a long read per chapter or asked topic (prose with its reasoning and linked sources, one question, the writer's gaps), and a letter when the pages under a long read change. Stored in the brain, read in Shellie's Read view.

**Architecture:** Skills v10 add `/write` (chapter, topic, update). Long reads are files in `reads/`, letters in `reads/letters/`; Shellie records in `brain/reads.json` what each long read was written from (commit and the blob of every page) and derives "out of date" from it. A new job kind `write` carries a `target` and is queued through its own channel `brain:write`; hooks build the prompt, stamp the record after the job and run an optional automatic pass. The renderer gets a Long reads list and a reader in the Read view; what a person has read is a mark in local storage.

**Tech Stack:** Electron, React 19, TypeScript, zod, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-11-brain-long-reads-design.md` (design canvas: https://claude.ai/artifact/LwtD8pqm5RDHjhBWFMKJKp). This is project 1 of 3; the phone site and the prioritised reading list with nudges follow.

## Global Constraints

- Agent-neutral copy; Claude Code and OpenCode brains both run `/write` (the skills list in `templates.ts` feeds both).
- `TEMPLATES_VERSION` 10; `writeReady(brain)` = `templatesVersion >= 10` gates `brain:write`, the automatic pass and the switch in Add and in Settings.
- No points, streaks, counters of days or guilt. Read is a mark the reader sets.
- Telemetry: actions and kinds only, never a title, topic, chapter or path. That includes the message of a refused IPC call.
- Automatic writing is off by default and bounded: 2 writes a day per brain, only under half of the daily token cap, only when nothing else is waiting, never a target that failed twice in the last seven days.
- Paths from a long read's frontmatter are never trusted: only `wiki/…` pages inside the brain count.
- Checks: `npm test`, `npm run typecheck`, `npm run lint` (oxfmt).

## Review Focus

- A long read whose pages did not change is never out of date; one that Shellie has no record of (written by hand) is never out of date either (Task 1 tests).
- `brain:run` refuses kind `write`; `brain:write` refuses below v10, an unknown chapter and an update of a long read that is not out of date; a second ask for a waiting target returns the waiting job (Task 3 tests).
- A write job that leaves no long read is not recorded and counts as a failure for the automatic pass (Task 3 tests).
- An updated long read is unread again; a letter has its own mark (Task 4 tests).
- A scrub redacts `reads/` and `brain/reads.json` and leaves no long read out of date over it (Task 3 tests).

---

### Task 1: Long reads as data (`reads.ts`)

**Files:** Modify `src/shared/brain.ts`; Create `src/main/brain/reads.ts`, `src/main/brain/reads.test.ts`.

**Interfaces (produces):**
- shared: `BrainReadRow = { path; title; summary; chapter: string | null; topic: string | null; pages: string[]; written; minutes; hash; stale: string[] }`, `BrainLetterRow = { path; title; read; written; minutes; hash }`, `BrainReads = { reads; letters }`; `isLetter(path)`, `writeTarget(...)` / `parseWriteTarget(target)` (`chapter:<title>`, `topic:<text>`, or a long read's path), `writeReady(brain)`, option `writeLongReads` (default false), `readsPass` on the brain (`failures`, `day`, `started`).
- main: `listReads(dir, git)`, `readRecord(dir)` / `stampRead(dir, git, path, commit)`, `chapterOf(read, book)` (a renamed chapter is found by the majority of its pages).

- [x] Tests first: frontmatter parsing with missing or wrong fields, minutes from the word count, letters newest first, stale pages from changed blobs, a deleted page counts as changed, no record means not stale, pages outside `wiki/` are dropped, the chapter fallback.
- [x] Implement; PASS; typecheck.

### Task 2: Skills v10 (`/write`)

**Files:** Modify `src/main/brain/templates.ts` and its test, `src/main/brain/scaffold.test.ts`.

- SCHEMA: `reads/` and `reads/letters/` and their frontmatter; `brain/reads.json` is Shellie's, never touched by an agent.
- WRITE: `chapter <title>`, `topic <text>`, `update <path> since <commit> changed: <pages>`. A long read teaches one subject from start to end around one idea and one worked case; every claim links its page or source; what the sources do not say is said as such; one `Before you read on` question with its answer; the last section is `What the writer was missing`. An update rewrites the long read and writes a letter (`What you read`, `What holds now`, `Why it changed`, `What follows`); a second letter on the same day is appended to the first.
- [x] Tests first (strings present, write listed for both agents, version 10, ten skills); implement; PASS.

### Task 3: The write job, IPC and the automatic pass

**Files:** Modify `src/shared/ipc.ts`, `src/main/brain/jobs.ts`, `brainHandlers.ts`, `scheduler.ts`, `scrub.ts`, `src/main.ts`; Create `src/main/brain/readsHooks.ts` (+ test).

**Interfaces (produces):** IPC `brain:reads(brainId) → BrainReads`; `brain:write(brainId, target) → BrainJob`. `BrainJob.target?: string`. Hooks: `promptFor(job)` (the `/write …` line, throws when the target no longer holds), `stamp(job)` (records the long read after the job's commit), `afterJob(job)` (failure counts for the automatic pass), `readsPass(brainId)`, `passRunning(brainId)`.

- [x] Tests first: every refusal above, the dedupe, the prompts, the 20-minute limit for kind `write`, the stamp, the pass (switch, skills, archived, anything pending, half of the cap, 2 a day, failed twice, all written), the scrub.
- [x] Implement; wire the scheduler tick and the hooks in `main.ts`; PASS.

### Task 4: Reading in Shellie

**Files:** Create `src/renderer/components/brain/longReads.ts`, `BrainLongRead.tsx`, `BrainLongReads.tsx` (+ tests); Modify `BrainWiki.tsx`, `BrainTreeView.tsx`, `BrainFront.tsx`, `BrainRead.tsx`, `screens/BrainScreen.tsx`, `styles/brain.css`, `styles/tokens.css`, test helpers.

- The list: Letters (newest first), By chapter (the long read, or "No long read yet" with Write, its status while it waits or runs, or that the last try failed), On a topic (the long reads asked for, the ones being written or failed, a one-line field).
- The reader: a serif column (`--font-read`), the title with reading time and day, the essay with the question (answer held back), the gaps in a closed box, links to pages and sources opening in the Read view. Out of date: which pages changed, with Update. A letter: its labelled sections, what was read struck through; long read and letter link to each other. Mark as read / Mark unread at the end.
- "Long reads" is the first entry of the tree with a dot while something is unread; the front page says how many chapters have one and how many are unread.
- [x] Tests first for the pure module, then the two components, then the wiring in `BrainRead.test.tsx` and `BrainFront.test.tsx`; implement; PASS.

### Task 5: Switches, Activity, telemetry

**Files:** Modify `components/brain/AutoRuns.tsx`, `composer/Activity.tsx`, `screens/settings/BrainsSection.tsx`, `brainActions.ts`, `docs/telemetry.md` (+ tests).

- "Write long reads" in What runs by itself (with v10 skills) and in Settings › Project › Brains.
- Activity names a write job by its target; Retry of a failed one goes through `brain:write`.
- `brain.screen.action`: `reads-open`, `read-open` (`kind`), `read-write` (`target`: `chapter` or `topic`), `read-update`, `read-answer`, `read-mark`; `brain.job` kind `write`.
- [x] Tests first; implement; PASS.

### Task 6: Check in the running app, review, change note

- [x] Dev app on a fresh data folder with a stand-in `claude` first on the PATH (no tokens): write a chapter, read it, mark it, change a page, Update, read the letter, ask for a topic, a failing topic.
- [x] Review of the whole diff; fix what it confirms, each with a test: refusals without names, frontmatter YAML cannot read, the chapter fallback counted on the chapter's pages, the record after a scrub, markers inside code blocks, failures that expire after a week, an update that renames its file, backslashes in a path, focus after "Show the answer", the Settings switch only on v10.
- [x] `docs/changes/2026-11-11-brain-long-reads.md` with screenshots.
