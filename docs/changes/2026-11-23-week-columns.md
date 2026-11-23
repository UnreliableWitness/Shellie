# Week page: days as columns of task cards

Date: 2026-11-23. Spec: `docs/superpowers/specs/2026-11-23-week-columns-design.md`. Replaces the table of #340.

## What changed

The Week page shows the week as seven columns on a scale of hours worked. Each day's work is stacked from 0 as
cards, in the order worked: one card per task per stretch, as tall as the time it took, with the hours and then the
work item id and title. The day's total heads its column, a line marks 8 hours, and the week's total is in the
page's head. The scale runs to 10 hours and grows by whole hours for a longer day. A click on a card copies its id
and title. Under the columns the tasks are listed with their colour, project and week total.

## How it works

- Main: `stretchesPerDay` in `src/main/time/weekTime.ts` gives, per day, a task's stretches (when each began, the
  seconds worked in it); work that resumes within 30 minutes joins the stretch. `time:week` returns them as
  `WeekRow.stretches` next to `perDay`. How time is measured and stored is unchanged.
- Renderer: `src/renderer/weekColumns.ts` (pure) orders a day's stretches of every task into blocks, gives each
  task its colour slot and picks the scale; `screens/WeekScreen.tsx` draws them. An hour is 40 px.
- Colours: `--series-1` to `--series-8`, `--series-other` and their `--on-series-*` text colours in `tokens.css`,
  for both themes. They passed the dataviz skill's validator against `--bg-card` (colour-blind separation, contrast).

## Verified

- `npm test`, `npm run typecheck`, `npm run lint` pass.
- In the running app on macOS, dark theme, with sample tasks and time written into a test data folder: the columns,
  the card texts, a 10-minute sliver, a 14.75-hour day (scale to 15, the page scrolls), the task list.

## Known gaps

- Windows and the light theme were not looked at.
- Clicking a card was not tried in the running app; the test covers the copy and the notice.
- Not seen with real data: many short stretches in one day, more than eight tasks in a week, two agents running at
  once (their time adds up, so a day's column can be longer than the day).
- A task's colour can differ from one week to the next.
- The cards are not reachable in a useful order by keyboard beyond Tab through all of them.
