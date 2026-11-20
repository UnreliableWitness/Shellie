# Dreams: project dreams for skills and rules — design

Date: 2026-11-20. Reviewed by a builder check; its five questions were settled by the designer and are marked
*(call, builder check)*. Screens: https://claude.ai/artifact/UpRsPykwKeKdEo2iWdQoLn (design canvas "Shellie Dreams", five
screens; the owner agreed with its direction on 2026-11-20, and sections 1 and 8 follow it). Piece 1 of 4 of "dreaming" (order agreed with the owner: 1 the dream run plus project dreams,
2 testing by replay, 3 brain dreams, 4 rehearsing tomorrow). Lines marked *(owner)* were decided by the owner; lines
marked *(call)* are the designer's and may be overruled.

## Why

The owner has a model licence from their employer (GLM 5.3) that is in effect unlimited and reachable only through
OpenCode. Tokens that are not used for tasks are wasted. The owner wants to spend them on improving their day-to-day:
the skills, rules and agents of each project first, the brains later.

Each project repo has its agent packages (apm) checked in: skills, rules and agents typical for that project *(owner)*.
What the agent sessions of that project teach (the same correction typed in three tasks, a skill the agent never
picked up, two rules that disagree) is lost today when the tab closes. A dream goes back over those sessions while the
machine is idle and proposes changes to the checked-in skills and rules.

Tokens are not the scarce thing here; the owner's attention in the morning is. A dream may spend a lot to hand over
little.

## Goals

- While the machine is idle, by day or by night *(owner)*, Shellie reads a project's past Claude Code and OpenCode task
  sessions and proposes new or better skills, rules and agents in that repo's checked-in sources.
- A dream's result is a local branch in that repo, reviewed per proposal with its evidence, and turned into a normal
  task when the owner wants to go on with it *(owner: approach B, plus "Open as task")*.
- Dreams run only on the agent and model the owner chose for dreaming, and the owner can always see which
  one *(owner)*.
- Switching dreaming on is a deliberate act *(owner)*.
- Spend is limited by a limit the owner chose; "no limit" is a choice, never a default *(owner)*.

## Non-goals (this piece)

- Replaying a past task to test a proposal (piece 2), brain dreams (piece 3), preparing sprint items (piece 4).
- Advice about the owner's way of working across projects, and dreams that span several projects.
- Claude Code or Copilot as the dreaming agent. Dreaming runs on OpenCode only in this piece *(call: the owner's
  licence only works there, and one agent keeps the model rule simple)*. Claude Code sessions are still read.
- The dream pushing a branch or opening a pull request. That happens through a task's Finish, by the owner.
- Sending dream usage to the cost server or attributing it to a work item.

## Anti-goals

- A dream call answered by any model other than the chosen one, including a fallback, OpenCode's default model, a
  helper model for titles or summaries, or a subagent with a model of its own.
- Dreaming that is on without the owner having switched it on: after install, after an update, for a newly added
  repo, or after the agent or model setting changed.
- Spend above the chosen limit by more than what one model call in flight adds.
- A dream touching the owner's main checkout, a task worktree, the remote, or files outside the folders it was
  allowed to change.
- Session text (customer material) going anywhere but the chosen model: no web access, no telemetry, no PR text.
- Dream results piling up unread, or dream sessions showing up as task cost.

## Approaches considered

1. **A dream is a brain job.** Reuses the brain's queue, scheduler, cap and activity list. Rejected: brain jobs work
   in the brain's folder and follow the brain's agent setting; a project dream writes into the project repo under a
   stricter model rule, and a project without a brain could not dream.
2. **A dream is a hidden task** (picked by the owner): a worktree and branch of its own, OpenCode without a terminal
   tab, a small scheduler and a record of its own, results on Home. More to build, but independent of the brain, one
   place for the model rule, and the result is already a branch.
3. **A dream is a visible task** with a live OpenCode tab. Rejected: clutters the task list and opens terminals while
   the owner is away, the area where Windows has stalled before. One part is kept: "Open as task" on a result.

## Design

### 1. Setting up and switching on

Dreaming has a setup screen of its own, **Let Shellie dream** (canvas screen 4), opened from the Dreams screen
(section 8) and from a short **Dreaming** section in Settings (user scope) that only shows the state, the model and
the limit with a link to Dreams. The settings are stored as `dreaming` in the app settings (`AppSettingsSchema`,
`src/shared/usage.ts`):

- `enabled` (default false), `model` (`provider/model` or null), `limit` (null until chosen; then tokens per day,
  euros per day, or none), `repos` (per repo: on, and the folders a dream may change), `idleMinutes` (default 10
  *(call)*).

The screen has four numbered steps on the left and, on the right, a panel **What you are switching on** that is
always in view and changes as the steps are filled in:

1. **The model that dreams.** The agent is a fixed line "OpenCode". The model is picked from the list OpenCode
   reports (`agents:opencodeModels`), never typed. **Test** makes one small call with it and shows "<model> answered"
   or the error. The step counts as done only when a test passed for the current model.
2. **How much it may spend a day.** No preset. Tokens, euros (offered only when the rate table prices that model;
   otherwise the row says why it is not available), or "No limit", which asks for a second confirmation.
3. **When it dreams.** Minutes without keyboard or mouse, with the fixed rules of section 2 as text.
4. **Which repos, and what a dream may change.** Every repo is off. A row shows the folders a dream may change,
   prefilled with the repo's apm source folder when Shellie finds one (`.apm/` *(call; the builder checks apm's
   convention)*), editable by the owner (for example to add `AGENTS.md`). A repo with no folder cannot be ticked.

The panel shows one sentence built from the settings, a tick box, and the switch:

```
Dreams run on OpenCode with zai/glm-5.3, when this machine is idle,
for 2 repos (Portal, Billing), up to 5 million tokens a day.
What was said in those repos' agent sessions is sent to that model.

[ ] I have read this and want dreaming on.
                                              [ Switch on dreaming ]
```

- The switch is available only with a tested model, a limit, at least one repo and the box ticked. The box is never
  ticked for the owner and is empty every time the screen opens.
- Changing the model switches dreaming off until it is tested and confirmed again *(call)*.
- While dreaming is on, a change that widens it (ticking another repo, adding a folder a dream may change, raising
  the limit or choosing "No limit") needs the same sentence, with the new values, and the tick box again. Until it
  is confirmed, dreaming goes on with the old values. A change that narrows it (unticking a repo, removing a folder,
  lowering the limit) applies at once *(call, builder check)*.
- An update never changes `enabled` in either direction. (An earlier sentence in the conversation said "off after
  every update"; with two releases a day that would switch it off twice a day. The rule is: an update never switches
  it **on**.)
- The screens use the wording the app already uses for a repo; "project" in this document means a repo in Shellie.

### 2. When a dream starts

A scheduler in main (`src/main/dreams/`), checked once a minute *(call)*. A dream starts when all hold:

- dreaming is on, and the model is still in OpenCode's list;
- the machine has had no keyboard or mouse input for `idleMinutes` (`powerMonitor.getSystemIdleTime()`, as
  `ActivityTracker` uses it), is not locked out by suspend, and is on mains power *(call)*;
- no task agent tab is `working` (`TabActivity`), so dreams never compete with the owner's own agents for the
  licence *(call)*;
- no other dream is running (one at a time);
- today's limit has room;
- some ticked repo is **ready**: it has material no dream has covered yet (below), and it has no open dream result
  waiting for review *(call: one open result per repo, so results cannot pile up)*. Among ready repos the one that
  dreamt longest ago goes first.

When the owner comes back, a running dream finishes; it only ends early on Stop, the limit, the time limit, suspend
or quit. An interrupted dream removes its worktree and branch and its material counts as not covered.

A dream that **fails** (an OpenCode error, or the time limit) is different from one that was interrupted (Stop, the
day's limit, suspend, quit). After a failure the repo waits before it is ready again: 1 hour, then 6 hours. After
three failures in a row on the same material the repo stops dreaming until there is new material or the owner
presses Dream now; Home shows "Dreams for Portal keep failing: <reason>" with Try again *(call, builder check)*.

**Dream now** (per repo, in Settings and on Home) skips the idle, power and busy checks only. It does not skip the
model rule, the limit, or "one at a time".

### 3. Material

For the repo, Shellie collects the stored tasks (open and finished) that have that repo, and for each the session
turns the same way the lessons flow does (`claudeSessionTurns`, `opencodeSessionTurns`, `sessionDigest`): what the
developer typed and what the agent answered, tool calls left out, bounded per task.

- A dream record (`dreams.json` in the user data folder, via `JsonFileStore`) keeps per repo which task sessions were
  covered and up to which turn time. Material is new when a task has turns after that mark.
- A dream takes at most 20 tasks, newest first *(call)*; the rest wait for the next dream. Less than one task with
  at least one developer turn means the repo is not ready.
- A covered task that got new turns is digested whole again, and the index says which turns are new, so the dream
  has the context but knows what it has seen *(call, builder check)*.
- **What a dream remembers** *(call, builder check)*. The record also keeps, per repo:
  - *sightings*: things a dream noticed only once (a single correction, a single manual walk-through), each with its
    task, date and quoted line, kept for 90 days. The next dream gets them with its material, so a correction seen
    once in each of three dreams does count as repeated;
  - *rejections*: the title and reason of every proposal the owner dropped or discarded. The next dream is told not
    to propose them again unless sessions after the rejection add new evidence, and then it must say so.

  Both hold quoted session text, so they stay in the user data folder like the digests.
- Discarded tasks are gone from the store and are not read. Brain job sessions and dream sessions are never material.
- Shellie writes one digest file per task plus an index (task title, work item id, dates, agents used) into the
  dream's own folder under user data. These files are deleted when the dream is closed (kept, discarded or opened as
  a task).

### 4. The run

1. **Worktree and branch.** `GitClient` directly, not the task setup: fetch, then a worktree on a new local branch
   `dream/<date>-<n>` from the repo's PR target branch as fetched. The worktree lives under the user data folder, not
   in `<repo>.worktrees`, so task scans and leftover cleanup never see it. No setup steps, no `apm install`, no
   terminals, no Task record. Fetch fails (offline) → base on the local target branch.
2. **Propose.** `opencode run --format json --title "Shellie dream: …" -m <model>` in the worktree, prompt on stdin,
   spawned the way brain jobs are (`ptyHost.run`, through `Platform`). The prompt is Shellie's own text, versioned in
   code like the brain's skill templates. It tells the agent to read the index and digests, read the repo's current
   skills, rules and agents, and look for what the sessions show and the sources miss:
   - a correction the developer gave more than once;
   - a skill or rule that exists but was not followed or not picked up;
   - sources that contradict each other or the way the work was actually done;
   - steps the developer walked the agent through by hand more than once.

   It writes at most 3 proposals *(call)*, by editing or adding files in the allowed folders, and a report file in the
   dream's folder (outside the worktree, so it can never be committed): per proposal a title, the reason in two or three sentences, the evidence (task, date and the
   quoted lines), and the files it changed. It also lists its sightings. No proposal is a good answer; it must never invent one.
3. **Check.** A second run with the same model and rules reads the report, the diff and the digests and challenges
   each proposal: is the evidence really in the sessions, does it repeat or contradict an existing source, is the file
   well formed for its kind (frontmatter, name). It changes no source file: it writes a verdict per proposal in the
   report, and Shellie removes the changes of the ones that failed *(call: affordable because tokens are not the
   constraint; verdict only, builder check)*.
4. **Shellie finishes.** It reads the report and the worktree's changes. Any change outside the allowed folders is
   reverted and noted on the result. Changes are committed on the dream branch by Shellie (the agent runs no git), so
   that each proposal can later be dropped on its own; proposals whose files overlap are shown as one. Nothing is
   pushed. No proposals left → worktree and branch are removed and the material is marked covered.

**Permissions for both runs** (inline OpenCode config, as brain jobs do): read the worktree and the dream's folder;
edit only inside the worktree and, for the report, the dream's folder *(call, builder check)*; no shell, no web fetch or search, no MCP servers, no subagents *(call)*. Each run has a
time limit of 30 minutes *(call)*.

### 5. The model rule

- Every run passes `-m <model>` and an inline config that sets every model OpenCode can be told about (including the
  small model it uses for titles and summaries) to the chosen one, and disables subagents. The repo's own
  `opencode.json` and agent files must not be able to bring in another model; the builder verifies this against the
  installed OpenCode and records what was checked.
- Before a run: the model must be in OpenCode's list. If not, no run; Home says "Dreaming is waiting: zai/glm-5.3 is
  not available in OpenCode".
- After a run: Shellie reads the run's session and any child sessions from OpenCode's database and compares the model
  of every assistant message with the chosen one. Any other model → the dream is thrown away (worktree, branch,
  digests), dreaming is switched off, and Home shows "Dreaming switched itself off: a call was answered by <model>
  instead of <chosen>". The material is not marked covered.
- The setup test call uses exactly the same arguments and check.

### 6. The limit

- Dream usage is read from OpenCode's database for sessions with the dream title prefix. Tokens are counted the way
  the ledger counts them; euros with the rate table.
- The day is the local calendar day. Before a run: there must be room. During a run: usage is checked at least every
  30 seconds; at the limit the run is stopped, the dream is treated as interrupted, and dreaming waits until the next
  day. Home shows "Today's limit reached".
- "No limit" skips these checks; the time limit still applies.

### 7. Cost records

- Dream sessions are kept out of task sessions: the dream title prefix joins the session filter in
  `src/main/budget/openCode.ts`, and the ledger gets a level of its own for them (`dream`, by the dream worktree or
  title), so they are never credited to a task, a brain or a repo's work.
- They are kept locally and shown on Home and in Settings (today, this week), and are never sent to the cost server
  *(call, agreed in conversation without objection)*.

### 8. What the owner sees

The design canvas is the reference for layout and copy; this section says what each screen holds.

**Navigation.** A new item **Dreams** (moon icon) under Sprint, with a count of the dream results waiting for
review. It is shown always, also while dreaming is off. The foot of the navigation gets a dream line under the
status line, in every state (canvas screen 5): "Dreams off"; "Dreams on" with the model; "Dreaming about <repo>"
with the model and the minutes; "Dreams on · no limit" in the warning colour. Clicking it opens Dreams; while a
dream runs it opens a small panel with what the dream is doing, the model, today's usage, **Stop this dream** and
a link to Dreams.

**Dreams screen** (canvas screen 2), top to bottom:

- the title with the state (On / Off), **Change setup** and **Switch off** (off: an invitation with **Set up
  dreaming**, and nothing below it but the journal);
- a status strip of four cells: the model ("through OpenCode · every call checked"), today's usage against the
  limit, when a dream starts, and what is happening now (dreaming, waiting until you are away, waiting for a reason
  from section 2, or the limit reached);
- **Waiting for you**: one row per open result with the first proposal's title and **Review**;
- **Repos**: every repo with the folders a dream may change, its state in words (new sessions waiting, nothing
  new since, keeps failing with the reason, not dreaming), and **Dream now** (or **Add** for a repo that is off,
  which opens setup);
- **Journal**: past dreams, newest first: when, repo, outcome in words, tokens. The record keeps the last 100
  dreams *(call)*. The outcome line follows the result to its end ("2 kept, opened as task …, 1 dropped").

**Home** (canvas screen 1). A band **While you were away** at the top, only while a result waits for review. One
card per result with the repo, the proposal titles, where it came from, **Review** and **Not now**. Not now hides
that card on Home; the result stays on Dreams and in the count *(call)*. The band's aside names the model and
today's usage. A dream that found nothing is one quiet line with a link to Dreams. With nothing to review, Home is
as it is today.

The notices: "Dreaming switched itself off: a call … was answered by <model> instead of <chosen>. The dream was
thrown away and nothing was changed." with **Test the model again** (on Home and on Dreams, until dreaming is set
up again); and on Dreams only, "<model> is not available in OpenCode" and "Today's limit reached".

**A dream result** (canvas screen 3), opened with Review:

- a head with the title "What <repo>'s sessions taught", when it was dreamt and from how many sessions, the model,
  the tokens, the branch, "<n> of <m> kept", **Discard dream** and **Open <n> as a task**;
- on the left the proposals, each with its kind (new rule, changed rule, new skill, changed skill, new agent,
  changed agent) and a short line; a dropped one is struck through with **Undo**. Under them, when the dream's own
  check removed ideas, one line saying how many and that they are remembered;
- on the right the chosen proposal as an argument: the claim and the reason, then **Where it comes from** (the
  developer's own words as quotes, each with its task and date; a link when the task still exists), then **What it
  changes** (each file with its added and removed lines, and a way to open it in the app's full diff view), and
  **Drop this proposal**;
- a line "Changes outside the allowed folders were removed: …" when that happened.

- A proposal is kept unless it is dropped; there is no Keep button *(call, builder check)*. **Drop** removes that
  proposal's changes from the branch and can be undone until the result is closed. **Open as task** makes a normal
  task on the dream branch with the proposals that were not dropped (no work item needed; the owner can link one),
  removes the dream worktree, and closes the result; from there it is ordinary work, including Finish and a pull
  request. **Discard dream** removes worktree and branch and records every proposal as rejected. Both delete the
  digests and mark the material covered.
- The builder decides whether "Open as task" moves the worktree or makes a new one on the same branch.

### 9. Telemetry

`dream.enabled` (limit kind, repo count), `dream.run` (outcome: proposed, nothing, interrupted, limit, wrong-model,
failed; ms; proposals; dropped by check), `dream.result` (kept, dropped, outcome: task or discarded). Enums, counts
and booleans only; no model, repo or file names. Listed in `docs/telemetry.md`.

## Constraints

- Windows is the release target: spawning and paths go through `Platform`; no terminal is opened for a dream.
- No new paid service; the only model calls are the ones the owner switched on.
- Session text is customer material: it stays in the user data folder and the chosen model's calls.
- A change note in `docs/changes/` with what was verified and what was not.

## Left to the builder

- Module layout under `src/main/dreams/`, IPC channel names (`dream:*`, with a `dream:changed` event as
  `brain:changed` does), store shape, and the exact prompts.
- How proposals are kept separable on the branch (a commit per proposal or another way).
- The exact OpenCode config keys that pin every model and disable subagents, verified live.
- Where the dream worktree folder sits under user data, with Windows path length in mind.
- A fake `opencode` for tests and the dev check, as the brain's fake `claude`.

## To verify for real (cannot be done unattended)

- A dream on the owner's licence model through OpenCode on Windows: that the model check sees only that model, and
  how good the proposals are.
- apm's source folder in the owner's project repos.

## Changed during the build

Rulings made while building (2026-11-20) that change or add to what the sections above say. The change note
`docs/changes/2026-11-20-dreams.md` has the rest.

- Section 4, permissions: a dream never writes OpenCode's own configuration (`opencode.json`, `opencode.jsonc`,
  anything under `.opencode/`) or anything in a folder named `hooks` (`.apm/hooks/` holds scripts that run by
  themselves). Such paths cannot be chosen as a folder a dream may change, and are reverted after a run. Runs also set
  `OPENCODE_DISABLE_PROJECT_CONFIG=1` and drop inherited `OPENCODE_*` variables; `--pure` is not passed, so the
  owner's global plugins still load.
- Section 4, step 3: the check run is read-only on the worktree, enforced by its permissions and by comparing the
  worktree's changed paths (ignored files included) before and after it; any difference fails the dream with "The
  check run changed files".
- Section 4, step 4: Shellie's dream commits run with hooks off and without signing.
- Section 4 and 8: failure reasons are fixed phrases, never session text, a path or git's own errors.
- Section 4, after a crash: the startup cleanup deletes a `dream/<date>-<n>` branch only when its dream folder still
  exists; a branch without one (a dream opened as a task) is the owner's and stays.
- Section 3: OpenCode turns carry their times, like Claude Code's, so new turns in an OpenCode-only task are new
  material.
- Section 5: a recorded "switched itself off" holds across restarts and is ended only by switching on again.
- Section 1: while a widening change waits for the tick, the panel lists what it adds (a repo, a folder, a higher or
  no limit), since the sentence does not name folders. Every control shows the saved settings or the held change.
- Section 8, a dream result: the changed lines of a proposal come from git (its own hunks, with caps), and the full
  diff gets the two texts of one file on demand.
- Dream ids (`<date>-<n>`) are per repo: two repos dreaming on one day share an id, so every lookup is by repo and id,
  and an id the repo's journal names is never given again.
- Section 8, Home: the "found nothing" line shows only inside the While you were away band, for the newest journal
  line under 24 hours old.
- Section 8, Open as task: a setup failure or cancel of the task never deletes the dream branch, and the task
  remembers its branch already existed.
