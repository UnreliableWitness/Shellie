# Week page: one card per task a day, or as worked

Date: 2026-11-24. Asked by the owner in a session; follows `2026-11-23-week-columns.md`.

## What changed

A day's column on the Week page now shows one card per task, as tall as the task's total for that day, so a task
worked on in three stretches is one entry with one number. The tasks stay in the order they were first worked on
that day. A toggle in the page's head, "Per task" / "As worked", switches to the cards as they were before: one
per stretch, in the order worked. Per task is the default; the choice is remembered.

## How it works

- `dayBlocks(rows, perTask)` in `src/renderer/weekColumns.ts` adds a stretch to the task's block of that day
  instead of only to the block just before it. Nothing changes in main: the stretches are the same.
- The choice is a flag in localStorage (`shellie.ui.week.asWorked`, `uiPrefs.ts`), absent meaning per task.
- The toggle is two joined buttons with `aria-pressed` (`.week-mode` in `screens.css`), the chosen one washed in
  the accent like the scope of Changes.

## Verified

- `npm test`, `npm run typecheck`, `npm run lint` pass; tests cover both modes, the default and the remembered
  choice.
- In the running app on macOS, dark and light, with three sample tasks and agent time written into a test data
  folder for two days: both modes, the toggle's pressed state, and the columns ending at the same day totals.

## Known gaps

- Windows was not looked at.
- The table under the columns is the same in both modes.
