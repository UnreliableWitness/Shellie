# Brain Read and Add: one number for what waits, and the parked rough edges

A follow-up to `2026-11-06-brain-read-add.md` (PR #247), so the first slice ships finished. The owner asked why the Add badge and the "Waiting to capture" count differed and agreed to fix that and the visible items the reviews had parked.

## What changed

- **Waiting to capture** counts what waits for you, the same number as the Add badge: a capture that failed or a file put in the folder by hand. Sources being captured, queued or held by the daily token cap stay listed, but show as "N capturing" beside the heading, not in the count; with nothing waiting for you the heading has no number. The `?` text says so.
- **Lists** (`.list` on a `ul`: Waiting to capture, Recent work, Health findings) lose the browser's default indent and bullets (`screens.css`).
- **Health** facts sit in two columns, label and value, instead of the page header's wrapping row, which broke up in the side column.
- **Tree** groups use Fluent chevrons (16 px) instead of 10 px text triangles.
- **Tree**: the group holding a newly opened page opens once; a group the reader collapses afterwards stays collapsed when the brain changes (it reopened on every `brain:changed`).
- **`?` help** stays open when its own text is clicked (the popover takes focus instead of closing on the button's blur).

## Verified

`npm test` (3776 passed), `npm run typecheck`, `npm run lint`. New tests: the heading count with a capture in flight and with only captures in flight (`BrainAdd.test.tsx`), the collapsed group across a `brain:changed` (`BrainRead.test.tsx`), the help staying open on a click on its text (`ui.test.tsx`). The Add and Read views were rendered with sample data through a throwaway renderer harness in dark mode and looked at: badge and heading agree, lists unindented, Health in columns, chevrons visible. The full Electron app with a real brain was not driven.

## Known gaps

Still parked from the PR #247 reviews: "N pages changed" opens the first page only; the Read | Add tablist has no arrow keys; the pinned open page is marked current twice; the help does not follow scrolling; the brain terminal panel has a fixed height.
