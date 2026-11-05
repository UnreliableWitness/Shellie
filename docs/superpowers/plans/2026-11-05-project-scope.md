# Project scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Project page per connection (sprint, brains, a graph of repositories) and Settings in three scopes, User | Project | Repository, with the project's "work items on start" inherited by its repos and the time write-back per project.

**Architecture:** No new entity: a project is a `Connection`. Pure derivations in `src/shared/` (effective start settings, the repo graph) are unit-tested first and consumed by main and renderer. Main gains one patch channel for a connection's settings and one boot migration. The renderer gains one screen, one nav item, one settings scope, and moves three existing settings sections under it.

**Tech Stack:** Electron, React 18, TypeScript, zod 4, Zustand store, Vitest + Testing Library, hand-written SVG.

**Spec:** `docs/superpowers/specs/2026-11-05-project-scope-design.md`

## Global Constraints

- The UI says **Project** everywhere a user sees a connection; code and storage keep `Connection`, `connectionId`.
- Storage stays backward compatible: every new schema field has a `.default()`; old files parse. `StateSchema.version` and `ConnectionsFileSchema.version` stay `1`.
- A repo's `workItemOnStart` is stored **only when overridden** (absent = inherit). A repo with no project keeps its own value.
- Edges count open tasks and tasks with `finishedAt` within **90 days**; the constant is `EDGE_WINDOW_DAYS = 90` beside the derivation.
- The Settings project picker is Settings-local (localStorage `shellie.settings.connectionId`); it never calls `setConnectionId`.
- Update token stays per organization.
- Every new `SettingRow` under the Project scope passes `scope="project"`; row ids are unique across scopes and prefixed `project-`.
- Telemetry: new screen `project`; events `project.open` (`from`: `nav` | `switcher` | `home`), `project.graph` (`target`: `node` | `edge`), and `settings.scope` gains the value `project`. Document each in `docs/telemetry.md`.
- Each task ends with `npm run typecheck` and `npm run lint` green for the files it touched, and a commit.
- Checks: `npx vitest run <file>` for one file, `npm test` for all.

## Review Focus

1. A repo whose project is removed: `connections:remove` unlinks it; its effective start settings must fall back to its own value or the schema default, never throw. Test in Task 1 (`effectiveStartSettings` with `connection = null`) and Task 5 (handler).
2. A task whose `connectionId` names one project while its home repo is now linked to another: it must appear on the home repo's project, never produce an edge to a missing node. Test in Task 2.
3. Settings opened by a deep link with `repoId` for a repo in a project other than the picked one: the picker must follow the repo. Test in Task 9.
4. Old `settings.json` with `writeTimeToAdo: true` and old repos with the copied default: the migration must move the flag and strip equal copies, and a second boot must change nothing. Test in Task 6.
5. A project with no connections at all, or tracker "none": no Project nav item, no Project scope, the page is unreachable, and nothing throws. Test in Tasks 8 and 9.

---

### Task 1: Effective start settings and the connection fields

**Files:**
- Create: `src/shared/startSettings.ts`, `src/shared/startSettings.test.ts`
- Modify: `src/shared/types.ts:251-268` (Repo), `src/shared/types.ts:525-541` (Connection), `src/shared/types.ts:553-561` (ConnectionInput)
- Modify: `src/main/services/RepoRegistry.ts:244` (stop filling the default), `src/main/services/ConnectionStore.ts:230-243` (`strip`)
- Modify: `src/main/services/RepoRegistry.test.ts:86-115` (expects the default; now expects `undefined`)

**Interfaces:**
- Produces: `effectiveStartSettings(repo: Pick<Repo,'workItemOnStart'>, connection: Pick<Connection,'workItemOnStart'> | null): StartSettings` and `startSettingsSource(repo, connection): 'repo' | 'project' | 'default'`, both in `src/shared/startSettings.ts`.
- Produces: `Repo.workItemOnStart?: StartSettings` (optional), `Connection.writeTimeToAdo: boolean` (default false), `ConnectionPatch = Partial<Pick<Connection,'name'|'workItemOnStart'|'writeTimeToAdo'>>` exported from `src/shared/types.ts`.

- [ ] **Step 1: Write the failing tests** in `src/shared/startSettings.test.ts`

```ts
const own = { moveToInProgress: false, assignToMe: true, stateOverrides: { Bug: 'Doing' } };
const proj = { moveToInProgress: true, assignToMe: false, stateOverrides: {} };
it('a repo without its own value inherits the project', () => {
  expect(effectiveStartSettings({}, { workItemOnStart: proj })).toEqual(proj);
  expect(startSettingsSource({}, { workItemOnStart: proj })).toBe('project');
});
it('a repo with its own value wins', () => {
  expect(effectiveStartSettings({ workItemOnStart: own }, { workItemOnStart: proj })).toEqual(own);
  expect(startSettingsSource({ workItemOnStart: own }, { workItemOnStart: proj })).toBe('repo');
});
it('no project and no own value gives the schema default', () => {
  expect(effectiveStartSettings({}, null)).toEqual({ moveToInProgress: true, assignToMe: true, stateOverrides: {} });
  expect(startSettingsSource({}, null)).toBe('default');
});
it('no project but an own value keeps it', () => {
  expect(effectiveStartSettings({ workItemOnStart: own }, null)).toEqual(own);
});
```

- [ ] **Step 2: Run it to see it fail**: `npx vitest run src/shared/startSettings.test.ts` → FAIL, module not found.
- [ ] **Step 3: Change the schemas.** In `RepoObjectSchema` make `workItemOnStart: StartSettingsSchema.optional()`. In `ConnectionSchema` add `writeTimeToAdo: z.boolean().default(false)` after `workItemOnStart`; add it to `strip()` in `ConnectionStore.ts`. Export `ConnectionPatch` from `types.ts`. In `RepoRegistry.describe()` line 244 keep `workItemOnStart` as stored (drop the `?? StartSettingsSchema.parse({})`).
- [ ] **Step 4: Implement `src/shared/startSettings.ts`** with the two functions; the default comes from `StartSettingsSchema.parse({})`.
- [ ] **Step 5: Fix the typecheck fallout.** Every `repo.workItemOnStart.<field>` read now fails to compile. Update the readers to `effectiveStartSettings(repo, conn)` where `conn` is the repo's connection: `src/main/ipc/handlers.ts:1996-2003`, `2115`, `2120-2125`, `3113-3128` (use `s.connections.list().find(c => c.id === repo.connectionId) ?? null`); `src/renderer/screens/NewTaskScreen.tsx:257` (connection from the store); `src/renderer/screens/settings/repo/WorkItemsCategory.tsx:27` (temporary: `effectiveStartSettings(repo, conn)`; Task 11 reworks the category). In `handlers.ts` `repos:add` (3011-3026) stop copying the connection's value into the repo. Update `RepoRegistry.test.ts:86-115` to expect `workItemOnStart` `undefined`.
- [ ] **Step 6: Run** `npx vitest run src/shared/startSettings.test.ts src/main/services/RepoRegistry.test.ts src/main/services/ConnectionStore.test.ts` → PASS; `npm run typecheck` → clean.
- [ ] **Step 7: Commit**: `git commit -m "Project scope: effective start settings, optional repo value, writeTimeToAdo on the connection"`

### Task 2: The repo graph derivation

**Files:**
- Create: `src/shared/projectGraph.ts`, `src/shared/projectGraph.test.ts`
- Modify: `src/shared/workspaces.ts` (move `taskRepoIds` here from `src/main/ipc/handlers.ts:422-426`, export it)

**Interfaces:**
- Produces, in `src/shared/projectGraph.ts`:
```ts
export const EDGE_WINDOW_DAYS = 90;
export type GraphNode = { repoId: string; name: string; baseBranch: string; openTasks: number; prOpen: boolean;
  setupMissing: boolean; projectName: string | null; foundByClaude: boolean };
export type GraphEdge = { a: string; b: string; taskIds: string[] };   // a < b by repoId
export type ProjectGraph = { linked: GraphNode[]; elsewhere: GraphNode[]; edges: GraphEdge[] };
export function projectTasks(tasks: Task[], repos: Repo[], connectionId: string, now: Date): Task[];
export function projectGraph(input: { tasks: Task[]; repos: Repo[]; connections: Pick<Connection,'id'|'project'>[];
  connectionId: string; now: Date }): ProjectGraph;
```
- `projectTasks`: a task belongs to the project its **home repo is linked to now**; a task with `repoId === null` belongs to `task.connectionId`; kept when `status !== 'done'` or `finishedAt` within `EDGE_WINDOW_DAYS` of `now`.
- `linked`: repos with `connectionId === input.connectionId`, in `repos` order, `discovered` ones included. `openTasks`: tasks of the project with `status !== 'done'` whose home repo is this one. `prOpen`: any such open task with `pullRequest !== null` (home) or an undropped extra workspace in this repo with a `pullRequest`. `setupMissing`: `!repo.configFound && repo.overrides.setup === undefined`.
- `elsewhere`: repos that are not linked to this project but appear as an undropped extra workspace of a project task, in first-seen order; `projectName` from `connections`; `foundByClaude` when every workspace that brought it in has `source === 'detected'`.
- `edges`: for each project task, every pair among `taskRepoIds(task)` minus dropped workspaces; one edge per unordered pair, `taskIds` accumulated.

- [ ] **Step 1: Write the failing tests** (`mkTask` as in `src/shared/workspaces.test.ts`, a `mkRepo` helper):
  - `a task spanning a linked repo and a repo of another project gives one edge and one elsewhere node` (asserts `elsewhere[0].projectName === 'IML HUB'`, `edges[0].taskIds`).
  - `two tasks on the same pair thicken one edge, not two`.
  - `a done task older than 90 days adds no edge; one finished 89 days ago does` (uses `now`).
  - `a task whose connectionId is another project but whose home repo is linked here counts here` (Review Focus 2).
  - `a dropped workspace adds no node and no edge`.
  - `foundByClaude is true only when every bringing workspace is detected`.
  - `setupMissing is false when a setup override exists`.
  - `a no-repo task with this connectionId counts for projectTasks but adds nothing to the graph`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; move `taskRepoIds` into `workspaces.ts` and import it in `handlers.ts`.
- [ ] **Step 4: Run** `npx vitest run src/shared/projectGraph.test.ts src/shared/workspaces.test.ts src/main/ipc` → PASS.
- [ ] **Step 5: Commit**: `git commit -m "Project scope: repo graph derivation"`

### Task 3: `connections:update` and the time write-back per project

**Files:**
- Modify: `src/main/services/ConnectionStore.ts` (add `patch`), `src/main/services/ConnectionStore.test.ts`
- Modify: `src/shared/ipc.ts:152-156` (add the channel), `src/main/ipc/handlers.ts` (handler; `writeTime()` at 950, 1033, 4427)
- Modify: `src/main/ipc/handlers.part3.test.ts`, `src/main/ipc/handlers.part5.test.ts:52-161` (time tests seed the flag on the connection)
- Modify: `src/renderer/test-helpers/fakeApi.ts` (default `connections:update` echoing a patched fixture)

**Interfaces:**
- Produces: `ConnectionStore.patch(id: string, patch: ConnectionPatch): Promise<Connection>` (keeps `tokenCiphertext`, `status`, `user`, `checkedAt`).
- Produces: `'connections:update': { args: [id: string, patch: ConnectionPatch]; result: Connection }`; the handler patches, calls `connectionsChanged()`, no verify, no status reset.
- Produces: in `handlers.ts`, `writeTimeFor(task: Task): boolean` = the `writeTimeToAdo` of the connection `adoTarget(task)` names, false without one; replaces `writeTime()` at 1033 and 4427.

- [ ] **Step 1: Store test** in `ConnectionStore.test.ts`: `patch changes workItemOnStart and writeTimeToAdo and keeps the token and status` (save, setStatus ok, patch, then `token(id)` still decrypts and `get(id).status === 'ok'`).
- [ ] **Step 2: Handler tests** in `handlers.part3.test.ts`: `connections:update patches without a PAT and broadcasts connections:changed` (asserts `broadcasts` contains `connections:changed` and no `verify` route was hit). In `handlers.part5.test.ts` change `timeTask(hx, writeTime)` to set the flag on the task's connection with `h['connections:update']` instead of `settings.save`; add `time:sync throws when the task's project has write-back off even if another project has it on`.
- [ ] **Step 3: Run** → FAIL (no channel).
- [ ] **Step 4: Implement** `patch`, the channel, the handler, `writeTimeFor`. The thrown message at 4427 becomes `'Writing time to Azure DevOps is off for this project. Turn it on in Settings > Project > Time.'`.
- [ ] **Step 5: Run** `npx vitest run src/main/services/ConnectionStore.test.ts src/main/ipc/handlers.part3.test.ts src/main/ipc/handlers.part5.test.ts` → PASS.
- [ ] **Step 6: Commit**: `git commit -m "Project scope: connections:update, time write-back per project"`

### Task 4: Per-task cost for a list of tasks

**Files:**
- Modify: `src/shared/ipc.ts` (near `usage:task` at 509), `src/main/ipc/handlers.ts` (handler beside `usage:task`), `src/main/ipc/handlers.part4.test.ts`, `src/renderer/test-helpers/fakeApi.ts` (default `usage:costs` → `{}`)

**Interfaces:**
- Produces: `'usage:costs': { args: [taskIds: string[]]; result: Record<string, number> }`, billable EUR per task id (same billable rule and `OFFICIAL_USD_TO_EUR` as `homeStats`), tasks without usage absent from the record.

- [ ] **Step 1: Test** in `handlers.part4.test.ts`: `usage:costs sums billable EUR per task and skips unknown ids` (seed two tasks' usage like the existing `usage:task` tests do).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**: `git commit -m "Project scope: usage:costs for a list of tasks"`

### Task 5: Removing a project archives its brains

**Files:**
- Modify: `src/main/brain/BrainStore.ts` (add `archiveByConnection`), `src/main/brain/BrainStore.test.ts`
- Modify: `src/main/ipc/handlers.ts:4149-4159` (`connections:remove`), `src/main/ipc/handlersHarness.ts` (if `Services` lacks the brain store, add it; `brainServices()` at 271 shows how one is built), `src/main/ipc/handlers.part3.test.ts`

**Interfaces:**
- Produces: `BrainStore.archiveByConnection(connectionId: string): Promise<number>` (count archived; already archived ones not counted).
- `connections:remove` calls it after unlinking repos and before `connectionsChanged()`; the result is unchanged (`void`).

- [ ] **Step 1: Tests**: BrainStore `archiveByConnection archives only that connection's brains and returns the count`; handler `removing a connection archives its brains` (brain of `c.id` ends `archived: true`, a brain of another connection untouched).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**: `git commit -m "Project scope: removing a project archives its brains"`

### Task 6: The boot migration

**Files:**
- Create: `src/main/migrate/projectScope.ts`, `src/main/migrate/projectScope.test.ts`
- Modify: `src/shared/usage.ts:76` (`writeTimeToAdo: z.boolean().optional()` with a comment: legacy, moved to the connection; read once by the migration), `src/main.ts:456-465` (call after `migrateOnboarding`)
- Modify: `src/renderer/components/TimeSection.tsx` (drop `writeTimeToAdo` from `Draft`, `save`, and the row `user-time-ado`), `src/renderer/components/TimeSection.test.tsx:11-22`, `src/renderer/screens/SettingsScreen.test.tsx` (432/490/528/587 reference the flag), `src/renderer/test-helpers/fakeApi.ts:144`

**Interfaces:**
- Produces, pure:
```ts
export function migrateWriteTime(settings: AppSettings, connections: Connection[]):
  { settings: AppSettings; patches: { id: string; writeTimeToAdo: boolean }[] } | null;   // null when the legacy key is absent
export function migrateStartSettings(repos: Repo[], connections: Connection[]): { id: string }[];   // repos whose value to drop
```
- `main.ts` applies: for each patch `connections.patch(id, {writeTimeToAdo})`; save `settings` with the key deleted; for each repo id `store.update(s => delete repo.workItemOnStart)`. Errors are logged like the onboarding migration's, never fatal.

- [ ] **Step 1: Tests**:
  - `copies the legacy flag onto every connection and removes it from settings` (two connections, flag true → two patches true; returned settings has no `writeTimeToAdo` key).
  - `returns null when the legacy key is absent` (second boot).
  - `drops a repo value equal to its project's and keeps a different one` (three repos: equal, different, no project → only the first id).
  - `is idempotent`: running `migrateStartSettings` on the result gives `[]`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** and wire `main.ts`. **Step 4: Fix TimeSection and its tests** (the row is gone; Task 10 adds the project row). **Step 5: Run** `npx vitest run src/main/migrate src/renderer/components/TimeSection.test.tsx src/renderer/screens/SettingsScreen.test.tsx` → PASS.
- [ ] **Step 6: Commit**: `git commit -m "Project scope: migrate writeTimeToAdo and copied start settings"`

### Task 7: Store, screens and nav plumbing

**Files:**
- Modify: `src/renderer/store.ts:67-96` (Screen), `src/renderer/App.tsx:27-64`, `src/renderer/components/HeaderBar.tsx:194-250`, `src/renderer/components/TaskNav.tsx:427-431, 541-548`, `src/renderer/components/TaskNav.test.tsx`
- Modify: `src/renderer/screens/NewTaskScreen.tsx:45-59` (candidates), `src/renderer/screens/AddRepoScreen.tsx:170`, `src/renderer/screens/BrainScreen.tsx:20-31, 102, 115`, `src/renderer/components/brain/AskBox.tsx` (an `initiallyOpen?: boolean` prop)
- Modify: `src/renderer/hooks/useSprint.ts` (create), `src/renderer/screens/SprintScreen.tsx:454-516` (write the fetched sprint into the cache)
- Modify: `docs/telemetry.md:29` (add `project`)

**Interfaces:**
- Produces, Screen variants: `{ kind: 'project' }`; `{ kind: 'new-task'; workItem?; repoId?; connectionId?: string }`; `{ kind: 'add-repo'; from; folder?; connectionId?: string }`; `{ kind: 'brain'; brainId; focus?: 'ask' | 'wiki' | 'drop' }`; `{ kind: 'settings'; section?; repoId?; connectionId?: string; scope?: 'user' | 'project' | 'repo' }`.
- Produces, store: `sprints: Record<string, { at: number; sprint: Sprint }>` and `setSprint(connectionId: string, sprint: Sprint): void`.
- Produces: `useSprint(connectionId: string | null): { sprint: Sprint | null; loading: boolean; error: string | null; refresh(): void }` in `src/renderer/hooks/useSprint.ts`: returns the cached sprint at once, fetches `workItems:sprint(connectionId)` (current iteration) when nothing cached or older than 60 s, writes it with `setSprint`. `SprintPage.refresh` also calls `setSprint` for the current iteration (no `selected`).
- Produces: `App.tsx` `case 'project': return <ProjectScreen />` (the component comes in Task 8; stub it as `() => null` here). `HeaderBar` page label `'Project'` for the kind; `home()` goes to `{kind:'project'}`.
- Produces: nav `NavItem` "Project" (icon `Grid20Regular` or similar Fluent icon, `current = screenKind === 'project'`, `go({kind:'project'})`, `track('project.open', {from:'nav'})`), rendered only when `connection !== null`. `ProjectTile` pick: `go({kind:'project'})` + `track('project.open', {from:'switcher'})`.
- `NewTaskScreen`: candidates use `initial.connectionId ?? active?.id`. `AddRepoScreen`: `connectionId: found.remote?.connectionId ?? initial.connectionId ?? null` (read `screen.connectionId`). `BrainScreen`: `focus === 'wiki'` sets the initial tab, `'ask'` passes `initiallyOpen` to `AskBox`, `'drop'` focuses the Choose files input after mount.

- [ ] **Step 1: Nav tests** in `TaskNav.test.tsx`: `has a Project item that opens the project page` (like the Sprint test at 445-452; `aria-current`); `picking a project in the switcher opens its page` (extend 462-497: `screen` equals `{kind:'project'}`, `connectionId === 'c2'`); `no Project item without connections` (Review Focus 5).
- [ ] **Step 2: Hook test** `src/renderer/hooks/useSprint.test.tsx`: `serves the cache and fetches once when stale` (stub `workItems:sprint`, render twice, one call).
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** all of the above. **Step 5: Run** `npx vitest run src/renderer/components/TaskNav.test.tsx src/renderer/hooks src/renderer/screens/SprintScreen.test.tsx src/renderer/screens/BrainScreen.test.tsx` → PASS; `npm run typecheck`.
- [ ] **Step 6: Commit**: `git commit -m "Project scope: project screen kind, nav item, switcher, sprint cache, deep-link params"`

### Task 8: The Project page

**Files:**
- Create: `src/renderer/screens/ProjectScreen.tsx`, `src/renderer/screens/ProjectScreen.test.tsx`
- Create: `src/renderer/screens/project/SprintBand.tsx`, `BrainsBand.tsx`, `ReposBand.tsx`, `RepoGraph.tsx`, `RepoGraph.test.tsx`, `layout.ts` (pure geometry), `layout.test.ts`
- Create: `src/renderer/styles/project.css` (import where `home.css` is imported)
- Modify: `src/renderer/App.tsx` (replace the stub), `docs/telemetry.md` (events)

**Interfaces:**
- Consumes: `projectGraph`, `useSprint`, `useHome` (`HomeConnection.sprints` for my items), `useBrains`, `brain:get` + `brain:sources` per brain, `usage:costs`, `sprintTotals` from `homeView.ts` shaped as `{ items: rows.map(r => r.item) }`, `useWorkItemTypes` for the category function, `PageHeader`, `PopupMenu`, `StateDot`, `WorkItemTypeIcon`, `statusText`, `chipState`.
- Produces: `ProjectScreen()` using `useStore(activeConnection)`; with `null` renders the empty state "Add a project in Settings" with a button to Settings (never reached from the nav, but the kind may be restored).
- Produces, `layout.ts`:
```ts
export type Placed = { node: GraphNode; x: number; y: number; w: number; h: number; column: 'linked' | 'elsewhere'; colour: number /* 1..6 */ };
export type PlacedEdge = { edge: GraphEdge; path: string /* SVG d */; label: { x: number; y: number } };
export function layoutGraph(g: ProjectGraph, width: number): { nodes: Placed[]; edges: PlacedEdge[]; height: number };
```
  Constants: node `220×50`, row gap `30`, column top `45`, left column x `20`, right column x `width − 20 − 220` (absent when `elsewhere` is empty: the left column centres at `(width − 220) / 2`), linked-to-linked edges curve into the gutter right of the left column, cross-column edges are cubic curves between facing edges. `height` = tallest column + top + 20.
- Produces, `RepoGraph({ graph, onNode(repoId), onEdge(edge, anchor: HTMLElement) })`: one `<g role="button" aria-label="Repository <name>">` per node, one `<path role="button" aria-label="<n> tasks in <a> and <b>">` per edge, hover highlight via a `data-hover` attribute on the `<svg>`; a `Start a task` link (`<text role="link">`) under a linked node with `openTasks === 0 && !setupMissing`.
- Bands (copy fixed by the spec): header subtitle `` `${connection.name} · ${host(organizationUrl)} · ${statusText(connection)}` ``; commands **Project settings** → `go({kind:'settings', scope:'project', connectionId})`, **New task** → `go({kind:'new-task', connectionId})`. Sprint band: chips `Mine N`, `In progress N`, `Done N / M`, `AI this sprint € X` (`usage:costs` over project tasks whose `workItem.id` is in the sprint rows; EUR with a comma as elsewhere: reuse the formatter in `src/renderer/format.ts`), up to 5 of my items, "Open sprint". Brains band: cards with `Ask` → `go({kind:'brain', brainId, focus:'ask'})`, `Browse` → `focus:'wiki'`, `Drop a file` → `focus:'drop'`; `+ New brain` and `Manage` → `go({kind:'settings', scope:'project', connectionId, section:'project-brains'})`; "Recently finished": last 3 done tasks of the project (`finishedAt` desc) with the date and `usage:costs`. Repos band: meta `` `${linked.length} linked · ${elsewhere.length} used from elsewhere` ``, **Add repository** → `go({kind:'add-repo', from:'settings', connectionId})`; node click → `go({kind:'settings', scope:'repo', repoId})` + `track('project.graph',{target:'node'})`; edge click → `PopupMenu` listing tasks (`#id title`, `StateDot`), each `openTask(id)`, + `track('project.graph',{target:'edge'})`; "Start a task" → `go({kind:'new-task', repoId, connectionId})`; empty state "No repositories in this project yet".

- [ ] **Step 1: Layout tests** (`layout.test.ts`): `two columns when elsewhere is non-empty, one centred column otherwise`; `height grows with the taller column`; `an edge between two linked repos has its label in the gutter` (label x between left column's right edge and the gutter width).
- [ ] **Step 2: Graph tests** (`RepoGraph.test.tsx`): `renders a button per node and per edge with the counts in the labels`; `clicking a node and an edge calls back`.
- [ ] **Step 3: Screen tests** (`ProjectScreen.test.tsx`, render `<Shell/>` with `screen: {kind:'project'}`, fixtures like `SprintScreen.test.tsx:165-182` plus `home:get` snapshot and `brain:list`): `shows the sprint band with whole-sprint counts and my items`; `brains band links to the brain screen with a focus`; `repositories band meta counts linked and elsewhere`; `New task opens with the project preselected`; `empty state without a connection`; `an unauthorized project still renders and the sprint band offers Update token` (connection `status: 'unauthorized'`, `workItems:sprint` rejects: the band shows the `chipState` error message and a link to `{kind:'settings', scope:'project', connectionId, section:'project-connection'}`; the brains and repositories bands render from the store).
- [ ] **Step 4: Run** → FAIL. **Step 5: Implement** screen, bands, graph, css. **Step 6: Run** `npx vitest run src/renderer/screens/ProjectScreen.test.tsx src/renderer/screens/project` → PASS.
- [ ] **Step 7: Commit**: `git commit -m "Project scope: the Project page with sprint, brains and the repo graph"`

### Task 9: Settings: three scopes and the project picker

**Files:**
- Modify: `src/renderer/screens/SettingsScreen.tsx` (whole file), `src/renderer/components/settings/settingsSearch.ts` (add `countIn(scope)`), `src/renderer/screens/SettingsScreen.test.tsx:706-932`
- Create: `src/renderer/screens/settings/ProjectScope.tsx` (categories list and the scope component; category components come in Tasks 10-11, stub them as empty `SettingsCategory` sections here)

**Interfaces:**
- Produces: `type Scope = 'user' | 'project' | 'repo'`; `SCOPE_LABEL = { user: 'User', project: 'Project', repo: 'Repository' }`; `CONNECTION_KEY = 'shellie.settings.connectionId'`.
- Produces: `PROJECT_CATEGORIES: SettingsCategoryInfo[] = [project-connection 'Connection', project-workitems 'Work items on start', project-time 'Time', project-brains 'Brains', project-danger 'Danger zone']` and `ProjectScope({ connection, active }: { connection: Connection; active: boolean })`.
- `linkScope`: `repoId` → repo; `connectionId` → project; a section starting `project-` or equal to `brains` → project; `repo-`/`repos` → repo; other sections → user; else `link.scope`.
- `linkConnection(link, repos)`: `link.connectionId`, else the project of `link.repoId`'s repo, else null.
- Toolbar: when `scope !== 'user'` a `<select className="field" aria-label="Project">` of connections (`${c.name} / ${c.project}`); when `scope === 'repo'` the repo `<select>` after it, listing repos of the picked project then an `<optgroup label="No project">`. The Pivots show `project` only when `connections.length > 0`.
- `SearchStatus` with three scopes: "N results in <other scope>" for each other scope with matches, using `countIn`.
- Mounting: all three scopes mounted, inactive ones hidden; `ProjectScope` keyed by `connection.id`.

- [ ] **Step 1: Tests** (`SettingsScreen.test.tsx`): `the pivot has three scopes with connections and two without`; `remembers the picked project` (`shellie.settings.connectionId`); `a repoId deep link picks that repo's project` (Review Focus 3); `a brains deep link opens the Project scope` (`section: 'brains'`); `search counts name both other scopes`; update the counts in the test at 863-898 after the moves (Task 10 adjusts again).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run src/renderer/screens/SettingsScreen.test.tsx` → PASS.
- [ ] **Step 5: Commit**: `git commit -m "Project scope: Settings with User, Project and Repository scopes"`

### Task 10: Project scope categories: Connection, Time, Brains, Danger zone; User > Projects

**Files:**
- Create: `src/renderer/screens/settings/project/ConnectionCategory.tsx`, `TimeCategory.tsx`, `BrainsCategory.tsx`, `DangerCategory.tsx`, `project.test.tsx`
- Modify: `src/renderer/screens/settings/BrainsSection.tsx` (becomes the per-connection body: export `BrainsForConnection({ connection })` from the existing per-row content; remove the all-connections wrapper), `src/renderer/screens/settings/BrainsSection.test.tsx`
- Modify: `src/renderer/screens/settings/UserScope.tsx` (drop `brains`; `ado` title becomes `Projects`), `src/renderer/components/ConnectionsSection.tsx` (category title `Projects`; `ConnectionRow` loses Verify/Remove and its project name becomes a button to `go({kind:'settings', scope:'project', connectionId})`; `OrganizationGroup` keeps Add a project and Update token), `src/renderer/screens/settings/UserScope.test.tsx`
- Modify: `src/renderer/components/TaskSummaryCard.tsx:85-97` (`edit('Brain', 'project-brains', ...)` with `connectionId`)

**Interfaces:**
- Consumes: `connections:update`, `connections:verify`, `connections:remove`, `UpdateTokenForm` (export it from `ConnectionsSection.tsx`).
- `ConnectionCategory({ connection, title })`: rows `project-conn-status` ("Status": `statusText`, Verify button), `project-conn-token` ("Token": copy `One token for all N projects of <org>`, Update token opens `UpdateTokenForm` with every connection of the org), `project-conn-identity` ("Who I am there": `user` / `userUniqueName`, read-only).
- `TimeCategory({ connection, title })`: row `project-time-ado` "Write booked time to Azure DevOps", checkbox, `modified={connection.writeTimeToAdo}`, reset → false, saves with `connections:update`.
- `BrainsCategory({ connection, active, title })`: row `project-brains-list` wrapping `BrainsForConnection`.
- `DangerCategory({ connection, title })`: row `project-danger-remove`: "Remove project", confirm copy `N repositories will be unlinked and M brains archived.` (counts from the store and `useBrains`), then `connections:remove`, refresh connections and repos as `ConnectionRow.remove` did, then `go({kind:'settings', scope:'user', section:'ado'})`.
- All rows `scope="project"`, category = the category title.

- [ ] **Step 1: Tests** (`project.test.tsx`, render `<ProjectScope connection active/>` like `repo.test.tsx`): `time write-back saves with connections:update`; `remove confirms with repo and brain counts and calls connections:remove`; `token row names the organization's project count`; `brains category lists only this connection's brains`. `UserScope.test.tsx`: `Projects lists connections and a project name opens its scope`; `User has no Brains category`. Fix `BrainsSection.test.tsx` for the new export.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run src/renderer/screens/settings src/renderer/components/ConnectionsSection.test.tsx src/renderer/components/TaskSummaryCard.test.tsx` → PASS.
- [ ] **Step 5: Commit**: `git commit -m "Project scope: Connection, Time, Brains and Danger zone categories; User > Projects"`

### Task 11: Work items on start: project default and repo override

**Files:**
- Create: `src/renderer/components/settings/StartSettingsRows.tsx` (the three controls, shared), `src/renderer/screens/settings/project/WorkItemsCategory.tsx`
- Modify: `src/renderer/screens/settings/repo/WorkItemsCategory.tsx` (whole file), `src/renderer/screens/settings/repo/repo.test.tsx:172-223`, `src/renderer/screens/settings/project/project.test.tsx`
- Modify: `src/renderer/screens/NewTaskScreen.tsx` and `src/shared/setupSummary.ts:50-81` (the summary's start line names its source: `startSettingsSource` → "from project DXP" / "set on this repo" / "default")
- Modify: `src/renderer/screens/settings/repo/GeneralCategory.tsx:136-164` (the row `repo-general-connection` is titled **Project**, its select labelled `Project for <repo>`, the empty option `No project`; the id and channel stay)

**Interfaces:**
- Produces: `StartSettingsRows({ value: StartSettings; onChange(next: StartSettings): void; types: WorkItemTypeMeta[]; idPrefix: 'project-workitems' | 'repo-workitems'; scope: 'project' | 'repo'; category: string; disabled?: boolean; hint?: string })` rendering the rows `${idPrefix}-move`, `-assign`, `-states` exactly as today's repo rows (same labels, `modified`, reset semantics).
- Project category: `WorkItemsCategory({ connection, active, title })`, loads `workItems:types(connection.id)` when active, saves with `connections:update(id, { workItemOnStart })`.
- Repo category: a first row `repo-workitems-source` titled "Source": when the repo has a project and no own value, text `Inherited from <project>` and an **Override** button (copies the effective value onto the repo with `repos:setWorkItemOnStart`); when it has an own value and a project, text `Overridden here` and **Reset to project default** (new channel `repos:clearWorkItemOnStart: { args: [repoId]; result: Repo }`, handler deletes the field, `RepoRegistry.clearWorkItemOnStart(repoId)`); the three controls render only when the repo has an own value, or has no project (then as today, with the hint `Link a project in General first` when unlinked).

- [ ] **Step 1: Tests**: project `saves the default on the connection`; repo `inherited repo shows the project name and Override copies the value` (asserts `repos:setWorkItemOnStart` args equal the project's value); `Reset to project default calls repos:clearWorkItemOnStart`; keep the existing `In Progress state for Task` test working for an overriding repo; `setupSummary` test: `the start line says where the settings came from`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (channel + handler + registry method included; harness test `repos:clearWorkItemOnStart removes the override` in `handlers.part3.test.ts`). **Step 4: Run** `npx vitest run src/renderer/screens/settings src/shared/setupSummary.test.ts src/main/ipc/handlers.part3.test.ts` → PASS.
- [ ] **Step 5: Commit**: `git commit -m "Project scope: work items on start inherited from the project, overridable per repo"`

### Task 12: Home links to the project

**Files:**
- Modify: `src/renderer/screens/HomeScreen.tsx:60-82` (chips), `src/renderer/screens/HomeScreen.test.tsx`

**Interfaces:**
- A header chip click does `setConnectionId(c.id)`, `go({kind:'project'})`, `track('project.open', {from:'home'})` (today it goes to Settings). Deviation from the spec's "the tile's connection name becomes the link": the sprint cards are buttons, so the chip is the link; the spec's intent (one click from Home to the project) holds.

- [ ] **Step 1: Test**: `a connection chip opens that project's page` (chip `uw: Shellie, connected` → `screen.kind === 'project'`, `connectionId`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**: `git commit -m "Project scope: Home chips open the project page"`

### Task 13: Docs, telemetry, change note, full checks

**Files:**
- Modify: `docs/telemetry.md` (screen list, three event rows, `settings.scope` values)
- Create: `docs/changes/2026-11-05-project-scope.md` (sections `## What changed`, `## Verified`, `## Known gaps`; name the spec and the migration)
- Modify: `CLAUDE.md` is **not** touched (change notes never go there).

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run everything**: `npm test`, `npm run typecheck`, `npm run lint` → all green; paste the summary lines into the change note's Verified section.
- [ ] **Step 3: Run the app** (`SHELLIE_USER_DATA=<fresh folder> npm start`): add a project, switch to it in the tile, see the page, click a node and an edge, override and reset work items on start, remove a project. Record what was and wasn't checked in the note (Windows unverified).
- [ ] **Step 4: Commit**: `git commit -m "Project scope: docs, telemetry, change note"`
