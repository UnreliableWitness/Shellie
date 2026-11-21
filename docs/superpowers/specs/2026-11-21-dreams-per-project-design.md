# Dreams per project, and a clear ending for a dream

Date 2026-11-21. Builds on `docs/superpowers/specs/2026-11-20-dreams-design.md` and
`docs/changes/2026-11-20-dreams.md` (Dreams as shipped), and on `docs/changes/2026-11-05-project-scope.md` (a project
is an Azure DevOps connection with its own page and settings).

## Why

The owner, one day after Dreams shipped:

- "the dreaming function should completely be scoped to project", because the mixed version is confusing: one setup
  and one list hold every project's repos.
- "its not clear what i have to do with dreams. why do i have to open them in a task and if i do, the task has no idea
  what im talking about": the only way forward from a result is Open as task, which makes a blank task whose agent
  knows nothing about the dream.

## Goals

1. Everything about dreaming belongs to one project: its setup, its limit, its results, its journal, its notices.
   While a project is active, nothing of another project's dreams shows or counts.
2. A dream result has one obvious ending that needs no task: a pull request with the kept proposals.
3. When the owner does want an agent to change the proposals, that agent starts out knowing the dream.

## Non-goals

- More than one dream at a time on the machine.
- Changes to how a dream runs, what it reads, the evidence check, or the prompts.
- A project-level view over several projects' dreams.

## Anti-goals

- A project's dream material, usage or notices showing up in another project.
- A setup split over User and Project settings.
- Switching dreaming on for a project by migration when the owner had no repo of it switched on.

## Approaches considered (scope)

- **A. Everything per project (chosen by the owner).** Each project has its own switch, model, tested model, daily
  limit, idle minutes and repos; every screen follows the active project. Costs: the one model licence gets a limit
  per project, so a day's total is the sum of the projects' limits.
- B. Model and limit shared under User, switch and repos per project. Matches the single licence, but splits the
  setup over two places.
- C. Screens only: one setup, lists filtered by project. Smallest, but the setup still mixes repos.

## Part 1: dreaming per project

### Settings

- The app settings hold one dreaming block per project, keyed by connection id; each block has today's fields
  (`enabled`, `model`, `testedModel`, `limit`, `repos`, `idleMinutes`). A block may only name repos of its project.
- A project without a block is off and not set up.
- The rule "only switch-on with a tested model, a limit, a repo and the owner's tick sets `enabled`" holds per
  project, as do held widenings and immediate narrowings. `SettingsStore` keeps one single writer for dreaming.
- **Migration** (on reading an old settings file): the old block is copied to every project that has at least one of
  its repos in the block's `repos`, each copy keeping only that project's repos. A copy is `enabled` only when the
  old block was enabled and the copy still has a repo that is on with a folder. Other projects get no block. The
  limit is copied as it is (so the day's total can now be higher than before; the change note says so).
- A repo with no project does not dream (Claude's call): its entry is dropped by the migration and it is not offered
  in any setup. Its open result or "opened" branch, if any, stays listed in every project's Dreams screen until
  reviewed, the way tasks without a connection show in every project.
- A repo moved to another project leaves the old project's block (a narrowing) and is off in the new one.
- Removing a project removes its block, after the existing per-repo cleanup.

### Where it shows

- Settings: the Dreaming section moves from User to Project (Settings › Project › Dreaming) and shows the picked
  project's setup. Nothing about dreaming stays under User.
- The setup screen (Let Shellie dream), the Dreams screen with its journal, the Dreams navigation item and its
  count, the Home "While you were away" band, the switched-off notice and the status line at the foot of the
  sidebar all show the active project only. With no project (fresh install) Dreams is not offered.
- When a dream of another project is running, the active project shows only "Another project is dreaming" as the
  reason it waits; no repo name, step or Stop.
- A dream result screen opened for a repo of another project (a stale link) goes to the Dreams screen.

### Running

- One dream at a time. Each minute the scheduler looks at every project that is on and ready (its own idle minutes,
  its own model in OpenCode's list, room under its own limit, a repo with new material and no open result) and
  starts the one whose last dream is longest ago; a project that never dreamt goes first.
- Dream now acts for the active project and is refused while any dream runs.
- **Limit and usage per project.** A dream session's tokens count toward the project of the repo it dreamt for. The
  setup's model test counts toward the project it was run for. Sessions that cannot be tied to a project (older
  ones, a repo since removed) count toward none.
- **Wrong model.** When another model answers, the dream is thrown away as today, and every project whose chosen
  model is that same model is switched off with its passed test cleared, each with its own notice (Claude's call:
  the fault is the model's, and it would otherwise spend unasked in the next project). Other projects go on.
- Back-off after failures, sightings, rejections and results stay per repo, as stored today; only the switched-off
  notice changes shape (Part 2 lists it).

### IPC and telemetry

- Dream calls that are about a setup or a view take the project (connection id); calls about one repo's result keep
  their repo id. `dream:changed` stays one broadcast.
- Telemetry events keep their names and props; no project or repo name is sent.

## Part 2: what to do with a dream

### The result screen

- A line under the title says what this is and what to do: "Shellie proposes these changes to this repo's skills and
  rules, from your past sessions. Drop what you don't want, then create a pull request."
- Three actions, in this order of weight:
  1. **Create pull request** (primary). Pushes the dream branch with the kept proposals and opens a pull request to
     the repo's PR target through the project's connection. Title: "Dream: N proposals for skills and rules" (or the
     proposal's title when there is one). Description: each kept proposal's title, files and reason; no session
     quotes. The dream then closes: dropped proposals are remembered as rejected, the worktree, data and local branch
     are removed, and the journal line names the pull request and links to it.
  2. **Change with an agent** (secondary; replaces Open as task). Makes a task named "Dream <date>" on the dream
     branch at once, without the New task form. The task's first agent tab gets a briefing as its first message:
     that these commits are a dream's proposals, and per kept proposal its title, files, reason and evidence quotes
     with who said them and in which task. The briefing ends by asking the agent to wait for instructions. From
     there the task is a normal task, finished the normal way.
  3. **Discard dream**, as today.
- A failed push or pull request leaves the result open and shows a fixed phrase ("Could not push the branch",
  "Could not create the pull request"). When the push worked and the pull request did not, a second press only
  creates the pull request.
- **Secret check.** The push goes through the same secret-leak check as a task's push, in a form that needs no
  task. A finding stops the push and shows on the result screen with the same choice as today (look at it, or push
  anyway after a confirm).
- **When Shellie cannot make the pull request** (the repo's remote is not Azure Repos, it is in another
  organization, or the repo has no project): the primary action is **Push branch** instead, with the reason in a
  line beside it. It pushes the kept proposals, closes the dream the same way, and the journal names the branch.
- **Published, not a draft** (the owner approved Claude's recommendation on 2026-11-21: the proposals were already
  reviewed in Shellie, and a dream has no Finish page to publish from). Pull requests made from tasks stay drafts.
- **Change with an agent** falls back to today's New task form (prefilled, as Open as task does now) when the repo's
  default environment needs a confirm or its first agent tab is not Claude Code or OpenCode.
- The switched-off notice becomes one per project; an old stored notice belongs to its repo's project (to every
  project using that model when it names no repo).
- Telemetry: `dream.result` gets the outcomes `pr` and `pushed`.
- The Home band's card and the Dreams list keep "Review", which opens this screen.
- The "opened as task, task not made yet" state (Make the task, Leave the branch) stays as the recovery path when
  making the task fails or is cancelled.

### Left to the builder

- How the briefing reaches the agent tab (the PR-description feature already writes to an idle agent tab) and where
  its text is kept after the dream's data folder is removed.
- How a dream session is tied to its project for usage (the session's folder lies under `dreams/<repoId>/`).
- The exact shape of the stored settings and of the changed IPC calls.

## Delivery

Two pull requests, each releasable alone: Part 1, then Part 2. Each adds its own note in `docs/changes/` and keeps
`docs/telemetry.md` in step.

## Verification wanted

- Tests for the migration (one project, two projects, a repo without a project, old block off), the scheduler's
  choice between projects, usage per project, the wrong-model switch-off across projects, and each screen with two
  projects.
- The dev app with two projects (fake OpenCode): setup in one leaves the other off; a result of one is absent in the
  other; a pull request created from a result against the test Azure DevOps project; Change with an agent with the
  briefing arriving in the tab.

## Claude's calls, not asked

- Repos without a project stop dreaming.
- A wrong model switches off every project that uses that model.
- The scheduler's order between projects (longest since last dream).
- The limit is copied to each project, not divided.
- The pull request description leaves out session quotes; the local dream branch is removed after the push.
- Change with an agent skips the New task form.
- Push branch as the ending where no pull request can be made; the secret check kept on a dream's push.
