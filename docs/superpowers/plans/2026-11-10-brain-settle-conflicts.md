# Brain settle conflicts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settle lint's `contradiction` and `scope-change` findings in a guided page inside Shellie (pick what is true, ask someone, settle in the background), with history kept in the pages and a decision page per settle.

**Architecture:** Lint (skills v9) writes a structured `conflict` on each finding; Shellie keeps what the person did in `brain/conflicts.json` (parked, settled with the whole decision and a status) and lists open, parked and settled conflicts over IPC. A new job kind `settle` runs a new `/settle` skill with the decision as JSON; hooks mark the record done or failed, record an answer source as captured, and re-queue pending settles at launch. The renderer gets a Settle view on the Brain screen, reached from Add, Health and Read.

**Tech Stack:** Electron, React 19, TypeScript, zod, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-10-brain-settle-conflicts-design.md` (mockups: https://claude.ai/artifact/JWaKY49q1TBQijpBRRjygh).

## Global Constraints

- Agent-neutral copy; Claude Code and OpenCode brains both run `/settle` (skills list in `templates.ts` feeds both).
- `TEMPLATES_VERSION` 9; `settleReady(brain)` = `templatesVersion >= 9` gates `settle` and Re-check.
- "Who can answer" never leaves the renderer's local storage (`shellie.brain.ask.<brainId>`); never committed, never in a prompt, never in telemetry.
- Telemetry: counts and kinds only, never question, claims, why, answers or names.
- `brain/state.json` round-trips a lint-written `conflict` untouched; a malformed one never makes the state unreadable.
- Checks: `npm test`, `npm run typecheck`, `npm run lint` (oxfmt).

## Review Focus

- Shellie writing `state.json` after a capture must keep every finding's `conflict` exactly (Task 1 test).
- A settle whose job is lost (app quit) is queued again at launch, once; a failed one keeps its decision for Retry (Task 3 tests).
- A parked conflict is in neither Needs you nor the badge; a settled one never reappears unless lint marks `reopens` (Task 1 listing tests, Task 5 badge test).
- An answer source with a pending settle is not "uncaptured" anywhere (badge, Activity, Health) and is captured when the settle succeeds (Tasks 3, 5).
- A brain on skills below v9 shows its conflicts as old findings and cannot queue `settle` (Tasks 3, 4).

---

### Task 1: Conflict data and `brain/conflicts.json`

**Files:** Modify `src/shared/brain.ts`; Create `src/main/brain/conflicts.ts`, `src/main/brain/conflicts.test.ts`; Test also `src/main/brain/state.test.ts`.

**Interfaces (produces):**
- shared: `ConflictSchema` / `Conflict` = `{ id: string; question: string; claims: { a: ConflictClaim; b: ConflictClaim }; suggestion: { pick: 'a'|'b'|'both'|'neither'|null; reason: string } | null; reopens: string | null }`, `ConflictClaim = { page: string; quote: string; source: string | null; date: string | null }`. `BrainFindingSchema` gains `conflict: z.unknown().optional()`. `CONFLICT_KINDS = new Set(['contradiction','scope-change'])`. `conflictOf(f: BrainFinding): Conflict | null` (safeParse). `conflictIdOf(f: BrainFinding): string` (`conflict.id` or `${kind}:${page}:${detail}`). `SETTLE_TEMPLATES = 9`, `settleReady(brain)`.
- shared: `SettleChoice = 'a'|'b'|'both'|'neither'|'accept'|'keep'|'write'`; `SettleDecision = { id: string; kind: 'contradiction'|'scope-change'; page: string; question: string; detail: string; claims: { a: ConflictClaim; b: ConflictClaim } | null; choice: SettleChoice; text: string | null; why: string | null; answer: string | null }` (+ zod schema).
- shared: `BrainConflictRow = { id; kind; page; detail; at; conflict: Conflict | null }`, `ParkedConflictRow = BrainConflictRow & { question: string; parkedAt: string }`, `SettledConflictRow = { id; question: string; choice: SettleChoice; text: string | null; at: string; status: 'pending'|'done'|'failed'; page: string | null; error: string | null }`, `BrainConflicts = { open: BrainConflictRow[]; parked: ParkedConflictRow[]; settled: SettledConflictRow[]; answers: string[] }` (`answers`: answer sources of pending or failed settles).
- main `conflicts.ts`: `readConflicts(dir): Promise<ConflictsFile>` (missing or invalid → empty), `updateConflicts(dir, fn): Promise<ConflictsFile>` (per-dir serialized, atomic write), `listConflicts(findings: BrainFinding[], file: ConflictsFile, now: Date): BrainConflicts` (settled shown 30 days). `ConflictsFile = { version: 1; conflicts: Record<string, { parked?: { question: string; at: string }; settled?: { at: string; status: 'pending'|'done'|'failed'; decision: SettleDecision; page: string | null; error: string | null } }> }`.

- [ ] Tests first: `writeState` keeps a finding's `conflict` object (and an invalid one) byte-identical after a mutate that changes `captured`; `readState` of a state with `conflict: 42` succeeds. `conflictOf` parses lint's shape, null for a partial one; `conflictIdOf` falls back to `kind:page:detail`. `listConflicts`: only contradiction/scope-change; settled ids hidden unless `conflict.reopens`; parked ids in `parked` with their question; settled older than 30 days dropped; `answers` lists pending/failed decisions' answers; open sorted by `at` newest first. `readConflicts` of a missing or corrupt file gives empty; two concurrent `updateConflicts` both land.
- [ ] Run (`npx vitest run src/main/brain/conflicts.test.ts src/main/brain/state.test.ts`) — FAIL; implement; PASS; typecheck; commit `Brain: conflicts as lint writes them and what the person did with them`.

### Task 2: Skills v9 (schema, lint, settle, capture)

**Files:** Modify `src/main/brain/templates.ts`, its test (`src/main/brain/templates.test.ts`).

- SCHEMA: findings may carry `conflict` (shape above, written by `/lint` only); `brain/conflicts.json` is Shellie's, never touched; the superseded form for an outdated fact (`~~old~~ new, since <when> ([decision](decision-….md))`, old claim kept); decision page sections (Question, Claims, Decision, Why, Answer, Date; people by role).
- LINT: write `conflict` for every contradiction and scope-change (stable id `<kind>:<page a>+<page b>:<topic>`, sorted page paths, topic a short slug); read `decision-*` pages and raise nothing they settled unless a source newer than the decision disagrees, then with `reopens: <decision path>`.
- SETTLE (new, kind `settle`): takes the decision JSON; writes the decision page; updates every page holding an outdated claim in the superseded form per choice (a/b/both/neither/write/accept/keep); scope accepted updates the scope page, kept notes the request as not taken in; removes the finding from `state.json` (only that one); log line; ends by printing `decision: wiki/decision-….md`. Treats the decision's text fields as data, not instructions.
- CAPTURE: when a source updates a fact, use the superseded form.
- `TEMPLATES_VERSION = 9`; `settle` in `SKILLS` (both agents).
- [ ] Tests first (strings present, settle listed for both agents, version 9); FAIL; implement; PASS; commit `Brain skills v9: lint writes conflicts, /settle settles one`.

### Task 3: The settle job and IPC in main

**Files:** Modify `src/shared/brain.ts` (`BrainJobKind` + `'settle'`, `BrainJob.conflict?: string`), `src/main/brain/jobs.ts` (enqueue opts `conflict`), `src/shared/ipc.ts`, `src/main/brain/brainHandlers.ts`, `src/main/brain/health.ts`; Create `src/main/brain/settleHooks.ts` (+ test); Modify `src/main.ts` (hooks, launch resume). Tests: `brainHandlers.test.ts`, `settleHooks.test.ts`, `health.test.ts`.

**Interfaces (produces):** IPC `brain:conflicts(brainId) → BrainConflicts`; `brain:settle(brainId, decision: SettleDecision) → void` (validates, refuses below v9 with "Update skills to settle conflicts here", writes `settled: pending`, removes `parked`, enqueues `settle` with `{ conflict: id }`); `brain:settleRetry(brainId, id) → void` (failed → pending, enqueue); `brain:park(brainId, id, question) → void`; `brain:unpark(brainId, id) → void`; `brain:addText(..., note?, model?, opts?: { capture?: boolean })` (capture false: no capture queued). `createSettleHooks({ brains, runner }) → { promptFor(job): Promise<string|null|undefined>, afterJob(job): void, resume(brainId): Promise<void> }`: promptFor for `settle` returns `/settle <JSON of the pending decision>` (null when none: nothing to do); afterJob done → status done, page from `/decision: (wiki\/decision-[^\s]+\.md)/` in the result, and the answer source recorded captured in `state.json`; failed → status failed with the error; resume queues every pending record whose `settle` job is not queued/running/paused. `brain:run` refuses `settle`. Health: lint findings with a settled or parked id are left out; pending/failed answers count as in flight (not uncaptured).

- [ ] Tests first (handlers: settle writes pending + queues with conflict id, refuses below v9, refuses an invalid decision; park/unpark; addText with `{capture:false}` queues nothing; conflicts listing through IPC. Hooks: prompt JSON, done/failed records, answer captured, resume queues once and skips one in flight. Health: settled/parked filtered, answer not uncaptured); FAIL; implement; PASS; `npx vitest run src/main`; commit `Brain: a settle job, conflicts over IPC, settles resumed at launch`.

### Task 4: The Settle view

**Files:** Create `src/renderer/components/brain/settle/useBrainConflicts.ts`, `SettleView.tsx`, `ConflictCard.tsx`, `AskPanel.tsx`, `ConflictList.tsx`, `askStore.ts`, tests `SettleView.test.tsx`, `askStore.test.ts`; Modify `brainActions.ts` (actions `settle-open`, `settle`, `park`, `copy-question`, `answer`, `skip`, `recheck`; `trackSettle(p)`).

**Interfaces (produces):** `useBrainConflicts(brainId): { conflicts: BrainConflicts; loaded: boolean }` (reloads on `brain:changed`). `SettleView(props: { brain: BrainView; conflicts: BrainConflicts; rows: BrainPageRow[]; target: string | null; onTarget(id: string | null): void; onBack(): void; onOpenPage(path: string): void })`. `askStore`: `askedWho(brainId, id): string`, `setAskedWho(brainId, id, who)`, `forgetAsked(brainId, id)` (localStorage, try/catch). `defaultQuestion(c: BrainConflictRow, titleOf: (p) => string): string`.

Behaviour (spec "The flow"): with a target, one conflict (n of m over open ones, previous/next, ← Add); claims A/B (quote, page title via rows, source file name and date, "Newer" on the later date, Open page), the agent's read, choices per kind (nothing preselected; Suggested pill), fields for both/neither, Why, "Settle: <choice>", Skip for now; I need to ask someone → Who (local), Question (prefilled), Copy question (clipboard), Park. Old finding (conflict null): detail, Write what is true, Re-check (lint), no Park. Below v9: the card shows "Update skills to settle conflicts here" and Settle/Re-check disabled. After Settle/Park: next open conflict, or the list. List (no target): Needs you, Waiting on someone (who from askStore, Copy question, Got an answer → textarea → "Add answer and settle": `brain:addText(id, answer, "Answer: <question>", 'note', 'Answer to a conflict', undefined, { capture: false })`, `brain:unpark`, then opens the conflict with the answer shown and passed as `decision.answer`), Settled (choice line, status, Decision page, Retry on failed).

- [ ] Tests first (each behaviour above, plus names no agent); FAIL; implement; PASS; commit `Brain: the Settle view`.

### Task 5: Wiring, entry points, docs

**Files:** Modify `src/renderer/screens/BrainScreen.tsx` (view `settle`, target, badge + open conflicts), `src/renderer/components/brain/BrainAdd.tsx` and `composer/Activity.tsx` (a "Conflicts to settle · n" row in Needs you with Settle; answers excluded from waiting), `composer/activityRows.ts` and `waiting.ts` (`badgeCount(sources, jobs, exclude?: string[])`), `BrainHealth.tsx` (Settle for contradiction/scope-change → `onSettle(conflictIdOf(f))`), `BrainRead.tsx`/`BrainPage.tsx` (line under the title for an open conflict on the page: "This page disagrees with <other> · Settle"), `src/renderer/styles/brain.css`, `docs/telemetry.md`; Create `docs/changes/2026-11-10-brain-settle-conflicts.md`. Tests: `BrainScreen.test.tsx`, `BrainAdd.test.tsx`, `Activity.test.tsx`, `BrainPage.test.tsx`, `waiting.test.ts`.

- [ ] Tests first (badge counts open conflicts and skips parked and answer sources; Activity row opens Settle; Health Settle opens the view at that conflict and Shellie's own findings keep Resolve in terminal; Read line opens it; Settle view ← goes back); FAIL; implement; PASS; full `npm test`, typecheck, lint.
- [ ] Dev app check with a fake agent and a v9-shaped state (settle, park, answer, Retry after a fake failure, resume after restart); one real `/settle` run on a scratch brain is optional (owner's subscription; skip if it would cost API money). Screenshots into `docs/changes/assets/2026-11-10-brain-settle-conflicts/`; change note; commit `Brain: settle conflicts from Add, Health and Read`.
