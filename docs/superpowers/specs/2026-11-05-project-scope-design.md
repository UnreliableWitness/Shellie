# Project scope: a page per connection, and settings in three levels

Date: 2026-11-05. Status: approved by the owner, not built.

## Why

A connection (one Azure DevOps organization + project + token) is already the thing the app thinks in: since
#219 and #229 the left nav shows only the active project's tasks and brains, Home groups sprints and stats per
connection, the cost ledger attributes every request to a connection. But a project has no page of its own and no
place of its own in Settings. Its settings are split between User > Connections (the token, and a copy of "work
items on start" chosen when the connection was added and never shown again), User > Brains (every project's
brains on one page, grouped by connection), User > Time tracking (write-back, one switch for all projects) and
Repository > General (the "Connection" dropdown, the only place that says which project a repo belongs to). The
owner's words: "the settings are a bit jumbled", and the first thing they went looking for in the wrong place was
Brains.

The owner wants, when switching project in the tile, an overview of that project: its sprint, its repos, the
repos its tasks pull in from elsewhere, its brains, with a diagram of the repos, and navigation from there.

## Goals

- A **Project page** per connection: the active project's sprint, brains and repositories, reached from the nav
  and from the project switcher. The repositories are a graph.
- **Settings in three scopes**: User | Project | Repository. Everything about one project in one place; User
  keeps only what is about the developer and this machine; Repository lists the active project's repos.
- The project's defaults flow down: a repo **inherits** the project's "work items on start" unless it overrides
  it, instead of taking a copy at link time.
- Nothing stored is duplicated per project: no per-project editor, appearance, rates, or terminals.

## Non-goals

- Separate workspaces per connection (own tasks store, own settings file, own window). Home across all projects
  and one personal settings set are features; the owner chose a page and a settings scope, not a wall.
- New data: no new entity. A project *is* a connection; the page and the scope read what exists.
- Changing how cost is attributed or invoiced. The ledger already attributes to a connection.
- A per-project budget. Budgets are the developer's monthly Claude and Copilot budgets and stay on User.
- The "No tracker" mode gains no project page: without connections there is no project (see Edge cases).
- Dependency edges between repos from package.json or similar. Edges come from tasks only, for now.

## Anti-goals

- A second copy of a setting. "Work items on start" is stored once on the project and once per repo *only when
  overridden*; the repo row must say "Inherited from DXP" or "Overridden here".
- Losing a control: every current setting has a home in the mapping below.
- A project page that repeats the Sprint page or the nav. It summarizes and links; the detail stays where it is.
- Blocking on the network: the page renders from the store at once, and the sprint band fills in like Home does.

## Vocabulary

- **Project**: what the UI calls a connection from now on, everywhere the user sees it (the tile already says
  "project"). The code keeps `Connection`, `connectionId`; this design renames nothing in storage.
- **Linked repo**: a repo whose `connectionId` is this project's.
- **Repo used from elsewhere**: a repo that is not linked to this project but that a task of this project has as
  an extra workspace (`task.extraWorkspaces[].repoId`, both `source: 'detected'`, where Shellie found Claude
  working in it, and `source: 'manual'`). Such a repo may be linked to another project or to none (including
  `discovered: true` repos).
- **Active project**: `activeConnection()` in `src/renderer/store.ts`, unchanged: the open task's project, else
  the one picked in the tile, else a fallback.

## The Project page

A new screen `{ kind: 'project' }` showing the active project; a new `NavItem` "Project" in the left nav between
Home and Sprint (the rail shows its icon only). Picking a project in the switcher goes to this page instead of
Sprint (today `ProjectTile` goes to Sprint). With no connections the item is absent.

`PageHeader`: the project name as title; subtitle "<connection name> · <org host> · token ok, checked 10 min ago"
(`statusText` from `src/renderer/connectionStatus.ts`), amber/red like Home's health chip when not ok. Commands:
"Project settings" (deep link to Settings, Project scope, this project) and "New task" (New task with this
project's connection preselected).

Bands, in a two-column grid like Home (`home.css`), the repositories band full width below:

1. **Sprint** (left). The current iteration of this connection: name, days left, end date, a progress bar
   (done / total), chips "Mine N", "In progress N", "Done N / M", "AI this sprint € X" (ledger total for this
   connection's tasks whose work item is in the iteration; builder: reuse `homeStats` if it fits, else sum the
   ledger). Then up to 5 of my items with their task state, a row's right side showing the task status or
   "To do · Start". "Open sprint" goes to the Sprint page.
   Data: Home's snapshot (`HomeSprint`) holds only the items assigned to me and skips a sprint I have nothing in,
   so the whole-sprint numbers come from the Sprint page's fetch (`workItems:sprint` for the current iteration),
   which the band shares with the Sprint page through the store's sprint cache.
2. **Brains** (right). One card per non-archived brain of this connection: name, "N pages · N sources ·
   refreshed <ago>" (`brain:list` gives no counts; one `brain:get` per brain after the page renders, or a new
   channel that returns the counts for a connection, builder's choice), the wiki name and root when set; links Ask, Browse, Drop a file (the three entry points the
   brain screen has). A dashed "+ New brain" card opens the create form (today `CreateBrainForm` in Settings; the
   card goes to Settings > Project > Brains with the form open). "Manage" goes there too. Below it, **Recently
   finished**: the last 3 finished tasks of this project with when and their AI cost (my call; drop if the band
   gets tall).
3. **Repositories** (full width). Title "Repositories", meta "N linked · M used from elsewhere", command "Add
   repository" (Add repo screen with this connection preselected). The graph is described next. Below it a
   legend. With no linked repos: the empty state "No repositories in this project yet" and the Add command.

### The repositories graph

An SVG the renderer lays out itself (no graph library; the layout is two columns, deterministic, no physics):

- **Left column**: linked repos, one node each, in the order Settings lists them. A node: name, a colour bar on
  the left cycling `--repo-1`..`--repo-6` by position in this column (a page-local colour; `repoColor` in
  `workspaces.ts` colours workspaces within one task and is not reused, so a repo's colour here need not match
  its colour inside a task), a mono
  line "<base branch> · N open tasks[ · PR open]" and, when the repo has no `.shellie.yml` and no setup override,
  "⚠ setup missing". A repo with no open tasks and no warning says "no open tasks".
- **Right column**: repos used from elsewhere, one node each, dashed border, mono line "project <name>" or "no
  project", plus " · found by Claude" when every workspace that brought it in is `detected`.
- **Edges**: one line between two nodes for every pair of repos that share at least one task of this project
  (home repo + each extra workspace; extra + extra too; dropped workspaces excluded). Stroke width 1 for one
  task, 2 for two or more; a small label with the count at the midpoint. Linked-to-linked edges curve in the left
  column's gutter.
- **Which tasks count**: open tasks and tasks finished in the last 90 days (see Decisions below). A task belongs to the project its home repo is linked to *now* (a task without a repo: its own
  `connectionId`), so a home repo is always a left-column node even when `task.connectionId` recorded another
  project at creation (a repo re-linked later). Tasks with no project (#219 shows them under every project)
  add no edges.
- **Interaction**: hovering a node or edge highlights it and the nodes it joins. Clicking a node goes to
  Settings > Repository for that repo (a used-from-elsewhere repo: the same, in its own project's scope). Clicking
  an edge opens a popover listing the tasks (id, title, state), each a link to the task. A linked repo with no open
  tasks shows a "Start a task" link under its mono line (New task with the repo preselected).
- **Scale**: up to 8 nodes per column fits without scrolling; beyond that the band grows in height (the page
  scrolls). No zoom, no drag.
- **Empty right column**: the column is absent and the left column centres; the meta says "0 used from
  elsewhere".

The owner chose this graph over a lanes-with-tasks layout; the graph is about structure, the nav is about tasks.

An earlier mock showed "brain coverage" of repos beside the graph; brains have no repo sources
(`SourceTypeSchema`: sow, deck, doc, transcript, note, task, wiki-page), so that panel is dropped.

## Settings: three scopes

The Settings screen's scope pivot becomes User | Project | Repository (`SettingsScreen.tsx`, `Scope`). The
Project scope has a project picker in the toolbar, like the Repository scope's repo `<select>` there. The picked
project is **Settings-local** (kept like `shellie.settings.repoId` in localStorage, initialised from the active
project when Settings opens); it never calls `setConnectionId`, so looking at another project's settings does
not switch the nav's tasks and brains. The Repository scope's picker lists the Settings-picked project's repos,
with repos linked to no project under a "No project" group shown whatever the picked project. Deep links:
`{ kind: 'settings', scope: 'project', connectionId }` sets the picked project; a `repoId` deep link sets it to
that repo's project; existing `repo-*` sections keep working.

Saving a project's settings (on-start default, time write-back, name) needs a new IPC channel,
`connections:update`, that takes no PAT and leaves `status` alone; today's `connections:save` requires the PAT
and resets the status.

### Mapping: where every current control goes

| Today | Scope | Category | Note |
|---|---|---|---|
| User > Connections > Work item tracker (Azure DevOps / none) | User | Projects | Renamed category: "Projects". Holds the tracker switch and the list of projects with Add project. |
| User > Connections > organizations, PAT, Verify, Update token, Add a project | User | Projects | The list; each row's name links to the Project scope. |
| Connection's `workItemOnStart` (set at Connect, never shown) | Project | Work items on start | Shown and editable. The default its repos inherit. |
| User > Brains | Project | Brains | Only this project's brains, with create, archive, restore, options. |
| User > Time tracking > Write booked time to Azure DevOps | Project | Time | Per project: `writeTimeToAdo` moves from `AppSettings` to the connection. Migration: every existing connection gets the current global value. |
| Project token, status, "who I am there" | Project | Connection | Verify, Update token, Remove (what `ConnectionRow` does today). Update token stays **per organization**, as `UpdateTokenForm` works today: the row says "One token for all N projects of <org>" and updating it from any project updates them all. |
| Repository > General > Connection dropdown | Repository | General | Stays, renamed "Project". Changing it moves the repo to another scope's list. |
| Repository > Work items on start | Repository | Work items on start | Becomes an override: a row "Inherited from <project>" with "Override" that reveals the three controls, and "Reset to project default". Storage: `repo.workItemOnStart` becomes optional (absent = inherit). Migration: a repo whose value equals its project's at migration time drops it; a different value stays as an override. A repo with no project keeps its own value (nothing to inherit). |
| User > Secrets, Editor, Agents and terminals, AI cost and invoicing, Time tracking (hours, days, idle), Budgets, Cost server, Appearance, About | User | unchanged | |
| Repository > everything else | Repository | unchanged | |

Project categories, in tree order: Connection, Work items on start, Time, Brains, Danger zone (Remove project;
today's confirm about linked repos moves here).

### Effective "work items on start"

One function, `effectiveStartSettings(repo, connection)` in `src/shared/` beside `repoConfig.ts`, used by
`workItemStart.ts`, New task's summary and the Settings row: the repo's own value when set, else the project's,
else the schema default. New task's summary line says where it came from, as the Settings redesign requires.

## The nav and the switcher

- "Project" nav item as above; current when the Project page is on screen.
- The switcher's list stays. Picking a project goes to the Project page.
- Home is unchanged: across all projects. Its per-connection sprint and stats tiles get a link to that project's
  page (the connection name becomes the link).

## Edge cases

- **No connections / tracker none**: no Project nav item, no Project scope in Settings (the pivot shows User |
  Repository as today), the Projects category under User explains how to add one.
- **A repo linked to no project**: shown in every project's Repository scope under "No project"; never in a
  project page's left column; in the right column when a task of that project used it.
- **A task without a repo** (#225): counts for the sprint band; adds nothing to the graph.
- **A connection removed**: today its repos lose their link (`connections:remove` already does that); its brains
  stay and show under "No project"? No: a brain requires a connection (`connectionId` min 1), so the Danger zone
  says "N brains will be archived" and archives them. My call; the owner can change it.
- **Token unauthorized**: the page still renders from the store; the sprint band shows the health message Home
  shows and an "Update token" link to Project > Connection.

## Telemetry

New screen `project` (`trackScreen`), events `project.open` (from: nav | switcher | home), `project.graph.node`
and `project.graph.edge` (clicked), `settings.scope` gains the value `project`. Add them to `docs/telemetry.md`.

## Migration

One migration in `src/main/migrate/` (where the others live), run once at start, idempotent:

1. `writeTimeToAdo`: copy the global value onto each connection; keep the global key out of the schema afterwards
   (preprocess drops it).
2. `repo.workItemOnStart`: for each repo with a connection, drop the value when it deep-equals the connection's;
   otherwise keep it.
3. Nothing for brains, tasks, ledger.

## Verification

- Unit tests for `effectiveStartSettings`, the "used from elsewhere" derivation, the edge derivation (pairs and
  counts, dropped workspaces excluded), the migration (both branches), and the Settings scope routing.
- Renderer tests for the Project page bands with `fakeApi`, the graph's nodes and edges, the Settings pivot with
  and without connections.
- Running app: switch project in the tile, land on the page, click a node, click an edge, override and reset
  "work items on start", remove a project. Both themes. Windows unverified (as usual).

## What is left to the builder

- Exact graph geometry (node size, column gap, curve) within the mock's proportions; a hand-written SVG, no
  library.
- Whether the sprint band reuses `HomeService`'s snapshot or asks for one connection; reuse unless it costs a
  second fetch.
- The popover component for an edge's tasks (reuse an existing popover/menu if one fits).
- Category ids for the Project scope (`project-*`), following `repo-*`.
- Where in `docs/changes/` the note goes: one file for the whole change.

## Decisions the owner left to the designer

The owner approved the design with "go for it" on 2026-11-05, leaving these two to the designer:

1. The sprint band shows **whole-sprint numbers** (done / total, in progress) from the Sprint page's fetch,
   shared with the Sprint page through the store, plus my items as rows.
2. The graph's edges count **open tasks and tasks finished in the last 90 days** (`finishedAt` within 90 days
   of now); older history adds no lines. The 90 days is a constant beside the derivation, not a setting.

## Mocks

Rendered from the brainstorm (not checked in): the Project page with the graph, and the hierarchy diagram. The
hierarchy, in words: User (one: editor, appearance, agents, working hours, rates, usage port, cost server,
telemetry, personal secrets, tracker switch) has Projects (one per connection: token, on-start default, time
write-back, brains, sprint, the page), each has Repositories (path, base branch, setup, run, copy, agent commands,
on-start override, editor override, secrets & env, review collapse); a Task has a home repo and borrows extra
repos from any project; Home sits beside the projects, across all of them.
