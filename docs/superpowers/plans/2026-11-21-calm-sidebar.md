# Calm Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The left task list becomes one fixed list (newest first) with at most one quiet mark per row; nothing moves on a click, a timer or a PR status refresh.

**Architecture:** `src/shared/pulse.ts` stops deciding groups and returns a small signal per task (waits / merged / none, plus the story). A pure renderer function turns task status and signal into the row's one mark. `TaskNav.tsx` renders a flat sorted list, with Finish and Discard as icons inside the current row.

**Tech Stack:** React + TypeScript, Zustand store, Fluent icons, plain CSS (`src/renderer/styles/shell.css`), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-21-calm-sidebar-design.md`

## Global Constraints

- Order of open tasks: `createdAt` newest first, ties by `id` ascending. Nothing else may influence it.
- At most one mark per row, first that applies: red dot (worktree missing, setup failed) → accent dot (setting up, finishing) → amber dot (waits on the owner) → green check (merged).
- Selecting a task must not change the height or position of any row.
- No change to how or how often PR status is read (`TaskPulseService`, `pulse:get`, `pulse:refresh`, `pulse:changed`).
- Home, Project, Sprint, Dreams, brain items, the join card, the Done toggle and the nav resize handle are untouched.
- Colours and sizes only from `src/renderer/styles/tokens.css` (`--red`, `--accent`, `--amber`, `--green`, `--muted`).
- Checks: `npm test`, `npm run typecheck`, `npm run lint` all pass at the end of every task.
- Commit messages end with the two attribution lines used on this branch (`Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>` and the `Claude-Session:` line).

## Review Focus

1. Two tasks with the same or an unparsable `createdAt` (tests use `'now'`): the order must still be stable across renders (unparsable counts as 0, tie by id). Test in Task 2.
2. A stale pulse on a setting-up, setup-failed or finishing task: the status mark wins and the tooltip carries no PR story. Test in Task 2.
3. The current task is merged and ready: exactly one Finish control on its row (the Finish icon, not also the green check). Test in Task 3.
4. Clicking a mark must not also open the task; the mark is a separate button from the row button. Test in Task 3.
5. A pulse change or opening another task re-renders the list: the row order before and after is identical. Test in Task 3.

---

### Task 1: The task signal in `pulse.ts`

**Files:**
- Modify: `src/shared/pulse.ts`
- Test: `src/shared/pulse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TaskSignal = {
    state: 'waits' | 'merged' | 'none';
    /** One line for the tooltip; '' when there is nothing to say. */
    story: string;
    /** The workspace whose PR the wait is about; null for a blocked agent, merged and none. */
    prWorkspaceId: string | null;
  };
  export function taskSignal(input: { pulses: PrPulse[]; agentBlocked: boolean; now: number }): TaskSignal;
  ```
- `lifecycleOf` and its types stay for now (Task 5 removes them), so the app keeps compiling.

- [ ] **Step 1: Write the failing tests** in a new `describe('taskSignal')`, reusing the file's existing pulse builders:
  - merged: all live PRs completed → `{ state: 'merged', story: 'PR merged', prWorkspaceId: null }`; an abandoned PR or a PR-less workspace beside it does not block; another active PR does (state not `merged`).
  - waits, from a PR: CI failing, conflict, changes asked, unanswered comments each give `state: 'waits'` and `prWorkspaceId` of that pulse; with two troubled workspaces the worse one (existing `SEVERITY` order, then older PR) is named.
  - waits, from an agent: no PR trouble and `agentBlocked: true` → `state: 'waits'`, `prWorkspaceId: null`, story contains `agent needs you`.
  - none: a published PR with nothing wrong → `state: 'none'` and the story still reads e.g. `1 of 2 approvals · waiting 2d`; no pulses → `{ state: 'none', story: '', prWorkspaceId: null }`.
  - recency plays no part: the function takes no `lastActiveAt`.
- [ ] **Step 2: Run** `npx vitest run src/shared/pulse.test.ts` — the new tests fail (`taskSignal` not exported).
- [ ] **Step 3: Implement `taskSignal`** from the merged check, the worst-trouble loop and `storyOf` that `lifecycleOf` already has; share those pieces, do not copy them.
- [ ] **Step 4: Run** `npx vitest run src/shared/pulse.test.ts` — all pass.
- [ ] **Step 5: Commit** `feat(nav): a task signal without groups (waits, merged, none)`.

### Task 2: The list order and the one mark, as pure functions

**Files:**
- Create: `src/renderer/taskMark.ts`, `src/renderer/taskMark.test.ts`
- Modify: `src/renderer/components/TaskNav.tsx` (replace `groupTasks`), `src/renderer/components/TaskNav.test.tsx` (the `groupTasks` describe)

**Interfaces:**
- Consumes: `TaskSignal` (Task 1).
- Produces, in `src/renderer/taskMark.ts`:
  ```ts
  export type TaskMark = {
    kind: 'broken' | 'busy' | 'waits' | 'merged';
    /** Accessible name and first tooltip line. */
    label: string;
  };
  export function taskMark(task: TaskView, signal: TaskSignal | null): TaskMark | null;
  /** Tooltip lines joined with '\n': the mark's label (or the signal's story when there is no mark), the repo line, the cost. Empty parts are left out. */
  export function rowTitle(input: { mark: TaskMark | null; story: string; repos: string; cost: number }): string;
  ```
  Labels: `Worktree folder missing`, `Setup failed`, `Setting up`, `Finishing`; waits → the signal's story, or `Waiting for you` when it is empty; merged → `Merged: finish this task`. `repos` is the home repo's name plus ` +N repos` (existing `plural`); cost shows as `eur(cost)` only when above 0.
- Produces, in `TaskNav.tsx` (replacing `groupTasks`):
  ```ts
  export function listTasks(all: TaskView[], repos: Repo[], connectionId: string | null | undefined, knownIds: string[] | undefined): { open: TaskView[]; done: TaskView[] };
  ```
  Same connection filter as `groupTasks` (#219, #225); `open` sorted by the Global Constraints order.

- [ ] **Step 1: Write the failing tests.**
  - `taskMark.test.ts`: precedence (a task with `worktreeMissing` and a `waits` signal → `broken`; `setup-failed` → `broken`; `setting-up`/`finishing` → `busy` even with a `merged` or `waits` signal; ready + `waits` → `waits` with the story as label; ready + `merged` → `merged`; ready + `none` or `null` → `null`). `rowTitle`: mark label first; for a busy/broken task the PR story is not included; with no mark the story is the first line; `webshop +1 repo`; cost line only when > 0.
  - `TaskNav.test.tsx`: replace the `groupTasks` describe with `listTasks`: newest first; same `createdAt` → by id; `createdAt: 'now'` on all → by id, and the same on a second call; the three connection cases (#219, #225) carried over with their existing fixtures; done tasks collected apart.
- [ ] **Step 2: Run** `npx vitest run src/renderer/taskMark.test.ts src/renderer/components/TaskNav.test.tsx -t "taskMark|rowTitle|listTasks"` — fail.
- [ ] **Step 3: Implement** `taskMark`, `rowTitle`, `listTasks`. Keep `groupTasks` exported until Task 3 switches the component (delete it there).
- [ ] **Step 4: Run** the same command — pass. `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(nav): fixed task order and one mark per task, as pure functions`.

### Task 3: The expanded list

**Files:**
- Modify: `src/renderer/components/TaskNav.tsx`, `src/renderer/styles/shell.css`, `src/renderer/components/TaskNav.test.tsx`

**Interfaces:**
- Consumes: `taskSignal`, `taskMark`, `rowTitle`, `listTasks`.
- Produces: a hook in `TaskNav.tsx`, `useSignals(): { pulse: PulseView | null; signal: (t: TaskView) => TaskSignal | null }` (null for setting-up, setup-failed and finishing tasks), used by Task 4's rail. It replaces `useLifecycles`; no minute timer, no `recentAt`.

Behaviour to build (spec sections "The list", "A row", "Finish and discard"):

- One list under the Tasks heading: no `nav-subhead`, no counts, one `role="list"`-free plain sequence of rows from `listTasks().open`.
- Row = row button (type icon, id, title; `title` = `rowTitle(...)`) + at most one trailing element:
  - current task, status `ready`, Finish page not open → two `ibtn` icon buttons: Finish (`CheckmarkCircle16Regular`, `aria-label="Finish task"`, `title` = existing `FINISH_TITLE`) and Discard (`Delete16Regular`, existing `DISCARD_LABEL`, calls `askDiscard`). No mark beside them.
  - else the mark: `broken` → red dot, `busy` → accent dot, both `<span role="img" aria-label={label}>`; `waits` with a `prWorkspaceId` → a `<button class="navmark navmark-waits" aria-label={label}>` that opens that workspace's PR url via `links:open`; `waits` without one (agent) → the same dot as a `span`; `merged` → a `<button class="navmark navmark-merged" aria-label={label}>` with a 16px green check that goes to `{ kind: 'finish', taskId }`.
  - Mark clicks call `track('nav.chipClicked', { kind })` with kind `waits` or `merged`.
- Costs: `useTaskCosts` for every open task (tooltip), plus done tasks when shown; Done rows keep their visible cost as today.
- Removed from the expanded list: `Chip`, `FinishAction`, `DiscardButton`'s own line, `AttentionDot` on rows, `navrow-repos`, row cost on open rows, `is-muted`.
- CSS: add `.navmark` (24×24 hit area, no border or background, centred 8px dot; hover `--bg-hover`), `.navmark-waits` dot `--amber`, `.navmark-merged` icon `--green`, `.navrow-actions` (the two icons, `--muted`, Discard red on hover as `.nav-discard` is today). Rows keep one fixed height.

- [ ] **Step 1: Write the failing tests** (replace `describe('TaskNav lifecycle groups')`, `'TaskNav current merged task'` open-list case, `'TaskNav task actions (#95)'` open-list cases, `'attention'`, `'TaskNav extra repos'`, and the muting/Active cases in `'TaskNav review fixes'` and `'TaskNav lifecycle fixes'`):
  - no group headings: `queryByText('Needs you')`, `'Active'`, `'In review'`, `'Parked'` are all null with pulses that would have produced them.
  - order pinned: render three tasks; record the row titles' order; open the oldest task, then emit a `pulse:changed` with CI failing on the middle one; the order is identical both times.
  - row height pinned structurally: with a current ready task there is no element with class `nav-task-action`, and the Finish and Discard buttons are inside that task's `.navrow`.
  - marks: CI-failing pulse → a button named by the story inside the row, clicking it invokes `links:open` with the PR url, tracks `nav.chipClicked` `{ kind: 'waits' }`, and `openTask` is not called; merged pulse on a non-current task → button `Merged: finish this task` that sets screen `{ kind: 'finish', taskId }`; blocked agent → an amber mark that is not a button; clean task → no `.navmark` and no `.dot` in the row.
  - current + merged + ready → exactly one control whose name matches `/finish/i` in the row.
  - stale pulse on a setting-up task → accent dot `Setting up`, row `title` does not contain `CI failing`.
  - tooltip: a two-repo task's row title contains `webshop +1 repo`; a task with cost contains the `eur` text; no cost text is visible in an open row.
  - Finishing: current task with status `finishing` shows the accent dot `Finishing` and no Finish button.
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/TaskNav.test.tsx` — the new tests fail.
- [ ] **Step 3: Implement** the list, row, marks, inline actions and CSS; delete `groupTasks`, `useLifecycles`, `recentAt`, `Chip`, `FinishAction` and their tests. The rail keeps compiling by reading `useSignals` minimally (full rail work is Task 4).
- [ ] **Step 4: Run** `npx vitest run src/renderer/components/TaskNav.test.tsx`, `npm run typecheck`, `npm run lint` — pass.
- [ ] **Step 5: Commit** `feat(nav): one fixed task list with one mark per row, Finish inside the row`.

### Task 4: The collapsed rail

**Files:**
- Modify: `src/renderer/components/TaskNav.tsx`, `src/renderer/styles/shell.css`, `src/renderer/components/TaskNav.test.tsx`

**Interfaces:**
- Consumes: `useSignals`, `taskMark`, `listTasks`.

Behaviour (spec "The rail"): icons in list order, no `rail-sep`, no `rail-count`, no `is-dim`. Corner dot `rail-dot-red` / `rail-dot-accent` / `rail-dot-amber` for `broken` / `busy` / `waits`; for `merged` a small green corner check (`rail-check`, 10px). Icon `title` and `aria-label`: `"<id> <title>"`, plus ` · <mark label>` in the title when there is a mark. `RailFinish` and `RailDiscard` under the current ready icon stay; `RailMergedFinish` goes. No `AttentionDot` in the rail.

- [ ] **Step 1: Write the failing tests** (replace `describe('TaskNav collapsed rail (R3)')`, the rail cases of `'TaskNav current merged task'`, `'matches the dimming selector…'`, `'shows no rail dot from a stale pulse…'`): no `.rail-count`, `.rail-sep`, `.is-dim` or `.rail-finish-hollow` with a full mix of pulses; amber corner dot on a CI-failing task; `.rail-check` on a merged one; none on a clean one; accent dot (not amber) on a setting-up task with a stale failing pulse; icon order equals the expanded order; the current ready task still has exactly one `Finish task` and one `Discard task` button.
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/TaskNav.test.tsx -t "rail"` — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole `TaskNav.test.tsx`, `npm run typecheck` — pass.
- [ ] **Step 5: Commit** `feat(nav): the rail follows the calm list`.

### Task 5: Foot, clean-up, notes, and a look at the real app

**Files:**
- Modify: `src/renderer/components/TaskNav.tsx` (foot), `src/shared/pulse.ts`, `src/shared/pulse.test.ts`, `src/main/ipc/handlers.ts` (`pulse:get`, around line 3226), its test `src/main/ipc/handlers.part4.test.ts`, `src/renderer/test-helpers/fakeApi.ts`, `src/renderer/styles/shell.css`, `docs/telemetry.md`
- Create: `docs/changes/2026-11-21-calm-sidebar.md`

- [ ] **Step 1: Foot.** Test first: with a connection whose status is `ok` there is no `.nav-status` connection line (expanded and rail); with a failing status or no connection the existing text shows. Update `'shows the selected task repo connection status in the footer'` accordingly. Implement, run, pass.
- [ ] **Step 2: Remove what has no user left.** In `pulse.ts`: `lifecycleOf`, `Lifecycle`, `LIFECYCLE_ORDER`, `LIFECYCLE_LABEL`, `TaskLifecycle`, `Chip`, `ChipKind`, `RECENT_MS`, `troubleChip`, sort keys; `PulseView` becomes `PulseSnapshot` (drop `lastActive`) — and the `lastActive` computation in the `pulse:get` handler with its test and the `fakeApi` fields. Confirm with `grep -rn "lifecycleOf\|LIFECYCLE_\|RECENT_MS\|lastActive\b" src` (the unrelated `RECENT_MS` in `src/main/prDraft/pickTab.ts` stays). Delete the matching tests in `pulse.test.ts` (`lifecycleOf`, `lifecycleOf fixes`, `lifecycle labels`) only after checking each case is covered by a `taskSignal` test; port any that is not.
- [ ] **Step 3: Remove dead CSS** in `shell.css`: `.navchip*`, `.nav-subhead*`, `.rail-sep`, `.rail-count`, `.rail-finish-hollow`, `.is-muted`/`.is-dim` rules, `.nav-task-action`, `.btn.nav-finish`, `.navrow-cost` (if Done rows use another class; otherwise keep), `.navrow-repos`. Check each with a grep over `src/renderer` before deleting. `AttentionDot` stays if another component imports it.
- [ ] **Step 4: Docs.** `docs/telemetry.md`: `nav.chipClicked` `kind` is now `waits` or `merged` (the mark on a task row). Change note `docs/changes/2026-11-21-calm-sidebar.md`: the spec it followed, how the list and marks work, what was verified, known gaps (in review and parked no longer told apart; agent-finished no longer marked; anything not seen in the real app).
- [ ] **Step 5: Run** `npm test`, `npm run typecheck`, `npm run lint` — all pass.
- [ ] **Step 6: Look at it.** `SHELLIE_USER_DATA=<fresh absolute folder> npm start`, create two or three blank tasks, and check by eye (expanded and rail): order stays put when switching tasks, selecting a task moves no row, Finish and Discard sit inside the current row, the foot shows no connection line when all is well. Record in the change note what was and was not seen.
- [ ] **Step 7: Commit** `refactor(nav): grouping code and styles removed, notes for the calm sidebar`.
