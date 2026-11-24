# Reopen with a chosen agent

Date: 2026-11-24. Asked by the owner in a session: Reopen should offer the agent the way Start on the Sprint page
does (#313).

## What changed

Reopen on a finished task's page is now a split button, the same one as Start on the Sprint page: the button
itself reopens the task as before, with the tabs it had, and the chevron next to it lists the installed agents.
Picking one reopens the task with that agent as its only agent:

- the task's shell and other tabs come back as they were;
- tabs of the picked agent the task already had stay, so their sessions resume;
- tabs of the other agents are not brought back;
- when the task had no tab of the picked agent, a new one takes the place of its first agent tab.

## How it works

- `tasks:reopen` takes an optional agent. `tabsWithAgent` in `src/shared/terminals.ts` (pure) makes the tab list.
- A reopen with kept worktrees applies it at once. A reopen that makes a worktree again stores the choice on the
  task (`reopenAgent`) until its setup ends, so the setup's apm step installs for that agent and the tabs it opens
  are that agent's; it is cleared when the reopen ends, done or failed.
- `StartAgentMenu` got a `verb` (the hint and the menu's name say Reopen) and `markDefaults`: on Reopen no agent
  is marked "(default)", since the plain button brings back the task's own tabs, not the ones ticked in Settings.

## Verified

- `npm test`, `npm run typecheck`, `npm run lint` pass; tests cover the tab list, both reopen paths, an unknown
  agent and the menu on the Done page.
- In the running app on macOS (test data folder): a task with only a shell tab was finished with its worktree
  kept, the menu listed the three agents in dark and light, and picking OpenCode reopened it with an OpenCode tab
  and its shell.

## Known gaps

- Not seen in the running app: a reopen that makes the worktree again with a chosen agent (covered by a test), a
  task that had several agents, and Windows.
- Reopening with another agent starts that agent fresh: the earlier agent's conversation is not carried over, and
  its tabs are gone from the task (the sessions themselves stay on disk).
- The menu does not show which agent the task had.
