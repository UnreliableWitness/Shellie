# A blank task gets its project's brain

Issue #359, branch `agent/issues/359-creating-blank-task-doesnt-select-a-brai`.

A task without a work item in a repo (New task > Blank) got no brain: the New task card said
"Brain: None for this project" although the project had one, and after creation task.md had no Context section, Claude
got no `--add-dir`, setup had no Brain context step, and the Brain tab and Finish's lessons were missing. Only a task
without a repo got its project's brain (#225).

Such a task now gets its connection's project's brain, as work-item references from before the project was stored
already did. This replaces "a task without a work item gets no brain" in the brain note (`2026-11-03-brain.md`) and the
No repo exception in the #225 note: with or without a repo, a task without a work item uses the connection's project.

- `setupBrain`, `taskBrain` and `summaryBrain` (`handlers.ts`) and `brain:forTask` (`brainHandlers.ts`) fall back to the
  connection's project when there is no work item. The project learned from Azure DevOps is still only read and stored
  for a task with a work item.
- The New task card names the brain live: a new `brain:forNewTask` (connection, work item project) returns the brain's
  name when it adds its context to task.md, else null. Before, the card always showed None and main only filled the
  name in when the task was made.

Choosing a brain on the form, or between several brains of one project (the first one is still used), is not part of
this. No telemetry change.

## Not verified

The app was not run; Windows not tested locally. Covered by `handlers.part2.test.ts` (the brain at setup),
`brainHandlers.test.ts` and `NewTaskScreen.test.tsx`.
