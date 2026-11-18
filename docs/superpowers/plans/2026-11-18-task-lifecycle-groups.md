# Task lifecycle groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the left task list by lifecycle (Needs you, Active, In review, Merged · close me, Parked) with a status chip per row and dots plus a count in the collapsed rail, from each task's Azure DevOps PR, CI, reviews and comments.

**Architecture:** A main-process `TaskPulseService` (modelled on `HomeService`) finds each open task workspace's PR by branch, reads its policy evaluations, statuses and threads, and keeps one `PrPulse` per workspace in memory and in `pulse.json`. The renderer fetches the snapshot (`pulse:get`, refetched on `pulse:changed` and `time:changed`) and a pure shared function `lifecycleOf` turns pulse + last activity + attention into a group, a chip and a sort key. `TaskNav` renders groups instead of repos.

**Tech Stack:** Electron, TypeScript, React, zustand, zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-18-task-lifecycle-groups-design.md`

## Global Constraints

- Azure DevOps only, read-only; nothing is written to Azure DevOps.
- Refresh every 3 minutes while a window is focused; on focus when the last check is older than 60 s; never while unfocused.
- "Recent" = last activity within 4 hours (`RECENT_MS = 4 * 60 * 60 * 1000`).
- Concurrency limit 4 per refresh; one workspace's failure never blocks the others.
- Group order and labels exactly: `Needs you`, `Active`, `In review`, `Merged · close me`, `Parked`.
- Rows stay one line; the repo tag shows only when the active project has more than one repo.
- New telemetry events (`pulse.refreshed`, `nav.chipClicked`) carry no names, ids, paths or URLs, and are listed in `docs/telemetry.md`.
- Checks: `npm test`, `npm run typecheck`, `npm run lint` all pass after every task.

## Review Focus

- A token without Code read scope (401/403 on PR calls): rows keep their last pulse, the footer says "PR status unavailable: check the Azure DevOps token", nothing throws into the nav. Test in Task 3.
- A repo whose origin is GitHub or has no remote (`prAvailability` has no target): the task gets no pulse and lands in Active/Parked by activity only, no error. Test in Task 3.
- A reopened task whose branch has an old completed PR closed before the latest `openPeriods` start: not Merged, PR not written to the workspace. Test in Task 3.
- A task with two workspaces, one merged, one active PR: In review (or Needs you), never Merged; chip opens the troubled workspace's PR. Test in Task 1.
- A thread whose last comment is a system comment ("Policy status changed") after my reply: still answered. Test in Task 2.

---

### Task 1: Shared pulse types and the lifecycle rule

**Files:**
- Create: `src/shared/pulse.ts`
- Test: `src/shared/pulse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const RECENT_MS: number;
  export type CiState = 'failing' | 'running' | 'passing' | 'none';
  export type ReviewState = 'changes-asked' | 'approved' | 'waiting' | 'none';
  export const PrPulseSchema: z.ZodType<PrPulse>;
  export type PrPulse = {
    workspaceId: string;
    pr: { id: number; url: string; status: 'active' | 'completed' | 'abandoned'; isDraft: boolean;
          createdAt: string; closedAt: string | null } | null;
    ci: CiState; ciFailedName: string | null;
    review: ReviewState; approvals: { have: number; need: number | null };
    conflict: boolean; unanswered: number; checkedAt: string;
  };
  export const PulseSnapshotSchema; // { tasks: Record<taskId, PrPulse[]>, error: 'auth' | null, checkedAt: string | null }
  export type PulseSnapshot = z.infer<typeof PulseSnapshotSchema>;
  export type PulseView = PulseSnapshot & { lastActive: Record<string, number> }; // pulse:get result
  export type Lifecycle = 'needs-you' | 'active' | 'in-review' | 'merged' | 'parked';
  export const LIFECYCLE_ORDER: Lifecycle[];          // needs-you, active, in-review, merged, parked
  export const LIFECYCLE_LABEL: Record<Lifecycle, string>;
  export type ChipKind = 'ci-failing' | 'conflict' | 'changes-asked' | 'comments' | 'draft' | 'approved' | 'waiting' | 'finish';
  export type Chip = { kind: ChipKind; text: string; tone: 'red' | 'amber' | 'green' | 'muted'; workspaceId: string | null };
  export type TaskLifecycle = { group: Lifecycle; chip: Chip | null; story: string; sortKey: number };
  export function lifecycleOf(input: {
    pulses: PrPulse[];            // one per workspace that has an ADO target; [] when none
    lastActiveAt: number | null;  // epoch ms
    agentBlocked: boolean;        // an attention entry with reason 'blocked' on one of the task's terminals
    now: number;
  }): TaskLifecycle;
  ```

- [ ] **Step 1: Write the failing tests** in `src/shared/pulse.test.ts` (helper `pulse(over: Partial<PrPulse>)` with defaults `pr: active non-draft, ci 'passing', review 'waiting', conflict false, unanswered 0`; `NOW = Date.parse('2026-11-18T12:00:00Z')`):
  - `merged wins`: all pulses `pr.status 'completed'` → `group 'merged'`, `chip.kind 'finish'`, `sortKey` = latest `closedAt` in ms (ascending: merged first, first listed).
  - `recent wins over trouble`: `ci 'failing'`, `lastActiveAt NOW - 3h` → `group 'active'`, `chip.kind 'ci-failing'`, `chip.tone 'red'`.
  - `recent boundary`: `lastActiveAt NOW - RECENT_MS` → not active (strictly less than 4 h counts).
  - `trouble when idle` (lastActiveAt NOW − 5h) for each: ci failing → `needs-you`/`ci-failing`; conflict → `conflict`; review changes-asked → `changes-asked` amber; unanswered 2 → `comments` with `text '2 comments'`; `agentBlocked` with a clean pulse → `needs-you`, `chip null` (the attention dot carries it).
  - `severity order`: ci failing + unanswered 1 → chip `ci-failing`; Needs you `sortKey` orders ci-failing < conflict < changes-asked < comments < agent, ties by older `pr.createdAt` first.
  - `published PR idle` → `in-review`; approved → chip `approved` green; otherwise chip `waiting` with `text` from `pr.createdAt` age (`'3h'`, `'1d'`), sortKey ascending `createdAt` (longest waiting first).
  - `parked`: no pulses, idle → `parked`, chip null; draft PR idle → `parked`, chip `draft` muted.
  - `abandoned = no PR`: abandoned pulse, idle → `parked`.
  - `two workspaces`: [completed, active published] idle → `in-review` (not merged); [completed, none-PR] → `parked`; [active ci failing ws 'b', active clean ws 'a'] idle → `needs-you`, `chip.workspaceId 'b'`.
  - `Active sort`: sortKey = −lastActiveAt (most recent first). `Parked` the same.
  - `story`: ci failing + 1 of 2 approvals + 2 comments → `'CI failing: PR build · 1 of 2 approvals · 2 unanswered comments · waiting 1d'` (parts joined by `' · '`, omitted when absent; `ciFailedName` after `CI failing: `).

- [ ] **Step 2: Run** `npx vitest run src/shared/pulse.test.ts` — expected FAIL (module not found).

- [ ] **Step 3: Implement `src/shared/pulse.ts`.** Combine workspaces first: PR state from the least advanced (`none`/abandoned < draft < published active < completed), trouble from the worst workspace by the severity order above. Then:
  ```
  merged      if every pulse with a non-abandoned PR is completed and at least one is, and no pulse lacks a PR
  active      else if lastActiveAt !== null && now - lastActiveAt < RECENT_MS
  needs-you   else if trouble (ci failing | conflict | changes-asked | unanswered > 0 | agentBlocked)
  in-review   else if least advanced is a published active PR
  parked      otherwise
  ```
  Chip = the worst trouble if any, else per group (`draft` for a draft, `approved`/`waiting` in review, `finish` in merged). Age text: `< 1h` → `'<1h'`, `< 24h` → `'${h}h'`, else `'${d}d'`.

- [ ] **Step 4: Run** `npx vitest run src/shared/pulse.test.ts` — expected PASS.

- [ ] **Step 5: Commit** `git add src/shared/pulse.ts src/shared/pulse.test.ts && git commit -m "Lifecycle rule for the task list (pulse types)"`

---

### Task 2: Azure DevOps reads for a branch's PR and turning them into a pulse

**Files:**
- Modify: `src/main/services/AdoClient.ts` (next to `findActivePullRequest`, ~line 970)
- Create: `src/main/pulse/prPulse.ts`
- Test: `src/main/services/AdoClient.test.ts`, `src/main/pulse/prPulse.test.ts`

**Interfaces:**
- Produces (AdoClient):
  ```ts
  export type RawPrDetail = {
    pullRequestId: number; status: 'active'|'completed'|'abandoned'; isDraft: boolean;
    creationDate: string; closedDate: string | null; mergeStatus: string | null;
    projectId: string; createdById: string | null; webUrl: string;
    reviewers: { id: string; vote: number; isContainer: boolean }[];
  };
  pullRequestsForBranch(project: string, repositoryId: string, branch: string): Promise<RawPrDetail[]>; // status=all, newest first
  policyEvaluations(project: string, projectId: string, prId: number): Promise<RawPolicyEvaluation[]>;
  pullRequestStatuses(project: string, repositoryId: string, prId: number): Promise<RawPrStatus[]>;
  pullRequestThreads(project: string, repositoryId: string, prId: number): Promise<RawPrThread[]>;
  ```
  with `RawPolicyEvaluation = { status: string; typeName: string; displayName: string | null; minimumApproverCount: number | null }`, `RawPrStatus = { state: string; context: string; description: string | null; creationDate: string }`, `RawPrThread = { status: string | null; isDeleted: boolean; comments: { authorId: string; commentType: string; isDeleted: boolean }[] }`.
- Produces (`src/main/pulse/prPulse.ts`):
  ```ts
  export function pickPr(prs: RawPrDetail[], openedAt: string | null): RawPrDetail | null;
  export function toPrPulse(input: { workspaceId: string; pr: RawPrDetail | null; evaluations: RawPolicyEvaluation[];
    statuses: RawPrStatus[]; threads: RawPrThread[]; me: string; now: Date }): PrPulse;
  ```

- [ ] **Step 1: Write failing AdoClient tests** with the file's existing fake-fetch pattern:
  - `pullRequestsForBranch` requests `/{project}/_apis/git/repositories/{repoId}/pullrequests?searchCriteria.sourceRefName=refs%2Fheads%2Ffeat%2Fx&searchCriteria.status=all&api-version=7.1` and maps `repository.project.id` → `projectId`, `_links.web.href` or the built `{org}/{project}/_git/{repo}/pullrequest/{id}` → `webUrl`, `closedDate` missing → `null`.
  - `policyEvaluations` requests `/{project}/_apis/policy/evaluations?artifactId=` + `encodeURIComponent('vstfs:///CodeReview/CodeReviewId/{projectId}/{prId}')` + `&api-version=7.1-preview.1`; maps `configuration.type.displayName` → `typeName`, `context.buildDefinitionName ?? configuration.settings.displayName` → `displayName`, `configuration.settings.minimumApproverCount` → number or null.
  - `pullRequestStatuses` and `pullRequestThreads` hit `.../pullRequests/{id}/statuses` and `/threads`; thread comment `author.id` → `authorId`.
  - All four pass `{ code: true }` so a 401 is `AdoError('unauthorized')` with the code-read message.

- [ ] **Step 2: Write failing `prPulse.test.ts`:**
  - `pickPr`: an active PR wins over a newer completed one; completed with `closedDate` before `openedAt` is ignored (→ null when it is the only one); abandoned kept (lifecycle treats it as none); `openedAt null` keeps everything.
  - CI: Build evaluation `rejected` → `failing`, `ciFailedName` = its displayName; `queued`/`running` → `running`; all `approved` → `passing`; status `failed`/`error` (latest per `context` by `creationDate`) → `failing` with `ciFailedName` = context; `pending` → `running`; nothing → `none`. Failing beats running beats passing.
  - Review: any reviewer vote −10 → `changes-asked`; else any vote 10 or 5 → `approved` only when `have >= need` (or `need` null); else `waiting`; `have` = non-container reviewers with vote ≥ 5; `need` from a `Minimum number of reviewers` evaluation.
  - `conflict` = `mergeStatus === 'conflicts'`.
  - `unanswered`: counts `status 'active'`, not deleted threads whose last non-deleted comment with `commentType !== 'system'` is by someone other than `me` **and** other than `pr.createdById`; a thread where only system comments follow my reply → not counted; a thread with only system comments → not counted.
  - `pr null` → pulse with `pr null`, `ci 'none'`, `review 'none'`, `unanswered 0`.

- [ ] **Step 3: Run** `npx vitest run src/main/services/AdoClient.test.ts src/main/pulse/prPulse.test.ts` — FAIL.

- [ ] **Step 4: Implement** the four AdoClient methods (reuse `prPath`, `request`, `API`) and `prPulse.ts`. Add the four to the `Tracker` interface and `AzureDevOpsTracker` delegation (`src/main/trackers/Tracker.ts`, `AzureDevOpsTracker.ts`) under the same names.

- [ ] **Step 5: Run** the two test files, then `npm run typecheck` — PASS.

- [ ] **Step 6: Commit** `git commit -m "Read a branch's PR, checks, statuses and threads from Azure DevOps"`

---

### Task 3: TaskPulseService

**Files:**
- Create: `src/main/pulse/TaskPulseService.ts`
- Test: `src/main/pulse/TaskPulseService.test.ts`

**Interfaces:**
- Consumes: Task 1 `PrPulse`, `PulseSnapshot`, `PulseSnapshotSchema`; Task 2 client methods, `pickPr`, `toPrPulse`; `JsonFileStore` (`src/main/usage/JsonFileStore.ts`); `PullRequestRef` (`src/shared/types.ts`).
- Produces:
  ```ts
  export type PulseTarget = { connectionId: string; project: string; repo: string };
  export type PulseClient = Pick<AdoClient, 'me' | 'repositoryId' | 'pullRequestsForBranch'
    | 'policyEvaluations' | 'pullRequestStatuses' | 'pullRequestThreads'>;
  export type PulseDeps = {
    file: string;
    /** Open (status !== 'done') tasks and their workspaces with a branch. */
    workspaces: () => { taskId: string; workspaceId: string; branch: string; openedAt: string | null;
                        stored: PullRequestRef | null }[];
    target: (taskId: string, workspaceId: string) => Promise<PulseTarget | null>;
    client: (connectionId: string) => PulseClient;
    /** Saves a found PR on the workspace when it differs from `stored`. */
    link: (taskId: string, workspaceId: string, ref: PullRequestRef) => Promise<void>;
    onChanged: (snapshot: PulseSnapshot) => void;
    onRefreshed?: (info: { tasks: number; durationMs: number; errors: ('auth' | 'network' | 'not-found')[] }) => void;
    now?: () => Date;
    concurrency?: number; // default 4
  };
  export class TaskPulseService {
    constructor(d: PulseDeps);
    get(): Promise<PulseSnapshot>;           // loads pulse.json once
    refresh(): Promise<PulseSnapshot>;       // one at a time: a call during a refresh returns the running one
    lastRefreshAt(): number | null;
  }
  ```

- [ ] **Step 1: Write failing tests** with an in-memory fake client and a temp file:
  - one workspace with an active PR → snapshot `tasks[taskId][0].pr.id` set, `onChanged` called once, `link` called with a `PullRequestRef` (`status`, `isDraft`, `url = webUrl`, `repositoryId`, `project`, `repo`) when `stored` is null; not called again when unchanged.
  - `target` returns null → task absent from `snapshot.tasks`, no client call.
  - reopened: only PR completed before `openedAt` → pulse `pr null`, `link` not called.
  - `repositoryId` cached: two refreshes → one `repositoryId` call per (connection, project, repo); `me()` once per connection per refresh.
  - auth: client throws `AdoError('unauthorized', ...)` → previous pulse for that workspace kept, `snapshot.error 'auth'`, `onRefreshed.errors` contains `'auth'`; next successful refresh clears `error`.
  - network error on one workspace does not stop another workspace's pulse.
  - concurrency: with 10 workspaces and a fake that counts in-flight calls, max in-flight `pullRequestsForBranch` ≤ 4.
  - persistence: a new service on the same file returns the last snapshot from `get()` before any refresh.
  - tasks no longer open are dropped from the snapshot.

- [ ] **Step 2: Run** `npx vitest run src/main/pulse/TaskPulseService.test.ts` — FAIL.

- [ ] **Step 3: Implement.** Per workspace: `target` → `repositoryId` (cached) → `pullRequestsForBranch` → `pickPr(prs, openedAt)` → if a PR: evaluations (needs `projectId` from the PR), statuses, threads in parallel → `toPrPulse`. Error kind from `AdoError.kind` (`unauthorized` → `auth`, `not-found` → `not-found`, else `network`). Persist with `JsonFileStore<PulseSnapshot>`.

- [ ] **Step 4: Run** the test — PASS.

- [ ] **Step 5: Commit** `git commit -m "TaskPulseService: PR, CI and review status per task workspace"`

---

### Task 4: Wire the service into IPC, main timers and telemetry

**Files:**
- Modify: `src/shared/ipc.ts` (Channels near `'home:refresh'`; Events near `'home:updated'`)
- Modify: `src/main/ipc/handlers.ts` (construct beside `home`, ~line 735; handlers near `'home:refresh'`, ~line 4906; after Finish succeeds)
- Modify: `src/main.ts` (`onWindowFocus`, ~line 1501; timers near `timeTick`, ~line 1484; `stopTime`)
- Modify: `src/renderer/test-helpers/fakeApi.ts`, `docs/telemetry.md`, `src/shared/telemetry.ts` if events are typed there
- Test: `src/main/ipc/handlers.part6.test.ts` (or the part with the `tasks:prStatus` tests)

**Interfaces:**
- Consumes: Task 3 `TaskPulseService`; Task 1 `PulseView`; existing `prContext(task, w)`, `taskWorkspaces`, `patchWorkspace`, `s.time` (`TimeStore.activeIntervals`, `agentIntervals`).
- Produces:
  - Channels: `'pulse:get': { args: []; result: PulseView }`, `'pulse:refresh': { args: []; result: PulseView }`.
  - Event: `'pulse:changed': PulseSnapshot`.
  - `Services.pulse?: TaskPulseService` (test override, like `s.home`).
  - `lastActiveAt(taskId)` in handlers: max interval end over `s.time.activeIntervals(taskId)` and every list in `s.time.agentIntervals(taskId)`; absent when none.

- [ ] **Step 1: Write failing handler tests:** `pulse:get` returns `{ tasks, error, checkedAt, lastActive }` with `lastActive[taskId]` = the latest end of the task's active/agent intervals; `target` for a workspace without an ADO remote is null (use the harness's git remote fake); `link` writes `pullRequest` on the workspace (`tasks:changed` broadcast); `pulse:refresh` broadcasts `pulse:changed`.

- [ ] **Step 2: Run** the test file — FAIL.

- [ ] **Step 3: Implement.** In handlers: `target` from `prContext` (`availability.target` + `connection.id`, else null); `openedAt` = last `openPeriods[].start` or null; `onRefreshed` → `tel.event('pulse.refreshed', { tasks, errors: errors.length }, { durationMs })`. After a Finish completes call `void pulse.refresh()`. In `main.ts`: `setInterval` every 180 000 ms that calls `pulse:refresh` only while the main window is focused; in `onWindowFocus(true)` refresh when `lastRefreshAt()` is null or older than 60 000 ms; clear the interval in `stopTime`. Add `pulse.refreshed` and `nav.chipClicked` (renderer, `{ kind: ChipKind }`) to `docs/telemetry.md` and the renderer telemetry type.

- [ ] **Step 4: Run** the handler tests, `npm run typecheck`, `npm run lint` — PASS.

- [ ] **Step 5: Commit** `git commit -m "Refresh task PR status while Shellie is focused (pulse IPC)"`

---

### Task 5: Lifecycle groups and chips in the open task list

**Files:**
- Create: `src/renderer/hooks/usePulse.ts`
- Modify: `src/renderer/components/TaskNav.tsx` (`groupTasks` ~line 53, `Row` ~113, render ~605), `src/renderer/styles/shell.css`
- Test: `src/renderer/components/TaskNav.test.tsx`

**Interfaces:**
- Consumes: Task 1 `lifecycleOf`, `LIFECYCLE_ORDER`, `LIFECYCLE_LABEL`, `TaskLifecycle`; Task 4 `pulse:get`, `pulse:changed`; `time:changed`; store `attention`.
- Produces:
  ```ts
  export function usePulse(): PulseView | null; // fetch on mount, on 'pulse:changed', and on 'time:changed' throttled to once per 30 s
  export function groupTasks(all: TaskView[], repos: Repo[], connectionId: string | null | undefined, knownIds: string[] | undefined,
    life: (t: TaskView) => TaskLifecycle):
    { groups: { group: Lifecycle; tasks: TaskView[] }[]; done: TaskView[] };
  ```
  (repo-less tasks join the groups like any other; `setting-up`/`setup-failed`/`finishing` tasks always go to `active`.)

- [ ] **Step 1: Update/replace the `groupTasks` tests:** groups appear in `LIFECYCLE_ORDER`, empty ones omitted; sorted by `sortKey`; connection filtering tests keep passing with the new signature; a `setting-up` task lands in Active. Render tests: header `Needs you` with count `3` has the amber class; a Needs you row shows chip text `CI failing` with the red class; row `title` is the `story`; clicking the chip calls `links:open` with that workspace's PR url and tracks `nav.chipClicked` `{ kind: 'ci-failing' }` without opening the task; Merged row shows a `Finish` button that goes to the task's Finish page; with one repo there is no repo tag, with two the row shows the repo name; no pulse yet (`usePulse` null) → every open task in Active or Parked by activity, no chips.

- [ ] **Step 2: Run** `npx vitest run src/renderer/components/TaskNav.test.tsx` — FAIL.

- [ ] **Step 3: Implement** `usePulse` and the nav: life per task = `lifecycleOf({ pulses: pulse?.tasks[t.id] ?? [], lastActiveAt: pulse?.lastActive[t.id] ?? null, agentBlocked, now: Date.now() })`; `agentBlocked` from the existing `useWaiting` logic (`reason === 'blocked'`). Group header reuses `nav-subhead` with a count; chip is a `<button className="navchip navchip-{tone}">`; cost shows only in Active; footer shows the auth note when `pulse.error === 'auth'`. Keep `FinishAction`/Discard for the current task as today.

- [ ] **Step 4: Run** the nav tests, `npm run typecheck`, `npm run lint` — PASS.

- [ ] **Step 5: Commit** `git commit -m "Group the task list by lifecycle with a status chip per row"`

---

### Task 6: The collapsed rail (R3)

**Files:**
- Modify: `src/renderer/components/TaskNav.tsx` (`RailRow` ~line 150, rail branch of the render), `src/renderer/styles/shell.css` (`.railrow` ~line 465)
- Test: `src/renderer/components/TaskNav.test.tsx`

**Interfaces:**
- Consumes: Task 5 `groupTasks` result and per-task `TaskLifecycle`.

- [ ] **Step 1: Write failing tests** (nav collapsed): an amber count pill with text `3` above the Needs you icons (`aria-label "3 tasks need you"`); a red corner dot (`rail-dot rail-dot-red`) on a CI-failing task, green on approved, none on a clean Active task; a separator between groups; In review and Parked icons have the `is-dim` class; a Merged task renders the hollow Finish square; icon `title` = `"{id} {title} · {story}"`.

- [ ] **Step 2: Run** the nav tests — FAIL.

- [ ] **Step 3: Implement** per the spec's rail section; dot colour = chip tone (muted chips get no dot); keep `AttentionDot` as today.

- [ ] **Step 4: Run** nav tests, `npm run typecheck`, `npm run lint` — PASS.

- [ ] **Step 5: Commit** `git commit -m "Collapsed rail: needs-you count, status dots, dimmed waiting tasks"`

---

### Task 7: Change note and full check

**Files:**
- Create: `docs/changes/2026-11-18-task-lifecycle-groups.md`

- [ ] **Step 1:** Write the change note: what it does, the grouping rule, where status comes from, refresh cadence, what was verified, known gaps (GitHub-hosted repos get no status; CI only once a PR exists; "me" includes the PR creator).
- [ ] **Step 2: Run** `npm test && npm run typecheck && npm run lint` — all PASS.
- [ ] **Step 3:** Run the app on a fresh data folder (`SHELLIE_USER_DATA=<abs path> npm start`) with the Shellie test project connection and check the nav renders groups with no errors in the console (real PR states may be few; note what could and could not be seen in the change note).
- [ ] **Step 4: Commit** `git commit -m "Change note: task list grouped by lifecycle"`
