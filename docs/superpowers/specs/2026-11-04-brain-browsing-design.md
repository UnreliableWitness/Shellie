# Brain: browsing the wiki

Follows `2026-11-04-brain-followups-design.md`. The owner asked for "ways to make the wiki visually attractive and easy to browse through", uses the brain both from inside a task looking for one fact and to read up on a customer before a meeting, and approved the picture below. A builder check by a separate agent on 2026-11-04 corrected the mechanics; its answers are folded in and the open choices are settled below, marked "(my call)".

## Intent

Today the Brain screen's Wiki tab and the task's Brain tab are file browsers: file paths on the left, rendered markdown on the right, the index at the top of the task tab with links that do nothing. The brain's pages already carry everything a good front page needs (title, summary, type by file name, sources, confidence, verified, last update, links). This change renders that, makes every link work, and gives the task tab search, relevance and the Ask box. No change to what the skills write.

## Goals

- From the Brain screen: see the brain at a glance (account, scope, latest digest; what changed recently; every page as a card grouped by type), open a page, follow its links, come back.
- From a task: find one fact fast (search across page text), see the pages that matter for this task first, ask the brain without leaving the task.
- A page presents itself: a header from its frontmatter, the sources it rests on as chips, the pages that link to it.

## Non-goals

- A graph view. An Obsidian launcher. Editing pages in the app. Any change to the skills, the schema or what Shellie writes. The Sources tab keeps `BrainFiles` as it is (with its Remove bar).

## Data (main process)

All read-only, computed from files already on disk, no model call, no git call.

- `brain:pages(brainId)` → `BrainPageRow[]`: every `wiki/**/*.md` page (`readPages` in `pages.ts`) with `path`; `title` and `summary` from `pageTitle`/`pageSummary` in `indexPage.ts` (a page without either shows "(no summary)", rendered muted); `type` from the file name prefix as the schema names them (`account`, `scope-`, `component-`, `decision-`, `meeting-`, `lesson-`, `glossary`; a page under `wiki/digests/` is `digest`; anything else, sub-folder pages included, is `other`) (my call); `lastUpdated` (as written, or null); `confidence` (only `high`/`medium`/`low`, else null); `verified` (a `yyyy-mm-dd` day, else null); `changedSinceVerified` (`verified` before `lastUpdated`, both days); `sources` (`citedSources` in `check.ts`, repo-relative); `linkedFrom` (paths of pages whose links resolve through `localTarget` in `check.ts` to this page). Order: type order `account, scope, component, glossary, decision, meeting, lesson, digest, other`, then as the index sorts within a type (dated names newest first) (my call).
- `brain:search(brainId, query)` → `BrainSearchHit[]`: case-insensitive substring search, `query` trimmed, at least 2 characters, over `wiki/**/*.md` first then `sources/**/*.md` (not `.attachments`, not `-assets`), outside the frontmatter block; per file at most 3 hits, at most 50 in all; a hit is `{ path, kind: 'page' | 'source', title, line, text, anchor }` with `text` the matching line cut to 160 characters around the match, `line` the 1-based line in the file, and `anchor` the slug of the nearest heading above the line (the same slugger `rehype-slug` uses, `github-slugger`, added as a direct dependency; `## p.3` → `p3`, `## Slide 4` → `slide-4`, a repeated heading gets `-1`, `-2` like the renderer) or null. Files over 2 MB skipped.
- `brain:relevant(brainId, taskId)` → `string[]`: page paths ranked for the task. Words of 4+ letters (lower-cased, a short stop list: with, from, this, that, task, work, item, when, then, have, will) from the work item title and the task name together (deduplicated, so a name that repeats the title counts once) and from the first 200 lines of `.shellie/task.md` (`withoutContext` in `context.ts`; the task's `worktreePath`, which a no-repo task has too) when it exists; each page scores the number of distinct words found in its title (counted twice) and summary; the top 5 with a score above 0, by score then title. The task comes from `BrainHandlerDeps.task(taskId)`.
- `brain:openSource(brainId, path)` → `void`: opens a file under `sources/` with the system (`BrainHandlerDeps.openPath`, as `brain:openFolder` does); refused outside `sources/` or with `..`. Used for a source's original (`BrainSourceRow.original`) and for a link to a non-markdown, non-image file (a `.pptx` original).
- `brain:read` as today for the body (its "too large" error text is aligned with `DocsBody`'s `'too-large'` so the state shows); `brain:sources` (exists) gives a source's type, ingested day, contents line and original for the source header.

## Screens (renderer)

### The front page (Brain screen › Wiki tab)

`BrainWiki` replaces `BrainFiles` for the Wiki tab. From top to bottom:

1. **Pinned:** cards for the account page, every `scope-*` page (my call: all of them, the grid wraps) and the latest digest (by file name, the ISO week) (my call), when they exist.
2. **Recent:** the last 10 entries of `log.md` (file order, newest first as the schema prescribes) that carry a `pages:` part (`→` or `->` accepted), each rendered as the skill, the pages as links and the timestamp. A `pages:` entry is matched, case-insensitively, against a page's path suffix, its file stem or its title; an entry that matches nothing is shown as text (my call). Pages touched since the brain was last opened in this app carry a "new" tag; "last opened" is a snapshot taken when the front page mounts, stored per brain in `localStorage` after the snapshot (a convenience: cleared storage just shows no tags) (my call).
3. **Search:** a box over page text (`brain:search`, debounced 150 ms); results replace the cards while a query of 2+ characters is typed, each hit a row with the page or source title, the matching line with the match emphasised, and the kind; click or Enter (the first hit) opens it at its `anchor` when there is one, else at the top (my call). Esc clears.
4. **Cards by type**, in the type order above, a section heading per type with the count, cards in a responsive grid (`minmax(240px, 1fr)`, like `.home-cards`). A card: title, the summary (3 lines, then cut), a confidence tag (`.tag-green` for high, `.tag-muted` for medium, `.tag-warn` for low; none when absent), a verified tag ("verified 4 Nov" muted, "changed since verified" warn, "not verified" muted) (my call), "updated <day>" muted. Dates in the app's locale, day and short month (my call). Click opens the page.

### The page view

`BrainPage` opens inside the Wiki tab and inside the task tab, replacing the lists, with:

- **A bar:** back and forward over a history the view keeps (a stack of `{ path, anchor }`; lost when the view unmounts, which a pivot or tab switch does) (my call); back from the first page returns to the lists, and is disabled only on the lists (my call); a breadcrumb of the folder and the title ("wiki › decisions › Database") rather than the raw path (my call); for a wiki page, the "Mark verified" button.
- **A header** from the frontmatter instead of the raw block: the title, the summary as the lead paragraph, tags (confidence, verified, updated), **Sources** as chips (the file name without date prefix and extension; click opens the source in this view), **Linked from** as chips (page titles; click opens the page). For a source: its type, ingested day, the contents line, and "Original: <file>" that opens it with the system (`brain:openSource`); no Remove here, that stays on the Sources tab (my call).
- **The body**: `MarkdownView` with the frontmatter block stripped (it is in the header), brain-scoped styles (`.brain-doc .doc-md`): reading width `72ch`, images at most the column width, tables `display: block; overflow-x: auto`. A click on an image opens a lightbox (an in-app overlay with the asset at full size, Esc or click closes; the app's window guard allows no new windows).
- **Links:** `MarkdownView` resolves relative links and calls `onOpenDoc(path, anchor)` for markdown targets and `onOpenFile(path)` for the rest. `BrainPage` pushes to the history and opens the target; after the text renders it scrolls to the anchor's element by id. `onOpenFile` opens an image as the asset lightbox and anything else under `sources/` with the system. Same-page `#` links scroll as today and do not enter the history (my call). A web link opens the browser, as today.

### The task's Brain tab

`BrainTab` gets two new props from `TerminalTabs`: `taskId` and `onTerminal(def)` (the tab bar's existing `openBrainTerminal` path, which selects the terminal's tab). From top to bottom, keeping the drop zone and "Open brain":

1. **Ask:** an `AskBox` component extracted from the Brain screen (the same inline form, a toggle button opening it) (my call), sending `/ask <q>` through `openBrainTerminal` and handing the terminal to `onTerminal`.
2. **Search:** the same search box and results as the front page.
3. **For this task:** the `brain:relevant` pages as cards, or "No page mentions this task yet".
4. **All pages:** the type sections in a compact form (one line per page: title, summary cut to one line, tags) instead of the index markdown.
5. Opening anything shows `BrainPage` in place of the lists; the drop zone stays active around it.

The index markdown rendering and the filter box go.

## Styling

Badges are the app's `.tag` with `.tag-green`, `.tag-warn`, `.tag-muted` (`app.css`). Cards are a new `.brain-card` (1px `var(--border)`, `var(--radius)`, the app's surface) in a `.brain-card-grid`. Colours only from `tokens.css`. The brain-scoped reading styles live in `brain.css`, never in the shared `docs.css`.

## Telemetry

`brain.screen.action` gains `open-page` (a card, a hit, a chip or a link opened a page or a source), `search` (a debounced query of 2+ characters ran; never the text), `back` (back or forward). `docs/telemetry.md` updated.

## Tests

Main: `brain:pages` rows (type from name and folder, bad values nulled, backlinks, changed since verified, order), `brain:search` (frontmatter skipped, per-file and total caps, sources after pages, snippet cut, anchor slugs incl. repeats), `brain:relevant` (title words count double, stop words, name deduplicated against title, task.md without Context, missing task.md), `brain:openSource` guards. Renderer: the front page renders pinned, recent with the new tag and matched links, cards by type with tags; search replaces the cards and opens a hit at its anchor; the page view's header, chips, backlinks, back and forward, anchor scroll, the lightbox; the task tab's Ask through `onTerminal`, relevant cards and the page view in place. `npm test`, `npm run typecheck`, `npm run lint`, a review by a separate agent before merge.

## Known gaps to expect

- Search is substring, not ranked; a brain of thousands of pages will feel it.
- "Recent" relies on the skills writing the schema's log format and real timestamps (a known gap: the skills sometimes invent one); a line in another shape is shown without links.
- The relevance score is word overlap; it will miss a page named by a synonym.
- The history is per view: switching pivots or task tabs forgets it.
