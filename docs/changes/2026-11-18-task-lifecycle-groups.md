# Task list grouped by lifecycle, with PR and CI status

Branch `feat/task-lifecycle-groups`. Spec: `docs/superpowers/specs/2026-11-18-task-lifecycle-groups-design.md`,
plan: `docs/superpowers/plans/2026-11-18-task-lifecycle-groups.md`.

With about ten open tasks per project, the left list (grouped by repo, silent about the PR) could not answer "which task
needs me now". The list now groups open tasks by lifecycle and shows a status chip per row, so that is visible without
opening each task or going to Azure DevOps.

## The grouping rule

Pure function in `src/shared/pulse.ts`, first match wins:

1. **Merged · close me**: at least one workspace has a non-abandoned PR and all such PRs are completed. A workspace with
   no PR, or only an abandoned one, does not block Merged; a still-active PR in another workspace does. One Finish control on the row (and on the rail icon).
2. **Active**: the task was worked on in the last 4 hours (latest end of its active and agent intervals in the time
   store). In the renderer a task whose page is on screen, or that was created less than 4 hours ago, also counts as
   recent before the time store has an interval for it, so a new task does not flash Parked. Setting-up, setup-failed
   and finishing tasks always sit in Active, first. Trouble shows as a chip but does not move the row.
3. **Needs you**: CI failing, changes asked, a merge conflict, an unanswered comment, or an agent tab blocked on you.
4. **In review**: a published (non-draft) PR with nothing waiting on you. Approved PRs stay here; there is no
   "Ready to merge" group.
5. **Parked** (bottom, quiet): idle, no PR or only a draft, nothing waiting.

Changes asked is a reviewer vote of -10 (rejected) or -5 (waiting for author) by a person; group votes do not count.
Reopened tasks: a completed or abandoned PR closed before the start of the task's latest open period is ignored, so a
reopened task does not jump back to Merged (spec, "Reopened tasks").

An abandoned PR counts as no PR. In review and Parked rows are muted (title colour), and their rail icons dimmed. Ordering inside each group follows the spec (Needs you by severity then age, In review by
longest waiting, and so on).

## Where the status comes from

`src/main/pulse/prPulse.ts` turns what `AdoClient` reads (the branch's PR, its policy evaluations, statuses and comment
threads) into a pulse per task. `TaskPulseService` (`src/main/pulse/TaskPulseService.ts`) collects pulses for the open
tasks of the connection, four requests at a time, one task's failure not blocking the others. The last pulse per task is
saved in `pulse.json` in the usage folder so the list is grouped right at startup. Results reach the renderer through
`pulse:changed` (`usePulse`); `pulse:get` and `pulse:refresh` are the IPC calls.

"Me" for unanswered comments is the connection's token user or the PR's creator, because agents may post under another
account than the owner's.

## Refresh cadence

Every 3 minutes while a window is focused; on window focus when the last check is older than 60 s; after Finish
(single and multi-repo); on demand through `pulse:refresh`. Nothing runs in the background while Shellie is not focused.

## The rail

The collapsed rail shows an amber needs-you count pill, a status dot per task, and dims tasks that are only waiting
(In review). The count pill is announced to screen readers.

Telemetry: `pulse.refreshed` and `nav.chipClicked` added to `docs/telemetry.md`.

## Verified

- Vitest: `src/shared/pulse.test.ts` (the rule), `prPulse.test.ts`, `AdoClient.test.ts` (PR reads),
  `TaskPulseService.test.ts`, `handlers.part4.test.ts` (IPC and refresh triggers), `TaskNav.test.tsx` (groups, chips, rail).
  Full `npm test`, `npm run typecheck` and `npm run lint` pass.
- Real app: `npm start` on a fresh `SHELLIE_USER_DATA` folder started, and the terminal output showed no errors from the
  pulse service or the nav. A fresh folder has no connection and no tasks, so this confirms only that the app starts
  and the empty list renders without errors. The renderer DevTools console was not checked. It was not checked visually and no groups, chips or rail states were seen.

## Not verified, and known gaps

- Nothing was checked against a real Azure DevOps PR, in particular not one with failing CI, a conflict, changes asked or
  unanswered comments. The pulse reading is covered by tests with canned responses only.
- Repos hosted on GitHub get no status (Azure DevOps only); those tasks are grouped by activity and agent state alone.
- CI is only known once a PR exists; a pushed branch without a PR shows no CI.
- A non-blocking Build policy that fails still shows CI as failing.
- "Me" is the token user or the PR creator, a guess at which account the owner and their agents post under.
- Windows was not run (macOS only).
