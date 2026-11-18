# apm installs only for the agents a task opens

Issue #327, branch `agent/issues/327-using-opencode-as-agent-but-apm-is-targe`.

A task that opened only OpenCode still ran `apm install --target claude` first, then `--target opencode`.
The repo's Agent packages setting was a chosen list (`apm: [claude, opencode]` in `.shellie.yml`), and setup
used that list as it was, without looking at the task's tabs.

A chosen list is now narrowed to the harnesses of the tabs the task opens (`apmTargetsOfList` in
`src/shared/agents.ts`, used by `buildPlan` in `src/main/ipc/handlers.ts`): an OpenCode-only task installs
for opencode only, a task with Claude and OpenCode tabs gets both, and a harness the list leaves out is still
skipped. A task with no agent tab (shell only) keeps the whole list, so a chosen list still works there.
The "This task will..." summary uses the same rule (`setupAgents` in `src/shared/setupSummary.ts`), so its
Setup line matches what runs. The Settings help for Agent packages says a chosen list is limited to the
harnesses the task opens.

Unchanged: Automatic mode, `apm: false`, and the narrowing to apm.yml's own `targets` (#135). No telemetry
events change.

Tests: `handlers.part1.test.ts` (OpenCode only, both tabs, shell only with a chosen list) and
`setupSummary.test.ts` (the summary shows the narrowed list).

Not verified: the running app and Windows (tested through Vitest on macOS only). The "brain not refreshed:
timed out" line in the issue's screenshot is a separate matter and not part of this change.
