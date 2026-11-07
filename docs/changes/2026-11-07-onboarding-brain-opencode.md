# Onboarding up to date, and the brain on Claude Code or OpenCode

Spec: `docs/superpowers/specs/2026-11-07-onboarding-brain-opencode-design.md`; plan: `docs/superpowers/plans/2026-11-07-onboarding-brain-opencode.md`. Follows `2026-10-22-onboarding.md` (the Get started page) and the brain notes (`2026-11-04-brain-*.md`, `2026-11-07-brain-picture-coverage.md`).

## What changed

### The brain runs on OpenCode as well as Claude Code

- **An agent per brain** (`src/shared/brain.ts`). `BrainOptions.agent` is `'claude' | 'opencode'` and defaults to `'claude'`, so an existing brain behaves as before. `BrainOptions.opencodeModel` is `provider/model`, or null for OpenCode's own default. The Claude model (`model`: haiku, sonnet or opus) stays as it was. `opencodeReady(b)` is `templatesVersion >= 7`, and `picturesReady` stays at 6.
- **Skills v7** (`templates.ts`, `TEMPLATES_VERSION = 7`).
  - `opencode.json` holds the same intent as `.claude/settings.json`. `edit` is `"*": "allow"`, then `"sources/**": "deny"`, then `"brain/pictures-dropped.json": "deny"`. That order matters, because OpenCode applies the last matching rule. `bash` allows only the read-only git commands, and `webfetch` is denied.
  - Each skill gets a `.opencode/command/<kind>.md` command, generated from the same list as the skills. The command reads "Load the `<kind>` skill and follow it exactly. The argument is: $ARGUMENTS", and `ask` adds "Read only".
  - `.gitignore` lists the files OpenCode writes under `.opencode/`.
  - The wording no longer assumes Claude: "the agent", and "your file-reading tool".
  - Every `SKILL.md` now starts its frontmatter with `name: <kind>`. Without it, OpenCode 1.19.3 does not load the skill at all (found in the live check, below). Claude Code reads the same field.
  - Existing brains get the new files through Settings › Project › Brains › Update skills. The diff is shown first, as before.
- **Headless jobs** (`jobs.ts`). For an OpenCode job, `BrainJobRunner` runs `opencode run --command <kind> --format json --title "Shellie brain job: <kind>" [-m <model>]` in the brain folder.
  - The job's argument goes on stdin, and stdin is then closed.
  - `OPENCODE_CONFIG_CONTENT` is set to the brain's own permission block. It replaces any inherited value, so a developer's inline config cannot loosen the `sources/` deny.
  - `opencodeResultWithSession` (`opencodeResult.ts`) reads the JSON events. The result is the text of the last step, or of the newest step with text. The session is the first `sessionID`. An `error` event becomes "OpenCode stopped (…)".
  - Lock, queue, timeout, cap and commits are shared with Claude jobs.
  - `job.agent` records the agent the job ran on. It is set again when the job starts, so a job queued before the brain switched agents runs on the new one.
  - Jobs of an OpenCode brain whose skills are older than v7 are held: no run and no timer. Health says "Update skills to run on OpenCode", and Update skills or an agent change releases them.
- **The brain terminal, Ask, Resolve and Continue** (`brainTerminal.ts`).
  - The terminal runs the brain's agent. On OpenCode it opens with `--session <id>`, or as a new session with `-m` and `--prompt`. It never uses `--continue`, because the jobs run in the same folder.
  - OpenCode makes its own session id. Shellie records when it spawned the terminal and later looks up the earliest top-level session in the brain folder (as given and real path) created after that spawn. The lookup leaves out job sessions (by the title marker, the jobs' ids and the captured sessions).
  - Ask on OpenCode sends plain text ("Load the ask skill …"), because a `/` message is not reliably run as a command.
  - Continue on a job that ran on the other agent opens that agent's terminal.
- **Task tabs.**
  - An OpenCode tab of a task with a brain gets, through `OPENCODE_CONFIG_CONTENT`, `external_directory: {"<brain>/**": "allow"}` and an `edit` deny for the brain. This is the counterpart of Claude's `--add-dir`.
  - The deny names the brain **relative to the tab's folder** (as given and real), for example `../../brain/**`. OpenCode matches `edit` patterns against the path from the project's worktree, so the absolute `<brain>/**` deny the spec named never matched (live check below). The spec's fallback, dropping the edit rule, was not needed.
  - The option is labelled "Give the task's agent read access to the brain folder". Its stored name is still `addDirForClaude`.
  - Lessons at Finish also read the task's OpenCode sessions from OpenCode's database (Developer and Agent turns, brain jobs left out). If that read fails, the error is logged and the Claude lessons still go in.
- **Settings › Project › Brains** (`BrainsSection.tsx`).
  - Create picks the agent `agents:detect` found: Claude Code first, then OpenCode. If neither is found, a note says so.
  - The card has an Agent select and the agent's Model control. For OpenCode, the model list comes from `agents:opencodeModels` (`opencode models`, no LLM call). A successful list is cached for the app session, and parallel callers share one run. A failed run is tried again on the next call. If the list cannot be read, the card shows a text field instead.
  - The card says "Update skills first" when the skills are too old for OpenCode.
- **Copy.** "never reached Claude" is now "never reached the agent", and "formats Claude cannot view" is now "formats the agent cannot view". Health's Open source button keys on a finding code, not on those words.
- **Cost.** OpenCode usage in a brain folder is attributed to the brain by cwd and is never billable (pinned by a test in `attribute.test.ts`). It counts toward the brain's daily cap.

### Get started

- **Four steps:** 1 · Agents, 2 · Connect Azure DevOps, 3 · Add a repository, 4 · A brain for your project (optional).
  - `OnboardingSchema.brain` is `'none' | null`. Step 4 is done when any brain exists, when it was skipped, or when the tracker is `none`; in that last case the card reads "Needs a connected project." and offers Connect.
  - Step 4 never reopens the page. The Home band can show again for installs that finished steps 1 to 3 but never dismissed it, and Dismiss ends it.
- **The brain page** (`BrainNewScreen.tsx`, `brain-new`) has the StepStrip, Back, Skip for now, and a "Create it for" project select when there are several connections. Below that is the same `CreateBrainForm` as Settings, with the agent choice. With no connection, the page offers Connect. Creating a brain does what it did before, and nothing more.
- **Texts brought up to date.**
  - The intro, and the Agents step: the OpenCode cost column reads "Per task, from its database", plus a line saying a brain runs on the agent you pick.
  - The Connect step: what Shellie does in Azure DevOps (it reads the sprint, moves the work item, opens draft pull requests), that each ticked project gets its own page, that writing time back stays off until turned on per project, and Wiki (Read) in the PAT scopes, "only needed for a brain".
  - The brain card: "Runs on Claude Code", "Runs on OpenCode" or "Needs Claude Code or OpenCode", and "<name> on <agent>." once a brain exists.
  - "What you get", and the skip line.
- **Telemetry.** `onboarding.step` gains `brain`. `brain.created` gains `agent`. `settings.brain` gains `field` for agent and model changes. `docs/telemetry.md` is updated.

## Verified

- `npm test`: 331 files passed (1 skipped), 4022 tests passed, 31 skipped.
- `npm run typecheck`: clean.
- `npm run lint`: 0 errors and 13 warnings, all already on `main` or in code this change did not write. Formatting is clean.
- Unit tests cover:
  - the parser, the job args and env, the runner choosing the agent and holding;
  - templates v7: permission order, command files, skill names;
  - the terminal args and session lookup, and the OpenCode lessons digest (including a failed database read);
  - the task tab's relative edit deny, and the shared `opencode models` run;
  - the attribution test, onboarding state with four steps, and the screens' texts.

The live check ran GUI-free in temporary vitest files (deleted, never committed). It used the real `opencode` 1.19.3, only on the free model `opencode/big-pickle`, with no Claude run. The modules were the real ones: `scaffoldBrain`, `addSource`, and `BrainJobRunner` with `runWithInput` and `createPlatform()`. The parent environment carried `OPENCODE_CONFIG_CONTENT={"permission":{"edit":"allow"}}`.

- **First run: the bug.** The capture ended done in 38 s, but OpenCode had not listed the skill. The model found `.claude/skills/capture/SKILL.md` by globbing. The lint then failed with "OpenCode gave no result": it could not find its skill, searched `~/.claude/skills`, was refused, and stopped on a tool step.
  - `opencode debug skill` showed the cause. A `SKILL.md` without `name:` in its frontmatter is not loaded; the same file with `name: greet` is.
- **After the fix**, in a fresh v7 brain:
  - `opencode debug skill` lists all eight brain skills, and each job's first tool call was `skill {"name":"capture"}` or `skill {"name":"lint"}`.
  - A pasted note went in through `addSource`. The capture finished in 30 s and wrote `wiki/component-order-service.md`, with every fact cited to the source. The lint, queued automatically, finished in 28 s with no findings.
  - The commits were `Brain created`, `Brain: add source …`, `Brain: capture sources/2026-11-07-order-service-notes.md` and `Brain: lint`. `git log -- sources` shows only Shellie's add-source commit, and `git status --porcelain` was empty, both for `sources` and overall.
  - `state.captured["sources/2026-11-07-order-service-notes.md"].sessionId` is `ses_e47e4cc8…`.
  - Shell commands other than the allowed git ones were refused (`ls -la`), and `git log` was allowed.
- **Ledger.** `OpenCodeReader` over OpenCode's database gave 19 assistant messages for the two job sessions (41,155 input and 3,110 output tokens, cost 0). `attribute()`, with a context holding the brain, gave every one `{ level: 'brain', brainId: 'b1', … }`, and `isBrainRecord` was true, so none is billable.
- **Shielding.** In the brain, with the job env and the parent's edit allow, `opencode run` was asked to append to `sources/<file>.md`. The edit was refused: the rules OpenCode reported were `edit *: allow`, `edit sources/**: deny`, and the parent's value was gone. The file was unchanged.
- **Task tab.** The check used a temporary repo with a linked git worktree (`git worktree add`), as Shellie makes them.
  - With the spec's absolute `edit: {"<brain>/**": "deny"}`, OpenCode **wrote** `<brain>/wiki/x.md` (not refused).
  - With the pattern relative to the worktree (`../../live-brain-…/acme-brain/**`), the write was refused, both from a plain repo and from the linked worktree.
  - With the config built by the final `opencodeConfigContent(undefined, null, undefined, [], brainDir, folderPaths(worktree))`, the write was refused ("The user has specified a rule which prevents you…"), and reading `<brain>/index.md` worked (it quoted `# Acme brain`).

## Known gaps

- `design/mockups/onboarding/` shows the original three-step design and is older than the screens. The Get started art (`assets/ART.md`) is still pending.
- Brain jobs on OpenCode still load the user's global OpenCode config, MCP servers and plugins. Only the inline config is replaced. This was accepted in the spec.
- The daily cap reads the ledger, which reads OpenCode's database every 30 s, so a job may finish before its tokens count. This is the same lag as Claude transcripts.
- Windows is untested except in CI.
  - The relative edit deny is written with forward slashes. A brain on another drive gets an absolute pattern, which may not match.
  - A missing `opencode` may read "OpenCode stopped (…)" rather than "not found".
- The task tab's relative deny assumes OpenCode's worktree is the tab's folder, which holds for Shellie's tabs. It is computed when the tab is spawned, so a brain moved while the tab runs keeps the old path until the tab restarts.
- Not run live: the OpenCode brain terminal (TUI), its session lookup, Ask, Resolve, Continue, and lessons at Finish from a real OpenCode session. These are covered by unit tests only.
- The onboarding screens were checked by tests, not in the running app.
- Parked from the reviews:
  - a Claude session can be lost after a Continue round trip through an OpenCode job;
  - a session the person starts by hand in the brain folder, after the terminal spawned and before its first message, could be picked as the terminal's;
  - untitled job sessions from before this change are excluded only by id;
  - the held flag can stay set after `dropQueued` (a cosmetic Health line);
  - `opencodeFailure` keys on the "OpenCode stopped" prefix;
  - the create form has no model control (set it on the card afterwards), and the select flickers briefly while loading;
  - one brain in any project counts the brain step as done;
  - there is no test for `useActiveBrains` dropping archived brains, for an onboarding object without `brain`, or for Skipped without a connection;
  - the warning for a non-JSON developer `OPENCODE_CONFIG_CONTENT` in `main.ts`, which now also fires when only the brain's access is lost, has no unit test;
  - the Claude-tab `brainDir` assertion may pass vacuously.
