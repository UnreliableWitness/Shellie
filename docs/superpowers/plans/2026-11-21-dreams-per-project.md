# Dreams per project, and a clear ending for a dream: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every part of dreaming belongs to one project, and a dream result ends in a pull request (or a briefed agent task) instead of a blank task.

**Architecture:** The settings hold one dreaming block per connection id; the scheduler evaluates each project with the existing pure `nextDream` and starts one dream at a time; usage is told apart per project by a tag in the dream session's title; every dream IPC call about a setup or a view takes the connection id and the renderer passes the active project. Part 2 extracts the task-shaped push and pull-request code into a task-free form and adds a briefing for the agent tab.

**Tech Stack:** Electron, React, TypeScript, Zustand, zod, Vitest. Lint is `oxlint && oxfmt --check` (format with `npx oxfmt <files>`).

**Spec:** `docs/superpowers/specs/2026-11-21-dreams-per-project-design.md`

## Global Constraints

- Two pull requests: Part 1 (Tasks 1 to 7), then Part 2 (Tasks 8 to 11). Each adds its own file in `docs/changes/` and keeps `docs/telemetry.md` in step; never add change notes to `CLAUDE.md`.
- `SettingsStore` keeps one single writer for dreaming; only switch-on (tested model, limit, repo, the owner's tick) sets `enabled`, per project.
- A migration never switches a project on that had no repo switched on.
- No project, repo, task or session text in telemetry, logs or failure phrases.
- One dream at a time on the machine.
- Checks before each commit: the touched tests, then `npm run typecheck` and `npm run lint`; full `npm test` at the end of each part.

## Review Focus

- An old settings file whose block names a repo that no longer exists or has no project: it must load, drop that repo, and switch nothing on.
- A repo moved to another project while its dream runs or its result is open: the result stays reviewable, the old project's block loses the repo.
- Two projects on the same model when another model answers: both off, each with its own notice; a third project on another model keeps dreaming.
- The active project changes while Dreams, a result or the setup screen is open: the screen must show the new project or leave, never a mix.
- A dream session of before this change (title without a project tag): counts toward no project's limit and must not break the usage read.

---

## Part 1: dreaming per project

### Task 1: settings per project

**Files:** `src/shared/dreams.ts`, `src/shared/usage.ts`, `src/main/usage/SettingsStore.ts` and their tests.

**Interfaces (produces):**
- `DreamingAll = { projects: Record<string, DreamingSettings>; legacy: DreamingSettings | null }`, `DreamingAllSchema`, `defaultDreamingAll()`.
- `AppSettings.dreaming: DreamingAll`. An old-shape block (no `projects` key) parses to `{ projects: {}, legacy: <the old block, or null when it does not parse> }`.
- `dreamingOf(all: DreamingAll, connectionId: string): DreamingSettings` (the block, or `defaultDreaming()`).
- `splitLegacyDreaming(legacy: DreamingSettings, repos: { id: string; connectionId: string | null }[]): Record<string, DreamingSettings>`: one copy per connection that owns at least one repo named in `legacy.repos`, holding only that connection's repos; `enabled` only when `legacy.enabled` and `canSwitchOn(copy) === null`.
- `SettingsStore.updateDreaming(fn: (cur: DreamingAll) => DreamingAll)` stays the only writer.

- [ ] Tests first: schema (new shape, old shape, garbage), `splitLegacyDreaming` (one project, two projects, repo without a project, unknown repo, old block off, copy left without an on repo is off), store (save/update keep the stored block).
- [ ] Implement; run tests, typecheck (other callers will fail to compile: fixed in later tasks, so this task's commit comes with Task 4's).

### Task 2: usage and limit per project

**Files:** `src/main/dreams/opencodeDream.ts`, `src/main/budget/openCode.ts`, `src/main/dreams/limit.ts`, `src/main/dreams/DreamRunner.ts`, tests.

**Interfaces (produces):**
- `dreamTitle(project: string, what: 'propose' | 'check' | 'test'): string` = `` `${DREAM_JOB_TITLE} ${project}: ${what}` ``; `dreamArgs(model, what, project)`.
- `OpenCodeReader.dreamTokens(since, until, project?: string)`: with `project`, only sessions whose title starts with `` `${DREAM_JOB_TITLE} ${project}:` `` (LIKE with `%`, `_` and `\` escaped); without, all dream sessions as today.
- `limitChecks({ reader, priceEur?, limit: (project) => DreamLimit | null, now })` returns `usage(project)`, `hasRoom(project)`, `overLimitFor(project, startedAt)`, `tokens(project, since, until)`.
- `DreamRunner.dream(repo, { model, folders, signal, project })`; `running()` also returns `project`.

- [ ] Tests first: a tagged title counts for its project only, an untagged (old) one for none; `%` or `_` in an id matches literally; limit checks per project.
- [ ] Implement.

### Task 3: switched-off notice per project

**Files:** `src/main/dreams/DreamStore.ts`, `src/shared/dreams.ts`, tests.

**Interfaces (produces):**
- Stored `switchedOffBy: Record<string, DreamSwitchedOff>` (default `{}`); the old `switchedOff` field is still read.
- `store.switchedOff(project): DreamSwitchedOff | null`, `store.setSwitchedOff(project, value | null)`, `store.adoptLegacySwitchedOff(projectsOf: (record: DreamSwitchedOff) => string[])`: moves the old record to those projects and clears it, in one write; a no-op without one.

- [ ] Tests first, implement.

### Task 4: scheduler and start across projects

**Files:** `src/main/dreams/scheduler.ts`, `src/main/dreams/startDreams.ts`, `src/main.ts`, tests.

**Interfaces:**
- Deps: `repos: () => { id; name; path; connectionId: string | null }[]`, `settings` (reads `DreamingAll`, writes through `updateDreaming`), `limit: { hasRoom(project) }`.
- `decide()`: for every project with an enabled block and no switch-off record, `nextDream` on that project's block, its repos and its limit; among the projects that return a repo, the one whose newest `lastDreamAt` over its repos is oldest (never dreamt first; ties by connection id). `dreamNow(repoId)` decides for the repo's project only.
- A wrong model: record and switch off every project whose `model` equals the chosen one (`enabled: false`, `testedModel: null`).
- `switchOn(project, save)`, `status(project): DreamStatus` where `wait` is `'running-elsewhere'` (new `DreamWait`) when a dream of another project runs, and `running`, `next`, `newSessions` cover that project's repos only.
- `startDreams`: before the first check, in one settings write, `legacy` is split with `splitLegacyDreaming` over the repo list and set to null (existing project blocks win); then `adoptLegacySwitchedOff` (the repo's project, or every project whose model is the record's `chosen` when it names no repo); a repo no longer in its block's project is dropped from that block.

- [ ] Tests first: choice between two projects, per-project idle minutes and limit, wrong model with three projects, migration at start, status per project.
- [ ] Implement; commit Tasks 1 to 4 together once typecheck passes for main (renderer follows).

### Task 5: IPC per project

**Files:** `src/shared/ipc.ts`, `src/main/dreams/dreamHandlers.ts`, `src/main/ipc/handlers.ts`, tests.

- `dream:get`, `dream:test`, `dream:save`, `dream:switchOn`, `dream:switchOff` take `connectionId` first. `dream:now`, `dream:stop`, and the per-repo calls keep their arguments; `dream:stop` takes `connectionId` and stops only that project's dream.
- `DreamView` for a project: its block, usage, wait, next, running, notice, its repos (plus repos without a project that still have a result or an opened branch, marked `orphan: true`), and the journal lines of those repos.
- Saving refuses a repo of another project. The setup test's title carries the project.
- `connections:remove` removes the project's block after the per-repo cleanup; a repo whose connection changes is dropped from the old block.

- [ ] Tests first (each call with two projects; refusal across projects), implement, commit.

### Task 6: the renderer follows the active project

**Files:** `src/renderer/components/dreams/*`, `src/renderer/screens/Dream*.tsx`, `src/renderer/screens/settings/*`, `src/renderer/screens/HomeScreen.tsx`, `src/renderer/components/TaskNav.tsx`, tests.

- `useDreams()` reads the active connection and refetches when it changes; with none it yields null and the Dreams item, the band and the status line render nothing.
- Settings: Dreaming leaves the User scope and joins the Project scope, for the picked project.
- `running-elsewhere` reads "Another project is dreaming", with no Stop.
- A result screen whose repo is not in the view goes to Dreams.

- [ ] Tests first, implement, commit.

### Task 7: notes, real-app check, review, pull request

- [ ] `docs/changes/2026-11-21-dreams-per-project.md`, `docs/telemetry.md` if anything changed.
- [ ] Full `npm test`, typecheck, lint.
- [ ] Dev app on a fresh data folder with two projects and the fake OpenCode: setup in one leaves the other off; a result of one is absent in the other.
- [ ] Fresh whole-branch review; fix Critical and Important; pull request; merge when CI is green.

## Part 2: what to do with a dream

### Task 8: a task-free push and pull request

**Files:** `src/main/ipc/handlers.ts` (extract from `pushIfNeeded`, `assertNoLeak`, `prTargetOf`, `openPullRequest`), `src/main/services/AdoClient.ts` (`createPullRequest` gets `isDraft`, default true), `src/main/dreams/dreamHandlers.ts`, `src/shared/ipc.ts`, tests.

- `dream:pr(repoId, opts?: { pushAnyway?: boolean })` → `{ kind: 'pr'; url: string; id: number } | { kind: 'pushed'; branch: string } | { kind: 'leak'; findings: … }`. Builds the branch from the kept proposals (as `dream:openAsTask` does), runs the secret check on what would be pushed, pushes, creates a published pull request (title and description per the spec) or, where `prAvailability` refuses, only pushes; then closes the dream (rejections, journal `as: 'pr' | 'pushed'` with the link or branch, worktree, data and local branch removed). A second call after a failed create finds the pushed branch and only creates.
- `dream:prAvailable(repoId)` → `{ ok: true } | { ok: false; reason: string }` for the screen.
- Telemetry: `dream.result` outcomes `pr`, `pushed`.

### Task 9: Change with an agent

- `dream:change(repoId)`: as `dream:openAsTask`, then makes the task "Dream <date>" directly when the repo's default environment needs no confirm and its first agent tab is Claude Code or OpenCode; else returns `{ form: true, branch }` and the renderer opens the New task form as today.
- The briefing (title, files, reason and captioned quotes per kept proposal, ending "Wait for my instructions.") is stored with the task and written to its first agent tab once that tab is idle, through the mechanism the PR-description feature uses; sent once.

### Task 10: the result screen

- The explaining line; Create pull request (or Push branch with its reason) as primary, Change with an agent, Discard dream; the leak state with Push anyway; fixed failure phrases; journal lines with the pull request link.

### Task 11: notes, real-app check, review, pull request

- [ ] As Task 7; the real-app check creates a pull request against the test Azure DevOps project (PAT from the Keychain, never printed) and sees the briefing arrive in an agent tab.
