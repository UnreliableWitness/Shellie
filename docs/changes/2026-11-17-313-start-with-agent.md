# Start a task with another agent

Issue #313, branch `agent/issues/313-on-starting-a-task-a-user-should-be-able`.

Start on the sprint (and in Up next on Home) created the task with the agents ticked in Settings > Terminals and agents, with no way to pick another one. The task then had only the default agent's tab, and because main derives the `apm install --target` list from the tabs (`apmTargetsFor`), apm installed nothing for an agent opened later, so its skills were missing.

## What changed

- `startTaskFor` takes an optional agent (claude, copilot or opencode). With one, the task opens only that agent; the shell tab stays as Settings has it. Without one, nothing changes.
- `StartAgentMenu`: a chevron next to Start opens a "Start with" menu of the agents `agents:detect` found (every agent when none is found), the ones ticked in Settings marked "(default)". Picking one starts the task with it. Used by the sprint rows and Up next on Home.
- No chevron when Start opens New task to pick a repo (several repos on the project), since New task has its own tick boxes, nor when no repo is linked.
- apm installs for the chosen agent with no main-process change: the target follows the tabs. The repo's `apm.yml` `targets:` and `.shellie.yml` `apm:` still narrow the targets (#135).
- No telemetry change.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests: `startTask.test.ts` (an agent replaces the Settings agents, the shell stays), `SprintScreen.test.tsx` (the menu lists the detected agents with the default marked, OpenCode starts an OpenCode task, the row does not open Azure DevOps), `TasksBand.test.tsx` (Up next's menu starts with Copilot).

## Known gaps

- Not run in the app or on Windows; the change is renderer-only.
- Adding an agent tab to an existing task still runs no `apm install`.
- No per-repo default agent.
