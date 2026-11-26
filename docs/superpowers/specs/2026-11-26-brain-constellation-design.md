# Brain constellation: a brain you can fly through

Date: 2026-11-26. Status: design, waiting for the owner's approval.

Prototype (throwaway, three.js, one page): https://claude.ai/artifact/Au4FxhYcPQfLNC5cy2bhz8, snapshot in
`design/mockups/brain-constellation/prototype.html`. The owner flew around in it and said the look is right and
that a page opening beside the scene is right.

## Why

The owner asked for "a very visually cool way to explore brains" and whether three.js could do it. Asked what it
is for, the answer was: both impressive and a help to navigate. So it has to earn its place twice: someone who
sees it should want to look, and the owner should be able to get to a page, and from a page to its neighbours,
faster or more pleasantly than through the tree.

Today a brain is read through the Read view: a tree of chapters and pages, a search box, the page, and on the
landing page a small flat graph of dots and links (`BrainGraph`, 300 px high, at most 150 pages).

## What it is

A third view of a brain, **Explore**, beside Read and Add. It fills the brain page with a night sky:

- **A star per wiki page.** Its colour is the page's type. Its size is how many pages link to or from it. Its
  brightness is how recently it was updated, a little brighter when a person verified it. A page that is new
  since the owner last looked pulses (the same "new" the Read view marks).
- **A cluster per chapter** of the book, placed in the book's order along a slow helix, with the chapter's number
  and title floating above it. The most linked pages sit near the middle of their chapter. Pages outside the
  chapters (decisions, meetings, lessons, the glossary) form one cluster, "Back of the book". A brain without a
  book clusters by page type.
- **Links** as faint threads between stars.
- **Flying.** A click on a star flies the camera to it. Its links light up, with a dot running along each, the
  linked stars are named, and everything else dims.
- **The page beside the scene.** The clicked page opens in a panel on the right, as the real page: the same
  reader the Read view uses, with its text, pictures, sources, backlinks and Mark verified. A link inside the
  page to another wiki page flies there. The panel has "Open in Read", which switches to the Read view on that
  page.
- **Finding.** A search field lights the pages whose title, summary or type match while typing and dims the rest;
  Enter flies to the best match.
- **A trail** of the last pages visited, each a click away.
- **Keys.** `/` goes to the search field. With a page open, Left and Right pick one of its linked pages, Enter
  flies there, Escape returns to the whole brain.
- **With nothing open** the panel shows the brain at a glance: how many pages and links, how many changed in the
  last 14 days, how many were untouched for 4 months, the new pages and the most linked pages, each a click away.

It reads and never writes, except what the page reader already does (Mark verified, removing a source).

## Goals

- Impressive at first sight: depth, glow, slow drift, a camera that flies instead of cutting.
- A place in space means a place in the book, so the owner learns where things are.
- From any page, its neighbours are one click or one key away.
- Stale corners are visible as dim ones.
- The rest of the app is no slower: nothing of this loads or runs until the view is opened.

## Non-goals (this step)

- Replaying the brain's growth from its history, and lighting the pages an agent read during a task. Both were
  proposed as a second step and are not designed here.
- Sources, long reads and letters as stars. Only wiki pages are drawn.
- Editing, adding or settling from this view.
- Replacing the Read view or its flat graph.
- Remembering the camera between visits.

## Anti-goals

- A view that looks good and is useless for getting to a page.
- Motion that cannot be stopped: with reduced motion on, nothing drifts, twinkles or pulses, and the camera
  jumps instead of flying.
- A cost while it is not on screen: no rendering when another view, another page or another window is in front.
- A new control in the app's shell. The view is a tab on the brain page and a command in the palette (the quiet
  shell's rule).

## Constraints

- The renderer's tests run in jsdom, which has no WebGL.
- Windows is the release target and was the scene of freezes (`docs/changes/` on #260, #271, #377): the scene
  must survive a lost graphics context (a monitor move, a driver reset, a remote desktop session) by rebuilding
  itself, and must never spin without a frame budget.
- A machine without WebGL gets a working view all the same.
- Telemetry never carries a page name, path or search text (`docs/telemetry.md`).
- Brains of up to about 2 000 pages must stay smooth; the flat graph's limit of 150 pages does not apply here.

## Approaches

1. **three.js directly, loaded when the view opens (chosen).** One class owns the canvas and draws with
   three.js; React holds the search, the panel and the trail around it. It is what the owner asked about, the
   prototype proves it, and the second step is easy in it. Cost: one dependency of about 170 kB compressed, which
   a desktop app does not feel because it loads from disk and only for this view.
2. **react-three-fiber.** The scene as React components. Two more dependencies, and React in the per-frame path,
   which the existing graph avoids on purpose.
3. **Raw WebGL without a library.** The smallest download, and the scene is only points and lines. But the
   camera maths, the shaders' plumbing and the context-loss handling would be ours to maintain, and every later
   effect costs more.

The owner picked the look and the page beside the scene; Claude picked approach 1 and said so, with no objection.

## Decided by the owner

- The constellation, over a literal brain shape or a time-lapse alone.
- It must be both impressive and a help to navigate.
- The prototype's look is enough: no more glow or motion needed.
- A page opens beside the scene, not in the Read view.

## Claude's calls (not asked; say so if wrong)

- The view is named **Explore** and is the third tab on the brain page, after Read and Add. The brain page
  remembers the last view per brain, as it does now, but never reopens on Explore by itself: opening a brain goes
  to Read or Add as before, so the app's start is never a 3D scene.
- The palette gets "Explore <brain>" per brain of the active project. No key.
- The sky is dark in the light theme too: it is a night sky. The panel, the search field and the trail follow
  the theme.
- The panel shows the real page reader, not the prototype's summary card. It is about 460 px wide, and the scene
  keeps its centre in the space left of it.
- Search is the instant match on title, summary and type from the pages already in memory, not the full-text
  search of the Read view. Full-text hits lighting stars can follow.
- Without WebGL the view shows the existing flat graph at full height with the same panel, search and trail.
- With reduced motion the 3D scene stays, without drift, twinkle, pulse or flight.
- While nothing moves and nothing is hovered, the scene draws at most 30 frames a second; it stops entirely
  when the view, the page or the window is not in front.
- Over 2 000 pages the most linked 2 000 are drawn and the view says how many are not.
- `three` is pinned to an exact version.

## How it is built

- `src/renderer/components/brain/sky/skyLayout.ts`: pure. From the page rows, the book and the new paths it
  returns the stars (position, size, brightness, colour key, new), the links (each pair once) and the clusters
  (centre, radius, number, title). The same input gives the same sky. This is where the meaning of size,
  brightness and place lives, and where the tests are.
- `sky/SkyScene.ts`: the three.js part, with no React: `mount(element)`, `setSky(sky)`, `setFocus(...)`,
  `flyTo(...)`, `onPick`, `onHover`, `labels()` for the names to place, `dispose()`. It handles resize, device
  pixel ratio, lost and restored context, the frame budget and reduced motion.
- `sky/BrainSky.tsx`: the view. It loads `SkyScene` with a dynamic import, so three.js is a chunk of its own,
  and holds the selection, the search, the trail, the names laid over the canvas, the keys and the panel with
  `BrainPage`.
- `BrainScreen.tsx`: the third tab and view; `newPaths`, now computed inside `BrainRead`, moves to a shared
  helper so both views mark the same pages.
- Telemetry: `brain.screen.action` gains `view-explore`, and `open-page` gains the origin `sky`. Listed in
  `docs/telemetry.md`.
- A change note in `docs/changes/`.

## Verified how

- Unit tests for `skyLayout` (clusters follow the book, back of the book, no book, link pairs once, size and
  brightness rules, the 2 000 limit) and for `BrainSky` with a fake scene (tab, selection opens the page, a link
  in the page flies, search, trail, keys, the fallback without WebGL).
- The scene itself in the running app on macOS with the seeded brain: by screenshot and by hand-driven clicks.
- Windows and a brain of real size cannot be checked from this Mac; the change note will say so.

## Left to the builder

- The exact helix, sizes, colours and timings: start from the prototype's values.
- How the names are laid over the canvas without overlapping too badly.
- Whether the panel can be resized.
