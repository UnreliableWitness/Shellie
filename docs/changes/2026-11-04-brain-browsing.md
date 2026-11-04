# Brain: browsing the wiki

Spec `docs/superpowers/specs/2026-11-04-brain-browsing-design.md`. The owner asked for "ways to make the wiki visually attractive and easy to browse through", uses the brain both from a task and to read up before a meeting, and approved the design; a builder check by a separate agent corrected its mechanics first.

## What changed

- **Data** (`src/main/brain/browse.ts`): `brain:pages` gives every wiki page as a row (title, summary, type from the file name, last update, confidence, verified and "changed since verified", the sources it cites, the pages linking to it), in type order then as the index sorts; `brain:search` finds lines of pages then sources holding a query (2+ characters, case-insensitive, outside the frontmatter, 3 per file, 50 in all, each with the nearest heading's slug as an anchor, the same slugger the viewer uses); `brain:relevant` ranks pages for a task by the words of the work item title, the task name and `task.md` (title words count twice, top 5); `brain:openSource` opens a file under `sources/` with the system. `github-slugger` becomes a direct dependency. `pageOrder` is exported from `indexPage.ts`.
- **The front page** (`BrainWiki`, the Brain screen's Wiki tab): pinned cards (the account page, every scope page, the latest digest), Recent (the last 10 log entries that name pages, each page a link, a "new" tag for pages touched since the front page was last shown, kept per brain in `localStorage`), a search box whose results replace the cards (Enter opens the first hit, Esc clears), and every page as a card grouped by type with confidence, verified and updated tags.
- **The page view** (`BrainPage`): back and forward over the pages opened (per view), a breadcrumb, a header from the frontmatter with the sources and the backlinks as chips that open in place, "Mark verified", the body with the frontmatter stripped, reading width 72ch, tables scrolling inside their box, pictures opening in a lightbox (Esc or click closes), links opening pages and sources in the same view and scrolling to their anchor (`#p3`, `#slide-4`), non-markdown files under `sources/` opening with the system. A source shows its type, ingested day, contents line, captured state and its original.
- **The task's Brain tab** (`BrainTab`, with `taskId` and an `onTerminal` callback from the tab bar): Ask (the `AskBox` extracted from the Brain screen; the terminal opens in the task's tab bar), the same search, "For this task" cards from `brain:relevant`, every page in a compact list, and the page view in place; the drop zone and "Open brain" stay. The index markdown and the name filter go.
- `VerifiedBar` is its own component (used by the page view and the Sources tab). Health reads `git status` NUL-separated, so a wiki page with a quote or a backslash in its name is listed as it is (a reviewer's note from the previous change).
- Telemetry: `brain.screen.action` gains `open-page`, `search`, `back`.

## After the review

A separate agent (Opus, temporary tests, the viewer's own slug pipeline) found and these were fixed: search anchors counted a `#` line inside fenced code as a heading and slugged raw markdown, so an anchor could miss the viewer's id (fences are tracked, and `headingText` reduces a heading to the text the viewer slugs: pictures gone, links to their text, code spans verbatim, only paired emphasis marks dropped, shortest pair first, so `snake_case_name`, `_private` and `Q&A: _why_?` all match; 34 headings compared); a slow read could land under another page's header (only the answer for the path shown lands) and a slow search answer could show for a later query (answers for an earlier query are dropped); a click on a picture did nothing (the lightbox opens, unless the picture is itself a link); the search and its results were lost on Back (the lists stay mounted under an open page); a page opened from the bottom of a long one started scrolled down (the page bar scrolls into view once per navigation, never on a refetch); a breadcrumb for a root file read its name twice; a file that is neither a page, a picture nor a source gave no feedback; a `pages:` entry with a trailing period or written as a link did not match; the "new" mark compared timestamps as text; task words were not Unicode-normalised and the stop list was English only; `brain:openSource` would have handed a script to the system (documents and pictures only now).

## Verified

`npm test`, `npm run typecheck`, `npm run lint` green. Tests: `browse.test.ts` (types, rows with backlinks and verified state, search with anchors and caps, snippets, task words, ranking), `recent.test.ts` (log parsing and matching, day formatting, chips, folders), `brainHandlers.test.ts` (the four channels, `openSource` guards), `BrainWiki.test.tsx` (pinned, recent with links, cards and tags, a page opened with its chips, a link opening a source with its header, back; search replacing the cards and Enter opening a hit), `BrainScreen.test.tsx` and `TaskScreen.test.tsx` updated for the new tab. A review by a separate agent before merge.

## Known gaps

- Search is substring, not ranked; thousands of pages will feel it.
- "Recent" needs the schema's log format and real timestamps (the skills sometimes invent one); other lines show without links. "New" marks depend on `localStorage`.
- Relevance is word overlap; a page named by a synonym is missed.
- The history is per view: switching pivots or task tabs forgets it.
- The lightbox test and the anchor scroll are covered by reading, not by a browser test (jsdom has no layout).
