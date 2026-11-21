# Calm sidebar: one fixed task list, one quiet mark per row

Date: 2026-11-21. Follows the lifecycle groups of 2026-11-18 (`2026-11-18-task-lifecycle-groups-design.md`), which this
replaces in the left list.

## Why

The owner finds the sidebar too busy: alert tags, icons, and tasks that jump around. It should be simple and calm.

What makes it busy today (`src/renderer/components/TaskNav.tsx`, `src/shared/pulse.ts`):

- A row can carry nine things: type icon, id, title, repo name, "+N repos", agent dot, setup dot, status chip, cost.
  The current task also gets a Finish button and a bin on a line of its own.
- Five group headings with counts, one amber.
- Tasks move: opening a task pulls it into Active, four idle hours drop it out again, and every PR status refresh
  (3 minutes, and on window focus) can move a task to another group or reorder a group.

## Goals

- A task keeps its place in the list for as long as it is open.
- A row shows at most one mark, and most rows show none.
- Selecting a task does not shift any other row.

## Not goals

- No change to how PR status is read or how often (`TaskPulseService`, `pulse:*` IPC stay).
- No change to Home, Project, Sprint, Dreams or brain items in the nav, nor to the join card.
- No new settings.

## What would make it a failure

- Any row moving because of a click, a timer or a PR status refresh.
- A mark that needs a legend: more than the three below.

## Approaches

- **A. One fixed list, one quiet mark per row.** No groups; detail on hover. Chosen by the owner: it removes both the
  noise and the movement. The cost: "in review" and "parked" are no longer told apart at a glance.
- **B. Two groups (Working, Waiting) that move only on PR publish or merge.** Keeps some overview, but headings and
  some movement remain.
- **C. Keep the five groups, trim the rows.** Smallest change, still the busiest, still shifts with time and status.

## The design

### The list

One list under the "Tasks" heading, no group headings, no counts. Open tasks in the active project, ordered by
`createdAt`, newest first (ties by id). The order depends on nothing else. The Done toggle below it stays as it is.

```
TASKS                          + New task
▢ 412  Export invoices to PDF      ●
▢ 398  Fix login redirect
▢ 377  Sprint cache refresh        ✓
▢ 351  Brain sync on Windows
```

### A row

Type icon, work item id, title. Then at most one mark at the right, the first that applies:

1. **Red dot**: the worktree folder is missing, or setup failed.
2. **Accent dot**: setting up, or finishing.
3. **Amber dot**: something waits on the owner. CI failing, a merge conflict, changes asked, unanswered comments, or an
   agent tab blocked on the owner.
4. **Green check**: every live PR is merged; the task can be finished.

Nothing else is on the row: no chip text, no cost, no repo name, no "+N repos", no muted titles, no separate dot for an
agent that finished its turn.

The row's tooltip carries the rest, one line each where it applies: what the mark means (the existing `story`, such as
"CI failing: build · 2 unanswered comments", or the agent's wait label), the repo (and "+N repos"), and the cost so far.
The mark has the same words as its accessible name.

Clicking an amber dot that comes from a PR opens that PR in the browser; clicking the green check opens the task's
Finish page (both as the chips do today, same `nav.chipClicked` telemetry). Other marks are not buttons.

### Finish and discard

The line under the current task (Finish button and bin) goes. On the current task's row, when the task is ready and
its Finish page is not open, two small icon buttons take the mark's place at the right: Finish (check) and Discard
(bin), with today's labels and tooltips. "Finishing…" is the accent dot. No other row changes height or position.

### The rail (collapsed)

Task icons in the same order as the list. No separators, no count pill, no dimming. A small corner dot on an icon for
marks 1 to 3 in the mark's colour, and a small green corner check for mark 4. Under the current task's icon the Finish
and Discard squares stay as today (the rail has no room in the row); the separate hollow Finish square for merged
tasks goes, since the corner check says it.

### The foot

The connection line shows only when there is no connection or its status is not ok. The Dreams line, the "PR status
unavailable" note and the collapse button stay.

### Code

- `lifecycleOf` keeps returning the chip and the story; the nav derives the mark from them and from the task status.
  `group`, `sortKey`, `LIFECYCLE_ORDER`, `LIFECYCLE_LABEL` and `RECENT_MS` have no other user: remove them, and the
  "active"/"in review"/"parked" branches with them, if nothing else needs them once the nav is done. The time store's
  `lastActive` in the pulse view goes the same way if unused.
- `groupTasks` becomes a plain filter and sort.
- Unused styles (`navchip*`, `nav-subhead*`, `rail-sep`, `rail-count`, `rail-finish-hollow`, `is-muted`, `is-dim`,
  `nav-task-action`, `navrow-cost`, `navrow-repos`) are deleted.
- Tests in `TaskNav.test.tsx` and `pulse.test.ts` follow; a test pins that opening a task and a pulse change leave the
  order untouched.
- Change note in `docs/changes/`, `docs/telemetry.md` if the event's properties change.

## Claude's calls (not asked)

- Newest first as the fixed order.
- One amber for every "waits on you" reason, red only for a broken task (missing folder, failed setup).
- The agent-finished dot is dropped; only a blocked agent marks a row.
- Cost and repo move to the tooltip rather than disappearing.
- The connection line hides while all is well.

## Left to the builder

Exact sizes, spacing and icon choice, within the tokens in `src/renderer/styles/tokens.css`.
