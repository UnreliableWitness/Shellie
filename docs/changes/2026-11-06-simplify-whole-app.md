# Simplify pass over the whole application

A `/simplify` review of all of `src/` (not one change's diff): four reviewers looked for reuse, simplification, efficiency and altitude issues, and the safe, local findings were applied. No feature changed; the behaviour deltas that were accepted are listed below.

## What changed

**Shared helpers** (new homes for code that existed in several copies)

- `src/shared/text.ts`: `plural`, `clip` and `eur` (the renderer's `format.ts` re-exports `eur` and `plural`). `eur` replaces the budget notification's own `€${n.toFixed(2)}`, which lacked the half-up rounding the UI applies; the brain's three `clip` copies and the terminal failure and repo graph truncations share one.
- `src/main/async.ts`: `sleep`, `tick`, `withTimeout`. Five `sleep` copies, three `tick` copies and five hand-rolled `Promise.race` timeouts (work item details, brain context, Home connection, terminal kill, smoke) use them. `HomeService` no longer has a `HomeTimeout` class: a timeout resolves to null and maps to the `timeout` failure kind as before.
- `src/main/fsRetry.ts`: `isFile`, `readJson`, `writeAtomic(file, text, tmpSuffix?)`, `monthFiles`. Six stat-lambdas, four package.json readers and six temp-file-then-rename writers use them; the brain's `state.json` and index page writers now get the Windows lock retry the ledger already had.
- `src/main/paths.ts` `toRel` (moved from `docs/worktreeFiles.ts`) serves the secrets scanners and `repos:pickFile`; `src/main/brain/paths.ts` `absPath` replaces 13 `path.join(brainDir, ...rel.split('/'))` sites.
- `claudeConfigDir`/`claudeProjectsDir` live only in `services/claudeSessions.ts`; the copy in `budget/claudeTranscripts.ts` and the inline one in `claudeTheme.ts` are gone.
- `errorMessage` from `src/shared/errors.ts` is the one way to read an error's text. The renderer's `ipcErrorMessage` was deleted: the preload already strips Electron's `Error invoking remote method` prefix, so the renderer regex never matched. Two tests that imitated the raw prefix now throw the plain message.
- `isAgentKind` is owned by `src/shared/agents.ts` (re-exported from `terminalFailure.ts`); `apmTargetsFor`, `SendComments` and `SetupCategory` use it instead of spelling out `claude || copilot || opencode`.
- Renderer: `hooks/useLiveQuery.ts` is the "invoke, then refetch on an event" hook that `useTaskUsage`, `useTaskCosts`, `useBudget`, `useHomeStats` (throttled) and `useTaskTime` (error + reload) are built on; `useTaskCost(taskId)` gives one task's cost, null until read. `localStorage.ts` holds the one `local()` getter. `format.ts` gained `clock(isoOrMs)` (HH:MM) and `sprintTime.ts` gained `progress(spentSeconds, estimateHours)`.

**IPC hub** (`src/main/ipc/handlers.ts`, about 300 lines shorter)

- The single-repo `tasks:finish` calls `openPullRequest` instead of an 80-line inline copy of it. Accepted deltas: no second push when the branch is already on origin, and the work item is linked only when the repo's organisation is the task's (otherwise it is named in the description), which the multi-repo path already did since #48.
- `markDone` is the one "task is done" tail (patch, `stopRuns`, `leakWatch.dropTask`, `reportFinished`, `afterFinish`) for the three finish paths; `newTask`/`registerTask` build and store a task for both create paths; `claudeSessionLines` and `addTempSource` serve `brainAtFinish` and `taskRequests`.
- `forgetTab` (spawn env, run args, leak watch) and `stopTaskProcesses` (watchers + kill all) replace hand-assembled lists; a `shellie run` tab stopped or closed now also drops its `runArgs` entry, which two of six sites forgot.
- `withClaim` wraps the claim/try/finally at five handlers; `openFolder`, `discover`, `discoverAndHold`, and hoisted defaults for the optional services (`openPath`, `revealFile`, `grantView`, `runAgent`, `sessionFile`; late-bound, since tests swap them after `createHandlers`).
- `RepoRegistry.find`/`repoName` and `ConnectionStore.find` replace nine `list().find(...)` and five `try { get } catch` lookups.

**Efficiency**

- `UsageStore.addMany`: an OTLP batch is one mkdir and one append per month file and one `changed` event per task, instead of one of each per record. `byTask` lists stay sorted at insert, so `records()` no longer copies and sorts on every call (`summarize` read it four times).
- Telemetry `scrub` caches its compiled patterns per sensitive-value list instead of building about four RegExps per value per scrubbed string.
- `TerminalAgentTimer` caches the negative answer, so shell, Claude and Copilot tabs no longer scan tasks × terminals on every output chunk.
- Boot runs the independent folder, plugin and shim writes together with the usage and time loads, and the budget and cost-server loads together.
- `LedgerStore.upsert` hashes a record once. `useGitSummary` polls only while the window has focus (like its sibling polls) and refreshes on focus.
- Cost-only consumers (task nav rows, the terminal tab cost button, the Home tasks band) read `usage:costs` instead of the full `usage:task` summary; the header keeps the summary because it shows the per-tool split.

**Renderer simplifications**: FinishScreen's `NotReadyPage`, `TaskHeading`, `CloseTerminalsOption` and `BrainCaptureOptions` serve the repo and no-repo screens; `TerminalTabs` has one `ClosableTab` (the brain tab gains middle-click close); `TaskNav` derives "current" from `taskOnScreen` and drops its second screen subscription; `NewTaskScreen`'s two create paths share `submit`; `DoneTaskPage` keeps the fetched PR keyed by task and workspace instead of a sync effect; the three-way `workItems:sprint` and two-way `docs:openInEditor` calls are one call each. `main.ts` has one safeStorage adapter, `brainOf`, `focusMain` and `claudeSettings`; `AdoClient` fetches work item types through one `rawWorkItemTypes`.

**Dead code**: `ReviewCommentStatus`, `pushedBranches`, `nouns` (with its test file) deleted; 79 values that no other file referenced lost their `export`.

## Verified

- `npm test`: Test Files 313 passed | 1 skipped (314); Tests 3687 passed | 31 skipped (3718) after the agents' edits; the cost-button and hook tests re-run after the last change (6 files, 102 tests). `npm run typecheck` clean; `npm run lint` 0 errors, the same warnings as `main`; format check clean.
- Test edits: `SprintScreen.test.tsx` and `DocsTab.test.tsx` assert the one-call argument tuples; `TaskNav.test.tsx` and `TaskScreen.test.tsx` mock `usage:costs`; `claudeProjectsDir`'s default-path test moved to `claudeSessions.test.ts`; `FinishScreen.test.tsx`/`ChangesTab.test.tsx` throw plain messages.

## Known gaps

- Not applied, by choice: moving the Azure DevOps status bookkeeping (`withConnection`) into `TrackerRegistry` so setup and PR polling also mark a connection (changes when a project turns red); store `onChange` hooks replacing the 25 `reposChanged`/`connectionsChanged`/`secretsChanged` calls; debouncing the `usage:changed` broadcast; skipping the 30 s ledger re-sweep when nothing changed; sharing the two 30 s transcript directory walks; a stat-only `docs:stat` channel for the docs fallback poll; one `glyphs.ts` for the per-file `DOT`/`UP`/`DOWN` constants.
- `withClaim` is not used at `openRunTab` and the `terminals:open` spawn loop: their bodies are synchronous and an async wrapper releases a microtask later, which breaks two concurrent opens.
- Not run in the app; unit and component tests only. Windows unverified.
