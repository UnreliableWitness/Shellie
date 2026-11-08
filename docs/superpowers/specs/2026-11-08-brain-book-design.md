# The brain as a book

Date: 2026-11-08. Status: approved by the owner's "run unattended and release a new version by the morning"; the four calls marked *unattended* below were settled after a builder check, without the owner.

Mockups: `docs/superpowers/specs/assets/2026-11-08-brain-book/` (`reading-width.html`, the owner chose option C; `front-page.html`, the owner chose option 1). They are made-up content, drawn to scale for a window about 1700 px wide.

## Why

The owner wants to read a brain like a book, to learn the big topics of a project as a whole: "the mission statements, who's onboard, general information about the customer's business, architecture". The graph on the Read view's landing is liked, but nothing guides a reader through the material. The left tree files pages by kind (Scope, Components, Decisions, Meetings), and nothing in a brain records which page comes first or what belongs together. An open page also leaves a lot of empty space: the 72ch text and 240 px rail are centred (`.brain-read-main > .brain-page.with-rail { justify-content: center }`), which on a wide window leaves roughly a fifth of the room empty on each side.

## Goals

1. A logical table of contents, written by the brain, that runs from the general (why the project exists) to the specific.
2. Chapters that read from start to finish.
3. An open page that uses the screen's width and stays readable.
4. The original pictures shown inside the pages.

## Non-goals

- Fresh prose chapters. The owner chose "arrange what's there" over having the brain write the whole book anew.
- A way for people to change the chapters or their order. The owner left that entirely to the brain: no drag and drop, no editor.
- A new command. The owner asked for this to fit the existing commands.
- Print or PDF export, reading progress beyond "Continue reading", zoom or pan on the graph.
- Any change to the task's Brain tab.

## Anti-goals

This has failed, even if it technically works, when:

- A page can no longer be reached from the Read view because the book left it out.
- The same fact is kept in two places and they can drift apart.
- Someone has to maintain the book by hand.
- The book costs far more of the daily token allowance than the captures already do.
- A brain with a missing or broken book shows an empty or broken Read view instead of today's tree.

## What the reader gets

### The front page (option 1 of the mockup)

Shown when a brain with a book opens on Read and no page is open. From top to bottom:

- The brain's title and, as the introduction, the summary of the first page of the first chapter (*unattended*: no new text, so no new facts to keep right).
- "Continue reading", back to the chapter and page last open in this brain. Hidden when nothing has been read yet.
- Two columns: **Contents** on the left and the existing graph (`BrainGraph`, unchanged in behaviour) on the right. They stack on a narrow window.
- Each contents row: the chapter's number, title, a one-line summary and how many sections it has. A chapter with no pages shows in amber "Nothing captured on this yet". A chapter holding a page changed since the last visit gets the existing blue dot.

The pinned cards go, as the contents replace them. Recent changes stays reachable from the tree. (Builder's note: these two are my call, following the mockup the owner chose.)

### The left tree

Search stays on top with its `⌘K`/`Ctrl+K`. Under it:

- **The book**: the numbered chapters. The open chapter expands to list its pages, and the page being read is highlighted.
- **Back of the book**: Decisions, Meetings, Weekly digests, Lessons, Glossary and Sources, each collapsible with a count, as today's groups are. Reference material a reader dips into, kept out of the chapters.
- **Not placed yet**, only when pages exist that are in no chapter and not in the back of the book. This group is what guarantees the first anti-goal.
- Recent changes and Log at the bottom.

### A chapter

A chapter shows its pages one after another as one continuous read, under the brain's short chapter introduction. At the end: previous and next chapter.

The page's own title and summary head its section, without repeating the summary that the schema also puts as the page's first paragraph. Opening a page that belongs to a chapter from anywhere (tree, search, graph, a link, Recent) opens its chapter scrolled to that section. Pages in the back of the book open alone, as today.

The rail's "In this chapter" lists the sections and follows the scroll. Linked from, Sources and Mark verified apply to one page, so they show for the section being read. Confidence and verification must stay visible per section.

### Width and type (option C of the mockup)

Applies to every page in the Read view, including back-of-the-book pages and sources.

- The content starts against the tree, not centred. The rail stays at the right edge at its current width.
- The text takes all the room left of the rail, and the type grows with the width of the reading pane: about today's size up to where a 72ch column already fills the pane, about 18 px at a 1700 px window. Headings grow with it.
- Above about 22 px the type stops growing; the column keeps filling the pane, lines may get somewhat longer. (My call; the owner's wide-screen case is about 1700 px.)
- The rail still folds under the header on a narrow pane, as today.

### Pictures in the pages

Pages cite pictures as text links (`[Deck slide 4 diagram](../sources/x-assets/slide-4-1.png)`, required by `SCHEMA.md` and counted by picture coverage), so today a reader has to click to see one. In the Read view, Shellie shows the original where it is cited:

- Rendering only, no skill change and no AI run, so every existing page benefits at once.
- A link whose target is a picture file in the brain becomes a figure after the block holding the link (paragraph, list or table). It is as wide as the text, no larger than the picture's natural size times a sensible factor, with a caption from the link text, and opens in the existing `Lightbox` on click. The link itself stays in the sentence.
- A picture is shown once per chapter, or once per page outside a chapter, at its first mention (my call). Later citations stay links. A picture already embedded with `![…](…)` counts as shown.
- A file that does not load leaves the link alone: no broken image.
- Sources already embed their pictures and are unchanged.

## How the book is made

No new skill and no new button. Bump `TEMPLATES_VERSION`; existing brains get the change through "Update skills" in Settings › Brains.

**The book file.** One file, written by the skills, holds the book: an ordered list of chapters, each with a title, a one-line summary, a short introduction and the ordered page paths. The builder picks its place and format. It should be easy for a skill to edit and validated tolerantly by Shellie (a wrong path is ignored, a page listed twice shows once). A book is **valid** when it parses and has at least one chapter; a missing or invalid file counts as no book.

**Introductions carry no facts** (*unattended*). A chapter's summary and introduction only say what the chapter covers and why it comes here: no names, figures, dates or claims. So nothing is kept twice, nothing needs a citation or verification, Retract has nothing to do in the book, and a brain with the weekly digest off cannot go stale there.

**Which pages go in chapters.** Everything but the back-of-the-book kinds: `account`, `scope`, `component`, `other` and the new subject pages below. A brain with no valid book file shows today's tree and landing, plus today's reading width change and pictures.

**Choosing chapters.** The brain decides. `SCHEMA.md` gives it the owner's picture of a good book: from the general to the specific, starting from the project itself, its mission and goals, who is on board, the customer's business, then architecture, how the work runs, and adapted to what the project actually is.

**Subject pages.** The mission or the people have no page kind today. Add one for pages on a subject that fits no other kind, with its file-name prefix handled wherever types are (`BRAIN_PAGE_TYPES`, `pageGroups`, `TYPE_ORDER` in `indexPage.ts`, the schema). These are ordinary wiki pages with frontmatter and citations, so each fact still lives in one place.

**What each command does.**

| Command | Extra job |
|---|---|
| Capture, Sync | When there is a valid book and they create or change a page, place it in the right chapter at the right position. Place any page that has none. Capture never creates a book (*unattended*): that keeps a capture cheap and stops a thin book from blocking the full first arrangement. |
| Sync, no valid book | Make the first arrangement, as below, and otherwise do its normal work. |
| Sync with the `book` argument | The first arrangement only, none of Sync's reconcile. |
| Digest (weekly) | Review the book as a whole: refresh chapter introductions, adjust order or names if the project has moved on. |
| Retract, Lint, Ask, Lessons, Pictures | Nothing. Shellie ignores paths of removed pages when it shows the book. |

**The first arrangement** chooses the chapters, places every page, writes the introductions, and writes subject pages for book subjects. It reads the wiki pages, and sources only for a subject no page covers. It does not touch existing pages, so nothing turns "changed since verified". It writes the book file last, in one write, so a job cut off midway leaves no book.

**Automatic for existing and new brains** (*unattended*), following the picture pass: once a brain's skills are at the new version and it has pages and no valid book, the scheduler queues one Sync with the `book` argument, in the background lane (never on the launch tick, not when any job for that is queued or running). It leaves `lastSyncCommit` alone, so a full reconcile is never forced on a brain whose field is null or old (a full Sync can hit the 10-minute job limit and rewrite `last_updated` everywhere). A new brain gets its book the same way, after its first capture. A job that ends without a valid book counts as a failed attempt. Attempts are persisted per brain and stop after two; Shellie then keeps showing today's tree, and a Sync from Run now still makes the arrangement. The daily token cap pauses this like any brain job.

**Empty chapters** need no AI: Shellie sees that a chapter lists no existing page.

`index.md` is untouched and stays what skills read first.

## Constraints

- No extra AI cost beyond the owner's subscription: everything runs through the existing brain jobs. No API key, no paid service.
- The book's extra share of a capture must stay small: a skill reads and edits one short file, not all pages.
- Jobs and queues: previous work here produced real cost bugs (extra Claude runs). The final review must check that no path queues a second first-arrangement Sync.
- Both themes through the existing tokens. Reduced motion is respected as `BrainGraph` already does.
- `Platform` rules apply as usual; Windows is the release target.
- Telemetry: new actions go in `docs/telemetry.md`. Paths and names stay scrubbed.
- A change note in `docs/changes/`. Picture coverage still counts citations as before.

## Verification

- `npm test`, `npm run typecheck`, `npm run lint`.
- Unit tests for reading the book file (valid, missing, invalid, dead paths, duplicates, unplaced pages), the tree, the picture rule (first mention, already embedded, table, missing file), and the queue (exactly one first-arrangement Sync per attempt, none after two failed attempts, none while a valid book exists).
- In the running app with a sample brain: front page, a chapter, a picture, wide and narrow windows, light and dark.
- One real first arrangement on a sample brain through the real CLI on the subscription, with its token use reported, and one capture afterwards showing the new page placed.

## Left to the builder

The book file's name and format, how the continuous chapter is rendered and how heading anchors stay unique within it, the curve the type size follows, the skill wording, and the telemetry names.
