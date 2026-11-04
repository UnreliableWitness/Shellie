# Brain: browsing the wiki

Follows `2026-11-04-brain-followups-design.md`. The owner asked for "ways to make the wiki visually attractive and easy to browse through", uses the brain both from inside a task looking for one fact and to read up on a customer before a meeting, and approved the picture below.

## Intent

Today the Brain screen's Wiki tab and the task's Brain tab are file browsers: file paths on the left, rendered markdown on the right, the index at the top of the task tab with links that do nothing. The brain's pages already carry everything a good front page needs (title, summary, type by file name, sources, confidence, verified, last update, links). This change renders that, makes every link work, and gives the task tab search, relevance and the Ask box. No change to what the skills write.

## Goals

- From the Brain screen: see the brain at a glance (account, scope, latest digest; what changed recently; every page as a card grouped by type), open a page, follow its links, come back.
- From a task: find one fact fast (search across page text), see the pages that matter for this task first, ask the brain without leaving the task.
- A page presents itself: a header from its frontmatter, the sources it rests on as chips, the pages that link to it.

## Non-goals

- A graph view. An Obsidian launcher. Editing pages in the app. Any change to the skills, the schema or what Shellie writes.

## Data (main process)

All read-only, computed from files already on disk, no model call, no git call except where noted.

- `brain:pages(brainId)` → `BrainPageRow[]`: every `wiki/**/*.md` page with `path`, `title` (frontmatter, else first heading, else file name), `summary` (frontmatter, else first paragraph line, else ''), `type` (`account`, `scope`, `component`, `decision`, `meeting`, `lesson`, `glossary`, `digest`, `other`, from the file name as the schema names them; `digests/` folder → `digest`), `lastUpdated` (day or null), `confidence` (`high`/`medium`/`low`/null), `verified` (day or null), `changedSinceVerified` (`verified` before `lastUpdated`), `sources` (repo-relative paths the page cites, from `citedSources`), `linkedFrom` (paths of pages whose links resolve to this page, from `pages.ts` links through `localTarget`). Uses `readPages`, `pageTitle`, `pageSummary` and `citedSources` that exist; sorted as the index sorts.
- `brain:search(brainId, query)` → `BrainSearchHit[]`: case-insensitive substring search, `query` trimmed, at least 2 characters, over `wiki/**/*.md` first then `sources/**/*.md` (not `.attachments`, not `-assets`), outside the frontmatter block; per file at most 3 hits, at most 50 in all; a hit is `{ path, kind: 'page' | 'source', title, line, text }` with `text` the matching line cut to 160 characters around the match. Files over 2 MB skipped.
- `brain:relevant(brainId, taskId)` → `string[]`: page paths ranked for the task. Words of 4+ letters (lower-cased, a short stop list: with, from, this, that, task, work, item) from the work item title, the task name and the first 200 lines of `.shellie/task.md` without its Context section (`withoutContext`); each page scores the number of distinct words found in its title (counted twice) and summary; the top 5 with a score above 0, by score then title. A task without a work item uses its name alone.
- `brain:read` as today for the body; `brain:sources` (exists) gives a source's type, ingested day, contents line and original file for the source header.

## Screens (renderer)

### The front page (Brain screen › Wiki tab)

Replaces `BrainFiles` for the Wiki tab. From top to bottom:

1. **Pinned:** three cards side by side when they exist: the account page, the scope page(s), the latest digest. The owner's "within two clicks before a meeting".
2. **Recent:** the last 10 lines of `log.md` that name pages (the `pages:` part of the schema's log format), newest first, each rendered as the action, the pages as links and the time. Pages touched since the brain was last opened in this app carry a "new" mark; "last opened" is the time the front page was last shown, kept per brain in `localStorage` (a convenience, never state).
3. **Search:** a box over page text (`brain:search`); results replace the cards while a query is typed (two characters or more), each hit a row with the page title, the matching line with the match emphasised, and the kind; Enter or click opens the page at that line's heading when one is known, else at the top. Esc clears.
4. **Cards by type**, in the schema's order: account, scope, components, glossary, decisions, meetings, lessons, digests, other. A section heading per type with the count, cards in a responsive grid (`minmax(220px, 1fr)`). A card: title, the summary (3 lines, then cut), a confidence badge (`high` green, `medium` neutral, `low` amber; none when absent), a verified badge ("verified 4 Nov" or "changed since verified" in amber), "updated <day>" muted. Dated types newest first, as the index. Click opens the page.

### The page view

Opens inside the Wiki tab (and inside the task tab), with:

- **A bar:** back, forward (a history kept by the view: a stack of `{ path, anchor }`), the path as a breadcrumb (`wiki / decisions / 2026-11-03 database`), and for a wiki page the existing "Mark verified" bar's content folded into the header below.
- **A header** from the frontmatter instead of the raw block: the title, the summary as the lead paragraph, badges (confidence, verified, updated), **Sources** as chips (the file name without date prefix and extension; click opens the source), **Linked from** as chips (page titles; click opens the page). For a source: its type, ingested day, the contents line, and "Original: <file>" that opens it with the system (the existing `brain:openFolder`-style open; a new `brain:openSource(brainId, path)` that calls `shell.openPath` on the original beside the source).
- **The body**: the existing `MarkdownView` with the frontmatter block stripped (it is in the header), reading width capped at 72 characters of body text, images at most the column width with a click to open at full size (the existing asset data URL in a new window is enough), tables scrolling horizontally inside their box instead of overflowing.
- **Links:** `MarkdownView` already resolves relative links and anchors; `onOpenDoc(path, anchor)` pushes to the history and opens the page or source, and after the text loads scrolls to the anchor's element (`rehype-slug` ids; `p3` and `slide-4` in citations match the converters' headings `## p.3` → `p3` and `## Slide 4` → `slide-4`; verify in tests). A link to a file that is not markdown (a picture) opens it as the asset. A web link opens the browser, as today.

### The task's Brain tab

From top to bottom, keeping the drop zone and "Open brain":

1. **Ask:** the Ask box of the Brain screen, same behaviour (`/ask <q>` into the brain terminal, which opens in the task's tab bar as "Continue in terminal" does today).
2. **Search:** the same search box and results as the front page.
3. **For this task:** the `brain:relevant` pages as cards (same card), or the line "No page mentions this task yet" when none scores.
4. **All pages:** the type sections in a compact form (one line per page: title, summary cut to one line, badges) instead of the index markdown.
5. Opening anything shows the page view in place, with its back button returning to the tab's lists; the drop zone stays active around it.

The index markdown rendering goes (the cards carry the same content). The filter box goes (search replaces it).

## Styling

Tokens already in `brain.css` and the app's variables. Cards use the app's `list-row` surfaces with a 1px border and 8px radius; badges are the app's small pill (`.pill` if present, else a new `.brain-badge`). The page view's body uses the docs typography already used for task docs. Dark and light both from the existing variables; nothing hard-coded.

## Telemetry

`brain.screen.action` gains `open-page` (a card, a hit or a link opened a page), `search` (a query of 2+ characters was run; never the text), `back`. `docs/telemetry.md` updated.

## Tests

Main: `brain:pages` rows (type from name, backlinks, changed since verified, digests folder), `brain:search` (frontmatter skipped, per-file and total caps, sources after pages, snippet cut), `brain:relevant` (title words count double, stop words, task.md without Context, no work item). Renderer: the front page renders pinned, recent with the new mark, cards by type with badges; search replaces the cards and opens a page; the page view's header, chips, backlinks, back and forward, anchor scroll; the task tab's Ask, relevant cards and page view in place. `npm test`, `npm run typecheck`, `npm run lint`, a review by a separate agent before merge.

## Known gaps to expect

- Search is substring, not ranked; a brain of thousands of pages will feel it.
- "Recent" relies on the skills writing the schema's log format; a line in another shape is shown without links.
- The relevance score is word overlap; it will miss a page named by a synonym.
