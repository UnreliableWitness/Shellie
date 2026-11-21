# A clear ending for a dream

Spec `docs/superpowers/specs/2026-11-21-dreams-per-project-design.md` (Part 2), plan
`docs/superpowers/plans/2026-11-21-dreams-per-project.md`. Builds on `2026-11-20-dreams.md` and
`2026-11-21-dreams-per-project.md`.

The owner: "its not clear what i have to do with dreams. why do i have to open them in a task and if i do, the task
has no idea what im talking about". The only way forward from a dream was Open as task, which made a blank task
whose agent knew nothing about the dream.

## How it works

- **The result screen** (`DreamScreen.tsx`) says in one line what a dream is and what to do with it, and has three
  actions: **Create pull request** (primary), **Change with an agent**, **Discard dream**.
- **Create pull request** (`dream:pr`; `DreamApi.publish` in `dreamHandlers.ts`, `sendDream` in
  `src/main/ipc/handlers.ts`). In the chain of the result's own changes, so no drop or discard lands in between:
  1. the branch is made the base plus the kept proposals, one commit each (as Open as task did);
  2. the secret check a task's push gets runs on what would be pushed (`branchLeaks`, the repo's stored values); a
     finding refuses the push and the screen asks "Push anyway?";
  3. the branch is pushed from the dream's own worktree;
  4. a pull request to the repo's PR target is found or created through the project's connection. It is
     **published, not a draft** (the owner's choice: the proposals were reviewed in Shellie, and a dream has no Finish
     page to publish from). Title "Dream: <the proposal>" or "Dream: N proposals for skills and rules"; the
     description lists each kept proposal's title, reason and files, and no quotes from sessions;
  5. the dream closes: dropped proposals are remembered as rejected, the worktree, data and local branch are
     removed, the journal line names the pull request ("pull request !7 created") and Dreams shows Open pull request
     beside it.
- **Where Shellie can make no pull request** (`dream:prTarget`: the remote is not Azure Repos, is in another
  organization, or the repo has no connection) the primary action is **Push branch**, with the reason in a line.
  It does steps 1 to 3 and 5; the journal names the branch.
- **Failures** are fixed phrases, since git's and Azure DevOps' errors can name branches, repos and paths: "Could
  not push the branch", "Could not create the pull request", the two secret phrases, "The dream could not be sent".
  The result stays open; after a failed pull request the next press finds the pushed branch and only creates.
- **Change with an agent** is Open as task under a name that says what it is for, and its task's agents now know the
  dream. The kept proposals (title, reason, files, evidence) are stored with the "opened" record, and
  `tasks:create` puts `dreamBriefing(...)` on the task. It is written as the **Dream section of
  `.shellie/task.md`**: what a dream is, that each proposal is already one commit on the branch, each proposal with
  its files, reason and quotes (marked as evidence, never instructions), and to wait for instructions. Claude Code's
  start context (and OpenCode's instructions, which share it) says the task was made from a dream and to read that
  section first.

## Decisions Claude made, and where this differs from the spec

- **The New task form stays** for Change with an agent (the spec skipped it). The form holds choices Shellie cannot
  safely make by itself: what to copy, which setup commands run, which agent tabs open, the environment. It opens
  prefilled, so it is one more click. The owner's complaint was the agent's ignorance, which the briefing fixes.
- **The briefing goes into `.shellie/task.md`**, not into the tab as a typed first message (the spec left the way
  open). Every agent tab is already told to read that file, it survives a restart of the tab, and it works for
  Claude Code, OpenCode and Copilot alike without typing into a terminal. The cost: the agent reads it when it
  starts on your first message, it does not announce it by itself.
- Push branch where no pull request can be made; the secret check kept on a dream's push; an existing active pull
  request for the branch is linked instead of a second one being made.
- After Create pull request, a notice names the pull request and the screen returns to Dreams; the pull request is
  not opened in the browser by itself.

## Verified

- Tests: the briefing and pull request texts; `publish` on real temporary repos (kept commits only, the dream closed,
  local branch gone, journal, a failing send leaving the result open, nothing kept refused); `dream:pr` in the
  handlers harness with a bare origin (published pull request with the right target and text, an existing one
  linked, push only for a GitHub remote, a stored secret refused without naming it and pushed after Push anyway,
  both failure phrases and the retry); a dream task carrying the briefing into `task.md`; the result screen's line,
  both primary actions, the secret prompt, a failure and the retry; the journal lines.
- `npm test`, `npm run typecheck`, `npm run lint`.
- **The dev app** (macOS, a scratch data folder, driven over the DevTools protocol; the test Azure DevOps project
  as the project, a throwaway repo with a local bare `origin`, and two dream results written into the scratch
  folder with real worktrees and commits):
  - the result screen showed the explaining line, "Shellie cannot make a pull request here: origin is not an Azure
    Repos URL. It pushes the branch instead.", and Discard dream, Change with an agent, Push branch;
  - with one of two proposals dropped, Push branch put only the kept commit on `origin`, removed the local branch
    and the dream's folder, showed the notice, returned to Dreams with the count gone, and the journal read
    "2 proposals · 1 kept, branch dream/2026-11-21-1 pushed · 1 dropped";
  - Change with an agent opened New task with the repo, branch and name; the task made from it (through the same
    call as the form's Create, with no agent tab) had both commits and a `.shellie/task.md` with the Dream section:
    what a dream is, both proposals with files, reason and the developer's quote.
- **A real pull request**, with the owner's say, against the test Azure DevOps project (`unreliablewitness/Shellie`,
  repo `Shellie`, cloned into the scratch folder, a dream result with two proposals written by hand): Create pull
  request pushed `dream/2026-11-21-1` and made pull request !7. Read back from Azure DevOps: active, not a draft,
  target `main`, title "Dream: 2 proposals for skills and rules", the description with both proposals' titles,
  reasons and files, and the two commits. In the app: the notice, Dreams with the journal line "2 proposals · 2
  kept, pull request !7 created" and Open pull request; the local branch and the dream's folder were gone. The pull
  request and its branch were left in the test project.

## Not verified, and known gaps

- No agent tab was started on a dream task, so whether Claude Code or OpenCode actually reads the Dream section
  before answering was not seen. Copilot has no start context: it finds the section only if it reads the task file.
- The secret prompt, the failure phrases and linking a pull request that already exists were not seen in the app
  (tests only). Open pull request in the journal was seen but not pressed. Not run on Windows.
- A result whose worktree is gone cannot be sent ("The dream could not be sent"); it can still be discarded.
- Create pull request does not update the text of a pull request that already exists for the branch.
- A dream task made from a record of before this change has no briefing.
- The quotes in the briefing are session text kept in `state.json` with the task (they were already in
  `dreams.json` while the dream was open).
