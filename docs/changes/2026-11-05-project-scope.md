# Project scope

Spec `docs/superpowers/specs/2026-11-05-project-scope-design.md`, plan `docs/superpowers/plans/2026-11-05-project-scope.md`. Each Azure DevOps connection is now a project with its own page and its own settings, instead of everything living in one global User scope.

## What changed

- **Project page**: one per connection, with a repositories graph; a click on a node opens that repository's settings, a click on an edge lists the tasks the line stands for. The nav has a Project item and a project switcher; the Home chips and the header's project crumb open the project page. Its Brains band lists the last 3 finished tasks of the project however long ago (`tasksOfProject`; the graph keeps its 90-day window), and "+ New brain" opens Settings › Project › Brains with the create form focused (section `project-brains-new`).
- **Settings scopes**: User | Project | Repository. Brains and the time write-back moved from User to Project; User > Connections is now User > Projects ("Add project…"). Settings opens on the active project; moving the shown repository to another project there makes the Settings project picker follow it.
- **Work items on start**: inherited from the project, overridable per repository and resettable back to the project's value.
- **Time write-back** is per project (`writeTimeToAdo` lives on the connection).
- **Migration** (`src/main/migrate/projectScope.ts`, at boot): moves the global `writeTimeToAdo` onto each connection and strips repository "work items on start" copies that equal their project's.
- **New IPC channels**: `connections:update`, `usage:costs`, `repos:clearWorkItemOnStart`, and `brain:counts` (a brain's page and source counts without the health check's index rebuild, git and lint work; the Project page's brain cards use it). `connections:remove` now also archives the project's brains and broadcasts `brain:changed` for each, so open brain views reload; an archived brain's error points at Settings › Project › Brains.
- Telemetry: screen `project`; events `project.open` (`from`: `nav`, `switcher`, `home`, `crumb`) and `project.graph` (`target`); `settings.scope` can be `project`. `docs/telemetry.md` updated and checked against the code.

## Verified

- `npm test`: Test Files 314 passed | 1 skipped (315); Tests 3689 passed | 31 skipped (3720). Both known flaky tests (`handlers.part6` "ends a run when its tab is stopped in Shellie" and `agentDetector` "resolves with the output printed before a timeout") passed this run.
- `npm run typecheck`: clean. `npm run lint`: 0 errors and 10 warnings, all on lines that were already on `main`; format check passes.
- The migration was exercised by unit tests only (`src/main/migrate/projectScope.test.ts`); the app run below used a fresh folder, which has nothing to migrate.
- App started with `SHELLIE_USER_DATA=<fresh folder> npm start` on macOS: it built and ran, created a fresh `state.json` (no repos, no tasks) and `settings.json`, and the terminal log held no errors or migration messages.

## Known gaps

- Not verified in the running app: adding a project (needs a personal access token), switching in the tile, the Project page, clicking a node and an edge, overriding and resetting work items on start, removing a project. Also not seen in the window: the first-run flow, no Project nav item and Settings showing User | Repository on a fresh folder; no screenshot could be taken here (no display capture available). These are covered by unit/component tests only.
- Windows unverified.
- Archived brains of a removed project are not restored when the same organization and project are added again: the new connection gets a new id, so they stay archived under the old one.
- The sprint AI-cost chip refreshes only when the task set changes.
