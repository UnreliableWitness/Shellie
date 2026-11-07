# Brain picture coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every picture of every brain source gets a status Shellie computes itself (described, nothing to record, not interpreted, never reached Claude / accepted), gaps are re-evaluated by Claude once automatically, and the owner sees it on the source, Health, the inbox and What runs by itself.

**Architecture:** A new main module `src/main/brain/pictures.ts` computes coverage from the asset files, the wiki pages' links, a skills-written `brain/pictures-skipped.json` and a Shellie-written `brain/pictures-dropped.json`. The converters report each dropped picture; `addSource` records them. A new job kind `pictures` carries the gap list in its prompt (computed when the job starts), runs through `BrainJobRunner`, and is queued automatically after a capture or a refresh that brought pictures, and once per earlier source by a one-time pass at background priority.

**Tech Stack:** Electron main (Node, TypeScript), zod, React renderer, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-07-brain-picture-coverage-design.md`

## Global Constraints

- Nothing writes under `sources/`. Shellie never writes `brain/pictures-skipped.json`; skills never write `brain/pictures-dropped.json` (deny it in the brain's `.claude/settings.json`).
- "Described" = a link or image under `wiki/**/*.md` resolving (via `localTarget` in `check.ts`) to the picture file. A `#slide-N` / `#pN` anchor does **not** count.
- PDF images under 48 px a side (`MIN_IMAGE_SIDE`) are counted (`tiny`), never flagged.
- Accepted drops and tiny images are not gaps: no finding, no warn tag.
- One automatic `pictures` job after a capture (or after a refresh whose attachments changed); a `pictures` job never queues another; the button queues one per press.
- The one-time pass's jobs run at background priority: any non-background queued job goes first.
- Health findings: one `picture` finding per source with gaps, never per picture.
- Telemetry carries no paths, reasons or names; keep `docs/telemetry.md` in sync.
- Checks: `npm test`, `npm run typecheck`, `npm run lint` green at every commit.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MCYrz9uNHQqxpx8zbZHfGW
  ```

## Review Focus

1. A page links a picture at another depth or URL-encoded (`../../sources/a%20b-assets/x.png`, `/sources/...`, `<...>` angle form, image embed with a title) → still **described**. Pinned in Task 1.
2. `brain/pictures-skipped.json` that Claude wrote badly (invalid JSON, wrong shape, an entry with no reason) → treated as empty / entry ignored, Health still renders, a `frontmatter`-style warning is not raised (silent), never a throw. Pinned in Task 1.
3. A picture both cited by a page and listed as skipped → **described** wins; a skipped entry for a file that no longer exists → ignored. Pinned in Task 1.
4. The fix text for a drop must work: re-adding the same file is refused as a duplicate (sha256), so the copy says "Remove the source and add it again on Windows", never "re-add". Pinned in Task 2.
5. A `pictures` job whose gaps were closed before it started (a sync described them) → finishes `done` without calling Claude. Pinned in Task 5.

---

### Task 1: Coverage core

**Files:**
- Create: `src/main/brain/pictures.ts`
- Test: `src/main/brain/pictures.test.ts`
- Modify: `src/shared/brain.ts` (types; `'picture'` in `BrainFindingSchema.kind`)
- Modify: `src/main/brain/check.ts` (`'picture'` in `SHELLIE_FINDING_KINDS`)

**Interfaces:**
- Produces (in `src/shared/brain.ts`):
  ```ts
  export type PictureStatus = 'described' | 'skipped' | 'missing' | 'dropped' | 'accepted';
  export type PictureRow = {
    /** Repo-relative picture file; null for a drop (no file). */
    path: string | null;
    label: string;            // 'Slide 4', 'Page 3', 'Slide layouts and master', 'Picture 2', 'Wiki attachment'
    alt: string | null;       // from the source's ![alt](path), null when none
    status: PictureStatus;
    pages: string[];          // wiki pages citing it (described)
    reason: string | null;    // skip reason, or drop reason
    fix: string | null;       // drops only
    where: string | null;     // drops only, the key used to accept it
  };
  export type PictureCounts = { total: number; described: number; skipped: number; missing: number; dropped: number; accepted: number; tiny: number };
  export type SourcePictures = { source: string; counts: PictureCounts; rows: PictureRow[] };
  ```
- Produces (in `src/main/brain/pictures.ts`):
  ```ts
  export const SKIPPED_FILE = 'brain/pictures-skipped.json';
  export const DROPPED_FILE = 'brain/pictures-dropped.json';
  export const MIRROR_SOURCE = 'sources/wiki';
  export type PictureDrop = { where: string; reason: string; fix: string; accepted: string | null };
  export type DroppedFile = Record<string, { dropped: PictureDrop[]; tiny: number }>;
  export type SkippedFile = Record<string, { reason: string; at: string }>;
  export function readSkipped(brainDir: string): Promise<SkippedFile>;      // tolerant: bad JSON/shape → {}, bad entries dropped
  export function readDropped(brainDir: string): Promise<DroppedFile>;      // tolerant the same way
  export function writeDropped(brainDir: string, update: (f: DroppedFile) => DroppedFile): Promise<void>; // pretty JSON + '\n'
  export function assetsOf(brainDir: string, source: string): Promise<string[]>; // files in sources/<stem>-assets/, or sources/wiki/.attachments/ for MIRROR_SOURCE; repo-relative, sorted
  export function pictureLabel(file: string): string;
  export function coverage(input: { source: string; assets: string[]; sourceText: string; pages: WikiPage[]; skipped: SkippedFile; dropped: DroppedFile }): SourcePictures;
  export function brainCoverage(brainDir: string, pages: WikiPage[], sources: BrainSourceRow[]): Promise<SourcePictures[]>; // every non-mirror source with assets or a dropped entry, plus MIRROR_SOURCE when it has attachments
  export function pictureFindings(all: SourcePictures[], at: string): BrainFinding[];
  ```

- [ ] **Step 1: Write the failing tests** in `pictures.test.ts` (temp brain folder like `check.test.ts`; `WikiPage` objects built with `readPages` from written files):
  - `counts a picture linked from a page as described, with the page` — page `wiki/arch.md` contains `[diagram](../sources/2026-11-04-deck-assets/slide-4-1.png)` → row status `described`, `pages: ['wiki/arch.md']`.
  - `resolves encoded, absolute and deeper links` — `wiki/sub/x.md` with `![d](../../sources/a%20b-assets/p3-1.png "t")` and `wiki/y.md` with `[d](/sources/a b-assets/p4-1.png)` → both described.
  - `does not count a slide anchor` — `[Deck slide 4](../sources/2026-11-04-deck.md#slide-4)` only → `missing`.
  - `marks a skipped picture with its reason, and described wins over skipped`.
  - `ignores a skipped entry whose file is gone and a bad skipped file` — `readSkipped` on `{not json` → `{}`; on `{"a":{"at":"x"}}` (no reason) → `{}`.
  - `lists drops, accepted ones apart, and counts tiny images` — dropped entry with one `accepted: null`, one accepted, `tiny: 23` → counts `{dropped:1, accepted:1, tiny:23}`, rows with `path: null`, `where` set.
  - `labels pictures from their file names` — `slide-4-1.png`→`Slide 4`, `p3.png`→`Page 3`, `p3-2.png`→`Page 3`, `layout-1.png`→`Slide layouts and master`, `image-2.jpg`→`Picture 2`, a mirror attachment → `Wiki attachment`.
  - `takes the alt text from the source` — source text `![Integration architecture]({stem}-assets/slide-4-1.png)` → `alt: 'Integration architecture'`.
  - `one finding per source with gaps, none for accepted drops or tiny images` — `pictureFindings` returns one `{kind:'picture', page: source, detail: '1 picture not interpreted · 2 never reached Claude'}`; a source with only accepted drops and tiny images → none.

- [ ] **Step 2: Run** `npx vitest run src/main/brain/pictures.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** the types and `pictures.ts`. Use `localTarget` from `check.ts` for every page link (`WikiPage.links` already holds both link and image targets — confirm in `pages.ts`; extend `linkTargets` if image targets are missing). Alt text: scan the source text for `!\[([^\]]*)\]\(([^)\s]+)` and match the resolved target. Finding detail parts joined with ` · `, singular/plural by count, parts omitted when 0. Add `'picture'` to the zod enum and to `SHELLIE_FINDING_KINDS`.

- [ ] **Step 4: Run** the test file and `npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `Brain pictures: coverage from pages, skip marks and drop records`.

---

### Task 2: Converters report each dropped picture

**Files:**
- Modify: `src/main/brain/convert/types.ts`, `convert/pdf.ts`, `convert/pptx.ts`, `convert/docx.ts`, `convert/xlsx.ts`
- Test: the existing `convert/*.test.ts` files

**Interfaces:**
- Produces: `Converted` gains `dropped: { where: string; reason: string; fix: string }[]` and `tiny: number`. `ImageCollector` gains `drop(where: string, reason: string, fix: string): void`, `tinyImage(): void`, `readonly dropped`, `tiny`; `addAny(stem, data, ext, where?: string)` and `add(name, data, where?: string)` record a drop themselves when they return null (`where` defaults to `pictureLabel(stem or name)` from Task 1 plus `, picture K` when the stem has a K). Warnings stay exactly as today.
- Copy (exact):
  - over the cap: reason `over the 60-picture limit`, fix `Split the file, or remove pictures that carry nothing, then remove the source and add it again`.
  - EMF/WMF not converted: reason `EMF converts on Windows only` (`WMF …` for wmf), fix `Remove the source and add it again on Windows, or save the picture as PNG in the file`.
  - other format not converted: reason `<EXT> could not be converted`, fix `Save the picture as PNG in the file, then remove the source and add it again`.
  - PDF image over 25 megapixels: reason `over 25 megapixels`, fix `Export the page as an image and add it as its own source`.
  - PDF render cap: one drop per unrendered page, where `Page N (drawing)`, reason `past the 20-page render limit`, fix `Split the PDF so each part has at most 20 drawn pages`.
  - render failure / canvas missing: reason `the drawing could not be rendered`, fix `Export the page as an image and add it as its own source`.

- [ ] **Step 1: Write failing tests** next to the existing ones: pptx over the cap (reuse the 60-picture test) → `dropped.length === n` with reason `over the 60-picture limit`, `where` `Slide 61`…; an EMF with no rasterizer → one drop `EMF converts on Windows only` whose fix contains `Remove the source and add it again`; PDF fixture with the render cap (the 22-page fixture) → two `past the 20-page render limit` drops; a PDF with a 20×20 image → `tiny === 1`, no drop; docx with an EMF → one drop `Picture 1`.
- [ ] **Step 2: Run** `npx vitest run src/main/brain/convert` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** In `pdf.ts` call `images.tinyImage()` where `MIN_IMAGE_SIDE` skips; pass `where` `Page N` to `add`. Keep `MIN_IMAGE_SIDE` and every warning unchanged.
- [ ] **Step 4: Run** the convert tests, `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `Brain converters: report each picture that could not be taken`.

---

### Task 3: Record drops when a source is added or removed

**Files:**
- Modify: `src/main/brain/sources.ts` (`addSource`, `removeSource`), `src/shared/brain.ts` (`AddSourceResult` ok branch gains `dropped: number`)
- Test: `src/main/brain/sources.test.ts`

**Interfaces:**
- Consumes: `writeDropped`, `DROPPED_FILE` (Task 1); `Converted.dropped/tiny` (Task 2).
- Produces: after a successful add with drops or tiny > 0, `DROPPED_FILE` holds `{ [sources/<name>]: { dropped: [...accepted: null], tiny } }` and is staged in the same `Brain: add source` commit (add it to `rels`; rolled back with the rest on failure). `removeSource` deletes the key in the same commit as the removal.

- [ ] **Step 1: Failing tests:** `records dropped pictures in the add commit` (fake converter output via a pptx built with JSZip containing an EMF and no rasterizer → file exists, `git show --stat HEAD` lists it, result `dropped: 1`); `adds no drop file when nothing was dropped`; `removes the entry when the source is removed`; `keeps other sources' entries`.
- [ ] **Step 2: Run** `npx vitest run src/main/brain/sources.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Write through `writeDropped`; on rollback restore the previous file content (read before writing).
- [ ] **Step 4: Run** — PASS; `npm run typecheck` (fix `AddSourceResult` literals in renderer tests with `dropped: 0`).
- [ ] **Step 5: Commit** — `Brain sources: keep a record of pictures that never reached Claude`.

---

### Task 4: Health, the source's pictures and accepting a drop (main)

**Files:**
- Modify: `src/main/brain/health.ts`, `src/shared/brain.ts` (`BrainHealth.pictures: PictureCounts`), `src/main/brain/brainHandlers.ts`, `src/shared/ipc.ts`
- Test: `src/main/brain/health.test.ts`, `src/main/brain/brainHandlers.test.ts`

**Interfaces:**
- Consumes: `brainCoverage`, `pictureFindings`, `writeDropped` (Task 1).
- Produces:
  - `BrainHealth.pictures`: summed `PictureCounts` over all sources; `findings` include `pictureFindings(...)`.
  - IPC `'brain:pictures': { args: [brainId: string, source: string]; result: SourcePictures }`.
  - IPC `'brain:acceptDrop': { args: [brainId: string, source: string, where: string]; result: void }` — sets `accepted` to now on the matching drop and commits `DROPPED_FILE` alone as `Brain: accepted dropped picture`, under `withBrainGit`; throws `Unknown dropped picture` when no match.
  - `'brain:run'` kind union gains `'pictures'`.

- [ ] **Step 1: Failing tests:** health with one missing picture → `pictures.missing === 1` and one `picture` finding; `brain:pictures` returns rows for a source; `brain:acceptDrop` flips `accepted`, makes one commit, and the next `brain:get` has no `picture` finding for that source; unknown `where` throws.
- [ ] **Step 2: Run** `npx vitest run src/main/brain/health.test.ts src/main/brain/brainHandlers.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Compute coverage once per `brainHealth` call from the pages and sources it already reads (no image bytes read; directory listings only).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `Brain health: pictures counted, one finding per source with gaps`.

---

### Task 5: The `pictures` job kind in the runner

**Files:**
- Modify: `src/shared/brain.ts` (`BrainJobKind` + `'pictures'`, in `SOURCE_JOB_KINDS`; `BrainJob.background: boolean`), `src/main/brain/jobs.ts`
- Test: `src/main/brain/jobs.test.ts`

**Interfaces:**
- Produces:
  - `enqueue(brainId, kind, source = null, opts?: { background?: boolean }): BrainJob`.
  - `BrainJobDeps.promptFor?: (job: BrainJob) => Promise<string | null | undefined>` — called after the lock is taken; `undefined` keeps the default `/${kind} ${source}`, a string replaces it, `null` ends the job `done` with `result: 'Nothing to re-evaluate'` and no Claude call.
  - `BrainJobDeps.afterJob?: (job: BrainJob) => void` — called once per finished job (done or failed), after commit, wrapped in try/catch like `onChange`.
  - `pump` takes the first queued non-background job, else the first queued background one.
  - `lint` is not chained after `pictures` (it is after `capture` only, as today).

- [ ] **Step 1: Failing tests:** `runs a non-background job before queued background ones`; `promptFor replaces the prompt`; `a null prompt finishes the job without running claude` (assert `calls.length === 0`, status `done`); `afterJob sees each finished job once`; `a pictures job needs a source`.
- [ ] **Step 2: Run** `npx vitest run src/main/brain/jobs.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; update `jobTelemetry` / `brain.job` kind list if it enumerates kinds.
- [ ] **Step 5: Commit** — `Brain jobs: a pictures kind, background priority, prompt and after-job hooks`.

---

### Task 6: Skills v6

**Files:**
- Modify: `src/main/brain/templates.ts` (`TEMPLATES_VERSION = 6`, `SCHEMA`, `CAPTURE`, `SYNC`, new `PICTURES` skill file `.claude/commands/pictures.md`, `SETTINGS` deny list), `src/main/brain/brainHandlers.ts` (`JOB_OUTPUT` + `'brain/pictures-skipped.json'`)
- Test: `src/main/brain/scaffold.test.ts`

**Interfaces:**
- Produces: the prompt shape `/pictures <source> <JSON array of repo-relative picture paths>` (one line), which Task 7 builds.
- Content the skills must say (wording is the implementer's, these facts are fixed):
  - SCHEMA: `brain/pictures-skipped.json` format `{ "<picture path>": { "reason": "…", "at": "<ISO>" } }`, written only by skills, read it first and keep other entries; `brain/pictures-dropped.json` is Shellie's, never touch it. Citation rule: a fact taken from a picture cites **the picture file** (`[Deck slide 4 diagram](../sources/2026-11-04-deck-assets/slide-4-1.png)`), in addition to or instead of the slide anchor.
  - CAPTURE / SYNC: for every picture, either describe it on a page citing the picture file, or add it to the skipped file with a short reason; a picture that carries knowledge is never skipped.
  - PICTURES: takes the source and the JSON list; opens each listed picture, then describes (may update existing pages) or marks it; touches no other picture; inserts a log line; same "never edit sources/, no CLAUDE.md, do not touch state.json" rules; for `sources/wiki` the pages are the mirror's.
  - SETTINGS deny: `Edit(brain/pictures-dropped.json)`, `Write(brain/pictures-dropped.json)`, `MultiEdit(brain/pictures-dropped.json)`.

- [ ] **Step 1: Failing tests:** scaffold writes `.claude/commands/pictures.md`; capture skill mentions `brain/pictures-skipped.json`; settings deny the dropped file; `JOB_OUTPUT` commits the skipped file after a job (handler test with a fake job writing it).
- [ ] **Step 2: Run** `npx vitest run src/main/brain/scaffold.test.ts src/main/brain/brainHandlers.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `Brain skills v6: cite pictures, mark the ones with nothing to record, /pictures`.

---

### Task 7: Automatic re-evaluation

**Files:**
- Modify: `src/main/brain/pictures.ts` (two functions below), `src/main.ts` (runner deps), `src/main/brain/brainHandlers.ts` (refresh), `src/main/brain/mirror.ts` (`RefreshResult` ok gains `attachments: number`; record unviewable attachments), `src/shared/brain.ts`
- Test: `src/main/brain/pictures.test.ts`, `src/main/brain/brainHandlers.test.ts`, `src/main/brain/mirror.test.ts`

**Interfaces:**
- Consumes: Task 1 coverage, Task 5 hooks, Task 6 prompt shape.
- Produces (in `pictures.ts`):
  ```ts
  /** The prompt for a pictures job: null when the source has no picture left to interpret. */
  export function picturesPrompt(brainDir: string, source: string): Promise<string | null>;
  /** After a job: a capture that left gaps queues one pictures job for its source. */
  export function afterPictureJob(job: BrainJob, d: { brainDir: (id: string) => string; enqueue: BrainRunner['enqueue'] }): Promise<void>;
  ```
- Behaviour: `main.ts` passes `promptFor: async (j) => j.kind === 'pictures' && j.source ? picturesPrompt(brainOf(j.brainId).path, j.source) : undefined` and `afterJob: (j) => void afterPictureJob(j, …)`. `afterPictureJob` acts only on `capture` + `done`. `brain:refresh`: when `r.ok && r.attachments > 0`, enqueue `pictures` for `MIRROR_SOURCE` after the optional sync. `refreshMirror` writes the unviewable attachments as drops under `MIRROR_SOURCE` (reason `<EXT> attachments cannot be viewed`, fix `Attach the picture to the wiki page as PNG`), replacing that key's list but keeping `accepted` for entries with the same `where` (`where` = the attachment file name).

- [ ] **Step 1: Failing tests:** `picturesPrompt` returns `/pictures sources/x.md ["sources/x-assets/slide-11-1.png"]` for one gap and `null` with none; `afterPictureJob` enqueues once after a capture with gaps, never after a `pictures` job, never after a failed capture; refresh with changed attachments enqueues `pictures` for `sources/wiki`; mirror records an unviewable attachment and keeps its `accepted` across refreshes.
- [ ] **Step 2: Run** the three test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `Brain pictures: re-evaluate gaps once after a capture or a refresh`.

---

### Task 8: One-time pass for earlier sources

**Files:**
- Modify: `src/shared/brain.ts` (`BrainSchema.picturePass: { startedAt: string; total: number; done: string[]; finishedAt: string | null } | null`, default null), `src/main/brain/pictures.ts`, `src/main/brain/scheduler.ts`, `src/main.ts`
- Test: `src/main/brain/pictures.test.ts`, `src/main/brain/scheduler.test.ts`

**Interfaces:**
- Produces (in `pictures.ts`):
  ```ts
  /** Rebuilds drop records from stored originals for sources without one; never writes sources/. Commits DROPPED_FILE alone as 'Brain: dropped pictures of earlier sources' when it changed. */
  export function rebuildDrops(git: GitClient, brainDir: string, sources: BrainSourceRow[], opts: ConvertOptions): Promise<void>;
  /** Starts or resumes the pass: queues a background pictures job per source with gaps not in picturePass.done, oldest first; returns the new picturePass. */
  export function runPicturePass(b: Brain, d: { git: GitClient; rasterize?: Rasterize; enqueue: BrainRunner['enqueue']; jobs: BrainRunner['jobs']; now: () => Date }): Promise<Brain['picturePass']>;
  ```
- Behaviour: scheduler gains `picturePass: (id: string) => void`, called on each check for a brain that is not archived, has `templatesVersion >= 6`, and has `picturePass === null` or `finishedAt === null` with no background `pictures` job of it queued or running (that covers app restarts). `afterJob` (Task 7's wiring) adds the source to `picturePass.done` for a finished background `pictures` job and sets `finishedAt` when `done.length >= total`. A pass with nothing to do finishes at once (`total: 0`).

- [ ] **Step 1: Failing tests:** rebuild reads a stored `.pptx` original with an EMF and writes one drop, leaving the source file byte-identical; a pasted-text source (no original) gets no entry; pass queues background jobs oldest first and skips sources in `done`; restart (no jobs queued, `finishedAt` null) re-queues only the remaining sources; scheduler does not call `picturePass` for templates v5 or archived brains; a finished pass is not started again.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Convert originals with `convertFile` from `convert/index.ts`, one at a time.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `Brain pictures: one pass over earlier sources, in the background`.

---

### Task 9: Renderer

**Files:**
- Create: `src/renderer/components/brain/SourcePictures.tsx`, `SourcePictures.test.tsx`
- Modify: `BrainPage.tsx` (panel above the source text, warn tag in the source header), `BrainHealth.tsx` (Pictures fact; `picture` finding buttons; prop `onOpen?: (path: string) => void` passed from its parent), `BrainInbox.tsx` + `BrainTab.tsx` (a live picture line per recently added source), `AutoRuns.tsx` (pass row), `brainActions.ts`, `src/renderer/styles/brain.css`
- Test: `BrainPage.test.tsx`, and a Health/AutoRuns test where one exists

**Interfaces:**
- Consumes: `brain:pictures`, `brain:acceptDrop`, `brain:run(id, 'pictures', source)`, `BrainHealth.pictures`, `Brain.picturePass`, `BrainJob.background`.
- UI as in the mockups `docs/superpowers/specs/assets/2026-11-07-picture-coverage-*.png`:
  - Panel: title `Pictures`, counts line (`11 described · 2 nothing to record · 1 not interpreted · 2 never reached Claude`, parts with 0 omitted, `plus 23 tiny images not looked at` when tiny > 0), a bar in `--green` / `--muted` / `--warn` / `--red`, rows with a thumbnail (`brain:asset`; a dashed box with the extension for drops), label · alt, the citing pages as links (`onOpen`), the reason, the fix; tags `described` (`tag-green`), `nothing to record` (`tag-muted`), `not interpreted` (`tag-warn`), `never reached Claude` (`tag-red`), `accepted` (`tag-muted`). First 5 rows, then `Show all N`. Button `Re-evaluate N picture(s)` when missing > 0 (disabled while a `pictures` job for the source is queued or running, label `Re-evaluating…`); `Fine, I know` on each unaccepted drop. Refetch on `brain:changed`.
  - Source header tag `N picture(s) not interpreted` (`tag-warn`) when missing + dropped > 0.
  - Health: fact `Pictures` → `211 of 214 interpreted · 1 not interpreted · 2 never reached Claude` (interpreted = described + skipped; total excludes tiny); a `picture` finding shows `Re-evaluate` when the source has missing pictures (detail contains `not interpreted`), else `Open source`.
  - Inbox / task tab: under the existing `Added …` line, while the source's capture or `pictures` job is queued/running: `Capture done · 13 of 14 pictures interpreted · re-evaluating 1 picture…`; when idle and complete: `all 14 pictures interpreted` (`tag-green`).
  - AutoRuns row `Picture check for earlier sources` with `N sources, M pictures captured before Shellie checked pictures. Re-evaluating them in the background, D of N done.` while `picturePass.finishedAt === null && total > 0`.
- Telemetry: `trackBrain('reevaluate')`, `trackBrain('accept-drop')`.

- [ ] **Step 1: Failing tests** (`SourcePictures.test.tsx` with a mocked `api().invoke`): renders counts and the four tags; `Re-evaluate 1 picture` invokes `brain:run` with `'pictures'`; `Fine, I know` invokes `brain:acceptDrop` with the row's `where`; omits zero parts; shows `Show all 16` after 5 rows. `BrainPage.test.tsx`: the warn tag appears for a source with gaps.
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/brain` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `npm run lint`.
- [ ] **Step 5: Commit** — `Brain pictures: the source panel, Health, inbox and the earlier-sources pass`.

---

### Task 10: Docs, telemetry and a live check

**Files:**
- Modify: `docs/telemetry.md` (`brain.job` kind `pictures`; `brain.screen.action` `reevaluate`, `accept-drop`)
- Create: `docs/changes/2026-11-07-brain-picture-coverage.md` (spec, how it works, verified, known gaps — same shape as `2026-11-04-brain-images-2.md`)

- [ ] **Step 1: Live check, GUI-free** (the workaround in the brain change notes: a temporary vitest file run with `--silent=false --disableConsoleIntercept`, deleted afterwards): build a PPTX with JSZip holding a diagram PNG, a logo on the master and an EMF; `addSource` with the real rasterizer into a fresh scaffolded brain; run the real headless `/capture` through `BrainJobRunner` with the real `claude`; then compute coverage. Expected: diagram `described`, logo `skipped` with a reason, EMF `dropped` (on macOS). Remove the diagram citation from the page, run the `pictures` job, expect it `described` again. Confirm the one-line JSON prompt reaches the skill intact (spaces in a path included).
- [ ] **Step 2: Write** the change note with what the live check showed, and the telemetry rows.
- [ ] **Step 3: Run** `npm test && npm run typecheck && npm run lint` — Expected: all green.
- [ ] **Step 4: Commit** — `Brain pictures: change note and telemetry`.
