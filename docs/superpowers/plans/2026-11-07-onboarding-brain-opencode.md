# Onboarding up to date, brain on Claude Code or OpenCode: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A brain runs on OpenCode as well as Claude Code, and the Get started flow tells the truth and offers a fourth, optional brain step on the agent the user has.

**Architecture:** A per-brain `agent` option drives three seams that are Claude-only today: the headless job command and its output parser (`jobs.ts`), the brain terminal (`brainTerminal.ts`), and the task's agent tab hooks (`handlers.ts`, `main.ts`). Templates v7 add OpenCode's `opencode.json` and `.opencode/command/*.md` wrappers around the existing skills (OpenCode loads `.claude/skills` natively). Onboarding grows a `brain` step backed by a new `brain-new` page that reuses `CreateBrainForm`.

**Tech Stack:** Electron, React, TypeScript, zod, Vitest, node:sqlite (`DatabaseSync`, already used by `src/main/budget/openCode.ts`).

**Spec:** `docs/superpowers/specs/2026-11-07-onboarding-brain-opencode-design.md` (read it first; it holds the live OpenCode findings and every "my call").

## Global Constraints

- `TEMPLATES_VERSION = 7`; `picturesReady` stays `>= 6`; new `opencodeReady = (b) => b.templatesVersion >= 7`.
- `BrainOptions.agent` defaults to `'claude'`; `BrainOptions.opencodeModel` defaults to `null`. Existing brains must behave exactly as before.
- OpenCode permission rules: **the last matching rule wins**. Edit order is always `"*": "allow"` first, then `"sources/**": "deny"`, then `"brain/pictures-dropped.json": "deny"`.
- OpenCode headless: `opencode run --command <kind> --format json [-m <model>]`, the argument on stdin, stdin closed.
- OpenCode terminals never use `--continue`.
- No step may start an agent run the user did not ask for (owner rule: no extra AI cost). `agents:opencodeModels` runs `opencode models` only.
- Copy: "Claude" in user-facing brain text becomes "the agent" except where it names Claude Code as a product choice.
- Every change keeps `npm test`, `npm run typecheck`, `npm run lint` green. Comments and naming match the surrounding code (one-line doc comments, plain English).
- Never change `addDirForClaude`'s storage name.

## Review Focus

1. A user's own `OPENCODE_CONFIG_CONTENT` with `"edit": "allow"`: brain jobs must still refuse to edit `sources/` (Task 5 test + Task 12 live check).
2. An OpenCode brain created from an existing brain folder (templatesVersion 0): jobs hold, Health says "Update skills to run on OpenCode", nothing fails or spins (Task 5 test).
3. OpenCode not installed but the brain is on OpenCode: the job fails once with a message naming OpenCode, the queue moves on (Task 5 test: run rejects with ENOENT-like error).
4. Pictures argument with spaces and quotes reaches OpenCode intact through stdin (Task 5 test asserts `input` equals the pictures argument verbatim).
5. Onboarding with tracker "none": step 4 reads "Needs a connected project", counts as done, and `nextStep` never routes to `brain-new` (Task 10 test).

---

### Task 1: Shared types and options

**Files:**
- Modify: `src/shared/brain.ts`
- Test: `src/shared/brain.test.ts` (create if missing)

**Interfaces:**
- Produces: `BrainAgentSchema = z.enum(['claude','opencode'])`, `type BrainAgent`; `BrainOptionsSchema` gains `agent: BrainAgentSchema.default('claude')`, `opencodeModel: z.string().nullable().default(null)`; `BrainJob` gains `agent: BrainAgent`; `OPENCODE_TEMPLATES = 7`; `opencodeReady(brain: Pick<Brain,'templatesVersion'>): boolean`; `BRAIN_AGENT_LABELS: Record<BrainAgent,string>` = `{ claude: 'Claude Code', opencode: 'OpenCode' }`.

- [ ] Step 1: test: `BrainOptionsSchema.parse({})` gives `agent: 'claude'`, `opencodeModel: null`; `opencodeReady({templatesVersion: 6})` false, `7` true.
- [ ] Step 2: run `npx vitest run src/shared/brain.test.ts`, expect FAIL.
- [ ] Step 3: implement; fix every `BrainJob` literal the typecheck flags (tests and `jobs.ts` enqueue: set `agent` from the brain at enqueue time via a new runner dep in Task 5; until then `'claude'`).
- [ ] Step 4: `npx vitest run src/shared/brain.test.ts && npm run typecheck` PASS.
- [ ] Step 5: commit `Brain: an agent option (Claude Code or OpenCode)`.

### Task 2: `Platform.opencodeCommand` takes args

**Files:**
- Modify: `src/main/platform/Platform.ts`, `darwin.ts`, `windows.ts`
- Test: the existing platform tests (`src/main/platform/*.test.ts`)

**Interfaces:**
- Produces: `opencodeCommand(base?: string, args?: string[]): Command`. darwin: `exec ${base?.trim() || 'opencode'} <args each quoted as claudeCommand quotes flags>`; windows: `tool('opencode', args ?? [], null, base)`.

- [ ] Step 1: tests: darwin `opencodeCommand(undefined, ['run','--command','capture','--format','json','-m','opencode/big-pickle'])` yields a login-shell command whose script ends with `exec opencode run --command capture --format json -m opencode/big-pickle` (quoting as the darwin quote helper produces); an arg with a space and a `"` is quoted. Windows: args reach `tool` unchanged; no args gives today's command.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS. Step 5: commit `Platform: OpenCode command with arguments`.

### Task 3: Templates v7

**Files:**
- Modify: `src/main/brain/templates.ts`, `src/main/brain/scaffold.ts` (only if `templateFiles` needs the new paths listed), tests `src/main/brain/templates.test.ts`, `scaffold.test.ts`

**Interfaces:**
- Produces: `TEMPLATES_VERSION = 7`; `brainOpencodePermission(): { edit: Record<string,'allow'|'deny'>; bash: Record<string,'allow'|'deny'>; webfetch: 'deny' }` exported from `templates.ts` (Task 5 uses it for job shielding); `templateFiles` returns, besides today's, `opencode.json` and `.opencode/command/{capture,sync,lint,digest,ask,retract,lessons,pictures}.md`.

- [ ] Step 1: tests:
  - `Object.keys(brainOpencodePermission().edit)` equals `['*','sources/**','brain/pictures-dropped.json']` in that order with values `allow, deny, deny`; `bash` keys in order `['*','git diff*','git log*','git show*','git rev-parse*','git status*']` with `deny` then `allow`×5.
  - `JSON.parse(templateFiles(...)['opencode.json'])` has `$schema: 'https://opencode.ai/config.json'` and `permission` deep-equal to `brainOpencodePermission()`.
  - each `.opencode/command/<kind>.md` starts with `---\ndescription: ` + the skill's description, and its body contains ``Load the `<kind>` skill and follow it exactly. The argument is: $ARGUMENTS``; `ask.md` also contains `Read only: never write, edit or run anything.`
  - `.gitignore` contains `.opencode/node_modules/`, `.opencode/package.json`, `.opencode/package-lock.json`, `.opencode/bun.lock` besides today's lines.
  - No template string contains `never reached Claude` or `the Read tool`; SCHEMA contains `AGENTS.md`.
- [ ] Step 2: FAIL. Step 3: implement: derive commands from the same skill list that builds `.claude/skills/*` (read each skill's `description` from its frontmatter constant); apply the spec's wording changes (capture/pictures: "open the image with your file-reading tool"; lessons: "a digest of a developer's conversation with their coding agent"; SCHEMA: "never reached the agent", and "Never create or edit a `CLAUDE.md` or `AGENTS.md`").
- [ ] Step 4: `npx vitest run src/main/brain` PASS (fix version-number expectations in existing tests).
- [ ] Step 5: commit `Brain: skills v7 for OpenCode (opencode.json, commands)`.

### Task 4: OpenCode output parser

**Files:**
- Create: `src/main/brain/opencodeResult.ts`, `src/main/brain/opencodeResult.test.ts`

**Interfaces:**
- Produces: `opencodeResultWithSession(stdout: string): { result: string; sessionId: string | null }`.

- [ ] Step 1: tests with JSON-lines fixtures shaped like the spec's findings:
  - two steps, text `DONE` in the last → `{ result: 'DONE', sessionId: 'ses_1' }`; two text parts in the last step join with `\n`; text in an earlier step only is ignored if the last step has text.
  - empty stdout → throws `OpenCode printed nothing`.
  - events but no text part → throws `OpenCode gave no result`.
  - an `{"type":"error",…,"error":{"name":"UnknownError","data":{"message":"boom"}}}` line → throws `OpenCode stopped (boom)`.
  - a non-JSON line between events is skipped.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS. Step 5: commit `Brain: read OpenCode's run output`.

Also in this task: make `claudeResultWithSession`'s messages unchanged (they already say "Claude Code").

### Task 5: Jobs run on the brain's agent

**Files:**
- Modify: `src/main/brain/jobs.ts`, `src/main/brain/health.ts` (held line), `src/main.ts` (runner deps), `src/main/brain/brainHandlers.ts` (enqueue sets `agent` via the runner)
- Test: `src/main/brain/jobs.test.ts`, `health.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 2 `opencodeCommand(base, args)`, Task 3 `brainOpencodePermission`, Task 4 parser.
- Produces: `BrainJobDeps` gains `platform: Pick<Platform,'claudeCommand'|'opencodeCommand'>`, `agent: (brainId) => BrainAgent`, `opencodeModel: (brainId) => string | null`, `ready: (brainId) => boolean` (main wires `opencodeReady` for OpenCode brains, `true` for Claude); exported `opencodeJobArgs(kind: BrainJobKind, model: string | null): string[]` = `['run','--command',kind,'--format','json', ...(model ? ['-m', model] : [])]`; exported `opencodeJobEnv(base: Record<string,string>): Record<string,string>` that sets `OPENCODE_CONFIG_CONTENT` to `JSON.stringify({ permission: brainOpencodePermission() })`, replacing any inherited value; `BrainJobRunner.held(brainId): boolean` (true while jobs wait for Update skills).

- [ ] Step 1: tests (fake `run`, as the existing runner tests do):
  - Claude brain: command and stdin exactly as today (`/capture sources/x.md` on stdin).
  - OpenCode brain: `run` gets `opencodeCommand(undefined, opencodeJobArgs('capture', 'opencode/big-pickle'))`, `input` is `sources/x.md` (no slash, no kind), env has `OPENCODE_CONFIG_CONTENT` equal to the brain rules even when the base env had `{"permission":{"edit":"allow"}}`; result parsed by `opencodeResultWithSession`; `job.agent === 'opencode'`; sessionId stored in `state.captured`.
  - Pictures job on OpenCode: `input` is exactly the argument `promptFor` produced minus the leading `/pictures ` (e.g. `sources/a b.md ["sources/a b-assets/x \"1\".png"]`).
  - `ready` false → no `run` call, job stays `queued`, `held()` true; after `ready` flips and `resume`/`kick` is called (use the same entry the Update skills handler calls: add `BrainJobRunner.release(brainId)`), the job runs.
  - `run` rejects with `spawn opencode ENOENT` → job `failed`, error mentions `OpenCode`, next job runs.
  - Health (`health.ts`) shows the line `Update skills to run on OpenCode` when `held` (pass it in like the paused flag is passed today).
- [ ] Step 2: FAIL. Step 3: implement; the job's `agent` is set at enqueue from `deps.agent(brainId)`; `brain:updateTemplates` calls `runner.release(brainId)` after saving the version; `brain:update` with an `options.agent` change also calls `release`.
- [ ] Step 4: `npx vitest run src/main/brain && npm run typecheck` PASS.
- [ ] Step 5: commit `Brain: jobs run on Claude Code or OpenCode`.

### Task 6: Brain terminal, Ask, Continue on the brain's agent

**Files:**
- Modify: `src/main/brain/brainTerminal.ts`, `src/main.ts` (deps), `src/main/budget/openCode.ts` (session lookup), `src/renderer/components/brain/AskBox.tsx`, `src/renderer/components/brain/BrainInbox.tsx` (Continue passes `job.agent`), `src/shared/ipc.ts` (`brain:terminal` args gain `agent?: BrainAgent`), `src/main/brain/brainHandlers.ts`
- Test: `brainTerminal.test.ts`, `openCode.test.ts`, `AskBox.test.tsx`

**Interfaces:**
- Produces:
  - `brainTerminalDef(brain, agent?: BrainAgent)` → `kind` = agent (default the brain's `options.agent`).
  - `brainOpencodeArgs(def: TerminalDef, model: string | null, prompt?: string): string[]` = `[...(def.sessionId ? ['--session', def.sessionId] : []), ...(model ? ['-m', model] : []), ...(prompt ? ['--prompt', prompt] : [])]`.
  - `OpenCodeReader.latestSession(dir: string, since: number, exclude: ReadonlySet<string>): string | null` — newest `session.id` with `directory = dir`, `parent_id IS NULL` (when the column exists), `time_created >= since`, id not in `exclude`.
  - `BrainTerminalDeps` gains `opencodeSession: (brain: Brain, since: number) => string | null` (main wires it with the job and captured session ids as `exclude`) and `now?: () => number`.
  - `askPrompt(agent: BrainAgent, q: string): string` in `src/shared/brain.ts`: Claude `/ask ${q}`; OpenCode `Load the ask skill and answer from this brain, reading only: ${q}`.
- Behaviour: OpenCode open with no stored session: before spawning, try `opencodeSession(brain, brain.terminal?.spawnedAt ?? 0)`; if found store it and `--session` it, else start new and store `spawnedAt` (add optional `spawnedAt?: number` to the stored def via `TerminalDefSchema` only if it has room; otherwise keep it in `Brain` as `terminalSpawnedAt`, builder's choice). Never `--continue`. Continue in terminal with a job whose `agent` differs from the running terminal's kind kills and respawns on `job.agent`.
- [ ] Step 1: tests for each produced function and: a Claude brain's terminal args unchanged; an OpenCode brain's spawn uses `platform.opencodeCommand(undefined, brainOpencodeArgs(...))`, cwd the brain path, taskId `brain:<id>`; a running OpenCode terminal gets the Ask text typed then `\r`; `latestSession` against a temp sqlite file built with the schema in the spec (`session` with `directory`, `parent_id`, `time_created`).
- [ ] Step 2: FAIL. Step 3: implement (TerminalFailures gets the terminal's real kind). Step 4: PASS. Step 5: commit `Brain: the brain terminal runs the brain's agent`.

### Task 7: Task hooks for OpenCode tabs and lessons from OpenCode sessions

**Files:**
- Modify: `src/main/attention/opencodePlugin.ts` (`opencodeConfigContent` gains `brainDir?: string`), `src/main.ts` (`terminalEnv` passes the task's brain path when `addDirForClaude` is on), `src/main/brain/sessionDigest.ts`, `src/main/ipc/handlers.ts` (`captureLessons` source), `src/main/budget/openCode.ts`
- Test: `opencodePlugin.test.ts`, `sessionDigest.test.ts`, `openCode.test.ts`, the handlers test that covers lessons

**Interfaces:**
- Produces:
  - `opencodeConfigContent(existing, pluginPath, instructions?, denyPaths?, brainDir?)`: with `brainDir`, `permission.external_directory[`${brainDir}/**`] = 'allow'` and `permission.edit[`${brainDir}/**`] = 'deny'` appended after existing edit rules (last wins).
  - `OpenCodeReader.sessionTexts(dir: string): { who: 'Developer' | 'Agent'; text: string }[][]` — per top-level session in `dir`, oldest first, text parts (`part.data.type === 'text'`, not `synthetic`) by message role (`message.data.role` `user` → Developer, `assistant` → Agent), consecutive Agent parts joined.
  - `sessionDigest(title, sessions)` accepts already-parsed turns too: add `sessionDigestFromTurns(title: string, sessions: Turn[][]): string | null` and make `sessionDigest` call it; Claude's speaker label stays `Claude`, OpenCode's is `Agent`.
- [ ] Step 1: tests: config content with `brainDir` `/b` has `external_directory: {'/b/**':'allow'}` and the `edit` rule last; existing user edit rules kept before it. `sessionTexts` on a temp db returns two sessions in order with roles mapped. Lessons at Finish for a task with only an OpenCode tab produce a digest containing `**Developer:**` and `**Agent:**`.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS. Step 5: commit `Brain: OpenCode tasks read the brain, and their sessions become lessons`.

### Task 8: Agent-neutral brain text

**Files:**
- Modify: `src/main/brain/pictures.ts:638`, `src/main/brain/mirror.ts:391`, `src/renderer/components/brain/SourcePictures.tsx`, `src/renderer/components/brain/BrainHealth.tsx`, `src/shared/brain.ts` (finding code)
- Test: existing tests of those files

**Interfaces:**
- Produces: `BrainFinding` gains optional `code?: 'pictures-dropped'`; `pictures.ts` sets it on the dropped-pictures finding; `BrainHealth` opens the picture view when `f.code === 'pictures-dropped'` (not by matching words).
- [ ] Steps: update tests to the new strings `never reached the agent` / `formats the agent cannot view`; FAIL; implement; PASS; commit `Brain: say "the agent", not "Claude"`.

### Task 9: Settings › Brains: agent and model

**Files:**
- Modify: `src/renderer/screens/settings/BrainsSection.tsx`, `src/shared/ipc.ts` (`brain:create` input gains `agent: BrainAgent`, `opencodeModel?: string | null`; new `agents:opencodeModels: { args: []; result: string[] | null }`), `src/main/ipc/handlers.ts` or the agents handler file (implement the channel: run `opencode models` via `Platform.opencodeCommand(undefined,['models'])`, 15 s timeout, lines matching `^[\w.-]+/[\w.:-]+$`, cached per app session, `null` on failure), `src/main/brain/brainHandlers.ts` (create stores the agent), telemetry `brain.created` gains `agent`
- Test: `BrainsSection.test.tsx`, handler tests

- Behaviour: Create form: an "Agent" select pre-selected by `agents:detect` (Claude found → claude; else OpenCode found → opencode; else claude with the note `Neither Claude Code nor OpenCode was found on this machine; the brain's jobs will fail until one is installed.`), labels `Claude Code (found)` / `OpenCode (not found)`. Card: Agent select; the Model control per agent (Claude: today's select; OpenCode: select with `OpenCode's default` first then the listed models, or a text field when the list is `null`); under the OpenCode model `Pictures are read only by models that can see images.`; when agent is OpenCode and `!opencodeReady(brain)`, `Update skills first` next to the agent. Toggle label `Give the task's agent read access to the brain folder`.
- [ ] Steps: tests for detection preselect (three cases), the note, the model control switch, the "Update skills first" hint, `brain:create` called with `agent`; FAIL; implement; PASS; commit `Settings: pick a brain's agent and model`.

### Task 10: Onboarding state with a brain step

**Files:**
- Modify: `src/shared/usage.ts` (`OnboardingSchema` gains `brain: z.enum(['none']).nullable().default(null)`; the default object in `AppSettings` too), `src/renderer/onboardingState.ts`, `src/renderer/components/ui/StepStrip.tsx` (`{ key: 'brain', label: 'Brain' }`), `src/renderer/store.ts` (`Screen` gains `{ kind: 'brain-new'; from: 'get-started' }`)
- Test: `src/renderer/onboardingState.test.ts`

**Interfaces:**
- Produces: `OnboardingStep = 'agents'|'connect'|'repository'|'brain'`; `onboardingSteps({ settings, connections, repos, brains })` with `brains: readonly unknown[]`; `brain` done when `brains.length > 0 || onboarding.brain === 'none' || onboarding.tracker === 'none'`; `brainNeedsProject: boolean` on the result (true when tracker is `none` or there is no connection); `stepsFrom` takes `brains` (the store's brain list; add it to the store if it is not there, fed by `brain:list` on load and `brain:changed`); `nextStep(steps, left)` returns `{ kind: 'brain-new', from: 'get-started' }` for `brain`.
- [ ] Step 1: tests: four steps in order; brain done by a brain, by `brain: 'none'`, by tracker `none`; `current` skips a done brain; `nextStep(…, 'repository')` → brain-new when brain todo, Home when done; `firstScreen` unchanged (no repo and not dismissed → get-started regardless of brains).
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS. Step 5: commit `Onboarding: a fourth step for the brain`.

### Task 11: Onboarding screens

**Files:**
- Create: `src/renderer/screens/BrainNewScreen.tsx`, `BrainNewScreen.test.tsx`
- Modify: `GetStartedScreen.tsx`, `GetStartedScreen.test.tsx`, `AgentsSection.tsx`, `ConnectScreen.tsx`, `ConnectScreen.test.tsx`, `src/renderer/App.tsx` (route `brain-new`), `BrainsSection.tsx` (export `CreateBrainForm` with an `onCreated?: (brain: Brain) => void` prop), `docs/telemetry.md`

- Exact copy (from the spec, verbatim):
  - Intro: `A task is a git worktree with its own agent tabs, tied to a work item, with the AI cost and time it took. A few short steps and your sprint is on this page.`
  - Titles: `1 · Agents`, `2 · Connect Azure DevOps`, `3 · Add a repository`, `4 · A brain for your project`.
  - Connect todo: `Shellie reads your sprint, moves the work item when a task starts and opens draft pull requests. GitHub later.`
  - Brain todo: `A local wiki of the project's documents, kept by your agent, that every task can read. Optional.` + ` Runs on Claude Code.` / ` Runs on OpenCode.` / ` Needs Claude Code or OpenCode.` (the brain's pre-selected agent per Task 9's rule). Needs-project: `Needs a connected project.` Done: `<name> on <Claude Code|OpenCode>.` (list when several) or `Skipped.` Button `Create brain…` (`Change` is not offered; when done the button reads `Open`, going to Settings › Project › Brains).
  - What you get: `Start on a sprint item → worktree, branch, setup, agent tabs`; `Claude Code, OpenCode and Copilot cost per task, priced in EUR`; `A brain per project: your documents and wiki, kept as pages your agent reads`; `Time, changes review, Docs, draft PR at Finish`.
  - AgentsSection: OpenCode cost cell `Per task, from its database`; line under the table `Brains run on Claude Code or OpenCode, whichever you pick per brain.`
  - ConnectScreen: intro (new connection) `Each project you tick becomes a project in Shellie with its own page and settings; add more later in Settings › Projects.`; footer `Writing time back to work items stays off until you turn it on per project.`; `SCOPES` gains `Wiki (Read)` last, and after the scopes line `Wiki (Read) is only needed for a brain.`
  - BrainNewScreen: StepStrip `current="brain"`, PageHeader `A brain for your project`, a muted intro `Drop documents or point it at the project's wiki; your agent writes them up as pages, and every task of the project can read them.`, a project select when there are several connections (label `Project`), the `CreateBrainForm`, actions Back, `Skip for now` (saves `onboarding.brain = 'none'`, tracks `onboarding.step {step:'brain', outcome:'skipped'}`), and on create tracks `continued` and goes to `nextStep(..., 'brain')`.
- [ ] Step 1: tests: Get started shows four cards with the exact titles and texts above for: fresh install; Claude only (`Runs on Claude Code.`); OpenCode only (`Runs on OpenCode.`); neither; tracker none (`Needs a connected project.`). Home band lists the brain step when todo. ConnectScreen shows `Wiki (Read)` and the new footer, and no longer contains `cost`. Agents table no longer contains `budget only`. BrainNewScreen: Skip saves `brain: 'none'` and goes Home when everything else is done; create goes on.
- [ ] Step 2: FAIL. Step 3: implement; update `docs/telemetry.md` (`onboarding.step` step list gains `brain`; `brain.created` gains `agent`; `settings.brain` lists `agent`, `opencodeModel` field names).
- [ ] Step 4: `npx vitest run src/renderer && npm run typecheck && npm run lint` PASS.
- [ ] Step 5: commit `Onboarding: true texts, OpenCode named, and the brain step`.

### Task 12: Attribution test, live check, change note

**Files:**
- Modify: `src/main/ledger/attribute.test.ts`
- Create: `docs/changes/2026-11-07-onboarding-brain-opencode.md`
- Temporary (not committed): a vitest file for the live check

- [ ] Step 1: attribution test: a record `{ tool: 'opencode', cwd: '<brain path>/wiki' }` with no task id attributes `{ level: 'brain', brainId }` and is not billable. Run, PASS (expected to pass already; it pins behaviour).
- [ ] Step 2: live check, GUI-free, on `opencode/big-pickle` (free; never a Claude run): scaffold a v7 brain in a temp dir, `addSource` a pasted note, run `BrainJobRunner` with the real `runWithInput`, `createPlatform()`, agent `opencode`, model `opencode/big-pickle`, and the parent env carrying `OPENCODE_CONFIG_CONTENT={"permission":{"edit":"allow"}}`; wait for capture and lint. Expect: a page under `wiki/`, commits `Brain: capture …` and `Brain: lint`, `git status --porcelain -- sources` empty and `git log -- sources` showing only Shellie's `add source` commit, `state.captured[...]` with a `ses_` id. Then check the task-tab rule: in a temp worktree with `OPENCODE_CONFIG_CONTENT` from `opencodeConfigContent(..., brainDir)`, `opencode run` asked to append to `<brain>/wiki/x.md` must be refused (record the outcome; if not refused, follow the spec's fallback and say so in the change note).
- [ ] Step 3: `npm test && npm run typecheck && npm run lint` all PASS; record the counts.
- [ ] Step 4: write the change note (spec, how it works, what was verified with numbers, known gaps: mockups older than the screens, art still pending, MCP servers of the user's OpenCode config load in brain jobs, the cap lags OpenCode's database by up to 30 s).
- [ ] Step 5: commit `Docs: change note for onboarding and the brain on OpenCode`.
