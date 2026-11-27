# The Brain page opens at once, the sky is the one picture of a brain, and it lies on the app's own background

Asked for (the owner, 2026-11-27): the Brain page "can take up to 10 seconds or longer" to open; "we now have 2 visualizations of the brain, can we standardize on the new space visualization"; and, while that was built, "can the background of the animations be the same as that of the app (dark light) so that it looks part of the app more". No spec.

## What changed

- **The page shows before its health is known** (`useBrain` in `hooks/useBrains.ts`). The page waited for `brain:get`, which rebuilds a stale index, runs git (the outside edits, the unsent commits) and reads every page and source for Health; until then it said "Loading". It now first shows the brain as `brain:list` has it (no `health`, no git), and the full answer follows: Health, the waiting count and the "Sending n changes" figure fill in a moment later.
- **A file that did not change is not read again** (`brain/fileCache.ts`, used by `readPages` and the sources list). Opening a brain read every wiki page three times (the index check, Health, the page list) and the head of every source twice, each time the whole file; every later `brain:changed` did it again. Parsed pages and source frontmatter are now kept per file and reused while the file's size and modified time are the same; the files are looked at 24 at a time instead of one by one. `listSources` listed the sources folder once per source (to find each original); it lists each folder once.
- **One picture of a brain** (`sky/SkyPreview.tsx`). The flat graph is gone from the Read view (the book's front page and the landing of a brain without a book). In its place is a window on the same sky as Explore: the brain's stars, drifting, with the page and link counts above it. It is not steered there; a click anywhere on it opens Explore. It draws only while Read is in front. `BrainGraph` stays only as Explore's stand-in on a machine without graphics.

- **The sky lies on the page's background, dark or light** (`sky/skyTheme.ts`, `SkyScene.setTheme`, the `--sky-*` tokens). It was a night sky of its own (`#070a12`) in both themes. `--sky` is now the page's background (`#201f1e` dark, `#faf9f8` light) and the names, search and trail on it use the theme's ink. On the dark page stars are light added to the background, as before; on the light page that would show nothing, so there they are ink laid over it: a deeper colour per page type (`SKY_TYPE_COLOR_LIGHT`), normal blending for stars, threads and the moving dots, darker dust. The scene follows a theme change while it is open. The dots in Explore's panel use the palette of the theme too (the near-white "account" dot was invisible on the light panel).

## Decided without the owner

- The sky on the front page is a window, not a second Explore: no dragging, zooming or picking there, so scrolling the front page is never caught by it.
- Opening a page from the picture on the front page (a click on a dot of the flat graph) is gone; the contents, the search and Explore do that.
- The quick first answer comes from `brain:list` rather than a new channel.
- The light theme's star colours are Claude's pick (the dark ones deepened); the faint glow per chapter stays blue in both.
- What is kept is keyed on size and modified time: a file rewritten with the same size inside the same clock tick would be missed until its next change.

## Verified

`npm run typecheck`, `npm run lint`, the tests of the touched files (`fileCache.test.ts`: read once until changed, edits, additions and removals seen by `readPages`, callers get copies; `SkyPreview.test.tsx`; `BrainFront.test.tsx`; `BrainScreen.test.tsx`: the page shows while `brain:get` never answers).

Measured in a scratch dev app on this Mac, on a brain grown to 300 sources (about 150 kB each) and 904 pages, 609 commits:

| | before | after |
|---|---|---|
| click on the brain to its header and Read view | 519 ms | 29 ms |
| `brain:get` | 230 to 246 ms | 123 to 139 ms |
| `brain:pages` | 92 ms | 14 to 20 ms |
| `brain:sources` | 31 ms | 2 ms |

The sky was seen on Read's landing there and in Explore, in the dark and the light theme (the scheme switched over CDP), on the page's background in each; a click on the window opened Explore.

## Known gaps

- **Not measured on Windows**, where the owner saw the 10 seconds: the Mac figures show the same causes at a smaller scale (opening files and starting git are both several times slower there), but the gain on the owner's brain is not known until they open it. What is left in `brain:get` is mostly its git calls (the outside-edits log reads the whole history) and a folder listing per source for its pictures; they no longer hold the page back.
- The first opening after Shellie starts still reads every file once.
- The book's front page with the sky was not seen in the running app (the scratch brain had no book), nor a brain with several chapters and page types in the light theme: the scratch brain was one dense cluster of one type, so how the type colours read on the light page is unseen. A change of theme while the sky is open is covered by the code path only.
- Each visit to the front page makes a graphics context for the window and gives it back on leaving.
