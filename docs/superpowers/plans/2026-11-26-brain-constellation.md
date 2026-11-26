# Brain Constellation (Explore view) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third view of a brain, Explore, that draws its wiki pages as a 3D constellation you can fly through, with the real page reader beside the scene.

**Architecture:** A pure layout module turns page rows, the book and the new paths into stars, links and clusters. An imperative three.js class draws them and reports picks; it is loaded with a dynamic import so three.js is its own chunk. A React view holds selection, search, trail, keys and the panel with `BrainPage`, and falls back to the flat `BrainGraph` without WebGL.

**Tech Stack:** Electron renderer, React 19, TypeScript, Vitest (jsdom), `three` pinned to an exact version, oxfmt.

**Spec:** `docs/superpowers/specs/2026-11-26-brain-constellation-design.md`. The prototype `design/mockups/brain-constellation/prototype.html` holds the shaders, camera maths and starting values; port from it.

## Global Constraints

- Nothing of the sky loads or runs until Explore is opened; `three` is imported only inside `SkyScene.ts`, and `SkyScene.ts` only through `import()`.
- No rendering while the view, the brain page or the window is not in front.
- Ambient motion (drift, twinkle, pulse) at most 30 frames a second; flights, drags and hover at display rate; with reduced motion and no input, draw only on change.
- Reduced motion: no drift, twinkle, pulse or flight (the camera jumps).
- A lost WebGL context rebuilds the scene; no WebGL shows the flat graph with the same panel, search and trail.
- At most 2 000 pages drawn (the most linked); the view says how many are not.
- Telemetry never carries a page name, path or search text.
- The sky is dark in both themes; panel, search and trail use the app's tokens.
- Choosing Explore never changes the stored view of a brain.
- Format with `npx oxfmt`, not prettier. Checks: `npx vitest run --project renderer`, `npm run typecheck`, `npm run lint`.

## Review Focus

1. An empty brain (no pages): the view shows the at-a-glance panel with zeros and no error; no scene crash on an empty geometry.
2. A page whose links point at sources or missing pages: those links are ignored, the star still draws.
3. The open page disappears on a refetch: the panel returns to the brain at a glance.
4. A page listed in two chapters, or a chapter listing a path that no row has: the star is placed once (first chapter), the missing path is skipped.
5. Keys while typing: Left, Right, Enter and `/` in the search field or the reader's text do not move the selection.

---

### Task 1: The sky's layout

**Files:**
- Create: `src/renderer/components/brain/sky/skyLayout.ts`
- Create: `src/renderer/components/brain/sky/skyLayout.test.ts`
- Create: `src/renderer/components/brain/newPaths.ts` (moved out of `BrainRead.tsx`)
- Modify: `src/renderer/components/brain/BrainRead.tsx` (use `newPathsSince`)

**Interfaces:**
- Produces:

```ts
export const SKY_MAX_STARS = 2000;
export type Star = {
  path: string; title: string; type: BrainPageType;
  cluster: number;            // index into Sky.clusters
  x: number; y: number; z: number;
  size: number;               // 6.5 + 9 * sqrt(degree / maxDegree)
  bright: number;             // 0.32 + 0.68 * exp(-ageDays / 70) + (verified ? 0.12 : 0)
  ageDays: number;            // 200 when lastUpdated is null
  isNew: boolean;
  links: number[];            // star indexes, both directions, each once
};
export type Cluster = { title: string; number: number /* 0: unnumbered */; x: number; y: number; z: number; r: number };
export type Sky = { stars: Star[]; links: [number, number][]; clusters: Cluster[]; total: number /* all pages, drawn or not */ };
export function skyLayout(rows: BrainPageRow[], book: BrainBook | null, newPaths: ReadonlySet<string>, today: number, max?: number): Sky;
/** What the at-a-glance panel shows. */
export function skyFacts(sky: Sky): { pages: number; links: number; changed14: number; untouched120: number };
/** Stars whose title, summary or type contain `query` (case-insensitive), best first: title starts with it, then most linked. */
export function skyMatches(rows: BrainPageRow[], sky: Sky, query: string): number[];
// newPaths.ts
export function newPathsSince(log: string, rows: BrainPageRow[], since: string | null): Set<string>;
```

- Layout rules (from the prototype's `build`): cluster `i` of `N` sits at angle `i * 0.95 - 0.6`, radius `N > 5 ? 96 : 46`, height `(i - (N - 1) / 2) * (N > 5 ? 11 : 8)`; cluster radius `7 + sqrt(count) * 4.2`; a star's distance from its cluster centre is `r * (0.25 + 0.75 * (1 - 0.7 * degree / maxDegree)) * jitter`, on a Fibonacci sphere, `jitter` in 0.75..1 from a seeded generator (seed from the page count), so the same input gives the same sky.
- Clusters: one per chapter in book order, numbered from 1; then "Back of the book" (number 0) for every page no chapter lists, omitted when empty. Without a book: one unnumbered cluster per type in `BRAIN_PAGE_TYPES` order, titled with the type's plural label, empty types skipped.
- Links come from `linkedFrom`, between two drawn pages only, each pair once.

- [ ] **Step 1: Write the failing tests** in `skyLayout.test.ts`:
  - `follows the book: a cluster per chapter in order, numbered from 1` (3 chapters, asserts `clusters.map(c => [c.number, c.title])` and each star's `cluster`).
  - `puts pages no chapter lists in Back of the book, whatever their type` and `has no Back of the book when every page is placed`.
  - `clusters by type without a book, in BRAIN_PAGE_TYPES order, skipping empty types`.
  - `counts a link once whichever way it points and ignores sources and missing pages`.
  - `sizes by links and brightens by freshness`: degree 0 gives `size` 6.5, the most linked gives 15.5; a page updated today has `bright` 1 (1.12 verified), one with `lastUpdated: null` has `ageDays` 200.
  - `places a page listed in two chapters once, in the first, and skips a listed path without a row`.
  - `gives the same sky for the same input` (deep equal of two calls).
  - `keeps the most linked pages over the limit and reports the total` (`max` 3 of 5).
  - `an empty brain is an empty sky` (`stars`, `links`, `clusters` empty, `total` 0, `skyFacts` all zero).
  - `skyMatches`: title prefix first, then most linked; type and summary match; empty query gives `[]`.
  - `newPathsSince`: the existing behaviour of `BrainRead`'s `newPaths` memo (a page in a log entry after `since` is new; null `since` gives none).
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/brain/sky` — expected: FAIL, module not found.
- [ ] **Step 3: Implement** `skyLayout.ts` and `newPaths.ts`; replace the memo in `BrainRead.tsx` with `newPathsSince(log, rows, since)`.
- [ ] **Step 4: Run** `npx vitest run src/renderer/components/brain` — expected: PASS, including the existing `BrainRead` tests.
- [ ] **Step 5: Commit** `feat(brain): the sky's layout: stars, links and clusters from pages and the book`.

### Task 2: The three.js scene

**Files:**
- Modify: `package.json`, `package-lock.json` (`npm install --save-exact three@0.170.0` and `--save-dev --save-exact @types/three@0.170.0`; if that exact version is not on the registry, take the newest one at least two weeks old and pin it)
- Create: `src/renderer/components/brain/sky/SkyScene.ts`
- Create: `src/renderer/components/brain/sky/frames.ts`, `frames.test.ts`

**Interfaces:**
- Consumes: `Sky`, `Star`, `Cluster` from Task 1.
- Produces:

```ts
// frames.ts — pure, so the budget is tested without WebGL
export type Motion = { flying: boolean; pointerDown: boolean; hovering: boolean; reduced: boolean; dirty: boolean };
/** Whether to draw now: always when flying, dragging, hovering or dirty; ambient at most every 33 ms; never ambient with reduced motion. */
export function frameDue(m: Motion, now: number, lastDraw: number): boolean;

// SkyScene.ts
export type SkyFocus = { selected: number | null; hovered: number | null; candidate: number | null; matches: ReadonlySet<number> | null };
export type SkyLabel = { kind: 'chapter' | 'page'; index: number; x: number; y: number; alpha: number };
export type SkyHandlers = { onPick(star: number): void; onHover(star: number | null): void; onLabels(labels: SkyLabel[]): void; onLost(): void };
export class SkyScene {
  /** Throws when WebGL is not available. `panelWidth` px on the right are kept free of the scene's centre. */
  constructor(host: HTMLElement, handlers: SkyHandlers, options: { reducedMotion: boolean });
  setSky(sky: Sky, keep?: { camera: boolean }): void;   // first call flies in from far; keep.camera swaps in place
  setFocus(focus: SkyFocus): void;
  flyToStar(star: number): void;                        // distance 30 + links * 1.2
  flyToOverview(): void;
  setPanelWidth(px: number): void;
  setRunning(on: boolean): void;                        // false: no frames at all
  dispose(): void;
}
```

- Port from the prototype: the star shader (size, brightness, twinkle, pulse, `aLit`), the chapter haze, base and lit link lines, the running dots, the dust, the orbit camera (drag, wheel, pinch, limits 12..900), the fly easing (1.25 s, first fly-in 2.2 s), picking by projecting stars (within 16 px), the lit values per focus state.
- Colours per type (dark sky): subject `#5fe0c2`, component `#6fb1ff`, scope `#b79bff`, account `#f2f5ff`, decision `#ffc45c`, meeting `#ff86b8`, lesson `#ff9a6b`, glossary, digest and other `#9fb0c8`. Export them as `SKY_TYPE_COLOR: Record<BrainPageType, string>` from `skyLayout.ts` so the panel's dots use the same.
- Clear colour `#070a12`, opaque canvas, pixel ratio capped at 2.
- Labels are not drawn in WebGL: each drawn frame calls `onLabels` with screen positions for every cluster (alpha fades below camera distance 100, 0 at 40) and for up to 22 pages: the focus star, its 14 most linked neighbours, the hovered and candidate stars, or with matches the 14 most linked matches.
- The loop uses `frameDue`; it does not schedule `requestAnimationFrame` while `setRunning(false)`, and also stops on `document.visibilitychange` hidden.
- `webglcontextlost`: `preventDefault`, stop; `webglcontextrestored`: rebuild geometries from the last sky and resume; if no restore within 3 s call `onLost` once.
- `dispose` removes listeners, the ResizeObserver, geometries, materials and the canvas, and calls `renderer.dispose()`.

- [ ] **Step 1: Write the failing tests** in `frames.test.ts`: draws when flying; draws when dirty with reduced motion; ambient not before 33 ms after the last draw and due after; never ambient when reduced and idle.
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/brain/sky/frames.test.ts` — expected: FAIL.
- [ ] **Step 3: Install `three`, implement `frames.ts` and `SkyScene.ts`.**
- [ ] **Step 4: Run** `npx vitest run src/renderer/components/brain/sky && npm run typecheck && npm run lint` — expected: PASS. Check `grep -rn "from 'three'" src` names only `SkyScene.ts`.
- [ ] **Step 5: Commit** `feat(brain): the constellation scene in three.js`.

### Task 3: The Explore view

**Files:**
- Create: `src/renderer/components/brain/sky/BrainSky.tsx`, `BrainSky.test.tsx`
- Create: `src/renderer/styles/sky.css` (imported where the other brain styles are)
- Modify: `src/renderer/components/brain/BrainGraph.tsx`, `pageGraph.ts` (optional `focus?: string | null`, `matches?: ReadonlySet<string> | null`, `height?: number` props; a focused page and its links are lit as on hover, non-matching dots dim)
- Modify: `src/renderer/components/brain/brainActions.ts` if `trackBrain` needs the `origin` property

**Interfaces:**
- Consumes: Task 1 and Task 2 exports; `BrainPage` (`layout="chips"`), `useBrainNav`, `BrainPages`.
- Produces:

```tsx
export function BrainSky(props: {
  brainId: string;
  brainName: string;
  pages: BrainPages;
  since: string | null;
  /** Whether Explore is the view in front: the scene runs only then. */
  active: boolean;
  jobs?: BrainJob[];
  skillsReady?: boolean;
  /** Read the page in the Read view. */
  onOpenInRead(path: string): void;
  /** Test seam: how the scene is made. Default: `import('./SkyScene')`. */
  loadScene?: () => Promise<{ SkyScene: typeof SkyScene }>;
}): JSX.Element;
```

- Behaviour:
  - Creates the scene on the first `active`; `setRunning(active)` after that; disposes on unmount. If the constructor throws or `onLost` fires, renders `BrainGraph` at full height with `focus` and `matches`, and a line "The 3D view is not available on this machine; this is the flat map." Over 150 pages it adds how many are not drawn.
  - Selection is `nav.current`: a wiki page that is a star is selected and flown to; a source opens in the panel and the camera stays; a path under `reads/` calls `onOpenInRead`. `nav.open` is what a pick, a row in the panel, a link in the page and the trail call. Opening counts as `trackBrain('open-page', { origin: 'sky' })`.
  - The panel (460 px, class `sky-panel`): with nothing open, the brain's name, "N pages in M clusters" (plus "K more not drawn" over the limit), the three facts from `skyFacts` labelled "Links", "Changed in 14 days", "Untouched for 4 months", then "New" (up to 5) and "Most linked" (5) as buttons. With a page open: `BrainPage` with the nav's back and forward, and a foot with "Open in Read" and "Whole brain".
  - Search field "Find a page": `skyMatches` on input; shows "N found"; Enter opens the best; a non-empty query closes the open page and flies to the overview.
  - Trail: the last 7 distinct opened wiki pages, shown with two or more; the current one has `aria-current`.
  - Keys on `document` while `active`, ignored when the target is an input, textarea, contenteditable, inside `.brain-page-body` or while a lightbox is open: `/` and Mod+K focus the search; Left/Right move the candidate through the selected star's neighbours (most linked first); Enter opens the candidate; Escape clears a search, else closes the page (`nav.home`).
  - Labels: one absolutely placed div per `SkyLabel`, written straight to the DOM (no React state per frame), chapters as `01 TITLE`, pages as their title.
  - A refetch (`pages.rows` identity changes): `setSky(next, { camera: true })`; if the open wiki page has no row any more, `nav.home()`.
  - The canvas host has `role="application"` and an `aria-label` that says what it is and that the panel lists the pages.

- [ ] **Step 1: Write the failing tests** in `BrainSky.test.tsx` with a fake `SkyScene` (records calls, exposes its handlers):
  - `shows the brain at a glance: pages, clusters, the three facts, most linked`.
  - `an empty brain shows zeros and makes a scene without error`.
  - `a picked star opens its page in the panel, flies to it and joins the trail`.
  - `a link in the page to another page flies there; a link to a source opens it and does not fly`.
  - `back returns to the previous page and flies`.
  - `search lights the matches, says how many, and Enter opens the best`.
  - `Left and Right pick a neighbour, Enter opens it, Escape closes; none of them act while typing in the search field`.
  - `Open in Read asks for the Read view on that page`.
  - `runs only while active and disposes on unmount`.
  - `the open page disappearing on a refetch returns to the brain at a glance`.
  - `without WebGL it shows the flat map with the same panel` (the fake constructor throws).
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/brain/sky/BrainSky.test.tsx` — expected: FAIL.
- [ ] **Step 3: Implement** `BrainSky.tsx`, `sky.css`, the `BrainGraph` props.
- [ ] **Step 4: Run** `npx vitest run src/renderer/components/brain` — expected: PASS.
- [ ] **Step 5: Commit** `feat(brain): the Explore view: the sky with the page beside it`.

### Task 4: Into the brain page, the palette and the docs

**Files:**
- Modify: `src/renderer/screens/BrainScreen.tsx`, its test
- Modify: `src/renderer/store.ts` (`focus?: 'ask' | 'wiki' | 'drop' | 'explore'` on the brain screen)
- Modify: `src/renderer/components/PlaceCommands.tsx`, its test
- Modify: `docs/telemetry.md`
- Create: `docs/changes/2026-11-26-brain-constellation.md`

**Interfaces:**
- Consumes: `BrainSky` from Task 3.

- `View` becomes `'read' | 'add' | 'explore'`. The tab list gets a third tab "Explore" after Add. `initialView` returns `'explore'` only for `focus === 'explore'`; `choose('explore')` tracks `view-explore` and does not write the stored view. `BrainSky` is rendered lazily (`React.lazy`) in a third `.brain-view` div, mounted from the first time Explore is chosen and then kept, hidden when not in front, with `active={view === 'explore'}` and `onOpenInRead={openPage}`.
- The palette gets, per brain of the active project, `{ id: 'goto.brain.explore.<i>', title: 'Explore <name>', group: 'goto', run: () => go({ kind: 'brain', brainId, focus: 'explore' }) }`.
- `docs/telemetry.md`: `view-explore` beside `view-read`, `view-add`; `open-page` may carry `origin` (`sky`).

- [ ] **Step 1: Write the failing tests:** `BrainScreen`: `has an Explore tab that shows the sky and does not change the remembered view`; `opens on Explore when the route asks for it`; `Open in Read from the sky shows the Read view on that page`. `PlaceCommands`: `offers Explore per brain and opens the brain on Explore`.
- [ ] **Step 2: Run** those two test files — expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project renderer && npm run typecheck && npm run lint` — expected: PASS.
- [ ] **Step 5: Look at it in the running app** (the seeded dev-app recipe: own data folder, own debug port, mock keychain, a brain with hand-written `wiki/*.md` and a `brain/book.json`): the tab, the fly-in, a click on a star, the page in the panel, search, the trail, Read and back with the camera kept, both themes, reduced motion (`Emulation.setEmulatedMedia`). Check in the built renderer that three.js is a chunk of its own.
- [ ] **Step 6: Write the change note** (what changed, how it works, what was verified, known gaps: Windows, a brain of real size, a lost context never provoked) **and commit** `feat(brain): Explore on the brain page and in the palette`.
