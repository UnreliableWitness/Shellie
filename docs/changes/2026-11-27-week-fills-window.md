# Week page: the columns fill the window and every card is readable

Date: 2026-11-27. Asked by the owner in a session. Spec: `docs/superpowers/specs/2026-11-27-week-fills-window-design.md`;
follows `2026-11-24-week-per-task.md`.

## What changed

- The scale of the columns ends at the week's longest day, in whole hours (one at least), where it never went
  below 10: a week with at most 5 hours a day is drawn from 0 to 5.
- The columns take the height the page has, so an hour is as tall as fits and follows the window when it is
  resized. An hour is never under 40 px, what it always was: a very long day or a low window scrolls. The table of
  exact hours is under the columns as before, now reached by scrolling.
- Every card is at least a line of text (18 px and its 2 px gap), with its time and task on it. What a short card
  gets more comes out of the same day's longer cards, in proportion to their time, so a column still ends at its
  day's total on the scale. The sliver without text is gone.
- A card under a quarter of an hour shows its minutes ("5 min") where its hours would round to "0 h".
- The 8-hour line shows only when the scale reaches 8.

## How it works

- `src/renderer/weekColumns.ts` (pure): `scaleHours` without its base of 10; `hourHeight(blocksPerDay, scale, room)`
  shares the room over the scale's hours, floored at `MIN_HOUR_PX`; `slotHeights(seconds, hourPx)` gives each block
  of a day its slot, holding the short ones at `MIN_SLOT_PX` and sharing the rest, in whole px by rounding the edges.
- `WeekColumns` in `screens/WeekScreen.tsx` measures the room in a layout effect and a `ResizeObserver` on
  `.week-body`: its height less its padding and less what the chart draws around the columns.

## Claude's calls

- A day whose lines do not fit in its total (a day of one 5-minute task) runs past its total instead of the hour
  growing for the whole week; the hour grows only until every day's lines fit inside the chart.
- Whole hours for the scale, so it does not shift every few seconds while time is being measured.
- Minutes on a card that would read "0 h".

## Verified

- `npx vitest run --project renderer`, `npm run typecheck`, `npm run lint`.
- In the running app on macOS with six sample tasks and time written into a scratch data folder: a week of at most
  5 hours a day (scale to 6, hour 120 px at 1440x900), dark and light, both card modes, 5-, 8- and 10-minute cards
  readable, a 1100x620 window (hour 71 px), an 11.5-hour day (scale to 12, the 8-hour line, hour 60 px) and that
  week in a 500 px high window (40 px an hour, the page scrolls).

## Known gaps

- Windows was not looked at.
- Two short tasks of different length are equally tall; the number on the card and the table tell them apart.
- A day's header still reads "0" for a day of a few minutes.
- A day just past a whole hour (5 h 03) leaves most of an hour empty under it.
- In a narrow window a one-line card cuts its title after a few letters; the hover has it.
