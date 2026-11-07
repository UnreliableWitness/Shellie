# Onboarding brought up to date, with the brain, on Claude Code or OpenCode

Date: 2026-11-07. Owner request: "do a deep review of the onboarding process and screens … nothing is mentioned about the brain either. please bring it up to date and make sure it works for both claude and opencode". The owner then said "start work, run unattended": every choice below that the owner did not state is marked **(my call)**.

## Why

Onboarding (`docs/changes/2026-10-22-onboarding.md`) has not moved since 2026-10-22 while the app did: the cost ledger and cost server (no cost is written to Azure DevOps), OpenCode cost per task, project scope (a connection is a project with its own page, Settings › Projects), and the brain. A new user is told wrong things and never hears of the brain. And the brain itself only runs on Claude Code (jobs, Ask, terminal, skills), while the owner said users typically have only one of Claude Code and OpenCode installed (memory, 2026-11-06). Onboarding that sends an OpenCode-only user to the brain must therefore come with a brain that runs on OpenCode.

## Goals

1. A brain runs fully on OpenCode as well as on Claude Code: the headless jobs (capture, lint, sync, digest, retract, lessons, pictures), Ask, Resolve in terminal, Continue in terminal, Open terminal, the task hooks, cost attribution and the daily cap.
2. Onboarding says only true things, names OpenCode wherever it names Claude Code, and has a fourth, optional step that creates the project's brain on the agent the user has.
3. Nothing changes for an existing Claude Code brain unless its owner switches it.

## Non-goals

- Copilot CLI as a brain agent.
- Several brains per project, OCR, the parked brain items in memory (`brain-read-add-follow-ups`, `brain-picture-coverage`).
- New Get started art (still pending in `assets/ART.md`) and regenerating `design/mockups/onboarding/` (they stay as the original design; the change note says they are older than the screens).
- A GitHub tracker.

## Anti-goals

- No extra AI cost: never run an agent the user did not ask for. Detection is `--version` probes; listing OpenCode models runs `opencode models` (no LLM call). Nothing in onboarding starts a brain job by itself except what creating a brain already does today.
- No silent overwrite of a brain's files (Update skills keeps showing a diff first).
- Never let a brain job edit `sources/` or `brain/pictures-dropped.json`, on either agent.

## Part A: the brain on OpenCode

### Findings this rests on (checked live with opencode 1.19.3 on its free models, 2026-11-07)

- `opencode run --command <name> --format json [-m provider/model]` in a folder runs `.opencode/command/<name>.md`; **the command's `$ARGUMENTS` come from stdin** when stdin is a pipe (`printf 'Zorro "x" [1]' | opencode run --command greet …` gave `Hello, Zorro "x" [1]!`). stdin must be closed: with an open, never-ending stdin the run hangs. A prompt starting with `/` sent as a plain message is not run as a command.
- OpenCode loads Claude Code skills from `.claude/skills/<name>/SKILL.md` natively, through its `skill` tool (the run's first tool call was `skill {"name":"greet"}`).
- Permissions come from `opencode.json` in the folder. **The last matching rule wins**: `{"edit": {"*": "allow", "sources/**": "deny"}}` blocks an edit of `sources/a.md`; the reverse order does not. Patterns are relative to the folder.
- A run creates `.opencode/node_modules`, `.opencode/package.json`, `.opencode/package-lock.json` and its own `.opencode/.gitignore` (listing those) when a `.opencode/` folder exists.
- `--format json` prints one JSON event per line: `step_start`, `tool_use` (with `part.tool`, `part.state.status`, `part.state.output`/`error`), `text` (`part.text`), `step_finish` (`part.tokens`, `part.cost`), each with `sessionID` (`ses_…`). The final answer is the `text` parts of the last step. A failure (unknown model, unknown command) prints one `{"type":"error","sessionID":…,"error":{"name":"UnknownError","data":{"message":"…"}}}` line and exits 1.
- The TUI takes `-s/--session <id>`, `-c/--continue`, `--prompt <text>`, `-m`.

### The brain's agent

- `BrainOptions.agent: 'claude' | 'opencode'`, default `'claude'` (so every existing brain keeps working), and `BrainOptions.opencodeModel: string | null` (`provider/model`; null = OpenCode's own default model). The existing `model` (haiku/sonnet/opus) stays and is the Claude Code model.
- Create (Settings › Project › Brains, and the onboarding step) pre-selects the agent from `agents:detect`: Claude Code if found, else OpenCode if found, else Claude Code with a note "Neither Claude Code nor OpenCode was found on this machine; the brain's jobs will fail until one is installed." **(my call: Claude first when both, matching `pretick`)**. The user can pick the other one.
- Settings › Brains card shows an Agent select (Claude Code / OpenCode) and, per agent, the Model control: Claude's Haiku/Sonnet/Opus select, or for OpenCode a select filled from a new channel `agents:opencodeModels` (runs `opencode models`, cached per app session, "OpenCode's default" first; if the list cannot be read, a text field). A note under the OpenCode model: "Pictures are read only by models that can see images."
- A brain on OpenCode whose `templatesVersion` is below 7 cannot run jobs: main does not start them (the queue holds, as for the cap, and Health says "Update skills to run on OpenCode", pointing at Settings › Project › Brains › Update skills), and the Brains card shows "Update skills first" beside the agent **(my call)**. This covers both switching an old brain and creating a brain on OpenCode from an existing brain folder (which `brain:create` marks as version 0): the brain is created on OpenCode, counts as a brain for onboarding, and waits for Update skills, whose diff is shown as today. Jobs queued while held start once the skills are updated.

### Templates v7

`TEMPLATES_VERSION = 7`. Managed files gain:

- `opencode.json`: `permission.edit` = `{"*": "allow", "sources/**": "deny", "brain/pictures-dropped.json": "deny"}` (in that order), `permission.bash` = `{"*": "deny", "git diff*": "allow", "git log*": "allow", "git show*": "allow", "git rev-parse*": "allow", "git status*": "allow"}`, `webfetch: "deny"`, the same intent as `.claude/settings.json`.
- `.opencode/command/<kind>.md` for each skill (capture, sync, lint, digest, ask, retract, lessons, pictures): frontmatter `description` (the skill's), body "Load the `<kind>` skill and follow it exactly. The argument is: $ARGUMENTS". The `ask` command also says "Read only: never write, edit or run anything." Generated from the same list as the skills, never hand-copied.
- `.gitignore` gains `.opencode/node_modules/`, `.opencode/package.json`, `.opencode/package-lock.json`, `.opencode/bun.lock`.
- Agent-neutral wording in `SCHEMA.md` and the skills: "Claude" → "the agent" where it means whoever runs the skill; capture/pictures say "open the image with your file-reading tool" instead of "the Read tool"; lessons' source is "a digest of a developer's conversation with their coding agent". `CLAUDE.md` stays named (still true for Claude Code) and SCHEMA also says not to create `AGENTS.md`.
- `isBrainFolder` accepts a folder with `SCHEMA.md` and the four core skills, as today (the OpenCode files are added by Update skills).
- New exported helper `opencodeReady = (b) => b.templatesVersion >= 7`; `picturesReady` stays at 6.

### Headless jobs

- `Platform.opencodeCommand(base?, args?)` gains optional args (quoted on macOS as `claudeCommand` does; on Windows through `tool('opencode', args, …)`). Exactly the existing pattern, so the Windows shim path is the one Claude already uses.
- `BrainJobRunner` asks the brain's agent: Claude unchanged; OpenCode runs `opencode run --command <kind> --format json [-m <opencodeModel>]` in the brain folder with `input` = the job's argument (the source path, or the pictures argument, or empty), stdin closed after it (as `runWithInput` does), same env (`brainJobEnv`), same timeout, lock, queue and cap.
- Shielding **(my call)**: for OpenCode jobs Shellie sets `OPENCODE_CONFIG_CONTENT` to the brain's own permission block (the same rules as the brain's `opencode.json`), replacing any inherited value, so a user's inline config cannot loosen the `sources/` deny (inline content is loaded after project config). The user's global config, MCP servers and plugins still load; accepted. The live check verifies the deny holds with a conflicting `OPENCODE_CONFIG_CONTENT` in the parent environment.
- A new parser `opencodeResultWithSession(stdout)` returns `{ result, sessionId }`: `sessionId` from the first event carrying `sessionID`; `result` = the joined `text` parts after the last `step_start`; it throws "OpenCode printed nothing", "OpenCode gave no result" (no text part) or "OpenCode stopped (<message>)" on an `error` event or a non-zero exit. Errors from both parsers say which agent.
- `job.sessionId` holds whichever id the agent gave; `state.captured[...]` stores it as today. Job rows show the agent the job ran on **(my call: `job.agent`, so Continue in terminal opens the right one even after the brain switched)**.

### The brain terminal, Ask, Resolve, Continue

- `brainTerminalDef(brain)` takes `kind` from the brain's agent; the label stays `<name> brain`.
- OpenCode args: a stored session → `--session <id>`; otherwise a new session (never `--continue`: the headless jobs run in the same folder, so "latest session" would land in a job's session) plus `-m <opencodeModel>` when set, and `--prompt <text>` for a first message. A running terminal gets the typed text and `\r`, as today.
- Session discovery **(my call)**: OpenCode makes the id itself, so Shellie records the spawn time and, the next time the terminal is opened or the brain is read, looks up in OpenCode's database the newest session whose directory is the brain folder, created after that spawn, that is not a job's session (`job.sessionId` of any job of the brain, and `state.captured[*].sessionId`), and stores it as `Brain.terminal.sessionId`. If none is found, a new session starts.
- Ask **(my call)**: on Claude Code it sends `/ask <q>` as today. On OpenCode it sends plain text, `Load the ask skill and answer from this brain, reading only: <q>`, both as `--prompt` and when typed into a running terminal, because a `/` message is not reliably run as a command and Enter may pick from the command menu. Resolve in terminal is already plain text.
- Continue in terminal with a job that ran on the other agent than the brain now has opens that agent's terminal for that session **(my call)**: the terminal is respawned on `job.agent`.
- Terminal failures, attention and the `kind` reported to `TerminalFailures` follow the terminal's kind.

### Task hooks

- An OpenCode tab of a task with a brain gets, through the `OPENCODE_CONFIG_CONTENT` merge Shellie already does, `permission.external_directory: {"<brain path>/**": "allow"}` and `permission.edit: {"<brain path>/**": "deny"}`, the counterpart of Claude's `--add-dir` (read access, the brain stays read-only for the task) **(my call: the read-only deny is stricter than Claude's today, which relies on the instruction in task.md)**. Absolute patterns for paths outside the project are what `opencodePermission` in `src/main/secrets/deny.ts` already relies on (checked against opencode 1.19.3 for `read`); the builder verifies the `edit` deny live and, if it does not match, drops the edit rule and keeps `external_directory` (noted in the change note). Gated by the same option, renamed in the UI to "Give the task's agent read access to the brain folder" (the field `addDirForClaude` keeps its name in storage).
- The Context section in task.md is unchanged (already agent-neutral).
- `openBrainTerminalOnStart` opens the brain's terminal on the brain's agent.
- Lessons at Finish (`captureLessons`): besides Claude transcripts, OpenCode sessions whose directory is the task's worktree, read from OpenCode's database (the reader in `src/main/budget/openCode.ts`), user and assistant text parts in time order, go through the same digest (`sessionDigest.ts`) with the speakers "Developer" and "Agent".

### Cost

- OpenCode usage in a brain folder is already attributed to the brain by cwd (`brainByCwd`), never billable, counted in `ledgerToday` and the cap. Keep it; add a test that proves it for a record with `tool: 'opencode'` and a cwd inside the brain.
- The cap reads the ledger, which reads OpenCode's database every 30 s: a job may finish before its tokens count. Accepted, the same lag as Claude transcripts.

### UI text

"never reached Claude" → "never reached the agent" everywhere (renderer and `pictures.ts`, and `BrainHealth`'s match on that text moves to a code, not the words); `mirror.ts` "formats Claude cannot view" → "formats the agent cannot view".

## Part B: onboarding

### The steps

Four steps, the fourth optional: **1 · Agents**, **2 · Connect Azure DevOps**, **3 · Add a repository**, **4 · A brain for your project**.

- `OnboardingSchema` gains `brain: 'none' | null` (null default). Step 4 is done when any brain exists, or `brain === 'none'` (Skip on its page), or the tracker is `'none'` (no project, no brain; the card says "Needs a connected project"). It is never the reason the page reopens: `firstScreen` is unchanged (a repo or a dismissal ends the page), and `nextStep` after step 3 goes to step 4 only if it is todo.
- The migration (`onboardingMigration.ts`) does not touch `brain`; an install that already dismissed Get started never sees step 4 except via Settings › About › Get started.

### Card and page texts (replacing the stale ones)

- Intro: "A task is a git worktree with its own agent tabs, tied to a work item, with the AI cost and time it took. A few short steps and your sprint is on this page."
- 1 · Agents (unchanged logic). The Agents table's cost column for OpenCode: "Per task, from its database" (it is attributed per task by the ledger). Below the table, one line naming the brain's agent: "Brains run on Claude Code or OpenCode, whichever you pick per brain."
- 2 · Connect Azure DevOps: "Shellie reads your sprint, moves the work item when a task starts and opens draft pull requests. GitHub later." Done text: "Connected to org/project, …". The Connect page intro: "Each project you tick becomes a project in Shellie with its own page and settings; add more later in Settings › Projects." The footer: "Writing time back to work items stays off until you turn it on per project." PAT scopes add **Wiki (Read)** (the brain's wiki picker and mirror) with "Wiki (Read) is only needed for a brain."
- 3 · Add a repository (unchanged).
- 4 · A brain for your project: todo text "A local wiki of the project's documents, kept by your agent, that every task can read. Optional." with the agent it will use ("Runs on Claude Code" / "Runs on OpenCode" / "Needs Claude Code or OpenCode"). Done text: "<brain name> on <agent>." or "Skipped." Button "Create brain…".
- "What you get": "Start on a sprint item → worktree, branch, setup, agent tabs"; "Claude Code, OpenCode and Copilot cost per task, priced in EUR"; "A brain per project: your documents and wiki, kept as pages your agent reads"; "Time, changes review, Docs, draft PR at Finish".
- The skip line: "Nothing here is required. Skip to Home and Shellie works with a shell alone; every step is in Settings later."

### The brain step's page

A page like AgentsScreen (`kind: 'brain-new'`, `from: 'get-started'`), with the StepStrip (now four steps), Back, Skip for now, and the existing `CreateBrainForm` for the first connection (a project select above it when there are several connections; default the first). On create, it continues to `nextStep` (Home when all done). The form gains the Agent choice (Part A) and shows the found agents. Creating a brain does what it does today and nothing more.

### Telemetry

`onboarding.step` gains `step: 'brain'`; `brain.created` gains `agent` (`claude`/`opencode`); `settings.brain` events for agent/model changes carry the field name only. `docs/telemetry.md` updated.

## Verification expected

- Unit tests for the parser, the command builder, templates v7 (permission order, command files), the runner choosing the agent, the terminal args, the OpenCode lessons digest, the attribution test, onboarding state with four steps, the screens' texts.
- A live check with the real `opencode` on a free model (`opencode/big-pickle`), GUI-free like the earlier brain checks: scaffold a v7 brain in a temp folder, add a pasted note, run a capture and lint through `BrainJobRunner` with the OpenCode agent, confirm a wiki page, a `Brain: capture` commit, no change under `sources/`, and the ledger attributing the run to the brain. No Claude run in this check (no cost).
- `npm test`, `npm run typecheck`, `npm run lint` green; CI green on macOS and Windows.

## Left to the builder

Component structure, exact file split, how the OpenCode model list is cached, the wording of error messages within the rules above, and whether `Platform.opencodeCommand` takes a prompt parameter or the args carry `--prompt`.
