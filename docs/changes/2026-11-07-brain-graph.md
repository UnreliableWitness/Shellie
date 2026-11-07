# Brain: a graph of how pages link

Asked for: "a cool graph animation on the brain homepage", showing how the pages link to each other, to click a page and open it. The owner chose option A of two mockups (2026-11-07): the graph on top of the Read view's landing, above the pinned pages and Recent (option B, the graph as the whole landing with a List switch, was not chosen).

## How it works

- `BrainGraph` (`src/renderer/components/brain/BrainGraph.tsx`) sits on the Read view's landing (`BrainRead`) when no page is open. It uses the rows the screen already loads (`brain:pages`, each row's `linkedFrom`); no new IPC, no Claude runs.
- `pageGraph` (`pageGraph.ts`) makes one dot per wiki page and one line per linked pair (either direction counts once; sources, broken targets and self links stay out). Over 150 pages it keeps the most linked ones and the header says "150 of 400 pages". Fewer than two pages: no graph.
- Layout: a small force layout of our own (no library): dots push apart, links pull to a length that follows the room per dot, a weak pull to the middle. It is settled at once (`settleLayout`, 300 steps) and stretched to fill the box (`fitLayout`, at most 1.6× per axis). The animation is only the way there: the dots drift from near the middle to their places over 1.6 s (cubic ease-out), then float a few pixels. After a refetch (the brain changed), pages already on screen glide from where they are and new ones come from the middle. The drift starts when the graph is first visible.
- Each frame writes positions straight to the SVG through refs, not through React state. Nothing is done while the document is hidden or the Read view is not shown.
- Hover or keyboard focus on a dot: its links light up (with small dots running out along them), its neighbours are named, everything else dims. Click, Enter or Space opens the page through the same `open` as the tree (so `brain.screen.action` `open-page` counts it). Pages changed since the last visit (the same "new" as Recent) get a green ring. Dot color is the page type (`--repo-*`, `--green`, `--amber` tokens, so both themes work), size is the number of links; the 8 most linked pages are named without hovering.
- Reduced motion (`prefers-reduced-motion`): the dots are drawn in place, nothing floats, no running dots, no animation frames.

## Verified

- `pageGraph.test.ts` (pairs, limit, seeding, separation, bounds, fit, neighbours) and `BrainGraph.test.tsx` (dots and counts, click and Enter open, focus dims, new ring, under two pages, over 150 pages, reduced motion).
- In the running app (`npm start` on a fresh `SHELLIE_USER_DATA` with a 24-page sample brain, driven over the DevTools protocol): the drift mid-way at 0.7 s, the settled graph, hover on a page with its links lit, dark and light theme.
- `npm test`, `npm run typecheck`, `npm run lint`.

## Known gaps

- The layout costs O(n²) per step once per graph change: about 3 M operations for 150 pages, a few milliseconds.
- No zoom, pan or drag; the graph has a fixed height of 300 px.
- Sources are not drawn.
- Not checked on Windows.
