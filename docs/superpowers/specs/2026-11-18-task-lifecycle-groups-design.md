# Task list grouped by lifecycle, with PR and CI status

Date: 2026-11-18. Status: design, approved approach (option 1), awaiting doc approval.

## Why

The owner keeps about ten tasks open per project at once. Some are being worked on, some have a pull request waiting
for review, some are merged and only need closing. Today the left task list groups open tasks by repo in creation order
and says nothing about the PR, so finding "which task needs me now" means opening each one or going to Azure DevOps.
The list should sort itself by where each task is in its life, and flag trouble (failing CI, changes asked, unanswered
comments, merge conflicts) so follow-up is obvious at a glance.

## Goals

- Group open tasks in the left list by lifecycle, not by repo:
  1. **Needs you**: something waits on the developer.
  2. **Active**: worked on in the last 4 hours, whatever the PR state.
  3. **In review**: a published PR, nothing waiting on the developer.
  4. **Merged · close me**: the PR is completed, the task is still open; the row offers Finish.
  5. **Parked** (quiet, at the bottom): not worked on recently, no published PR, nothing waiting.
- Show the reason on each row (status chip) and in the collapsed rail (corner dot + count).
- Find the task's PR by its branch, so PRs opened by an agent, by hand, or in the browser count, not only ones Finish made.

## Non-goals

- No separate board screen (may come later).
- No "Ready to merge" group: the owner's reviewers / auto-complete merge, so it would be noise. Approved PRs stay in In review.
- No GitHub-hosted repos or GitHub trackers (GitHub trackers are not supported yet; see `src/main/trackers/TrackerRegistry.ts`).
  Tasks whose repo has no Azure DevOps remote simply get no PR status.
- No CI status before a PR exists (no branch-build lookup).
- No OS notifications when a task moves to Needs you (possible follow-up).
- Nothing written to Azure DevOps; read-only.

## Anti-goals

- Paid infrastructure or webhooks (service hooks need a server). Polling from the app only.
- Background polling while the window is not focused.
- Groups that jump around while the developer is in a task (see the Active rule).
- A busier list: rows stay one line.

## Constraints

- Azure DevOps only, through the task's repo connection (multi-org: a workspace may live in another org than the task,
  as `tasks:prStatus` already handles).
- All new ADO calls go in `AdoClient` and through `Tracker`; read-only, with the existing request/timeout/error handling.
- Telemetry: any new event must be added to `docs/telemetry.md`; repo/task/work item names stay scrubbed.
- Windows is the release target; nothing here is platform-specific.

## Approaches considered

1. **Per-task lookup (picked).** For each open task workspace: find the PR by source branch, then fetch its policy
   evaluations and threads. ~3 calls per task, ~30 per refresh at ten tasks. Simple, catches PRs from any identity,
   and sees merged PRs.
2. **One "my PRs" query per project, details only for matches.** Fewer calls and could share Home's cache, but merged
   PRs drop out of the active list (needs a second path for "Merged · close me") and PRs created under another
   identity (an agent's token) are missed. More special cases for a saving that does not matter at ten tasks.
3. **Push via service hooks.** Rejected: needs a server to receive them (no paid infra).

## Design

### What a task's "pulse" is

Per open task, per workspace (home + extra workspaces), main computes a `PrPulse`:

```ts
type PrPulse = {
  pr: { id; url; status: 'active' | 'completed' | 'abandoned'; isDraft; closedAt?: string } | null;
  ci: 'failing' | 'running' | 'passing' | 'none';      // from build-validation policy evaluations + PR statuses
  ciFailedName?: string;                                // e.g. the failing pipeline's display name, for the tooltip
  review: 'changes-asked' | 'approved' | 'waiting' | 'none'; // from reviewer votes (-5/-10 = changes asked, 10/5 = approved)
  approvals: { have: number; need: number | null };     // need from the min-reviewers policy when present
  conflict: boolean;                                    // mergeStatus === 'conflicts'
  unanswered: number;                                   // active threads whose last non-system comment is not by me
  waitingSince?: string;                                // when the PR was published (or last pushed), for "1d"
  checkedAt: string;
  error?: 'auth' | 'network' | 'not-found';
};
```

Several workspaces: for **trouble** (CI, conflict, changes asked, comments) the worst workspace counts. For **PR
state** the least advanced workspace counts: the task reaches Merged · close me only when every workspace with a PR is
merged and none has an active PR; any workspace with no PR or a draft keeps the task out of In review. A chip click
opens the PR of the workspace that caused the chip.

### Finding the PR

- Target project/repo from the existing `prContext(task, w)` / `prAvailability` (origin remote URL + connection). No
  ADO remote → no pulse.
- `repositoryId` via `client.repositoryId(project, repo)` (cache per repo for the session).
- New `AdoClient.latestPullRequestForBranch(project, repositoryId, branch)`: `searchCriteria.sourceRefName=refs/heads/<branch>`
  with `searchCriteria.status=all`, newest first, take the first. An active one wins over a completed/abandoned one.
- **Reopened tasks**: ignore completed/abandoned PRs whose `closedDate` is before the start of the task's latest
  `openPeriods` entry, so a reopened task does not jump to Merged and Finish does not link the old PR.
- When found, store it on the workspace as `pullRequest` (same `PullRequestRef` Finish uses), so Finish links it instead
  of creating one and the Done page shows it. Only write when it changed.

### CI, reviews, comments

- **CI**: `GET {project}/_apis/policy/evaluations?artifactId=vstfs:///CodeReview/CodeReviewId/{projectId}/{prId}`; build
  validation policies (`type.displayName === 'Build'`) give `rejected` → failing, `queued`/`running` → running,
  `approved` → passing. Also `GET .../pullRequests/{id}/statuses` for external CI that posts statuses (latest per
  context; `failed`/`error` → failing, `pending` → running). No evaluations and no statuses → `none`.
  Project id comes from the PR payload (`repository.project.id`).
- **Reviews**: reviewers' `vote` from the PR payload (already parsed for Home in `RawHomePr`). Any -10 → changes asked.
  `need` from the "Minimum number of reviewers" policy evaluation's `configuration.settings.minimumApproverCount` when present.
- **Unanswered comments**: `GET .../pullRequests/{id}/threads`; count threads with `status === 'active'`, not
  `isDeleted`, whose last comment with `commentType !== 'system'` was not written by "me". A thread I opened and
  nobody answered does not count. **"Me"** = the connection's token user (`client.me()`) **or the PR's creator**: the
  owner does not know whether agents post under their own account or another one, and this covers both without a
  setting (an agent that opened the PR under its own identity and replies to reviewers counts as the developer).
- **Conflicts**: `mergeStatus === 'conflicts'` on the PR.

### Grouping rule (pure function in the renderer)

```
merged      := pr.status === 'completed'                      → Merged · close me
abandoned   := pr.status === 'abandoned'                      → treat as no PR
needsAgent  := an agent tab is blocked on the developer (existing attention 'blocked')
trouble     := ci failing || review changes-asked || conflict || unanswered > 0 || needsAgent
recent      := now - task.lastActiveAt < 4 h   (see "Recent activity" below)

Merged · close me   if merged
Active              else if recent            (trouble shows as a chip, does not move the row)
Needs you           else if trouble
In review           else if a published (non-draft) PR
Parked              otherwise (idle, no PR or only a draft, nothing waiting)
```

### Recent activity

`openPeriods` cannot answer "worked on recently" (every open task has a period with `end: null`), and attention keeps
no 'working' timestamp. Time tracking already records exactly the right signal, persisted in the time store
(`src/main/time/TimeStore.ts`): **active intervals** (the task's page on screen in a focused window, trimmed at system
idle, flushed every minute by `ActivityTracker`) and **agent intervals** (Claude Code from telemetry, Copilot, OpenCode).
So `lastActiveAt(task)` = the latest interval end across `activeIntervals(taskId)` and `agentIntervals(taskId)`; no new
task field. Typing in a terminal happens with the page on screen, so it is covered. Plain terminal output (a dev server
logging) does not count; a tab merely open in the background does not count.

Order inside a group: Needs you by severity (CI failing, conflict, changes asked, comments, agent waiting) then oldest
first; Active by most recently worked; In review by longest waiting; Merged by merge time; Parked by most recently
worked. Parked rows are muted, like In review (and dimmed in the rail). Repo becomes a small tag only
when the project has more than one repo. `setting-up` / `setup-failed` tasks stay in Active with today's status dot.
The "Done (n)" list is unchanged.

### Row (open list) — option A

One line, as today: type icon, id, title, then one chip on the right with the most important reason:

| Chip | Colour |
|---|---|
| CI failing | red |
| Conflict | red |
| Changes asked | amber |
| N comments | amber |
| Draft | muted |
| Approved | green |
| 1d / 3h (waiting time, In review) | muted |
| Finish (button, Merged group) | amber filled |

Agent attention dot and cost stay as today (cost only in Active, where there is room). Hover shows a tooltip with the
full story ("CI failing: PR build · 1 of 2 approvals · 2 unanswered comments · waiting 1d"); clicking a chip opens the PR
in the browser, clicking the row opens the task as today. Group headers use the existing small spaced-out labels with a
count; Needs you's label is amber.

### Collapsed rail — option R3

- Amber count pill above the Needs you icons.
- Corner dot on each icon in the chip's colour (red / amber / green); none when nothing to say.
- Thin separator between groups; In review icons dimmed.
- Merged tasks show the hollow ✓ Finish square.
- Tooltip: title + the same full story.

Mockups: the screenshots shared in the brainstorm (A row style, R3 rail).

### Refresh

- Main-process `TaskPulseService` (new, `src/main/pulse/`): refreshes all open tasks of the active connection every
  3 minutes while a window is focused, on window focus when the last check is older than 60 s, after Finish, and on
  demand (`pulse:refresh` IPC, e.g. a refresh button in the tasks header tooltip).
- Requests for one refresh run with a small concurrency limit (4); a task's failure does not block others.
- Results are kept in memory and broadcast to the renderer (`pulse:changed`), like usage broadcasts. The last pulse
  per task is also persisted in a small `pulse.json` so the list is grouped right on startup before the first fetch.
- Errors: auth → one quiet note in the nav footer ("PR status unavailable: check the Azure DevOps token"), rows keep
  their last pulse; network → keep last pulse, retry next tick.

### Telemetry

`pulse.refreshed` (task count, duration, error kinds) and `nav.chipClicked` (chip kind). Added to `docs/telemetry.md`.

## Decided by the owner

- Lifecycle groups replace the repo grouping in the left list (not a separate board).
- Groups: Needs you, Active, In review, Merged · close me. No Ready to merge.
- Active = worked in the task recently, regardless of PR state.
- Row style A (one line + chip); rail style R3.
- Approach 1 (per-task lookup by branch).

## Calls made in the design (owner can override)

- "Recently" = 4 hours.
- Active wins over Needs you while recent; trouble shows as a chip without moving the row.
- "Worked on" = page on screen in a focused window (not idle) or an agent working in its tabs, read from the time
  store's intervals (owner did not know; Claude's call).
- Idle tasks with no published PR go to a quiet Parked group (owner did not know; Claude's call, keeps Active honest).
- "Me" for unanswered comments = token user or PR creator (owner did not know how agents post; covers both).
- Several workspaces: least advanced for PR state, worst for trouble.
- Reopened tasks ignore PRs closed before the latest open period.
- 3-minute refresh while focused; nothing in the background.
- CI only once a PR exists.
- Repo tag only when the project has several repos.
- Abandoned PR = no PR.

## Left to the builder

- Exact component split in `TaskNav.tsx`, CSS, tooltip component reuse.
- Whether `pulse.json` lives in the data folder next to `state.json` (it should) and its schema.
- Test fixtures for ADO payloads (policy evaluations, statuses, threads).
- Write a change note in `docs/changes/` when shipping.
