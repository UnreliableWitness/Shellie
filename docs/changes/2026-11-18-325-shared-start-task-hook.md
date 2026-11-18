# Up next and Sprint rows share one Start flow

Issue #325, branch `agent/issues/325-up-next-and-sprint-rows-each-copy-the-wh`.

Home's Up next row and the Sprint row each carried a copy of the Start flow: build the work item ref, open
New task when several repos share the project, keep a `starting` flag, call `startTaskFor`, then select the
task and go to its setup. Every change to Start (#164, #313, #314) had to be made twice.

The flow now lives once, as `useStartTask(repoId, item, chooseRepo)` in `src/renderer/startTask.ts`, which
returns `{ starting, start(agent?) }`. Both rows call it; Up next keeps its `home.clicked` event and passes
"more than one linked repo" as `chooseRepo`. The Start buttons and the agent menu stay in each row, with their
own class names and labels. No behaviour change.

Test: `startTask.test.ts` covers the hook: New task when the repo must be picked, the task created with the
picked agent and its setup opened (with `starting` true meanwhile), and nothing without a repo. The TasksBand
and SprintScreen tests pass unchanged.

Not verified: the app itself was not run; the change is covered by the component tests only.
