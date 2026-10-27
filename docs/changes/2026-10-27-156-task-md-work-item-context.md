# task.md carries the whole work item

Issue #156, branch `agent/issues/156-shellie-task-md-should-contain-everythin` (2026-10-27). `.shellie/task.md` held only the work item's type, id and title, so a user opening Claude Code or OpenCode in a task had to look up the description, acceptance criteria and comments in Azure DevOps themselves.

Setup now reads the whole work item before it writes task.md. `AdoClient.workItemDetails` (exposed as `Tracker.itemDetails`) gets every field and the relations with `$expand=all`, then the newest 200 comments from the comments API (project from `System.TeamProject`), returned oldest first. A failing comments call leaves the comments out. `buildPlan` in `src/main/ipc/handlers.ts` calls it when the task has a work item and a connection, with an 8 s limit; any error, timeout or an answer without fields gives the old task.md, and setup never fails because of it.

`renderTaskMd` (`src/shared/naming.ts`) takes the details as a third argument and appends, after the existing content (which is unchanged, byte for byte, without details):

- `## Work item`: title, type, state, assigned to, area, iteration, tags, URL and linked work items (Parent, Child, Related, as ids only).
- `### Description`, `### Acceptance criteria`, `### Repro steps`, each when set; their HTML becomes plain text (line breaks and list items kept, other tags dropped, entities decoded).
- `### Other fields`: every remaining non-empty field by reference name, sorted; identities by display name, HTML stripped. Bookkeeping fields (`System.Rev`, `System.Watermark`, `System.AuthorizedAs`, link counts, area/iteration ids and levels, `WEF_*` board fields, `System.History`) are left out.
- `## Comments`: author, date and text, oldest first; HTML comments as plain text, markdown comments as they are.

The work item part is capped at about 200,000 characters: the oldest comments go first, with a note saying how many were left out.

task.md is a snapshot taken at setup (and again when a task is reopened, since that step rewrites the file); it is not refreshed when the work item changes. No telemetry events change.

Not in this change: refreshing task.md later, attachments and images, the content of linked work items, other trackers. Tested with Vitest on macOS only (renderer, the client's two calls with a fake server, and setup with details and with a failing read); not run in the app against a real organization, and not checked on Windows.
