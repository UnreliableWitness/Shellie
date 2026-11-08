# The brain as a book: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the Read view reads like a book: a brain-written table of contents, chapters that read start to finish, an open page that fills the wide screen with type that grows, and the original pictures inside the pages.

**Architecture:** the skills keep one file, `brain/book.json`. Main parses it tolerantly and serves it over a new IPC channel; the renderer builds the tree, front page and chapter view from it plus the rows it already has. A brain without a valid book keeps today's tree and landing. The first arrangement is a background Sync with the `book` argument, queued by the scheduler. Pictures and type are renderer-only.

**Tech Stack:** Electron, React, TypeScript, Vitest, react-markdown (remark/rehype).

**Spec:** `docs/superpowers/specs/2026-11-08-brain-book-design.md`. Mockups: `docs/superpowers/specs/assets/2026-11-08-brain-book/` (`reading-width.html` option C, `front-page.html` option 1).

## Global Constraints

- No extra AI cost beyond the existing brain jobs. No API key, no paid service, no new CLI run outside `BrainJobRunner`.
- No new skill. `TEMPLATES_VERSION` goes from 7 to 8; existing brains get it through "Update skills".
- Introductions and chapter summaries carry no facts (no names, figures, dates or claims).
- A page must always be reachable from the Read view; a missing or invalid book shows today's tree and landing.
- At most two failed first arrangements per brain, persisted; none queued while a valid book exists.
- The first arrangement leaves `lastSyncCommit` and existing pages alone.
- Both themes through existing tokens. UI text never names an agent. The task's Brain tab is unchanged.
- Checks: `npm test`, `npm run typecheck`, `npm run lint`. Match the surrounding code's comment density and idiom.

## Review Focus

1. Book lists a page that was deleted, or a page twice, or a back-of-the-book page: the dead path vanishes, the duplicate shows once, the decision stays in the back (Task 1 tests).
2. A page exists that the book does not list: it shows under "Not placed yet" and opens alone (Task 5 test).
3. Pictures: the same picture cited in two sections of a chapter shows once; a citation to a missing file leaves the link and draws no broken image (Task 3 tests).
4. Two pages in a chapter with the same heading: anchors stay distinct, and a link to `page#heading` lands in the right section (Task 3 and 4 tests).
5. A chapter page changes while it is being read (a job finishes): the reader keeps their scroll position, as `BrainPage` does (Task 4 test).

---

### Task 1: The book file, the subject page kind, picture lists on rows

**Files:**
- Create: `src/main/brain/book.ts`, `src/main/brain/book.test.ts`
- Modify: `src/shared/brain.ts`, `src/shared/ipc.ts`, `src/main/brain/browse.ts` (+ test), `src/main/brain/indexPage.ts`, `src/main/brain/brainHandlers.ts` (+ test), `src/renderer/components/brain/brainTree.ts`, `src/renderer/styles/brain.css`, `src/renderer/test-helpers/fakeApi.ts`

**Interfaces:**
- Produces in `src/shared/brain.ts`:
  - `type BrainChapter = { title: string; summary: string; intro: string; pages: string[] }`, `type BrainBook = { chapters: BrainChapter[] }`
  - `BRAIN_PAGE_TYPES` gains `'subject'`, first in the list; `BrainPageRow` gains `pictures: string[]` (repo-relative picture files the page links or embeds, document order, deduped).
  - `BACK_OF_BOOK_TYPES: ReadonlySet<BrainPageType>` = decision, meeting, digest, lesson, glossary.
  - `BOOK_TEMPLATES = 8`, `bookReady(brain)`; `BrainSchema` gains `bookPass: z.object({ attempts: z.number().int() }).nullable().default(null)`.
- Produces in `src/main/brain/book.ts`: `BOOK_PATH = 'brain/book.json'`, `parseBook(text: string, known: ReadonlyMap<string, BrainPageType>): BrainBook | null`, `readBook(brainDir: string): Promise<BrainBook | null>`.
- IPC: `'brain:book': { args: [brainId: string]; result: BrainBook | null }`, default `() => null` in `fakeApi`.

- [ ] **Step 1: Write failing tests in `book.test.ts`.** `parseBook`: valid file → chapters in order; invalid JSON, a non-object, no `chapters`, zero chapters, a chapter with no title → `null`; a path not in `known` is dropped; a path listed twice (same or other chapter) stays at its first place; a path of a back-of-the-book type is dropped; a chapter left with no pages is kept with `pages: []`; missing `summary`/`intro` become `''`. `readBook` on a missing file → `null`. In `browse.test.ts`: `subject-mission.md` has type `subject`; a row's `pictures` holds a linked and an embedded picture once each, in order, without the `#fragment`, and no `.md` target.
- [ ] **Step 2: Run them.** `npx vitest run src/main/brain/book.test.ts src/main/brain/browse.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `pageType` adds `subject`. `pageRows` fills `pictures` from `p.links` via `localTarget` and an extension test (png, jpg, jpeg, gif, webp, svg, bmp). `TYPE_ORDER` in `indexPage.ts` starts with `'subject-'`; `TYPE_LABELS` gains `subject: 'Subjects'`; `.brain-graph [data-type='subject']` uses `--accent`. `readBook` builds `known` from `readPages` + `pageType`. Handler `'brain:book': async (id) => readBook(brainOf(id).path)`.
- [ ] **Step 4: Run** the two test files and `npm run typecheck` → PASS (fix row fixtures that need `pictures: []`).
- [ ] **Step 5: Commit** `Brain book: the book file, subject pages, pictures on rows`.

### Task 2: Skills v8 and the first arrangement

**Files:**
- Create: `src/main/brain/bookPass.ts`, `src/main/brain/bookPass.test.ts`
- Modify: `src/main/brain/templates.ts` (+ `scaffold.test.ts` as needed), `src/main/brain/jobs.ts` (+ test), `src/main/brain/scheduler.ts` (+ test), `src/main.ts`, `src/renderer/components/brain/AutoRuns.tsx` (+ test in `BrainAdd.test.tsx`)

**Interfaces:**
- Consumes: Task 1's `readBook`, `bookReady`, `Brain.bookPass`.
- Produces: `isBookJob(j: Pick<BrainJob,'kind'|'background'>): boolean` in `src/shared/brain.ts` (a background `sync`); `createBookHooks(d: { brains: BrainStore-like get/patch; runner: () => Pick<BrainJobRunner,'enqueue'|'jobs'> }): { afterJob(j: BrainJob): void; bookPass(id: string): Promise<unknown>; passRunning(id: string): boolean }`; `MAX_BOOK_ATTEMPTS = 2`.

- [ ] **Step 1: Write failing tests.**
  - `jobs.test.ts`: a background `sync` runs with the input `/sync book`; a normal `sync` with `/sync`. An OpenCode background sync passes `book` as its arguments the way `opencodeInput` passes a source.
  - `bookPass.test.ts`: `bookPass` enqueues one background sync for a brain with pages and no valid book; none when a valid book exists, when the brain has no pages, or when any `sync` is queued, running or paused; a second call while the first is queued enqueues nothing. `afterJob`: a done book job with no valid book sets `bookPass.attempts` to 1; a failed one too; a done one with a valid book leaves it; a normal sync or a capture never counts.
  - `scheduler.test.ts`: `bookPass` is not called on the launch tick; is called on the next for a v8 brain; never for a v7 brain, an archived brain, or one with `bookPass.attempts >= 2`; not called again while its promise is pending.
  - Skill text tests in the existing templates test (or `scaffold.test.ts`): `TEMPLATES_VERSION === 8`; `SCHEMA.md` names `brain/book.json` and `subject-<topic>.md`; `/sync` names the `book` argument and says not to write `lastSyncCommit` in that mode; `/capture` says it never creates the book.
- [ ] **Step 2: Run them** → FAIL.
- [ ] **Step 3: Implement jobs.** `prompt(j)` returns `/sync book` for `isBookJob(j)`. Check `opencodeInput` and `d.commit`: the commit must include `brain/book.json` and new wiki pages. A background job waiting does not change other sync behaviour. `enqueue` for a normal `sync` drops a waiting (not running) book job, as a hand-queued pictures job replaces a background one.
- [ ] **Step 4: Implement `bookPass.ts`** following `createPictureHooks`, wired in `main.ts` by composing with the picture hooks' `afterJob` (`promptFor` stays). The scheduler guard: `!launch && bookReady(b) && (b.bookPass?.attempts ?? 0) < MAX_BOOK_ATTEMPTS && !bookPassing.has(b.id) && !d.bookPassRunning(b.id)`.
- [ ] **Step 5: Write the skills.** In `SCHEMA.md`: the `subject-*` type ("a subject of the project that fits no other type: its mission, who is on board, how the work runs"); a section **The book** with the format below, and the rules:
  ```json
  { "chapters": [ { "title": "The project", "summary": "What the project is for and what is out of scope", "intro": "…", "pages": ["wiki/subject-mission.md", "wiki/scope-rollout.md"] } ] }
  ```
  Chapters run from the general to the specific: the project itself (mission, goals), who is on board, the customer's business, then architecture, how the work runs; adapt to what the project actually is. Only `account`, `scope-*`, `component-*`, `subject-*` and other pages go in chapters; decisions, meetings, digests, lessons and the glossary stay out. The first page of the first chapter is the book's introduction, so its summary must say what the project is. `summary` and `intro` only say what the chapter covers and why it comes here: no names, figures, dates or claims. A chapter may list no pages when the subject matters and nothing is captured yet.
  `/capture`: new step: if `brain/book.json` exists, put each page you created at the right place in the right chapter and any page not listed; move nothing else; if it does not exist, do not create it.
  `/sync`: same step for a valid book. If `brain/book.json` is missing or unusable, make the first arrangement. With the argument `book`, make only the first arrangement and stop: skip the reconcile steps and do not write `lastSyncCommit`. The first arrangement: read `index.md` and the wiki pages it needs; choose chapters; write a `subject-*` page, with frontmatter and citations, for a book subject that no page covers, reading only the sources that bear on it; change no existing page; write `brain/book.json` last, in one write.
  `/digest`: new step: review `brain/book.json` if it exists (rewrite introductions, reorder or rename chapters when the project has moved on, place unlisted pages), no facts in introductions.
- [ ] **Step 6: AutoRuns.** A row "Arrange the brain as a book", tag `auto`, text "once, in the background, when a brain has pages and no book yet"; shown when `bookReady(brain)`.
- [ ] **Step 7: Run** the touched tests, `npm run typecheck` → PASS.
- [ ] **Step 8: Commit** `Brain book: skills v8 and the first arrangement`.

### Task 3: Full width, growing type, pictures in the page

**Files:**
- Create: `src/renderer/docs/remarkFigures.ts`, `src/renderer/docs/remarkFigures.test.ts`, `src/renderer/components/brain/usePageMedia.tsx`
- Modify: `src/renderer/components/docs/MarkdownView.tsx`, `src/renderer/components/brain/BrainPage.tsx` (+ test), `src/renderer/styles/brain.css`, `src/renderer/styles/docs.css` only if needed

**Interfaces:**
- Produces: `MarkdownView` optional props `figures?: { shown: ReadonlySet<string> }` (absent: no figures) and `idPrefix?: string` (prefixes every heading id, and `#x` links within the view; anchors passed to `onOpenDoc` stay unprefixed).
- `remarkFigures(opts: { path: string; shown: ReadonlySet<string> })`: remark plugin; never mutates `shown`.
- `usePageMedia(brainId: string): { asset; openFile(p: string): void; onBodyClick(e): void; lightbox: ReactNode }`, extracted from `BrainPage`.

- [ ] **Step 1: Write failing tests** in `remarkFigures.test.ts`, on the markdown → mdast result: a paragraph citing `../sources/a-assets/x.png` gets a figure block right after it, caption from the link text, link kept; a list and a table get it after the whole block; two citations of one picture give one figure, at the first; a picture in `shown`, or embedded with `![]` anywhere earlier, gives none; `.md` and web links give none. In `BrainPage.test.tsx`: rail layout on a wiki page renders the figure `img` with a caption and clicking it opens the lightbox; a failed `brain:asset` leaves the link and no `img` and no caption; the `chips` layout renders no figure. `MarkdownView` with `idPrefix="s1-"`: heading id `s1-intro`, `#intro` link scrolls to it.
- [ ] **Step 2: Run them** → FAIL.
- [ ] **Step 3: Implement.** The plugin walks top-level blocks in order and inserts `{type:'paragraph', children:[image]}` with `image.data.hProperties.dataFigure = 'true'`, allowed in the sanitize schema. Resolve with `resolveRelative(path, url)` (strip a fragment). `img` in `MarkdownView` renders a figure (`.doc-figure`, with `.doc-figure-cap`) when `dataFigure` is set, and nothing if the asset fails. `idPrefix` is a small rehype plugin after `rehypeSlug`. `BrainPage` passes `figures={{ shown: EMPTY }}` for rail + wiki page.
- [ ] **Step 4: CSS.** Remove the `justify-content: center` rule. `.brain-page.with-rail` columns `minmax(0, 1fr) 240px`, `no-rail` `minmax(0, 1fr)`. On `.with-rail .brain-page-body .doc-md`: `max-width: none; font-size: var(--read-size)`, where on `.brain-read-main > *`: `--read-size: clamp(14px, calc(14px + (100cqw - 860px) * 0.0074), 22px)` (check the base size in `docs.css` and use it as the floor). Keep the 72ch rule for the non-rail layout. Heading sizes in `.doc-md` must be relative (`em`) inside the Read view. `.brain-page-head h2` and `.brain-page-lead` scale too. `.doc-figure img { max-width: 100%; display: block; cursor: zoom-in }`.
- [ ] **Step 5: Run** touched tests, `npm run typecheck`, `npm run lint` → PASS.
- [ ] **Step 6: Commit** `Brain: pages use the width, pictures shown where cited`.

### Task 4: The chapter view

**Files:**
- Create: `src/renderer/components/brain/BrainChapter.tsx`, `src/renderer/components/brain/BrainChapter.test.tsx`, `src/renderer/components/brain/book.ts` (+ test)
- Modify: `src/renderer/components/brain/PageRail.tsx`, `src/renderer/styles/brain.css`

**Interfaces:**
- Consumes: Task 1 types, Task 3's `figures`, `idPrefix`, `usePageMedia`.
- Produces in `book.ts`: `chapterOf(book: BrainBook, path: string): number` (−1 when none), `sectionId(n: number): string`, `shownBefore(rows: BrainPageRow[], pages: string[], n: number): Set<string>`, `stripTitle(text: string): string` (frontmatter and a leading `# ` heading off).
- `BrainChapter` props: `{ brainId, book, index: number, path: string, anchor?: string, rows, canBack, canForward, onOpen(path, anchor?), onBack, onForward, onReading?(path: string): void }`.
- `PageRail` gains optional `outlineLabel?: string` (default "On this page") and `current?: string` (the outline id to highlight).

- [ ] **Step 1: Write failing tests** in `BrainChapter.test.tsx`: renders the chapter's title and intro, then every page's title and body in book order, reading each with `brain:read`; no summary shown beyond the page's own first paragraph; the same picture in two sections has one figure; two sections each with `## Notes` get distinct ids; `path` of the second page scrolls to its section (mock `scrollIntoView`), `anchor` to the heading in that section; a link to another page of the chapter calls `onOpen`; previous/next buttons open the first page of the neighbouring non-empty chapter and are absent at the ends; the rail lists the sections as "In this chapter" and shows Sources, Linked from and Mark verified for the section being read; a page's tags (confidence, verified) are in its section; a brain change refetches without scrolling.
- [ ] **Step 2: Run them** → FAIL.
- [ ] **Step 3: Implement.** Bar like `BrainPage`'s (Back, Forward, "Chapter N" crumb). Texts load with `Promise.all`, guarded like `BrainPage` for a stale chapter, refetched on `useBrainChanged`. Each section: `<section id={sectionId(n)} data-path>`, heading `h2` title, `PageTags`, `MarkdownView` with `idPrefix={`${sectionId(n)}-`}`, `figures={{ shown: shownBefore(rows, pages, n) }}`, `text={stripTitle(text)}`. Section being read: the last section whose top is above the scroller's top + a third, from a scroll listener on the closest `.brain-read-main`; report via `onReading`. Scroll once per navigation, as `BrainPage`'s `scrolledFor` does.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `Brain book: the chapter view`.

### Task 5: The front page and the tree

**Files:**
- Create: `src/renderer/components/brain/BrainFront.tsx` (+ test)
- Modify: `src/renderer/components/brain/BrainRead.tsx` (+ test), `src/renderer/components/brain/BrainTreeView.tsx`, `src/renderer/components/brain/brainTree.ts` (+ test), `src/renderer/components/brain/BrainWiki.tsx`, `src/renderer/screens/BrainScreen.tsx`, `src/renderer/components/brain/brainActions.ts`, `src/renderer/styles/brain.css`

**Interfaces:**
- Consumes: Tasks 1, 4. `BrainPages` gains `book: BrainBook | null`, loaded in `useBrainPages` with the rows.
- Produces in `brainTree.ts`: `backOfBook(rows, sources): TreeGroup[]` (Decisions, Meetings, Weekly digests, Lessons, Glossary, Sources), `unplaced(rows, book): TreeItem[]`.
- `BrainTree` gains optional `book?: { chapters: BrainChapter[]; openChapter: number; titleOf(path): string; onOpenChapter(n): void }`; with it, no Start here: "The book", then "Back of the book", then "Not placed yet" when any, then Recent changes and Log.
- `BrainFront` props: `{ brainName, book, rows, newPaths, continueAt: {path:string}|null, onOpen }`. `BrainRead` gains `brainName`.
- localStorage `shellie.brain.continue.<brainId>` holds the page last read.

- [ ] **Step 1: Write failing tests.** `BrainFront`: title, introduction = the first chapter's first page's summary, "Continue reading" only with a page still in the book, labelled `4 · Architecture › Order flow`; one row per chapter with number, title, summary, "3 sections" ("1 section"); an empty chapter shows "Nothing captured on this yet"; a chapter holding a new page has the blue dot; the graph is rendered; a row click opens the chapter's first page. `BrainTree`: chapters numbered, the open one lists its pages with the page highlighted; a chapter with no pages is not a button; back-of-the-book groups with counts; "Not placed yet" only when `unplaced` is non-empty. `BrainRead`: with a book, a chapter page opens `BrainChapter`, a decision opens `BrainPage` alone, an unplaced page opens alone; with `book: null`, today's tree and landing exactly (existing tests stay green); reading a section writes the continue key; a storage failure is ignored.
- [ ] **Step 2: Run them** → FAIL.
- [ ] **Step 3: Implement.** Layout per `front-page.html` option 1. `brain.screen.action` gains `continue-reading` (`brainActions.ts`, `docs/telemetry.md`). The two columns stack under a container width of 820 px.
- [ ] **Step 4: Run** full `npm test`, `npm run typecheck`, `npm run lint` → PASS.
- [ ] **Step 5: Commit** `Brain book: front page and contents tree`.

### Task 6: Prove it and write it down

**Files:** Create `docs/changes/2026-11-08-brain-book.md`. Modify `docs/telemetry.md` if not done.

- [ ] **Step 1:** In the running app (`SHELLIE_USER_DATA=<scratch> npm start -- --remote-debugging-port=<port>`, raw CDP over WebSocket; `await import("/src/renderer/store.ts")` gives the store) with a sample brain that has a book: screenshots of the front page, a chapter, a picture, a wide and a narrow window, light and dark.
- [ ] **Step 2:** One real first arrangement on a sample brain through `BrainJobRunner` and the real `claude` CLI on the subscription, model sonnet; report tokens used; then one capture showing the new page placed. Delete any temporary test file.
- [ ] **Step 3:** Change note: what changed, how it works, what was verified, known gaps (the mirror of brains with Digest off only refreshed by captures, Windows not checked).
- [ ] **Step 4: Commit** `Brain book: change note`.
