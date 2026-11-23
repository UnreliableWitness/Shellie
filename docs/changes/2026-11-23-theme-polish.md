# Theme polish: every screen looked at in dark and in light

Date: 2026-11-23. The owner asked for a review of the existing screens so they look great in both themes, unattended.
There was no spec: the review was done on the real app. A dev build ran on a fresh data folder, connected to the Azure
DevOps test project, with a demo repository, three tasks, uncommitted changes and a small brain; every screen was
captured in dark and in light (22 screens, then the changed ones again) and compared.

The colours themselves were already in good order: no colour is written outside `styles/tokens.css`, and the contrast
tests hold. What was wrong sat in the things the tokens did not reach.

## What changed

- **Scrollbars.** Every scrolling pane showed the system's scrollbar: a grey gutter stripe with its own border, in the
  middle of the window on Finish, beside the content on Settings, Home and a brain page. `:root` now sets
  `scrollbar-color` to the new `--scroll-thumb` on a clear track. Colour only, on purpose: macOS keeps its overlay
  bars and Windows keeps its scrollbar width. Monaco and xterm draw their own and are unchanged.
- **Native controls.** Checkboxes and radios outside `.checkbox` (Agents, Secrets, Dreams, the tracker choice) were the
  system's blue, a different blue from the accent beside them. `:root` now sets `accent-color`.
- **The slider** (Finish › Time spent) had a near-white track on the dark page. Track and thumb are now drawn from the
  tokens (`input[type='range']` in `app.css`).
- **Cards in dark.** A `.card`, `.list` or `.brain-card` is told from the page by `--shadow-1`, which does not show on
  a dark page: on Usage, Dreams setup, Agents and the brain's Add view the cards had no visible edge. The dark
  `--shadow-1` now starts with a hairline.
- **Warnings in light.** `--warn-bg` was the brown of `--warn` at 10%, which read as dirt on white (Finish's safety
  checks, "No .shellie.yml", the "off" marks). It is now an amber wash.
- **`.input` had no style at all.** The Docs filter, the secret editor's fields and the key/value rows use the class
  `input`; only `.field` was styled, so those six fields were the browser's own. `.input` now shares `.field`'s rules.
- **Changes › scope.** The pressed one of "All changes / Uncommitted" was a shade greyer than the other, which read
  as disabled. It now has the accent's wash and border.
- **Markdown** (Docs and brain pages): a quote was only indented; it now has a bar and muted text. A rule (`---`) is a
  hairline instead of the browser's inset line.
- **Padding.** The Agents page's card and the secret editor's card had their content against the card's edge.

## Verified

- `npm test` (new: the status colours on their washes over card and page, 4.5:1 in both themes; the thumb token),
  `npm run typecheck`, `npm run lint`.
- In the dev app on macOS, both themes: Get started, Home, a task's terminal, Changes, Usage and Docs, Sprint, Week,
  Project, New task, Settings (three scopes), Secrets and its editor, Dreams and its setup, Finish, Agents, Connect,
  the palette, a brain's Read and Add views.

## Known gaps

- Windows was not run. `scrollbar-color` is the standard property and Chromium honours it there, but the look of the
  thumb on Windows was not seen.
- Not seen with data: the Week page with time, Usage with sessions, a dream's review, a brain's Settle view, long
  reads, the reading list.
- Left as they are, on purpose: black text on the dark terminal ground is invisible (ANSI black is the ground's
  colour, as in most dark themes); three other "pressed" looks exist (Home's period, the brain's Read/Add switch,
  the import lanes); fields inside a white card use the page's off-white.
