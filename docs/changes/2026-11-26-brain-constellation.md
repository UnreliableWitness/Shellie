# Explore: a brain as a sky you can fly through

Date: 2026-11-26. Spec: `docs/superpowers/specs/2026-11-26-brain-constellation-design.md`; plan:
`docs/superpowers/plans/2026-11-26-brain-constellation.md`. Asked by the owner in a session: "a very visually cool
way to explore brains", with three.js, both impressive and a help to navigate. A throwaway prototype came first
(`design/mockups/brain-constellation/prototype.html`); the owner approved its look and the page beside the scene.

## What changed

A brain's page has a third view, **Explore**, after Read and Add.

- Each wiki page is a star: its colour is the page type, its size how linked it is, its brightness how recently it
  was updated (a little more when a person verified it). A page that is new since the last visit pulses.
- Each chapter of the book is a cluster, in the book's order along a slow helix, with its number and title above
  it. Pages no chapter lists form "Back of the book". A brain without a book clusters by page type.
- A click on a star flies to it, lights its links and names the linked pages. The page opens in a panel on the
  right, as the real reader: its text, its link chips, Mark verified, back and forward. A link in the page flies
  to that page; a source opens in the panel and the camera stays; a long read opens in the Read view.
- "Find a page" lights the pages whose title, summary or type match and dims the rest; Enter flies to the best.
- A trail of the last seven pages. Keys: `/` or Mod+K to find, Left and Right to pick a linked page, Enter to go,
  Escape to step back.
- With nothing open the panel shows the brain at a glance: pages, clusters, links, changed in 14 days, untouched
  for 4 months, the new pages, the most linked pages.
- The palette has "Explore <brain>" per brain of the active project.

Choosing Explore does not change the view a brain opens on: that stays Read or Add.

## How it works

- `components/brain/sky/skyLayout.ts`, pure: page rows, the book and the new paths become stars, links and
  clusters. The same brain always gives the same sky. Over 2 000 pages the most linked are kept.
- `sky/SkyScene.ts`: three.js, without React. Points with a small shader for the stars, lines for the links, an
  orbit camera that flies. It is loaded with `import()`, so three.js is a file of its own (about 490 kB, 123 kB
  compressed) that is fetched only when Explore is first opened; `BrainSky` is lazy too.
- `sky/frames.ts`: what the user drives (a flight, a drag, the pointer over the scene) draws at the display's
  rate; the scene's own drift, twinkle and pulse at 30 frames a second at most; nothing by itself with reduced
  motion. No frame is asked for while another view is in front or the window is hidden.
- `sky/BrainSky.tsx`: selection (its own `useBrainNav`), search, trail, keys, the names laid over the canvas
  (written straight to the page, not through React), and the panel with `BrainPage`.
- The scene is made the first time Explore is chosen and then kept, paused, while Read or Add is in front; it goes
  with the brain page. When the brain changes the sky is swapped in place and the camera stays.
- Without WebGL, or when a lost graphics context does not come back within 3 seconds, the view shows the flat
  graph (`BrainGraph`, which gained `focus`, `matches` and `height`) with the same panel, search and trail.
- The sky is dark in the light theme too; its colours are the `--sky-*` tokens. The panel follows the theme.
- `newPathsSince` (the pages new since the last visit) moved out of `BrainRead` so both views mark the same pages.
- Telemetry: `view-explore`, and `open-page` with `origin: 'sky'` (`docs/telemetry.md`).
- New dependency: `three` 0.170.0 (MIT), pinned, with its types.

## Verified

- `npm run typecheck`, `npm run lint` and the renderer tests pass. Tests cover the layout, the frame budget, and
  the view with a scene that draws nothing (the test environment has no WebGL).
- In the running app on macOS (fresh data folder, a seeded brain of 114 linked pages in 8 chapters), by
  screenshot and scripted clicks and keys: the tab, the fly-in, clusters and their names, a page opened from the
  panel with its links lit and named, Right and Enter to a linked page, the trail, Read and back with the same
  canvas and the page still open, Open in Read, search with its count, and the light theme with the dark sky.
- The built renderer has `SkyScene` and `BrainSky` as files of their own.

## Known gaps

- Windows was not run, nor a machine without a GPU; the flat-map fallback was seen only in tests.
- A click on a star itself was not scripted in the running app (pages were opened from the panel and by keys);
  hovering, dragging, zooming and pinching were not tried by hand.
- Reduced motion and a lost graphics context were never provoked; both are code read, not seen.
- A brain of real size and with real prose was not seen: the seeded pages are short, and 2 000 pages was not
  measured.
- While the pointer rests over the scene it draws at the display's rate, not at 30 frames a second.
- Chapter names can overlap each other and run under the panel; names are not kept apart.
- Search is the instant match on title, summary and type, not the Read view's full-text search.
- In the panel the reader is the narrow layout: no outline, and a source has no Remove.
- The reader's link chips share the class `brain-chip` with the Add composer's file chips, whose rule makes them
  340 px wide; the panel overrides that for itself, the task's Brain tab was not looked at.
- The replay of a brain's growth and the pages an agent read lighting up are not built (the spec's second step).
- From the review of the whole branch, fixed: Ctrl/Cmd+K is left to the brain's terminal and to other fields; a
  key a menu or dialog already took is left alone; the neighbour picked with the keys and the hovered star are
  forgotten when the page or the brain changes; the scene follows a change of display scaling (a monitor move).
  The last one has no test: the scene cannot run in the test environment.
- From the same review, left for later:
  - Shift+Left and Shift+Right pick a neighbour instead of extending a text selection after a click on the
    page's text.
  - A lost graphics context that takes over 3 seconds to return (a locked session, a remote desktop) leaves the
    flat map until the brain page is left; the wait also counts while the window is hidden.
  - `dispose()` does not force the graphics context to be released; it goes when the browser collects it.
  - Typing in the search field restarts the flight to the overview on every key.
  - A page that left the brain stays in the trail under its path; a removed source stays open in the panel.
  - A drag that ends without a pointer-up keeps the scene drawing at the display's rate.
  - One frame can be drawn at the wrong size on the way back from Read or Add.
  - A visible window that is not the active one keeps drawing at 30 frames a second.
  - Between about 740 and 900 px the scene is still shifted for a panel that has moved to the bottom.
  - The canvas has `role="application"` but cannot take focus; the neighbour picked with the keys is not
    announced, and is not shown at all on the flat map.
  - Over 2 000 pages the "changed" and "untouched" figures count only the drawn pages.
  - Hovering a star re-renders the page reader.
  - A chapter's glow is one large point, which may be cut off at the screen's edge or capped by a graphics card.
- In development, editing `SkyScene.ts` while Explore is open leaves a blank scene until the page is reloaded.
