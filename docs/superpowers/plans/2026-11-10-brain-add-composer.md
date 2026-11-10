# Brain Add composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Add view's paste form, per-file rows, Waiting to capture and Recent work with one composer (title, Monaco Markdown editor, file chips, one note, Capture with, one Add) and one Activity list.

**Architecture:** Main gains a per-job model override (`BrainJob.model`) threaded through `brain:addFiles`, `brain:addText` and `brain:run`. The renderer gets a `composer/` folder: pure helpers (title, formatting, HTML to Markdown, file kinds, activity grouping), a per-brain draft in the store mirrored to local storage, a `MarkdownEditor` (Monaco, with a textarea until Monaco loads), `Composer` and `Activity`. `BrainAdd` lays them out; `BrainTab` keeps `useBrainDrop` and `PendingFiles` unchanged.

**Tech Stack:** Electron, React 19, TypeScript, zustand, monaco-editor (already a dependency), react-markdown via `MarkdownView`, new `turndown@7.2.4` + `turndown-plugin-gfm@1.0.2` (+ `@types/turndown@5.0.6`), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-10-brain-add-composer-design.md` (mockups: https://claude.ai/artifact/HNagkGz94qedVqMRGP13Mu).

## Global Constraints

- Agent-neutral copy: never "Claude" in the Add view's texts; model names (Haiku, Sonnet, Opus, OpenCode `provider/model`) are the exception.
- Claude Code model override must be one of `haiku|sonnet|opus`; an OpenCode one must pass `isOpencodeModel`. Anything else is refused in main with `Unknown model <x>`.
- The override reaches capture jobs only (and their Retry). Lint, sync, digest, pictures, retract, the book and every automatic job use the brain's model.
- Telemetry: `brain.screen.action` with counts and kinds only; never text, titles, file names, notes or an OpenCode model string. Model kind is `haiku|sonnet|opus|opencode`.
- Look: `tokens.css` variables only (dark and light), existing `.btn`, `.field`, `HelpTip`, `brain-card`.
- `BrainTab` (the task's Brain tab) must not change behaviour: it keeps `useBrainDrop` + `PendingFiles` + `brainPending`.
- Checks: `npm test`, `npm run typecheck`, `npm run lint` (oxlint + oxfmt; format with `npx oxfmt`).
- Commits end with the session's attribution lines.

## Review Focus

- A Monaco load failure (broken chunk) must leave a working textarea, not an empty box. Test in Task 4.
- Pasting HTML that is only a wrapper around plain text (Word/Outlook often send `<html><body><p>…`) must give plain paragraphs, not escaped Markdown noise (`\*`, `\_` everywhere) or `<span>` leftovers. Test in Task 2.
- A draft restored from local storage whose file path no longer exists: the chip must go with a problem line, and Add must not send it. Test in Task 3/5 (main's `addFiles` already reports a missing file; the composer must show that result, not swallow it).
- Partial failure of an add: text added, one file refused. Only the refused file stays in the composer, with its problem line; the note stays only if something stayed. Test in Task 5.
- Switching brains with a draft open: each brain keeps its own draft and model; adding in brain B never sends brain A's files. Test in Task 3.

---

### Task 1: Per-job model override in main

**Files:**
- Modify: `src/shared/brain.ts` (BrainJob, export `isBrainModel`)
- Modify: `src/main/brain/jobs.ts` (`make`, `enqueue`, `runSkill`)
- Modify: `src/main/brain/brainHandlers.ts:594-650` (`brain:addFiles`, `brain:addText`, `brain:run`)
- Modify: `src/shared/ipc.ts:662-695` (args)
- Modify: `src/renderer/test-helpers/brainFixture.ts` (`brainJob` gets `model: null`)
- Test: `src/main/brain/jobs.test.ts`, `src/main/brain/brainHandlers.test.ts`

**Interfaces:**
- Produces: `BrainJob.model: string | null` (null = the brain's model at run time). `isBrainModel(m: string): m is BrainModel`. `BrainJobRunner.enqueue(brainId, kind, source?, opts?: { background?: boolean; model?: string | null })`. IPC: `'brain:addFiles': [brainId, files, model?: string]`, `'brain:addText': [brainId, text, title, type, note?: string, model?: string]`, `'brain:run': [brainId, kind, source?: string, model?: string]`.

- [ ] **Step 1: Failing tests in `jobs.test.ts`**
  - `it('runs a capture on the model it was queued with, and the lint after it on the brain\'s')`: `r.enqueue('b1','capture','sources/a.md',{ model: 'opus' })`; after idle, `calls[0].cmd.args` contains `'--model','opus'`; `calls[1].cmd.args` (the auto lint) contains `'--model','sonnet'`; `r.jobs('b1').find(j=>j.kind==='capture')!.model === 'opus'`, the lint's `model === null`.
  - `it('drops a model meant for the other agent')`: runner with `agent: () => 'claude'`, `enqueue(...,{ model: 'openai/gpt-5' })` → args contain `'--model','sonnet'`. Runner with `agent: () => 'opencode'`, `opencodeModel: () => 'opencode/big-pickle'`, `enqueue(...,{ model: 'opus' })` → OpenCode args contain `'-m','opencode/big-pickle'`; with `{ model: 'anthropic/claude-opus' }` → contain `'-m','anthropic/claude-opus'`.
- [ ] **Step 2: Run `npx vitest run src/main/brain/jobs.test.ts`** — expect the two new tests to FAIL (`model` undefined / args `sonnet`).
- [ ] **Step 3: Implement.** `make(..., background, model)` stores `model ?? null`. In `runSkill`: Claude uses `job.model && isBrainModel(job.model) ? job.model : d.model(brainId)`; OpenCode uses `opencodeModelArg(job.model) ?? d.opencodeModel(brainId)` (`opencodeModelArg` already returns null for `opus`). Add `model: null` to `brainJob` fixture and any other literal `BrainJob` in tests that typecheck complains about.
- [ ] **Step 4: Run the jobs tests** — PASS.
- [ ] **Step 5: Failing tests in `brainHandlers.test.ts`**
  - `addText` with model `'opus'` queues a capture whose `model` is `'opus'`; `addFiles(v.id, [row], 'haiku')` likewise; `run(v.id,'capture',src,'opus')` likewise; `run(v.id,'lint',undefined,'opus')` queues a lint with `model: null` (override only for capture).
  - `addText(..., 'gpt 5; rm')` rejects with `/Unknown model/` and adds nothing (no new source file).
- [ ] **Step 6: Run them** — FAIL.
- [ ] **Step 7: Implement** a `checkModel(model?: string): string | null` in `brainHandlers.ts` (undefined/'' → null; `isBrainModel` or `isOpencodeModel` → the string; else throw `Unknown model ${model}`), called before any write; pass `{ model }` to `enqueue` for captures; `brain:run` passes it only when `kind === 'capture'`. Update `src/shared/ipc.ts` args as in Interfaces.
- [ ] **Step 8: Run `npx vitest run src/main/brain` and `npm run typecheck`** — PASS.
- [ ] **Step 9: Commit** `Brain: a capture can run on a model of its own`.

### Task 2: Pure composer helpers and HTML to Markdown

**Files:**
- Create: `src/renderer/components/brain/composer/text.ts`, `text.test.ts`
- Create: `src/renderer/components/brain/composer/htmlToMarkdown.ts`, `htmlToMarkdown.test.ts`
- Create: `src/types/turndown-plugin-gfm.d.ts` (module declaration: `export const gfm: (s: TurndownService) => void`)
- Modify: `package.json`, `package-lock.json` (`npm install turndown@7.2.4 turndown-plugin-gfm@1.0.2` and `-D @types/turndown@5.0.6`, exact versions)

**Interfaces:**
- Produces (in `text.ts`):
  - `titleFor(title: string, text: string): string` — trimmed title; else first ATX heading's text (`#`–`######`, markers and trailing `#` stripped); else first non-empty line, Markdown list/quote markers stripped, cut to 60 chars at a word boundary with `…`; else `''`.
  - `type Format = 'heading' | 'bold' | 'italic' | 'bullets' | 'checklist' | 'link' | 'code' | 'table'`; `applyFormat(f: Format, text: string, start: number, end: number): { text: string; start: number; end: number }` — bold/italic/code wrap the selection (`**`, `_`, `` ` ``; a multi-line selection for code becomes a ``` fence), empty selection inserts the markers with the caret between; heading/bullets/checklist prefix every selected line (`## `, `- `, `- [ ] `), toggling off when all lines already have it; link gives `[sel](url)` with `url` selected; table inserts a 2×2 GFM table on its own lines.
  - `isEditorText(name: string): boolean` — `/\.(md|markdown|txt)$/i`.
  - `fileKind(name: string): 'pdf' | 'word' | 'deck' | 'sheet' | 'drawio' | 'transcript' | 'text' | 'picture' | 'other'` by extension (for the chip icon).
  - `BIG_FILE_BYTES = 5 * 1024 * 1024`; `suggestStronger(files: { name: string; bytes: number }[]): string | null` — returns `'the deck'` when a `.pptx` is attached, else `'the large file'` when any file ≥ `BIG_FILE_BYTES`, else null.
- Produces (in `htmlToMarkdown.ts`): `htmlToMarkdown(html: string): string` — turndown with `headingStyle: 'atx'`, `bulletListMarker: '-'`, `codeBlockStyle: 'fenced'`, `emDelimiter: '_'`, gfm plugin; removes `script`, `style`, `meta`, `head`, `title`; collapses 3+ newlines to 2; trims.

- [ ] **Step 1: Failing tests** (`text.test.ts`): `titleFor('', '# Steerco 5 Nov\n\nx') === 'Steerco 5 Nov'`; `titleFor('', 'just a line\nmore') === 'just a line'`; `titleFor('  Mine ', '# H') === 'Mine'`; a 100-char first line ends in `…` and is ≤ 61 chars; `titleFor('', '\n\n') === ''`. `applyFormat('bold','ab cd',3,5)` → `{ text: 'ab **cd**', start: 5, end: 7 }`; `applyFormat('bullets','a\nb',0,3).text === '- a\n- b'` and applying it again gives back `'a\nb'`; `applyFormat('checklist','x',0,0).text === '- [ ] x'`; `applyFormat('link','see docs',4,8)` → text `'see [docs](url)'`, selection on `url`. `isEditorText('A.MD')`, not `'a.pdf'`. `suggestStronger([{name:'a.pptx',bytes:1}]) === 'the deck'`, `([{name:'a.pdf',bytes:6e6}]) === 'the large file'`, `([]) === null`.
- [ ] **Step 2: Failing tests** (`htmlToMarkdown.test.ts`): `<h2>Decided</h2><ul><li>Go-live <b>2 Feb</b></li></ul>` → `'## Decided\n\n- Go-live **2 Feb**'`; a link → `[spec](https://x)`; a `<table>` with `<th>` → a GFM table with a `| --- |` row; `<style>p{}</style><script>x()</script><p>Hi</p>` → `'Hi'`; Outlook-like `<html><body><p class="MsoNormal"><span style="x">Plain words here</span></p></body></html>` → `'Plain words here'` (no `<span>`, no backslash escapes); a Teams-like `<div><div>Anna</div><div><p>Line one</p><p>Line two</p></div></div>` → contains `'Line one\n\nLine two'`.
- [ ] **Step 3: Run `npx vitest run src/renderer/components/brain/composer`** — FAIL (modules missing).
- [ ] **Step 4: Install the packages, implement both files.**
- [ ] **Step 5: Run the tests, `npm run typecheck`** — PASS.
- [ ] **Step 6: Commit** `Brain composer: title, formatting and paste-as-Markdown helpers`.

### Task 3: The per-brain draft

**Files:**
- Create: `src/renderer/components/brain/composer/draft.ts`, `draft.test.ts`
- Modify: `src/renderer/store.ts` (state `brainDrafts`, `setBrainDraft`)

**Interfaces:**
- Produces:
  - `type DraftFile = { name: string; path: string; bytes: number; type: SourceType; ownNote: string | null }` (`ownNote` null = uses the shared note; a string, even empty, = the Own note field is open).
  - `type ComposerDraft = { title: string; text: string; textType: SourceType; note: string; files: DraftFile[]; model: string | null }` (`model` null = the brain's).
  - `EMPTY_DRAFT: ComposerDraft` (`textType: 'note'`, everything else empty/null).
  - store: `brainDrafts: Record<string, ComposerDraft>`, `setBrainDraft(brainId: string, update: (d: ComposerDraft) => ComposerDraft): void`.
  - `useComposerDraft(brainId: string): { draft: ComposerDraft; update(patch: Partial<ComposerDraft> | ((d: ComposerDraft) => ComposerDraft)): void; clear(): void; isEmpty: boolean }` — reads the store; on first use for a brain with no store entry, loads `shellie.brain.draft.<brainId>` from local storage (try/catch, zod-validated, `model` never restored → null); every update writes the draft without `model` back to local storage, debounced 300 ms; `clear()` resets to `EMPTY_DRAFT` and removes the key.
  - `draftIsEmpty(d: ComposerDraft): boolean` — no text (trimmed), no title, no note, no files.

- [ ] **Step 1: Failing tests** (`draft.test.ts`, `renderHook`): an update survives unmount/remount (store); drafts of `b1` and `b2` are independent; after a store reset, the draft for `b1` comes back from local storage with `model: null` even if `model` was `'opus'`; corrupt JSON in local storage gives `EMPTY_DRAFT` without throwing; `clear()` removes the key; a local storage that throws on `setItem` does not break `update`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** (use `local()` from `src/renderer/localStorage.ts`; fake timers in the test for the debounce).
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `Brain composer: a draft per brain that survives a reload`.

### Task 4: MarkdownEditor

**Files:**
- Create: `src/renderer/components/brain/composer/MarkdownEditor.tsx`, `MarkdownEditor.test.tsx`
- Modify: `src/renderer/review/monacoSetup.ts` only if the `shellie-dark`/light theme needs Markdown token colours (optional `rules` for `keyword.md`, `string.link.md`, `variable.md`); no new worker.

**Interfaces:**
- Consumes: `applyFormat`, `Format` (Task 2), `htmlToMarkdown` (Task 2), `loadMonaco`, `useColorScheme`/`currentColorScheme` from `colorScheme.ts` (move `DiffView`'s private `monacoTheme` there and export it), `MarkdownView` (`src/renderer/components/docs/MarkdownView.tsx`) for the preview (`asset` rejects, `path: 'draft.md'`, no-op `onOpenDoc`/`onOpenFile`, `idPrefix: 'draft-'`).
- Produces: `type EditorView = 'write' | 'split' | 'preview'`; `MarkdownEditor(props: { value: string; onChange(v: string): void; onSubmit(): void; placeholder: string; view: EditorView; onView(v: EditorView): void; label: string })`. Remembers nothing itself (the Composer stores `view` in local storage `shellie.brain.editorView`).

Behaviour: a toolbar (`role="toolbar"`, `aria-label="Formatting"`) with buttons labelled Heading, Bold, Italic, Bulleted list, Checklist, Link, Code, Table (Fluent icons), and a Write / Split / Preview group (`role="tablist"`). Until Monaco has loaded, and for good when `loadMonaco` rejects, the editor is a `<textarea aria-label={label}>` with the same value, toolbar and Ctrl/Cmd+Enter. Once loaded: `monaco.editor.create(host, { language: 'markdown', wordWrap: 'on', lineNumbers: 'on', minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, fontFamily: var(--font-code) })`, the model kept in sync with `value` (setValue only when they differ), `addCommand(CtrlCmd|Enter, onSubmit)`. Toolbar buttons read the selection as offsets, call `applyFormat`, write back with one `executeEdits` (undoable) and set the selection. Paste: a capture-phase `paste` listener on the editor's wrapper; when `clipboardData` has `text/html`, prevent default, insert `htmlToMarkdown(html)` at the selection, and show "Pasted as Markdown · Paste as plain text" in the toolbar for 10 s; "Paste as plain text" replaces the inserted range with `text/plain`. Preview and Split render `MarkdownView` with the value.

- [ ] **Step 1: Failing tests** (mock `loadMonaco` to a never-settling promise, and in one test to a rejection): typing in the textarea calls `onChange`; Ctrl+Enter and Meta+Enter call `onSubmit`; Bold with "cd" selected in `'ab cd'` calls `onChange('ab **cd**')`; pasting a ClipboardEvent with `text/html` `<ul><li>a</li></ul>` calls `onChange('- a')`, shows "Pasted as Markdown", and "Paste as plain text" calls `onChange` with the plain text; Preview shows the rendered heading (`getByRole('heading', { name: 'Hi' })` for `# Hi`) and no textarea; after a rejected load the textarea is still there and typing works.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** `Brain composer: a Markdown editor with toolbar, preview and paste as Markdown`.

### Task 5: Composer

**Files:**
- Create: `src/renderer/components/brain/composer/Composer.tsx`, `Composer.test.tsx`, `FileChip.tsx`, `ModelPicker.tsx`
- Modify: `src/renderer/components/brain/brainActions.ts` (`BrainAction` gains `'paste-markdown' | 'paste-plain' | 'editor-view' | 'discard'`; `trackBrainAdd(p: { text: boolean; files: number; note: boolean; ownNotes: number; model: 'haiku'|'sonnet'|'opus'|'opencode'; overridden: boolean })` sends `brain.screen.action` with `action: 'add'` plus those props)
- Modify: `src/renderer/components/brain/useBrainDrop.ts` only to export `addedOf` and `failures` if not exported (no behaviour change)

**Interfaces:**
- Consumes: Tasks 2–4; IPC from Task 1; `AddedNotes` from `PendingFiles.tsx` (unchanged, shown under the success line until Activity lists those sources — keep it, it already shows per-file lines and picture progress).
- Produces: `Composer(props: { brain: BrainView; focus?: boolean; expanded: boolean; onExpand(): void; dropping: { over: boolean; names: string[] } })` and `useComposerFiles(brainId)` returning `addFiles(files: File[]): void` (used by `BrainAdd`'s page-wide drop: an editor text file goes into the empty editor, read with `File.text()`, title = name without extension, `textType: 'doc'`; others become `DraftFile`s with `bytes: f.size`, `type: guessType(name)`; a path already in the draft is skipped; no path → problem line `<name>: not a file on disk`).

Behaviour (spec "The composer", "Capture with", "After Add"):
- Header `Add to <brain.name>` and a `?` (`aria-label="How adding works"`) toggling a popover with `HowItWorks`' four steps (export `STEPS` from `HowItWorks.tsx`).
- Title input (`aria-label="Title"`, placeholder `Title (optional, made from the first heading)`), `MarkdownEditor` (`label="Text"`), file chips (`FileChip`: kind badge, name, size, type select `aria-label="Type of <name>"`, `Own note` link / input `aria-label="Own note for <name>"`, remove `aria-label="Remove <name>"`), `Attach files` (file input), the note textarea (`aria-label="Note for the agent"`, rows 2, hint text from the spec), footer: `Text goes in as` select (only when there is text), `ModelPicker`, the hint, `Discard`, primary button.
- Button label: `Add` (nothing), `Add text`, `Add 1 file`, `Add n files`, `Add text and 1 file`, `Add text and n files`; disabled with nothing or while adding.
- `ModelPicker`: `aria-label="Capture with"`. Claude brain: Haiku, Sonnet, Opus; the brain's option text gets ` (brain default)`. OpenCode brain: `agents:opencodeModels` (fetched once on mount, `tryInvoke`), brain's `opencodeModel` first labelled `(brain default)`, or an `OpenCode default` option when it is null. Value null = brain default. Hint `Opus may capture <suggestStronger(...)> better` when Claude, `suggestStronger` non-null and the value is not `opus`; for OpenCode no hint.
- Add: text (non-empty after trim) → `brain:addText(id, text, titleFor(title, text), textType, note || undefined, model ?? undefined)`; files → `brain:addFiles(id, rows, model ?? undefined)` with `note: ownNote ?? note` (trimmed, omitted when empty). Results: failed text keeps text+title; failed files stay as chips; a problem list (`role="alert"`) shows every failure message; when nothing stayed, the draft is cleared (model back to null) and the success line shows `Added <title> and n files. Capturing now; you can keep adding.` (or `Added n files…` / `Added <title>…`), dismissable (`aria-label="Dismiss"`). Calls `trackBrainAdd`.
- Discard: clears at once when the text has ≤ 20 words and no files; else asks inline (`Discard this draft?` Discard / Keep).
- Collapsed (`expanded=false`, after a successful add): one row with an input `aria-label="Write or paste"` (placeholder `Write or paste, or drop files…`) and Attach files; focusing or typing into it calls `onExpand` and moves the typed text into the draft.
- Drop overlay (`dropping.over`): over the composer column, "Drop to add n files", one line per name: `opens in the editor` for the first editor text file when the editor is empty, else `attached as it is`, then the formats line (`PDF, Word, PowerPoint, Excel, draw.io, VTT, Markdown, text, pictures`). Names come from `DataTransfer.items` where the browser gives them; when it does not, the overlay says "Drop to add files".

- [ ] **Step 1: Failing tests** (`Composer.test.tsx`, `installFakeApi`, `MarkdownEditor` used for real with `loadMonaco` mocked never-settling):
  - text + two files + one note in one press: `brain:addText` called with `(id, '# Steerco\n\nx', 'Steerco', 'note', 'Context', undefined)` and `brain:addFiles` with both rows carrying `note: 'Context'`; button read `Add text and 2 files` before.
  - an Own note on one file replaces the shared note for that file only.
  - choosing Opus sends `'opus'` as the last arg of both calls; after a successful add the picker shows the brain default again.
  - OpenCode brain lists `agents:opencodeModels` results with the brain's model first, `(brain default)`, and no hint.
  - a `.pptx` chip on a Sonnet brain shows `Opus may capture the deck better`; picking Opus hides it.
  - partial failure: `addFiles` answers one ok and one `{ ok: false, message: 'b.pdf: not a file on disk' }` → only `b.pdf` stays, the alert shows the message, the note stays, no success line.
  - a dropped `notes.md` (File with text `# Hi`) on an empty editor fills the text with `# Hi`, the title `notes`, `Text goes in as` = `doc`; a second `.md` becomes a chip.
  - Discard on a long draft asks first; Keep keeps it.
  - names no agent: no text matching `/claude/i` outside the model picker.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** `Brain composer: one composer for text and files, one note, Capture with`.

### Task 6: Activity

**Files:**
- Create: `src/renderer/components/brain/composer/activity.ts`, `activity.test.ts`, `Activity.tsx`, `Activity.test.tsx`
- Modify: `src/renderer/components/brain/BrainInbox.tsx` (move `JobRow`'s buttons into `Activity.tsx`; delete `WaitingToCapture`, `RecentWork`, `AddToBrain` once Task 7 no longer imports them; keep `guessType` re-export if other imports use it)

**Interfaces:**
- Consumes: `waitingSources`, `captureInFlight`, `waitReason` (`waiting.ts`); `pagesChangedBy` (`recent.ts`); `isBookJob`.
- Produces:
  - `type ActivityRow = { key: string; group: 'running' | 'needs' | 'earlier'; source: string | null; sourceRow: BrainSourceRow | null; job: BrainJob | null; reason: WaitReason | null }`.
  - `activityRows(jobs: BrainJob[], sources: BrainSourceRow[], queuePaused: 'cap' | null): ActivityRow[]` — rules from the spec: one row per source over its source jobs (newest of `capture|pictures|retract|lessons`); one row per job without a source; background jobs only while `running`; group `running` for `queued|running|paused`; `needs` for a waiting source with no capture in flight (job = its newest failed capture or null); `earlier` for done/failed rest; a source in `needs` never also in `earlier`; order: running, needs, earlier, each newest first (`startedAt ?? endedAt`, queued last-in first).
  - `Activity(props: { brain: BrainView; sources: BrainSourceRow[]; rows: BrainPageRow[]; log: string; onTerminal?; onOpenPage })`.

Behaviour: heading `Activity`, a `Needs you · n` count chip when n > 0 (same number as `badgeCount`), filter tabs All / `Needs you · n` / `Running · n` / Done (`role="tablist"`, `aria-label="Filter activity"`, remembered nowhere), groups headed `Just added`, `Needs you`, `Earlier` (only non-empty ones). Row: status text (`capturing…`, `queued`, `paused: daily token cap`, `failed`, `not captured yet`, `done`), the source's file name or the job kind, the reason or error, the type, the model when `job.model` is non-null (`Opus`, `Haiku`, `Sonnet` or the OpenCode string), and today's actions: Capture (`aria-label="Capture <path>"`, brain's model), Retry (failed non-book job; passes `job.model ?? undefined` as `brain:run`'s 4th arg), Continue in terminal, `n pages changed`, Takeaways, and Capture all on the Needs you group head. Empty: `Nothing added yet.`

- [ ] **Step 1: Failing tests** (`activity.test.ts`): a capture running for a new source → one `running` row; a failed capture for a waiting source → one `needs` row with that job, nothing in `earlier`; a done capture followed by a running pictures job for the same source → one `running` row (pictures); a done lint → `earlier`; a queued background pictures pass → no row, a running one → `running`; a file put in by hand (waiting, no job) → `needs` with job null; order running < needs < earlier.
- [ ] **Step 2: Failing tests** (`Activity.test.tsx`): port these from `BrainAdd.test.tsx` onto `Activity`: "lists jobs newest first with Retry and Continue in terminal", "Continue in terminal … other agent", "offers no Retry on a failed first arrangement of the book", "offers no Retry on a paused job and shows takeaways", "says a waiting source failed, with its error, and offers Capture" (now: Retry, since a failed job exists — and Capture when none), "Capture all queues one capture per waiting source not queued or running", "keeps a capture held by the token cap from being queued again", "links a done capture to the pages it changed", the count tests ("the heading counts only what waits for you"). New: Retry of a capture queued with `model: 'opus'` calls `brain:run(id,'capture',src,'opus')`; the row shows `Opus`; the Running filter hides Needs you rows.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run** — PASS. **Step 6: Commit** `Brain Add: one Activity list for what waits, runs and finished`.

### Task 7: The Add view, side panel, styles, docs

**Files:**
- Modify: `src/renderer/components/brain/BrainAdd.tsx` (layout), `HowItWorks.tsx` (export `STEPS`; the card component is no longer rendered by BrainAdd — delete it if nothing else uses it), `AutoRuns.tsx`, `RunNow.tsx`, `BrainHealth.tsx` (headings/rows only, no behaviour change)
- Modify: `src/renderer/styles/brain.css` (composer, chips, overlay, activity, side panel; remove dead `.brain-paste*`, `.brain-howto*` rules only if unused; keep `.brain-pending*` for `BrainTab`)
- Modify: `src/renderer/components/brain/BrainAdd.test.tsx` (drop the tests moved to Composer/Activity; keep "BrainAdd right column"; add layout tests), `src/renderer/screens/BrainScreen.test.tsx` where it relies on old texts
- Modify: `docs/telemetry.md` (`brain.screen.action`: `add` props, `paste-markdown`, `paste-plain`, `editor-view`, `discard`; `paste` and `drop` keep their meaning from the composer)
- Create: `docs/changes/2026-11-10-brain-add-composer.md`

**Interfaces:**
- Consumes: `Composer`, `useComposerFiles`, `Activity`, `AutoRuns`, `RunNow`, `BrainHealth`.

Behaviour: `BrainAdd` root takes the page-wide drop (`onDragOver/Leave/Drop` → `dropping` state and `useComposerFiles(brain.id).addFiles`); main column = `Composer` then `Activity`; side column = `AutoRuns`, `RunNow`, `BrainHealth`. `expanded` is true until a successful add, true again on `onExpand` or a drop; `focusChoose` (deep link) focuses Attach files. Below 1000 px wide the side column goes under the main one. The Add badge count is unchanged.

- [ ] **Step 1: Failing tests** in `BrainAdd.test.tsx`: dropping two files anywhere on the view adds two chips; after a successful add the composer is a single `Write or paste` row and the success line shows; typing there expands it with the typed text kept; the side panel still shows Runs by itself, Run now and Health; `focusChoose` focuses Attach files; no "How it works" card, the `?` opens the four steps.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**, styles from the mockups using `tokens.css` variables (check light theme by toggling Settings › Appearance in the dev app).
- [ ] **Step 4: Run `npm test`, `npm run typecheck`, `npm run lint`** — all green; name any unrelated flaky failure (known: `removeSource` in `brain/sources.test.ts`, one `brainHandlers.test.ts` case) and re-run it alone.
- [ ] **Step 5: Dev app check** (`SHELLIE_USER_DATA=<scratch dir> npm start`, a brain on a scratch repo): paste rich HTML (from a browser page), drop a `.md` and a `.pptx`, add with Opus, confirm the capture job's command line has `--model opus` (job row shows Opus) and the lint after it does not; screenshots of composing, dropping and after Add into the change note's folder `docs/changes/assets/2026-11-10-brain-add-composer/`.
- [ ] **Step 6: Change note** (spec followed, how it works, what was verified, known gaps), telemetry doc. **Step 7: Commit** `Brain Add: the composer view, Activity and a quieter side panel`.
