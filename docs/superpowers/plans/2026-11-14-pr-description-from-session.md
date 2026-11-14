# PR description from the session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Finish page's PR draft is written by the task's own idle agent tab when it is recently active, else by a
headless Claude Code or OpenCode run fed the work item text and the session's turns — both agents, fast readers.

**Architecture:** A main-owned draft service (`src/main/prDraft/`) runs per task and PR repo: pick a tab (pure rules
over `TabActivity` + session metadata) → type one line → wait for the marked reply in the session → else headless
fallback. Drafts and their progress live in main and broadcast to the renderer. Session readers get a streaming Claude
reader and a SQL-filtered OpenCode reader, shared with the brain lessons.

**Tech Stack:** Electron main (TypeScript, node:sqlite, node-pty via TerminalManager), React renderer, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-pr-description-from-session-design.md`

## Global Constraints

- Tab eligibility: kind `claude`|`opencode`, task tab (not brain), process running, not leak-paused, last agent turn ≤ 60 min ago, state `idle`/`done`/unknown-since-resume (never `working`, `blocked`, `clear`), nothing typed since last Enter, output quiet ≥ 2000 ms (`QUIET_MS`).
- Reply markers: `<!-- shellie-pr -->` … `<!-- /shellie-pr -->`. Typed line prefix: `Shellie: write the pull request description as asked in `.
- Tab wait timeout 3 min (`TAB_TIMEOUT_MS = 180_000`); headless timeout stays `PR_SUMMARY_TIMEOUT_MS` (120 s).
- Prompt: total `PR_PROMPT_MAX` 60k; work item ≤ 6000 chars; turns budget 14_000, per turn ≤ 1200, filled newest first, shown oldest first.
- Headless Claude: `--max-budget-usd 0.50`, model from setting `prSummaryModel: 'sonnet' | 'haiku'` (default `sonnet`). Headless OpenCode: `opencode run --format json --title "Shellie PR description"`, permission denies `edit`, `bash`, `webfetch`; user's default model.
- Claude reader: lines > 100_000 chars or containing `"tool_result"` are skipped before `JSON.parse`.
- Fallback reasons (telemetry `reason`): `no-tab`, `busy`, `stale`, `typing`, `no-reply`, `exited`, `timeout`; `source: 'tab'|'headless'`, `agent: 'claude'|'opencode'`.
- No change notes in CLAUDE.md; add `docs/changes/2026-11-14-pr-description-from-session.md`; keep `docs/telemetry.md` in sync.
- All spawn/shell logic through `Platform` (`claudeCommand`, `opencodeCommand`).

## Review Focus

1. A tab with a half-typed prompt or a picker open must never get the line → `typing`/`busy` fallback. (Task 4 test.)
2. The agent replies without markers (asks a question, refuses, plan mode) → fallback at once, not after 3 min. (Task 5 test.)
3. Leaving Finish and returning mid-draft shows the live state, not a stuck "writing". (Task 7 test.)
4. Skip while the tab is working: a late marked reply is ignored, request file deleted, next repo's draft may start. (Task 6 test.)
5. Shellie's own request/reply never shows in the brain lessons digest or the headless "What was done". (Task 2 test.)

---

### Task 1: Fast session readers

**Files:**
- Create: `src/main/sessions/claudeTranscript.ts`, `src/main/sessions/claudeTranscript.test.ts`
- Modify: `src/main/budget/openCode.ts` (`sessionTexts` SQL filter; new `latestSession`, `turnsSince`), `src/main/budget/openCode.test.ts`
- Modify: `src/main/ipc/handlers.ts` (`claudeSessionLines` → turns via new reader; brain lessons and `taskRequests` use it)

**Interfaces:**
- Produces: `type TurnAt = Turn & { at: number | null }` (epoch ms, from the line's `timestamp`).
- Produces: `readClaudeTurns(file: string, o?: { fromByte?: number }): Promise<{ turns: TurnAt[]; size: number }>` — streams with `readline` over `createReadStream(file, { start: fromByte })`; same turn rules as `sessionTurns` (merges consecutive Claude texts, skips meta/sidechain/compact/MACHINE).
- Produces: `lastAgentTurnAt(file: string): Promise<number | null>` — reads only the last 256 KB, newest assistant text line's timestamp.
- Produces: `OpenCodeReader.latestSession(dirs, since): { id: string; updatedAt: number } | null` (top-level, not brain-job title, max `time_updated`).
- Produces: `OpenCodeReader.turnsSince(sessionId: string, since: number): TurnAt[]` (text parts, non-synthetic, `message.time_created >= since`).

- [ ] **Step 1: Write failing tests** — `readClaudeTurns`: (a) same turns as `sessionTurns` on a fixture with user, assistant text, tool_use, tool_result, meta lines; (b) a 200k-char tool_result line is skipped and `JSON.parse` is not called for it (spy); (c) `fromByte` = size of first half returns only later turns; (d) `at` comes from `timestamp`. `lastAgentTurnAt` returns the last assistant timestamp in a file > 256 KB. OpenCode (temp DB fixture as in `openCode.test.ts`): `sessionTexts` unchanged output; a 1 MB tool part is not selected (assert via query result size or a part with type `tool` absent); `latestSession` picks the most recently updated top-level session; `turnsSince` excludes earlier messages.
- [ ] **Step 2: Run** `npx vitest run src/main/sessions src/main/budget/openCode.test.ts` — FAIL.
- [ ] **Step 3: Implement.** OpenCode SQL adds `AND json_extract(part.data, '$.type') = 'text'`. Replace `claudeSessionLines` usages with `readClaudeTurns` (lessons digest takes `turns`; `taskRequests` = developer turns).
- [ ] **Step 4: Run** the same tests plus `npx vitest run src/main/ipc src/main/brain` — PASS.
- [ ] **Step 5: Commit** `PR draft: streaming Claude transcript reader, text-only OpenCode reads`.

### Task 2: Shellie's own request stays out of digests

**Files:** Modify `src/main/brain/sessionDigest.ts` (+ test).

**Interfaces:**
- Produces: `PR_REQUEST_PREFIX = 'Shellie: write the pull request description as asked in '`, `PR_MARK_OPEN = '<!-- shellie-pr -->'`, `PR_MARK_CLOSE = '<!-- /shellie-pr -->'` (exported from `src/main/prDraft/protocol.ts`, created here).
- Produces: `withoutPrRequests(turns: Turn[]): Turn[]` — drops a Developer turn starting with the prefix and the next agent turn when it contains `PR_MARK_OPEN`.

- [ ] **Step 1: Failing test** — `sessionDigest` and `withoutPrRequests` drop the pair; an unrelated turn mentioning "pull request" stays.
- [ ] **Step 2: Run** `npx vitest run src/main/brain/sessionDigest.test.ts` — FAIL.
- [ ] **Step 3: Implement**; `sessionDigest` applies it per session.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit.**

### Task 3: Headless prompt and writers (both agents, model setting)

**Files:**
- Modify: `src/main/services/prSummary.ts` (+ test), `src/shared/usage.ts` (setting), `src/renderer/screens/settings/` AgentsSection (find the file exporting `AgentsSection`; + test)

**Interfaces:**
- Changes: `PrSummaryContext` drops `requests`, adds `workItem: string | null` (task.md text) and `turns: Turn[]`.
- Produces: `prSummaryPrompt(c)` sections in order: instructions, style, `# Work item` (heading + task.md cut to 6000), `# What was done` (turns budget per Global Constraints, `Developer:`/`Agent:` lines), `# Commits`, `# Files changed`, `# Diff` (rest).
- Produces: `PR_SHAPE` — the shared description instructions (What changed / Why / How it works / How it was verified; rules) used by both the headless prompt and the tab request.
- Produces: `prSummaryFlags(model: 'sonnet' | 'haiku')`; `prOpencodeArgs(): string[]` (`run --format json --title "Shellie PR description"`); `prOpencodeEnv(base): Record<string,string>` (OPENCODE_CONFIG_CONTENT with `permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' }`).
- Produces: setting `prSummaryModel: z.enum(['sonnet','haiku']).default('sonnet')`; a select row "PR description model" in Agents and terminals.

- [ ] **Step 1: Failing tests** — prompt contains `# What was done` with newest turns kept when over budget and output oldest-first; per-turn cut at 1200; task.md cut at 6000; total ≤ 60_000 with a huge diff; `prSummaryFlags('haiku')` includes `--model haiku` and `--max-budget-usd 0.50`; `prOpencodeEnv` JSON denies edit/bash/webfetch; settings default `sonnet`; the select saves `haiku`.
- [ ] **Step 2: Run** `npx vitest run src/main/services/prSummary.test.ts src/renderer/screens/settings` — FAIL.
- [ ] **Step 3: Implement.** Opencode result parsing reuses `opencodeResultWithSession` (`src/main/brain/opencodeResult.ts`). OpenCode headless session is excluded from `topSessions` reads by adding its title to the excluded-title check (`BRAIN_JOB_TITLE%` or `Shellie PR description`).
- [ ] **Step 4: Run** — PASS. **Step 5: Commit.**

### Task 4: Tab activity and muted done

**Files:**
- Create: `src/main/attention/TabActivity.ts` (+ test)
- Modify: `src/main/attention/AttentionHub.ts` (+ test), `src/main.ts` wiring

**Interfaces:**
- Produces: `class TabActivity { spawned(id); output(id); status(id, state: AttentionState); input(id, data); exit(id); view(id): { state: AttentionState | null; stateAt: number | null; typed: boolean; quietFor: number } | null; onState(listener: (id, state) => void): () => void }` — `typed` via `unsentAfter` (import from `ClaudeRetheme`).
- Produces: `AttentionHub.muteNextDone(id: string): void` — the next `done`/`idle` for `id` neither notifies nor badges; `blocked` still does; cleared on `exit`.
- main.ts: feed `TabActivity` from `terminals.on('data'|'exit')`, `onTerminalInput`, hub `status` callback and the receiver's `onSignal` (OpenCode); pass `tabActivity` and `attention.muteNextDone` into handlers' Services.

- [ ] **Step 1: Failing tests** — typed after printable input, cleared by `\r`/Ctrl+C; quietFor grows from last output; `onState` fires for OSC and OpenCode signals; hub: muted done shows no notification and no badge change, a later done notifies again, blocked while muted notifies.
- [ ] **Step 2: Run** `npx vitest run src/main/attention` — FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit.**

### Task 5: Ask the tab

**Files:**
- Create: `src/main/prDraft/protocol.ts` (from Task 2, extended), `src/main/prDraft/pickTab.ts`, `src/main/prDraft/askTab.ts` (+ tests)

**Interfaces:**
- Produces: `type TabCandidate = { id; label; kind: 'claude'|'opencode'; running: boolean; paused: boolean; lastAgentTurnAt: number | null; activity: ReturnType<TabActivity['view']> }`.
- Produces: `pickTab(c: TabCandidate[], now: number): { tab: TabCandidate } | { reason: 'no-tab'|'busy'|'stale'|'typing' }` — rules from Global Constraints; most recent `lastAgentTurnAt` wins; reason is the "closest" failure (any candidate typing → `typing`, else working/blocked/quiet<2s → `busy`, else too old → `stale`, else `no-tab`).
- Produces: `prRequestText(o: { repo; branch; base; worktree; style: string | null }): string` (PR_SHAPE + "do not edit, commit or run anything; reply with the description only between the markers").
- Produces: `markedReply(turns: Turn[]): string | null` — text between markers in the first agent turn after the request line.
- Produces: `askTab(d: AskTabDeps, signal: AbortSignal): Promise<{ text: string } | { reason: 'no-reply'|'exited'|'timeout' }>` with
  `AskTabDeps = { tab; requestPath; requestText; write(id, data); muteNextDone(id); onState(listener); alive(id): boolean; readReply(): Promise<Turn[]>; now; setTimer; onBlocked(blocked: boolean) }`. Writes the request file, mutes, types the line, waits 150 ms, types `\r`; after each `done`/`idle` calls `readReply()` (Claude: `readClaudeTurns(file, { fromByte })` from the size at request time; OpenCode: `turnsSince(session, requestAt)`); resolves on marked reply, `no-reply` on a done without one, `exited` when `alive` turns false, `timeout` at 180 s; deletes the request file in all cases including abort.

- [ ] **Step 1: Failing tests** — `pickTab` cases (each Global Constraints rule; two eligible → most recent; resumed tab with `state: null` and recent turn is eligible; `clear` never). `askTab` with fake timers: marked reply → text; done without markers → `no-reply` immediately; `blocked` → `onBlocked(true)` then working → `onBlocked(false)`; exit → `exited`; 180 s → `timeout`; abort → request file removed and no write after abort; typed sequence is line then `\r`.
- [ ] **Step 2: Run** `npx vitest run src/main/prDraft` — FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit.**

### Task 6: Draft service in main, IPC

**Files:**
- Create: `src/main/prDraft/PrDrafts.ts` (+ test)
- Modify: `src/shared/ipc.ts`, `src/main/ipc/handlers.ts` (replace `tasks:prSummary`; build candidates; headless runner closure), `src/preload.ts` if events are allow-listed there, `src/main/ipc/handlers.part4.test.ts`

**Interfaces:**
- Produces (shared): `type PrDraft = { status: 'asking-tab'|'tab-blocked'|'writing'|'ready'|'failed'|'skipped'; source: 'tab'|'headless'|null; tab: { id: string; label: string } | null; text: string; error: string | null; note: string | null }` (`note`: e.g. "Written without the tab: it was busy").
- IPC: `prDrafts:get` `[taskId] → Record<workspaceId, PrDraft>`; `prDrafts:write` `[taskId, workspaceId] → void` (start / Write again; cancels a running one); `prDrafts:skip` `[taskId, workspaceId] → void`; `prDrafts:edit` `[taskId, workspaceId, text] → void`. Event `prDrafts:changed` `{ taskId; workspaceId; draft: PrDraft }`.
- `class PrDrafts { constructor(d: { askTab(taskId, ws, signal): Promise<...> | null /* null = no candidate, with reason */; headless(taskId, ws, signal): Promise<{text}|{error}>; changed(taskId, ws, draft); event(name, props, measures) }) ; get(taskId); write(taskId, ws); skip(taskId, ws); edit(taskId, ws, text); forget(taskId) }` — one AbortController per draft; per task a queue so one tab is asked for one repo at a time; text masked by caller-supplied `mask`; telemetry `pr.summary` with `source`, `agent`, `reason`.
- Handlers: candidates from `task.terminals` (kind claude/opencode, `s.terminals.isRunning`, `!leakWatch.isPaused`), `lastAgentTurnAt` (Claude: `lastAgentTurnAt(sessionFile(def.sessionId))`; OpenCode: `latestSession(folderPaths(worktree), createdAt).updatedAt`), request file at `<tab worktree>/.shellie/pr-request-<n>.md`. Headless: existing code with `workItem` = `.shellie/task.md` of the home worktree, `turns` = `withoutPrRequests` of all sessions, writer = Claude if `agentsCache`/detect says found else OpenCode else error "Neither Claude Code nor OpenCode was found". Finish's `options.prSummaries` keeps coming from the renderer (unchanged contract). `PrDrafts.forget` on task finish/delete.

- [ ] **Step 1: Failing tests** — PrDrafts: no candidate → headless, `note` has reason; tab text → ready/source tab; tab `no-reply` → status goes `writing` then ready from headless; skip during ask aborts (askTab saw abort) and a late result is ignored; write again aborts previous; second repo waits for the first. Handlers (`handlers.part4.test.ts`, replacing the `tasks:prSummary` cases): headless prompt includes task.md text and agent turns; OpenCode-only detection runs `opencode run` with the deny env; masking still applied.
- [ ] **Step 2: Run** `npx vitest run src/main/prDraft src/main/ipc/handlers.part4.test.ts` — FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** — PASS; `npm run typecheck`. **Step 5: Commit.**

### Task 7: Finish page on main's drafts

**Files:** Modify `src/renderer/screens/FinishScreen.tsx`, `src/renderer/components/PrDescriptionField.tsx` (+ their tests).

**Interfaces:**
- Consumes: Task 6 IPC/event and `PrDraft`.
- FinishScreen: drop the module `prDrafts` map and `draftRuns`; on mount `prDrafts:get`, subscribe to `prDrafts:changed` for this task; start `prDrafts:write` for PR workspaces with no draft; `draftWriting` = any status in `asking-tab|tab-blocked|writing`; edits call `prDrafts:edit` (debounced 300 ms) and update local state at once.
- PrDescriptionField: header text per status — `asking-tab`: "Asking {label}…" + button "Show tab" (navigates to the task's tab via the store's `go`/tab select used by attention:open); `tab-blocked`: "{label} is waiting for you" + Show tab; `writing`: "Writing it without the tab…" when `source` fell back, else "Writing it…"; `note` shown muted under the field when ready.

- [ ] **Step 1: Failing tests** — unmount/remount mid-`asking-tab` shows the state from `prDrafts:get` and updates on event to ready; Finish disabled while asking; Show tab selects the tab; Skip calls `prDrafts:skip`; edit persists across remount.
- [ ] **Step 2: Run** `npx vitest run src/renderer/screens/FinishScreen.test.tsx src/renderer/components` — FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit.**

### Task 8: Docs and full check

**Files:** Create `docs/changes/2026-11-14-pr-description-from-session.md`; modify `docs/telemetry.md`; `design/README.md` only if a mock is affected (no).

- [ ] **Step 1:** Change note: spec link, how it works (A/B/C/D), what was verified (tests, the dev-app run), known gaps (Windows ConPTY typing and OpenCode stdin shim unverified; 60-min window vs cache TTL; OpenCode no budget cap; linked PRs not updated).
- [ ] **Step 2:** `npm test && npm run typecheck && npm run lint` — all pass.
- [ ] **Step 3:** Dev-app check: `SHELLIE_USER_DATA=<scratch> npm start` with a fake task if feasible, else note it as not run.
- [ ] **Step 4: Commit.**

## Review fixes (Fable, before building)

- Task 5: `no-reply` only when `readReply()` shows the request line followed by an agent turn without markers; a `done`/`idle` before the request line is in the transcript keeps waiting. Tests: done before the transcript has the request; stale idle right after typing.
- Task 4: Services hook `agentSpawned(id, kind)` at the tab spawn (both kinds) resets `TabActivity` (`state: null, typed: false`); OpenCode's plugin never sends `idle`. A muted `done` is passed to the tracker as `idle` (drops a blocked entry raised during the turn) and still reaches `d.status` and TabActivity; `unmute(id)` for aborts. Both paths (`data()` OSC, `signal()` OpenCode) tested.
- Task 1: `latestSession` shares the PR/brain title exclusion (done); `json_valid` guard on `json_extract` (done).
- Task 6: `askTab` returns `{ reason }` when nothing qualifies; `PrDrafts` deps include `finish(text): string` (tidy + mask); results carry `agent` and `reason` for telemetry. `withoutPrRequests`/`markedReply` treat `Claude` and `Agent` both as the agent. Session reading and git calls in `Promise.all`. Re-check `leakWatch.isPaused` right before typing. Writer detection is lazy (`agentsCache` or a detect call), tests stub `runProbe`. OpenCode via stdin through `runAgent` (no `prompt` arg to `opencodeCommand`); its "not found" message is its own.
- Task 3: `AgentsSection` is `src/renderer/components/AgentsSection.tsx`.
- Known gap: a tab resumed with `--continue` (no `sessionId`) is never asked.
