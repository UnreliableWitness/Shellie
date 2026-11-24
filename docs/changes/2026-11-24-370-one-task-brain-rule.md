# One rule for which brain a task gets

Date: 2026-11-24. Issue #370, branch `agent/issues/370-which-brain-a-task-gets-is-written-five`.

The rule for a task's brain (the work item's project, else the connection's, and for task.md only when the brain's
`contextInTaskMd` is on) was written five times: `brain:forTask`, `brain:forNewTask`, `summaryBrain`, `taskBrain`
and `setupBrain`. The copies had drifted: `brain:forTask` fell back with `??`, the others with `||`, and the
handlers.ts copies looked the connection up differently from the brain handlers.

## What changed

- **One place.** `src/main/brain/context.ts` has `taskBrainOf` (project `||` the connection's, no brain without a
  connection), `contextBrain` (the brain only when its context goes into task.md) and `connectionProject` (a removed
  connection has no project). All five callers are built on them; `setupBrain` still passes the project learned from
  Azure DevOps first. `brainForTask` stays the low-level lookup.
- **An empty stored project falls back everywhere.** A work item stored with `project: ''` now gets the connection's
  project's brain on the Brain tab too, as it already did at task setup and in the new-task summary.

Which brain wins when several match (the first), the `contextInTaskMd` rule, the IPC channels and the renderer did not
change.

## Not verified

- On Windows, and in the running app: covered by unit tests only.
