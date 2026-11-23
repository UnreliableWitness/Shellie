# Week page: days as columns of task cards

Date: 2026-11-23. Spec: `docs/superpowers/specs/2026-11-23-week-columns-design.md`. Replaces the table of #340.

## What changed

The Week page shows the week as seven columns on a scale of hours worked. Each day's work is stacked from 0 as
cards, in the order worked: one card per task per stretch, as tall as the time it took, with the hours and then the
work item id and title. The day's total heads its column, a line marks 8 hours, and the week's total is in the
page's head. The scale runs to 10 hours and grows by whole hours for a longer day. A click on a card copies its id
and title. Under the columns a table gives the exact hours per task and day (what the old page was), with the
task's colour, its project and the totals: the cards round and stack, the table is what a timesheet is filled from.

## How it works

- Main: `stretchesPerDay` in `src/main/time/weekTime.ts` gives, per day, a task's stretches (when each began, the
  seconds worked in it); work that resumes within 30 minutes joins the stretch. `time:week` returns them as
  `WeekRow.stretches` next to `perDay`. How time is measured and stored is unchanged.
- Renderer: `src/renderer/weekColumns.ts` (pure) orders a day's stretches of every task into blocks, gives each
  task its colour slot and picks the scale; `screens/WeekScreen.tsx` draws them. An hour is 40 px.
- Colours: `--series-1` to `--series-8`, `--series-other` and their `--on-series-*` text colours in `tokens.css`,
  for both themes. They passed the dataviz skill's validator against `--bg-card` (colour-blind separation,
  contrast); the text on each is near-black or white, whichever reads at 4.5:1 or more (`tokens.test.ts` checks it).
- A card is never taller than its time (a few minutes are a 1 px line), so a day's cards end at the day's total; a
  card under about an hour shows hours and task on one line, a sliver no text.

## Verified

- `npm test`, `npm run typecheck`, `npm run lint` pass.
- In the running app on macOS, dark theme, with sample tasks and time written into a test data folder: the columns,
  the card texts, a 10-minute sliver, a 14.75-hour day (scale to 15, the page scrolls), the table under the
  columns, and a click on a card (the clipboard held "412 Fix login redirect" and the notice showed).

## Known gaps

- Windows and the light theme were not looked at.
- Not seen with real data: many short stretches in one day, more than eight tasks in a week, two agents running at
  once (their time adds up, so a day's column can be longer than the day).
- A task's colour can differ from one week to the next.
- Every number is rounded to the quarter on its own, so cards need not add up to their day, nor days to the week
  (up to 7.5 minutes per number); the hover gives the exact time. A card under about 25 minutes shows no number.
- From the ninth task of a week on, cards share one grey and touch each other with only the gap between them.
- Each click on a card adds a "Copied" notice.
- The cards are not reachable in a useful order by keyboard beyond Tab through all of them.
