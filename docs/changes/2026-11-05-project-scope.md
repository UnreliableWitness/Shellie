# Project scope

Spec `docs/superpowers/specs/2026-11-05-project-scope-design.md`, plan `docs/superpowers/plans/2026-11-05-project-scope.md`. Each Azure DevOps connection is now a project with its own page and its own settings, instead of everything living in one global User scope.

## What changed

- **Project page**: one per connection, with a repositories graph; a click on a node opens that repository's settings, a click on an edge lists the tasks the line stands for. The nav has a Project item and a project switcher; the Home chips open the project page.
- **Settings scopes**: User | Project | Repository. Brains and the time write-back moved from User to Project; User > Connections is now User > Projects. Settings opens on the active project.
- **Work items on start**: inherited from the project, overridable per repository and resettable back to the project's value.
- **Time write-back** is per project (`writeTimeToAdo` lives on the connection).
- **Migration** (`src/main/migrate/projectScope.ts`, at boot): moves the global `writeTimeToAdo` onto each connection and strips repository "work items on start" copies that equal their project's.
- **New IPC channels**: `connections:update`, `usage:costs`, `repos:clearWorkItemOnStart`. `connections:remove` now also archives the project's brains.
- Telemetry: screen `project`; events `project.open` (`from`) and `project.graph` (`target`); `settings.scope` can be `project`. `docs/telemetry.md` updated and checked against the code.

## Verified

- `npm test`: Test Files 314 passed | 1 skipped (315); Tests 3683 passed | 31 skipped (3714). Both known flaky tests passed this run.
- `npm run typecheck`: clean. `npm run lint`: only warnings (existing unicorn ones), format check passes.
- App started with `SHELLIE_USER_DATA=<fresh folder> npm start` on macOS: it built and ran, created a fresh `state.json` (no repos, no tasks) and `settings.json`, and the terminal log held no errors or migration messages.

## Known gaps

- Not verified in the running app: adding a project (needs a personal access token), switching in the tile, the Project page, clicking a node and an edge, overriding and resetting work items on start, removing a project. Also not seen in the window: the first-run flow, no Project nav item and Settings showing User | Repository on a fresh folder; no screenshot could be taken here (no display capture available). These are covered by unit/component tests only.
- Windows unverified.
- The Project page's "Recently finished" list uses the graph's 90-day task window.
- User > Projects still says "Add connection…".
- The sprint AI-cost chip refreshes only when the task set changes.
