# Week overview screen

Issue #340, branch `agent/issues/340-week-overview-screen`.

Time showed per task (the time panel, the Finish slider), per sprint row, or as one task's CSV. There was no single view of what was worked on in a week across every project, which is what a timesheet needs.

## What changed

- A **Week** item in the left nav, below Sprint, opens a Week page: one row per task with time in that week (open and finished tasks, every project), columns Monday to Sunday plus a total, and a footer with the day totals. Previous, This week and Next buttons move between weeks; Next stops at the current week.
- Time is the realistic measure (time in Shellie plus agent time, overlap counted once), the same as the task's time panel: active time outside the task's open periods is left out. It is split by local calendar day, so a session past midnight lands on both days.
- Hours show in quarter steps, like the time booked on a work item; hovering a number shows the exact h:mm.
- Weeks start on Monday, in local time.
- Each row shows the work item id and title (or the task name), and the Azure DevOps project of the task, else its repo's name.
- Main: `weekTime.ts` (`weekBounds`, `secondsPerDay`), `TimeStore.weekSeconds`, and a new IPC call `time:week` taking the week's Monday as `YYYY-MM-DD`. Nothing about how time is measured or stored changed.
- No telemetry change.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests: `weekTime.test.ts` (a split over midnight, time before Monday and after Sunday left out, overlapping agent time counted once, active time outside the open periods dropped), `timeHandlers.test.ts` (`time:week` over two projects, a bad date refused), `WeekScreen.test.tsx` (rows, quarter-hour cells with the exact time on hover, day totals, week navigation, Monday of a week), `TaskNav.test.tsx` (the Week item).

## Known gaps

- Not run in the app or on Windows.
- No CSV or clipboard export of the week, and no booking or editing of time from this page.
- No setting for weeks that start on Sunday.
- Azure DevOps Completed Work is not shown per week, and work outside a Shellie task is not counted.
