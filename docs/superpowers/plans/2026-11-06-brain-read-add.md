# Brain Read and Add views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Brain screen's stacked Inbox/Health cards and Sources/Wiki/Log tabs with a Read view (tree, reading column, right rail) and an Add view (how it works, add, waiting, recent work, what runs by itself, run now with help, health).

**Architecture:** Renderer only. Pure helpers (tree groups, waiting sources, pages changed by a job) in `.ts` files with unit tests; components composed from today's pieces (`BrainPage`, `BrainSearch`, `useBrainDrop`, `JobRow`, `BrainHealth`, `SourceBar`). `BrainScreen` owns the Read/Add switch and the "since last opened" timestamp. No IPC or main-process changes.

**Tech Stack:** React, TypeScript, Vitest + Testing Library (`installFakeApi`, `brainView`/`brainJob` fixtures), plain CSS in `src/renderer/styles/brain.css`.

**Spec:** `docs/superpowers/specs/2026-11-06-brain-read-add-design.md` (mockups in `docs/superpowers/specs/assets/2026-11-06-brain-read-add/`).

## Global Constraints

- No text in the new views names an agent ("Claude", "Claude Code", "OpenCode"): say "the agent", "Open terminal", "tokens".
- No new IPC channels and no main-process changes. Use `brain:pages`, `brain:sources`, `brain:read`, `brain:search`, `brain:run` (accepts `sync`), `brain:update` (`options` patch), `brain:resumeQueue`, `brain:removeSource`, `brain:openFolder`.
- The task's Brain tab (`BrainTab.tsx`) must behave as today; `BrainPage` keeps its current layout when not asked for the rail.
- `localStorage` only through `local()` (`src/renderer/localStorage.ts`) inside try/catch, for conveniences: view per brain, collapsed groups, "How it works" hidden, last opened.
- New telemetry actions are added to `BrainAction` (`brainActions.ts`) and to the `brain.screen.action` row of `docs/telemetry.md`: `view-read`, `view-add`, `sync`, `help`, `option`. Never names, paths or content.
- Every "auto" text must match the spec's table exactly in meaning (lint only after a successful capture; refresh when older than a day while Shellie is open, and at task start only when "Context in task.md" is on).
- Checks: `npm test`, `npm run typecheck`, `npm run lint` green at the end of every task.

## Review Focus

1. A brain with no pages and no sources (fresh brain): Read shows an empty-state landing ("No pages yet. Add a source in Add.") and an empty tree without crashing; Add's badge is absent.
2. A brain without a wiki mirror (`brain.wiki === null`): the "Refresh the DevOps wiki" auto row and the Refresh wiki button are hidden; no "DevOps wiki" subgroup.
3. Switching Read → Add → Read keeps the open page, the search and the blue dots (Read stays mounted, hidden).
4. A page with no h2/h3 headings: the rail omits "On this page" instead of showing an empty heading.
5. Queue paused by the token cap with sources waiting: each waiting row says "paused: daily token cap" and the token cap row shows Resume, which calls `brain:resumeQueue`.

Each line has its test in the owning task (Tasks 2, 5, 6, 7, 8).

---

### Task 1: Log entries carry their source; pages changed by a job

**Files:**
- Modify: `src/renderer/components/brain/recent.ts`
- Test: `src/renderer/components/brain/recent.test.ts`

**Interfaces:**
- Produces: `RecentEntry` gains `source: string` (the text between the skill and `→`, trimmed, `''` when none). `recentEntries(logText, rows, max = 10)` unchanged otherwise.
- Produces: `pagesChangedBy(job: BrainJob, logText: string, rows: BrainPageRow[]): { label: string; path: string | null }[]`: the pages of the newest log entry whose `skill` is `/capture` or `capture` and whose `source` ends with the job's source file name (`job.source.split('/').pop()`), with `at` not after `job.endedAt` (when both parse; text compare otherwise, via `isAfter`). Scans all entries (call `recentEntries(logText, rows, Infinity)`). `[]` when the job is not a `done` capture or no entry matches.

- [ ] **Step 1: Write the failing tests** in `recent.test.ts`:
  - `recentEntries` on `- 2026-11-05T08:40:00Z /capture sources/2026-11-05-deck.md → pages: a, b; takeaway: x` gives `source: 'sources/2026-11-05-deck.md'`.
  - `pagesChangedBy` with a done capture job `{ source: 'sources/2026-11-05-deck.md', endedAt: '2026-11-05T08:41:00Z' }` and two entries for that source (08:40 and a later 09:30 one) returns the 08:40 entry's pages.
  - returns `[]` for a failed job, for a lint job, and when no entry names the source.
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/brain/recent.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** both in `recent.ts`.
- [ ] **Step 4: Run** the same command — expect PASS; then `npm run typecheck`.
- [ ] **Step 5: Commit** `git commit -m "Brain: log entries keep their source; pages changed by a capture"`.

### Task 2: Tree groups and waiting sources (pure helpers)

**Files:**
- Create: `src/renderer/components/brain/brainTree.ts`, `src/renderer/components/brain/waiting.ts`
- Test: `src/renderer/components/brain/brainTree.test.ts`, `src/renderer/components/brain/waiting.test.ts`
- Modify: `src/renderer/components/brain/BrainWiki.tsx` (use `pinnedPages`)

**Interfaces:**
- Produces (`brainTree.ts`):
  - `pinnedPages(rows: BrainPageRow[]): BrainPageRow[]` — moved from `BrainWiki`'s `pinned` memo unchanged (accounts, scopes, the latest digest by path).
  - `type TreeItem = { path: string; label: string }`
  - `type TreeGroup = { key: string; label: string; items: TreeItem[]; subgroups?: TreeGroup[] }`
  - `pageGroups(rows: BrainPageRow[]): TreeGroup[]` — one group per `BRAIN_PAGE_TYPES` entry that has pages, in that order, key = the type, items in `rows` order, label from `TYPE_LABELS` (`account: 'Accounts'`, `scope: 'Scope'`, `component: 'Components'`, `glossary: 'Glossary'`, `decision: 'Decisions'`, `meeting: 'Meetings'`, `lesson: 'Lessons'`, `digest: 'Digests'`, `other: 'Other'`); item label is `row.title`.
  - `sourceGroup(sources: BrainSourceRow[]): TreeGroup | null` — key `sources`, label `Sources`, no direct items; subgroups per `SourceType` present (outside `sources/wiki/`) in `SourceTypeSchema.options` order, labelled with the type, plus last a `DevOps wiki` subgroup (key `wiki-mirror`) for `sources/wiki/` paths; item label via `sourceLabel(path)` from `recent.ts`. `null` when no sources.
- Produces (`waiting.ts`):
  - `type WaitReason = { kind: 'queued' | 'running' | 'failed' | 'paused' | 'none'; text: string }`
  - `waitingSources(sources: BrainSourceRow[]): BrainSourceRow[]` — `!captured && !path.startsWith('sources/wiki/')` (today's `SourcesToCapture` filter).
  - `waitReason(path: string, jobs: BrainJob[], queuePaused: 'cap' | null): WaitReason` — the newest capture job for the path decides: `queued` → when `queuePaused === 'cap'` `{ kind: 'paused', text: 'paused: daily token cap' }` else `{ kind: 'queued', text: 'queued' }`; `running` → `'capturing…'`; `paused` → `'paused: daily token cap'`; `failed` → `{ kind: 'failed', text: job.error ?? 'failed' }`; `done` or none → `{ kind: 'none', text: 'not captured yet' }`.
  - `badgeCount(sources: BrainSourceRow[], jobs: BrainJob[], queuePaused: 'cap' | null): number` — waiting sources whose reason is not `queued` or `running` (per spec: no queued or running job).

- [ ] **Step 1: Write failing tests**:
  - `pageGroups` with rows of types decision, account, decision returns `[Accounts(1), Decisions(2)]` and no empty groups; an empty `rows` gives `[]` (Review Focus 1).
  - `sourceGroup` with a `sow`, a `note` and a `sources/wiki/Home.md` gives subgroups `sow`, `note`, `DevOps wiki` in that order; with only non-wiki sources there is no `DevOps wiki` subgroup (Review Focus 2); `[]` sources gives `null`.
  - `pinnedPages` returns account, scope, then only the latest digest.
  - `waitReason`: each job state above maps to its text; a queued job with `queuePaused: 'cap'` gives `paused: daily token cap` (Review Focus 5); no job gives `not captured yet`.
  - `badgeCount`: two waiting sources, one with a running job → `1`; a failed lint job does not count; zero waiting → `0`.
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/brain/brainTree.test.ts src/renderer/components/brain/waiting.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** both files; replace the `pinned` memo body in `BrainWiki.tsx` with `pinnedPages(rows)`.
- [ ] **Step 4: Run** the tests plus `npx vitest run src/renderer/components/brain` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Brain: tree groups and waiting-source helpers"`.

### Task 3: HelpTip

**Files:**
- Create: `src/renderer/components/ui/HelpTip.tsx`; export from `src/renderer/components/ui/index.ts`
- Modify: `src/renderer/styles/app.css` (`.helptip`, `.helptip-pop`)
- Test: `src/renderer/components/ui/ui.test.tsx`

**Interfaces:**
- Produces: `HelpTip({ label, children, onOpen }: { label: string; children: ReactNode; onOpen?: () => void })` — a 16 px round `?` button, `aria-label={`Help: ${label}`}`, `aria-expanded`, `aria-describedby` to the popover (`role="tooltip"`) when open. Opens on mouse enter, focus and click; closes on mouse leave (of button and popover), blur outside both, and Esc (Esc returns focus to the button). `onOpen` fires once per opening (used for telemetry). Popover is positioned under the button, kept inside the window horizontally; portal like `PopupMenu`.

- [ ] **Step 1: Write failing tests** in `ui.test.tsx` (`describe('HelpTip')`): hovering the `Help: Sync` button shows the tooltip text; Esc hides it and focus is on the button; clicking opens it and calls `onOpen` once; tabbing to it opens it.
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/ui/ui.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement** `HelpTip` and its CSS using the theme tokens (`--bg-card`, `--line-strong`, `--shadow-2`, `--radius-card`), max width 320 px, 12 px text.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "UI: HelpTip, a ? button with a popover"`.

### Task 4: SourceBar on its own; BrainPage with a right rail

**Files:**
- Create: `src/renderer/components/brain/SourceBar.tsx` (moved out of `BrainFiles.tsx` unchanged), `src/renderer/components/brain/PageRail.tsx`
- Modify: `src/renderer/components/brain/BrainPage.tsx`, `src/renderer/components/brain/BrainFiles.tsx` (import `SourceBar`), `src/renderer/styles/brain.css`
- Test: `src/renderer/components/brain/BrainPage.test.tsx` (new)

**Interfaces:**
- Produces: `SourceBar({ path, onRemove })` exported from `SourceBar.tsx`.
- Produces: `BrainPage` gains optional props `layout?: 'chips' | 'rail'` (default `'chips'`, today's rendering) and `onRemoved?: () => void`. With `'rail'`: the header keeps title, summary and tags but not the Sources/Linked from chips nor `VerifiedBar`; a `<PageRail>` sits beside the body; for a source outside `sources/wiki/`, `SourceBar` shows under the source header and removing calls `brain:removeSource`, tracks `remove-source`, then `onRemoved()`.
- Produces: `PageRail({ headings, row, titleOf, onOpen, onJump, verified })` where `headings: { id: string; text: string; level: 2 | 3 }[]` is read from `body.current` (`h2[id], h3[id]`) in an effect after `text` renders; sections: "On this page" (omitted when `headings` is empty), "Linked from", "Sources" (each omitted when empty), then `verified` (the `VerifiedBar` element). Clicking a heading scrolls its element into view (`onJump(id)`). Highlighting the current section is optional.

- [ ] **Step 1: Write failing tests** in `BrainPage.test.tsx` with `installFakeApi` (`brain:read` returns a page with frontmatter, `## What changes` and `### Detail`):
  - `layout="rail"` shows a region `On this page` with links `What changes` and `Detail`, `Linked from` with the backlink's title, `Sources` with the source label, and `Mark verified`; the header has no chip buttons.
  - a page without headings shows no `On this page` (Review Focus 4).
  - default layout renders the chips as today (no `On this page`).
  - a source path with `layout="rail"`: `Remove…` → `Remove source` calls `brain:removeSource` with `['b1', path]` and `onRemoved`; a `sources/wiki/` path shows no `Remove…`.
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/brain/BrainPage.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement**; CSS `.brain-page.with-rail` as a two-column grid (body max 72ch, rail 240 px); below 1100 px window width the rail stacks under the header (media query).
- [ ] **Step 4: Run** `npx vitest run src/renderer/components/brain` — expect PASS (BrainFiles, BrainWiki and BrainTab tests unchanged).
- [ ] **Step 5: Commit** `git commit -m "Brain: page rail with outline, backlinks, sources; SourceBar on its own"`.

### Task 5: The Read view

**Files:**
- Create: `src/renderer/components/brain/BrainTree.tsx`, `src/renderer/components/brain/BrainRead.tsx`
- Create: `src/renderer/components/brain/BrainRead.test.tsx` (replaces `BrainWiki.test.tsx`; port its cases)
- Modify: `src/renderer/components/brain/BrainWiki.tsx` → keep only `useBrainPages` and the `Recent` list (export it as `RecentList`); delete the `BrainWiki` component and `useLastOpened` (moves to Task 8). Delete `BrainWiki.test.tsx` once its cases live in `BrainRead.test.tsx`.
- Modify: `src/renderer/components/brain/useBrainNav.ts` only if needed (no change expected).
- Modify: `src/renderer/styles/brain.css`

**Interfaces:**
- Consumes: `pageGroups`, `sourceGroup`, `pinnedPages` (Task 2); `BrainPage` with `layout="rail"` (Task 4); `BrainSearch` (`onOpen`, `onActive`); `useBrainNav`; `useBrainPages` (rows, sources, log); `recentEntries`, `isAfter`.
- Produces: `BrainRead({ brainId, since }: { brainId: string; since: string | null })`.
- Produces: `BrainTree({ groups, start, current, newPaths, onOpen, onOpenSpecial, collapsedKey })` — `start: TreeItem[]` (pinned pages) rendered first under "Start here" with two extra entries "Recent changes" and, at the very bottom of the tree, "Log", which call `onOpenSpecial('recent' | 'log')`; groups collapsible (button with `aria-expanded`), count shown; collapsed set stored as JSON under `shellie.brain.tree.<brainId>`; the group holding `current` is expanded; current item has `aria-current="page"`; new items show a dot with `aria-label="new"`.
- Behaviour of `BrainRead`: three panes (`.brain-read` grid: tree 270 px, reading column, rail inside `BrainPage`). Tree pane: `BrainSearch` on top (results replace the tree while active; `⌘K`/`Ctrl+K` anywhere in the Read view focuses the search input), then `BrainTree`. Reading column: the open page (`BrainPage layout="rail" onRemoved={nav.home}`), or `recent` (the `RecentList`), or `log` (today's `BrainLog`, kept as a component), or the landing: pinned `PageCard`s plus `RecentList`; with no pages at all the landing reads "No pages yet. Add a source in Add." (Review Focus 1). `newPaths` computed as today from `recentEntries` and `since`.

- [ ] **Step 1: Write failing tests** in `BrainRead.test.tsx` (port every `BrainWiki.test.tsx` case to the new structure, then add):
  - the tree shows "Start here" with the account page, groups `Decisions 2` etc.; clicking a page opens it in the reading column and marks it `aria-current`.
  - collapsing `Decisions` hides its items; remounting keeps it collapsed (localStorage).
  - `Recent changes` and `Log` open in the reading column.
  - a page touched in the log after `since` has the `new` dot.
  - typing a query replaces the tree with results; Esc restores the tree.
  - an empty brain shows "No pages yet. Add a source in Add." (Review Focus 1).
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/brain/BrainRead.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement** `BrainTree`, `BrainRead`, CSS (panes scroll independently; page fills the height below the header: `.brain-page` screen body becomes a column flex with the view taking `flex: 1; min-height: 0`).
- [ ] **Step 4: Run** `npx vitest run src/renderer/components/brain` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Brain: the Read view, a tree beside the page"`.

### Task 6: The Add view, left column

**Files:**
- Create: `src/renderer/components/brain/BrainAdd.tsx` (the view), `src/renderer/components/brain/HowItWorks.tsx`
- Modify: `src/renderer/components/brain/BrainInbox.tsx` → split into `AddToBrain` (drop zone + paste form, today's markup and behaviour, plus the line "Captured automatically after you add it."), `WaitingToCapture`, `RecentWork` (today's job list with `JobRow`); delete the `BrainInbox` wrapper.
- Test: `src/renderer/components/brain/BrainInbox.test.tsx` → rename to `BrainAdd.test.tsx`, port its cases.

**Interfaces:**
- Consumes: `waitingSources`, `waitReason` (Task 2); `pagesChangedBy` (Task 1); `HelpTip` (Task 3); `useBrainPages` for `rows` and `log`.
- Produces: `BrainAdd({ brain, onTerminal, onOpenPage, focusChoose })` where `onOpenPage: (path: string) => void` switches to Read and opens the page (wired in Task 8). The whole view is the drop target (`dropProps` on the view root).
- `HowItWorks`: four steps with these texts: "1 · You add — Drop a file or paste text. It is stored untouched under sources/." / "2 · Capture (auto) — The agent reads the source and writes or updates wiki pages." / "3 · Lint (auto) — After each successful capture: checks for broken links, contradictions and gaps." / "4 · Read — New and changed pages get a blue dot in Read." A "Hide" button collapses it to a "How it works" button; state in `shellie.brain.howto.hidden` (global, not per brain).
- `WaitingToCapture`: heading "Waiting to capture · N" with a `HelpTip` "Dropped and pasted sources are captured automatically. This list holds the ones that were not: a capture that failed, the queue paused by the token cap, or a file put in the folder by hand." Each row: file label, `waitReason(...).text`, Capture (disabled for `queued`/`running`); "Capture all" queues every row not queued or running. Hidden when empty.
- `RecentWork`: today's job rows; a done capture with `pagesChangedBy(...)` non-empty shows a link "N pages changed" (or "1 page changed") that calls `onOpenPage(first page with a path)`.

- [ ] **Step 1: Write failing tests** in `BrainAdd.test.tsx` (port BrainInbox cases, then add): How it works shows the four steps and Hide persists across remount; a waiting source with a failed job shows its error and Capture; Capture all sends one `brain:run` capture per row not queued; a done capture job whose source appears in the log shows "2 pages changed" and clicking it calls `onOpenPage('wiki/a.md')`; no text in the rendered view matches `/claude|opencode/i`.
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/brain/BrainAdd.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npx vitest run src/renderer/components/brain` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Brain: the Add view's feeding column"`.

### Task 7: The Add view, right column

**Files:**
- Create: `src/renderer/components/brain/AutoRuns.tsx`, `src/renderer/components/brain/RunNow.tsx`
- Modify: `src/renderer/components/brain/BrainHealth.tsx` (drop the Today line and the paused banner, which move to `AutoRuns`), `src/renderer/components/brain/BrainAdd.tsx`, `src/renderer/components/brain/brainActions.ts` (`'sync' | 'help' | 'option' | 'view-read' | 'view-add'`)
- Test: `src/renderer/components/brain/BrainAdd.test.tsx`

**Interfaces:**
- Produces: `AutoRuns({ brain })` — card "What runs by itself", rows (tag `auto` green, `on` green / `off` amber):
  - "Capture after you add" · auto · "always"
  - "Lint after each capture" · auto · "after each successful capture"
  - "Refresh the DevOps wiki" · auto · "when older than a day, while Shellie is open" plus " · at task start" only when `options.contextInTaskMd`; row hidden when `brain.wiki === null` (Review Focus 2)
  - "Sync after a refresh" · on/off · a switch (`role="switch"`) calling `brain:update(brain.id, { options: { syncAfterRefresh: v } })`, tracks `option`; hidden without a wiki
  - "Weekly digest" · on/off · switch for `weeklyDigest`, tracks `option`
  - "Daily token cap" · `${tokensToday.toLocaleString('en-US')} of ${dailyTokenCap.toLocaleString('en-US')} tokens · ${eur(costEurToday)} today`; when `health.queuePaused === 'cap'` adds "paused" and a Resume button (`brain:resumeQueue`, tracks `resume`) (Review Focus 5).
- Produces: `RunNow({ brain, onTerminal })` — heading "Run now" with tag `manual`; buttons with a `HelpTip` each (`onOpen` tracks `help`), texts:
  - Refresh wiki (hidden without a wiki): "Copies the latest pages of the linked Azure DevOps wiki into the brain's sources. No tokens. Runs by itself once a day while Shellie is open." — calls `brain:refresh` with today's notify messages (move `refresh` from `BrainScreen`).
  - Lint: "Checks the wiki for broken links, contradictions, stale and orphan pages; findings show under Health. Uses tokens. Runs by itself after every successful capture."
  - Sync: "Compares what changed in the sources and the wiki since the last sync and updates the pages that cite it. Use it after editing pages by hand or after a large wiki refresh. Uses tokens and takes a few minutes." — `brain:run(brain.id, 'sync')`, tracks `sync`.
  - Digest: "Writes a summary page of what changed in the last week. Uses tokens."
  - Open terminal: "An agent session in the brain folder, for questions or edits by hand." — `openBrainTerminal`, tracks `terminal`, result to `onTerminal`.
- `BrainAdd` lays out the left column (Task 6) and the right column (`AutoRuns`, `RunNow`, `BrainHealth`).

- [ ] **Step 1: Write failing tests**: the auto rows' texts for a brain with a wiki and `contextInTaskMd: true` (includes "at task start"), and with `contextInTaskMd: false` (does not); without a wiki no refresh row, no sync switch, no Refresh wiki button (Review Focus 2); toggling Weekly digest calls `brain:update` with `['b1', { options: { weeklyDigest: true } }]`; paused health shows Resume which calls `brain:resumeQueue` (Review Focus 5); Sync calls `brain:run` `['b1', 'sync']` and tracks `sync`; hovering `Help: Sync` shows its text and tracks `help`.
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/brain/BrainAdd.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npx vitest run src/renderer/components/brain` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Brain: what runs by itself, run now with help"`.

### Task 8: BrainScreen: the switch, the header, docs

**Files:**
- Modify: `src/renderer/screens/BrainScreen.tsx`, `src/renderer/screens/BrainScreen.test.tsx`, `src/renderer/styles/brain.css`, `docs/telemetry.md`
- Delete: `src/renderer/components/brain/BrainFiles.tsx` and `BrainFiles.test.tsx` (Sources now live in the tree; Remove in the page rail) — only if nothing else imports them after this task.
- Create: `docs/changes/2026-11-06-brain-read-add.md`

**Interfaces:**
- Consumes: `BrainRead` (Task 5), `BrainAdd` (Tasks 6–7), `badgeCount` (Task 2), `PopupMenu`.
- Behaviour:
  - Header: `PageHeader` title = brain name, `after` = project then a segmented control (`role="tablist"`, two `role="tab"` buttons "Read" and "Add"; Add shows a badge with `badgeCount(...)` when > 0, `aria-label="Add, N waiting"`), commands = `AskBox` and a `⋯` button (`aria-label="More"`) opening a `PopupMenu` with "Open folder" (`brain:openFolder`) and "Brain settings" (`go({ kind: 'settings', scope: 'project', connectionId: brain.connectionId, section: 'project-brains' })`).
  - View state: initial from `focus` (`wiki` → read, `drop` → add, otherwise the stored view under `shellie.brain.view.<brainId>`, default `read`); switching tracks `view-read`/`view-add` and stores it.
  - Both views stay mounted; the inactive one is `hidden` (Review Focus 3).
  - `since`: read and replace `brain-last-opened:<brainId>` once per `BrainScreen` mount (today's `useLastOpened`, moved here), passed to `BrainRead`.
  - `BrainAdd.onOpenPage(path)`: switch to Read and open the path (lift `useBrainNav` into `BrainScreen` or give `BrainRead` an `openRequest` prop `{ path: string; n: number }`; builder's choice).
  - The terminal panel stays below the active view.
  - `docs/telemetry.md`: add `view-read`, `view-add`, `sync`, `help`, `option` to the `brain.screen.action` row.
  - Change note per `CLAUDE.md` conventions (spec, what changed, verified, known gaps; see `docs/changes/2026-11-04-brain-browsing.md` for the format).

- [ ] **Step 1: Write failing tests** in `BrainScreen.test.tsx` (update existing ones: Lint/Digest/Refresh/terminal now live in Add → click "Add" first):
  - opens on Read by default; `focus: 'drop'` opens on Add; the chosen view is remembered across remount.
  - the Add tab shows "Add, 2 waiting" for a brain with two uncaptured sources and no jobs; no badge at zero (Review Focus 1).
  - open a page in Read, switch to Add and back: the page is still open (Review Focus 3).
  - a done capture's "pages changed" link in Add switches to Read with that page open.
  - `More` → `Open folder` calls `brain:openFolder`.
  - switching tracks `view-add`.
- [ ] **Step 2: Run** `npx vitest run src/renderer/screens/BrainScreen.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement**; remove the old tabs, `BrainLog` stays (used by Read), drop unused CSS from `brain.css` (`.brain-columns` etc.).
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run lint` — expect all green.
- [ ] **Step 5: See it run**: `SHELLIE_USER_DATA=<scratch folder> npm start` or the run skill; screenshot Read and Add and compare with the mockups. Note in the change file what was and was not checked live.
- [ ] **Step 6: Commit** `git commit -m "Brain: Read and Add views on the Brain screen"`.
