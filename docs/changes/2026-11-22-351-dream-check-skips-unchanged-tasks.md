# The dream check skips tasks whose sessions did not change

Issue #351, branch `agent/issues/351-dream-check-rereads-every-task-transcrip`.

To tell whether a repo has anything new to dream about, the scheduler read and parsed every Claude transcript and
OpenCode session of every stored task of the repo, and `pickMaterial` then threw away most of it. Its cached answer was
dropped for every repo on every `tasks:changed`. On a machine with a long task history each check after any task change
parsed the whole history again.

- `dreamSessionsOf` (`src/main/dreams/startDreams.ts`) takes the repo's covered marks. A task with a mark is read only
  when one of its Claude transcripts was modified after it (`fs.stat` `mtimeMs`), or its newest OpenCode session was
  updated after it (`time_updated`, `OpenCodeReader.latestSession`). It is a prefilter only: `pickMaterial` still
  decides, and a task with any doubt (a file that cannot be stat'ed, OpenCode's database that cannot be read) is read.
  A task without a mark is always read.
- The scheduler's check passes the marks; the runner still reads everything when a dream starts.
- `tasks:changed` now clears the known material only of the repos whose tasks were added, changed, moved or removed
  (`changedTaskRepos`, comparing each task with what the last `tasks:changed` left).

The same repos become ready and the session counts on the Dreams screen stay the same.

## Not verified

The check relies on file modification times and on OpenCode updating a session's `time_updated` when a message is
added; a file whose mtime lies before its last turn (a clock change, a copied file) would be skipped until it changes
again. The runner's full read at dream start is unchanged. Windows mtimes were not checked locally; CI covers it.
