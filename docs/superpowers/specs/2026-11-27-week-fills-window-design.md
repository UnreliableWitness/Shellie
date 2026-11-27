# Week page: the columns fill the window and every card is readable

Date: 2026-11-27. Asked by the owner in a session; follows `2026-11-24-week-per-task.md`.

## Why

The columns are drawn at 40 px an hour on a scale of at least 10 hours. Short tasks are slivers without text, a
week whose longest day is 5 hours leaves half the chart empty, and the window's height under it goes unused. The
owner wants the chart to use the height there is, and above all every task to be readable.

## Goals

- The scale ends at the week's longest day, rounded up to a whole hour (at least 1), not at 10.
- The chart fills the height the window has: an hour is as tall as fits, never under 40 px (a very long day scrolls).
- Every card is at least one readable line (hours, id and title on one line). The room comes out of the same day's
  bigger cards, so a column still ends at its day's total on the scale.
- When a day's lines do not fit in its total (a day of only a 5-minute task), its cards run past the total rather
  than the hour growing: one such day would otherwise blow up the whole week (Claude's call, changed from "the hour
  grows" while planning). The hour grows only as far as needed for every day's lines to fit inside the chart.

## Non-goals

- How time is measured, stored or rounded; the table; the Per task / As worked toggle; colours.

## Anti-goal

- A card without its text. A sliver that only a hover explains is what this change removes.

## Approaches

- **A. A minimum of one line per card, taken from the day's bigger cards (chosen by the owner).** Costs: two short
  tasks of different length look equally tall; the number on the card and the table tell them apart.
- B. Strictly proportional, the hour grows until the shortest task has a line. One 5-minute task makes an 8-hour
  day almost 2000 px tall.
- C. Strictly proportional, only fill the window. Short tasks stay slivers.

## Decided

- The 8-hour line shows only when the scale reaches 8.
- The table stays under the columns; with the chart filling the window it is reached by scrolling.

## Left to the builder

- How the available height is measured, the exact minimum height, and how the room is taken from bigger cards.
