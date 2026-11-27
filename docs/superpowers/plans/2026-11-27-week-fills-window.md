# Week Fills The Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Week page's columns use the window's height on a scale that ends at the longest day, and every card shows its text.

**Architecture:** The sizes are pure functions in `src/renderer/weekColumns.ts`; `WeekScreen.tsx` measures the room with a `ResizeObserver` on `.week-body` and draws with them. Nothing changes in main.

**Tech Stack:** React, TypeScript, Vitest (jsdom has no layout: the measured room is 0 there, so tests run at the 40 px floor).

**Spec:** `docs/superpowers/specs/2026-11-27-week-fills-window-design.md`

## Global Constraints

- An hour is never under 40 px (`MIN_HOUR_PX`). A card's slot (card and its 2 px gap) is never under 20 px (`MIN_SLOT_PX`).
- The scale is the longest day in whole hours, at least 1.
- A column's slots add up to the day's total on the scale whenever the minimums fit in it.

## Review Focus

- A day whose minimums do not fit in its total: every slot is 20 px, the column runs past the total but stays inside the chart.
- A week of one short task (scale 1): the hour takes the whole height.
- A window too low for 40 px an hour: the floor holds and the page scrolls.
- The window resized or the week changed: the hour follows.
- No `ResizeObserver` (tests): the floor is used, nothing throws.

---

### Task 1: The sizes (`src/renderer/weekColumns.ts`, test `weekColumns.test.ts`)

**Produces:**
- `scaleHours(dayTotals: number[]): number`: `max(1, ceil(longest / 3600))`.
- `slotHeights(seconds: number[], hourPx: number): number[]`: whole px per block, each at least `MIN_SLOT_PX`; blocks above the minimum share what is left of `total / 3600 * hourPx` in proportion to their time; edges rounded cumulatively so the sum is the rounded total when the minimums fit, else `n * MIN_SLOT_PX`.
- `hourHeight(blocksPerDay: number[], scale: number, room: number): number`: `max(MIN_HOUR_PX, floor(room / scale), ceil(mostBlocks * MIN_SLOT_PX / scale))`.

- [ ] Tests first: scale 1 for an empty week, 5 for a 4.5 h day, 14 for 14 h; `slotHeights([9900, 900, 5400], 40)` sums to 180 with the middle at 20; `slotHeights([300], 40)` is `[20]`; `slotHeights([3600, 3600], 40)` is `[40, 40]`; `hourHeight([3], 5, 600)` is 120, `hourHeight([3], 15, 300)` is 40, `hourHeight([12], 2, 0)` is 120. Run, see them fail.
- [ ] Implement, run, commit.

### Task 2: The page (`screens/WeekScreen.tsx`, `styles/screens.css`, test `WeekScreen.test.tsx`, change note)

**Consumes:** Task 1's three functions.

- [ ] Update the tests: the axis of the sample week ends at its longest day; a 5-minute card is 18 px with `data-size="s"` and shows its text; a one-hour card stays 38 px. Run, see them fail.
- [ ] `WeekColumns` measures the room: `.week-body`'s `clientHeight` less its vertical padding and less the chart's own height around the columns (`chart.offsetHeight - axis.offsetHeight`), in a `ResizeObserver` on `.week-body`; 0 without one. Draws with `hourHeight` and `slotHeights` (card height is its slot less 2 px); `data-size` is `l` from 43 px, else `s`. Remove the `xs` rules from the CSS.
- [ ] `npm test`, `npm run typecheck`, `npm run lint`; look at the running app (short week, long day, many short tasks, resize, both themes).
- [ ] Change note `docs/changes/2026-11-27-week-fills-window.md`, commit.
