# Brain screen: a Read view and an Add view

Date: 2026-11-06. Status: design, awaiting the owner's approval.

Mockups: `assets/2026-11-06-brain-read-add/read.png` and `assets/2026-11-06-brain-read-add/add.png` (the yellow numbered pins and the white note boxes are annotations, not UI).

## Why

The Brain screen is unusable for reading. The Inbox and Health cards fill the top of the page, the wiki is one of three tabs (Sources, Wiki, Log) underneath them, and opening a page replaces the card list, so there is no index or tree that stays in view while reading. The owner wants "an index or tree to browse", and both reading and adding are frequent, so neither may be buried.

The owner also asked for help on the commands: an explanation of how the brain works, what runs by itself and what doesn't.

## Goals

- A dedicated **Read** view built like Obsidian, GitBook and Confluence: a tree that stays put on the left, the page in the middle at reading width, the page's outline and links on the right.
- A dedicated **Add** view holding everything that feeds and maintains the brain, with an explanation of the flow, what is automatic, and a help popover on every manual command.
- Texts that do not name an agent (see Constraints).

## Non-goals

- Changing how the brain works: no new jobs, no new IPC beyond what the views need to read, no changes to capture, lint, sync, digest, the scheduler or the skills.
- OpenCode support for brains. That is the next, separate project; this one only keeps the texts ready for it.
- The task's Brain tab (`BrainTab`). It stays as it is (builder's call whether it reuses the new tree component; it must not regress).
- Settings › Brains. The options stay there; the Add view only links to or toggles them.

## Anti-goals

- Reading that still competes with maintenance UI for the same screen space.
- Help text that is wrong about what runs by itself. Every "auto" line must match the code (see the table below).

## Constraints

- **Agent-neutral texts.** Users typically have only one of Claude Code or OpenCode. A follow-up makes brains run on either, so no text in these views says "Claude": "the agent reads the source", "Open terminal", "tokens". Code may keep calling `claude`; only the words change.
- Shellie's existing look (`tokens.css`, `brain.css`, dark and light theme), existing components where they fit (`PageHeader`, `Pivots` or a segmented control, `BrainPage`, `BrainSearch`, `VerifiedBar`, `Lightbox`).
- Telemetry: new actions go into `brain.screen.action` and `docs/telemetry.md` (counts and kinds only).
- Renderer tests (Vitest, Testing Library) for the new views; existing `BrainScreen.test.tsx` and `BrainWiki.test.tsx` updated.

## The screen

### Header (both views)

Brain name, project, then a **Read | Add** switch. Add carries a badge, when not zero, with the number of sources in the Waiting to capture list (uncaptured sources outside the wiki mirror with no queued or running job). A failed capture counts once, through its uncaptured source; failed lint, sync or digest jobs do not count, so the badge clears as soon as everything is captured. *(Builder check; my call.)* On the right: the Ask box (as now) and a `⋯` menu holding Open folder and Settings for this brain. The Refresh wiki, Lint, Digest and Open terminal buttons leave the header (they move to Add).

The brain terminal panel, when open, shows below the active view in both views, as now.

The view is remembered per brain in `localStorage` (a convenience; default Read). The existing `focus` prop maps: `wiki` → Read, `drop` → Add, `ask` → the current view with Ask open.

### Read view (mockup `read.png`)

Three columns, filling the height of the page, each scrolling on its own:

1. **Tree** (about 270 px, resizable not required).
   - Search box at the top, the existing `brain:search` behaviour (results replace the tree while a query is typed; Enter opens the first hit; Esc clears). `⌘K`/`Ctrl+K` focuses it.
   - **Start here** group: the account page, the scope pages, the latest digest (today's pinned cards), and **Recent changes**, which opens today's Recent list (last log entries with page links) in the reading column.
   - One collapsible group per page type in `BRAIN_PAGE_TYPES` order with a count, empty types hidden. Pages within a group in the existing order (`brain:pages`). Groups show all pages (no "+ N more" cut; the mockup's "+ 3 more" is not wanted).
   - **Sources** group last: the sources from `brain:sources`, grouped by `content_type`, plus the wiki mirror pages under a "DevOps wiki" subgroup.
   - **Log** as a single entry at the bottom: `log.md` rendered in the reading column (replaces the Log tab).
   - A blue dot on pages touched since the brain was last opened (today's "new" rule: pages named in the last 10 log entries newer than the stored timestamp). The timestamp is read and moved once per Brain screen mount, not when the Read view mounts, so switching Read/Add does not clear the dots. *(My call.)*
   - Expanded/collapsed state per group remembered in `localStorage`.
   - The open page is highlighted and its group expanded.
2. **Reading column**: today's `BrainPage` body (breadcrumb, title, tags, body at 72ch, back/forward, links, anchors, lightbox, the source header), centred. Remove for a source moves here from the Sources tab (`SourceBar` in `BrainFiles.tsx`, two clicks, hidden for `sources/wiki/` mirror pages): new placement, same behaviour. When nothing is open it shows a short landing: the Start here cards and Recent changes, i.e. today's front page without the all-pages list.
3. **Right rail** (about 240 px; hidden below a width the builder picks, its content then folding under the page header as today): **On this page** (the page's h2/h3 headings, clicking scrolls; the current section highlighted while scrolling is nice to have), **Linked from** (backlinks), **Sources** (cited sources), **Mark verified** (`VerifiedBar`). These move out of today's chips in the page header.

### Add view (mockup `add.png`)

Left column:

1. **How it works**: a strip of four steps, You add → Capture (auto) → Lint (auto) → Read ("new and changed pages get a blue dot"). A "Hide" link collapses it to a one-line "How it works" link; remembered in `localStorage`.
2. **Add to the brain**: today's Inbox drop zone and paste box (title, type, note fields stay), with the line "Captured automatically after you add it." The whole view stays a drop target (`useBrainDrop`).
3. **Waiting to capture**: today's "Sources to capture" list. Each row says why it waits only when an in-memory job tells: queued, running (Capture disabled, as today), failed with its error, paused by the token cap. Otherwise the row says "not captured yet" and nothing more: jobs are not kept across restarts and nothing records where a source came from, so the mockup's "added outside Shellie" is not shown. No backend work for this. Capture per row and Capture all. *(Builder check; my call.)* ("Needs OCR" files are refused at add time and never become sources; that stays the add-time message.) A `?` explains that dropped and pasted sources are captured automatically, so this list holds only what was not.
4. **Recent work**: today's job rows (state, error, Retry, Takeaways, Continue in terminal). A finished capture links to the pages it changed, taken from `log.md`: the capture's log entry (matched by the job's source file name, newest entry at or before the job's end) lists its pages, parsed with the existing `recent.ts` helpers; clicking opens Read on the first page (or a short list when several). No entry found → no link. *(My call.)*

Right column:

5. **What runs by itself**, every line matching the code:

   | Line | Tag | Shown value | Source of truth |
   |---|---|---|---|
   | Capture after you add | auto | always | `brainHandlers.ts` enqueues capture on `addFiles`/`addText` |
   | Lint after each capture | auto | after each successful capture | `jobs.ts` queues a lint at the front when a capture ends `done` |
   | Refresh the DevOps wiki | auto | when older than a day, while Shellie is open · at task start when "Context in task.md" is on | `scheduler.ts` (24 h, checked every 15 min), task setup (only with `contextInTaskMd`, 8 s limit); the row is hidden when the brain has no wiki |
   | Sync after a refresh | on/off | toggle | `options.syncAfterRefresh` |
   | Weekly digest | on/off | toggle | `options.weeklyDigest` |
   | Daily token cap | — | `<today> of <cap> · €<today>`, "paused" with Resume when hit | `health.tokensToday`, `options.dailyTokenCap`, `queuePaused` |

   The two toggles write the brain's options (`brain:update`) in place.
6. **Run now** (tagged manual): Refresh wiki, Lint, Sync, Digest, Open terminal, each with a `?` popover. **Sync** is new as a button; `brain:run` already accepts `sync`. Popover texts (builder may polish wording, not meaning):
   - Refresh wiki: copies the latest pages of the linked Azure DevOps wiki into the brain's sources. No tokens. Runs by itself once a day while Shellie is open.
   - Lint: checks the wiki for broken links, contradictions, stale and orphan pages; findings show under Health. Uses tokens. Runs after every successful capture anyway.
   - Sync: compares what changed in the sources and the wiki since the last sync and updates the pages that cite it. Use after editing pages by hand or after a large wiki refresh. Uses tokens, takes minutes.
   - Digest: writes a summary page of the last week's changes. Uses tokens.
   - Open terminal: an agent session in the brain folder, for questions or edits by hand.
7. **Health**: today's `BrainHealth` card unchanged in content (findings with Resolve, mirror freshness, edited outside a capture, the redaction field), minus the cost line, which moved to the token cap row.

The `?` popovers open on hover and on click/focus (keyboard reachable), close on Esc or leaving.

## What stays

All behaviour of today's components: search semantics, page navigation and history, anchors, lightbox, source view and Remove, Mark verified, Ask, job retry/resume, Resolve in terminal, the brain terminal panel. The task's Brain tab. IPC channels.

## Left to the builder

- Component split and file names, whether the tree is shared with the task tab.
- Column widths, the breakpoint where the rail folds, segmented control vs `Pivots`.
- Popover implementation (existing tooltip pattern if there is one).
- Exact wording of help texts within the meaning above.
