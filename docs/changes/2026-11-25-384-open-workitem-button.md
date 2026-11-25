# Open the work item from the task's row

Date: 2026-11-25. Issue #384, branch `agent/issues/384-open-devops-pbi-should-be-a-button-next`.

Opening a task's PBI in Azure DevOps took the command palette (`task.workItem`). The developer wanted it one click
away, next to Finish and Discard.

## What changed

- **An Open button before Finish.** The current task's row in the nav, and the rail's fly-out, now start their
  actions with an open-in-browser icon named `Open <id> in Azure DevOps`. It calls `shell:openExternal` with the work
  item's URL through `tryInvoke`, as the palette command does, so a failure shows as a notice.
- **Only where Finish and Discard show.** It sits in the same `.navrow-actions`, so it shows for the current ready
  task, and is hidden for a task without a work item or without a URL. The row keeps its height; the mark already
  steps aside for the actions there.
- The palette command is unchanged. No telemetry change.

## Not verified

- Not run in the app; only the unit tests in `TaskNav.test.tsx`. Not checked on Windows (CI runs the tests there).
- With three icons the current row's title is a little shorter on a narrow nav.
