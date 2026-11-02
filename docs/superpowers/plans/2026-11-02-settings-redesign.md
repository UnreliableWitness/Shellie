# Settings Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Settings into a VS Code style editor (search, User | Repository scopes, category tree, uniform rows)
with editable per-repo overrides of `.shellie.yml`, prominent Secrets, and a "This task will…" summary.

**Architecture:** A pure merge in `src/shared/repoConfig.ts` (defaults < file < overrides, with per-key sources) is
used by one main-side loader that every `Services.loadConfig` caller goes through. Overrides live on the repo record.
The renderer gets a small settings kit (`SettingRow`, list editors, search registry) and the screen is rebuilt from
category components; existing section components are wrapped, not rewritten, where their save logic stays.

**Tech Stack:** Electron, React 19, TypeScript, zod, Vitest + Testing Library, Fluent icons.

**Spec:** `docs/superpowers/specs/2026-11-02-settings-redesign-design.md` (read it first; the Secrets & env section
there supersedes the conversation).

## Global Constraints

- Colours only from `src/renderer/styles/tokens.css` (`--accent` for the modified bar, `--warn`, `--red`, `--green`);
  `tokens.test.ts` fails on colour literals elsewhere. Light and dark.
- Saving is immediate except where a section has a Save button today (Cost port, Time, Budgets, Cost server): those
  keep their own Save.
- `.shellie.yml` is written only by the explicit "Create .shellie.yml" action.
- Settings never shows a secret value or file contents.
- Telemetry: never names, paths or values; new events go in `docs/telemetry.md`.
- Every existing control keeps a home (spec's mapping table). Existing deep links (`repos`, `terminals`, `ado`,
  `conn-<id>`, `budgets`) keep working.
- Checks: `npm test`, `npm run typecheck`, `npm run lint` all green before each commit.
- Commits end with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01MCYrz9uNHQqxpx8zbZHfGW`

## Review Focus

1. A repo with a broken `.shellie.yml`: Settings must still open the repo (banner + defaults + overrides), not throw.
2. `repos:refresh` (called by `repos:config` when no file exists) must keep `overrides`.
3. An override list emptied to `[]` is a real override ("no setup commands"), distinct from Reset (absent).
4. Search with no matches in either scope shows an empty state; switching repo keeps the search text.
5. A copy entry that is a folder or escapes the repo (`../x`) gets a state, never a crash.

---

### Task 1: Pure config merge

**Files:**
- Create: `src/shared/repoConfig.ts`, `src/shared/repoConfig.test.ts`
- Modify: `src/shared/types.ts` (add `RepoOverridesSchema`, `Repo.overrides`)

**Interfaces:**
- Produces:
  - `RepoOverridesSchema` (zod, in `types.ts`): `z.object({ base: z.string().min(1), branch: z.string().min(1),
    copy: z.array(z.string()), copyAgentConfig: z.boolean(), setup: z.array(z.string()),
    run: z.record(z.string(), z.string()), apm: z.union([z.literal(false), z.literal('auto'), z.array(z.string())]),
    reviewCollapse: z.array(z.string()) }).partial()`; `type RepoOverrides`.
  - `RepoObjectSchema.overrides: RepoOverridesSchema.default({})`.
  - `type OverrideKey = keyof RepoOverrides`; `const OVERRIDE_KEYS: readonly OverrideKey[]`.
  - `type ConfigSource = 'default' | 'file' | 'override'`.
  - `mergeConfig(base: ShellieConfig, opts: { overrides: RepoOverrides; repoBase: string | null; fileKeys: ReadonlySet<OverrideKey> }): { config: ShellieConfig; sources: Record<OverrideKey, ConfigSource> }`
    — `base` is what `loadShellieConfig` returned; `fileKeys` are the keys present in the file; `repoBase` is the
    repo's stored `baseBranch`, applied when the file has no `base`. Override `apm: 'auto'` deletes `apm` from the
    config (automatic); `apm` absent in both = source `default`.

- [ ] **Step 1: Write failing tests** in `repoConfig.test.ts`:
  - `no file, no overrides: sources all default, base = repoBase`
  - `file base wins over repoBase; source file`
  - `override wins over file; source override` (for `setup`, `run`, `copy`, `branch`)
  - `override setup [] stays [] (not the default)` → `config.setup` equals `[]`, source `override`
  - `apm 'auto' override removes apm` → `'apm' in config` is false, source `override`
  - `reviewCollapse override maps to config.reviewCollapse`
- [ ] **Step 2:** `npx vitest run src/shared/repoConfig.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `mergeConfig` and the schema. Fix `Repo` fixtures that typecheck flags (add `overrides: {}`).
- [ ] **Step 4:** Run the test file and `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `Settings: merge .shellie.yml with per-repo overrides`.

### Task 2: Overrides in main (registry, loader, IPC)

**Files:**
- Modify: `src/main/services/ShellieConfig.ts` (export `fileKeysOf(repoPath): Promise<Set<OverrideKey>>`, or return
  the keys from a new `loadShellieFile(repoPath)`; builder's choice, one YAML read per load),
  `src/main/services/RepoRegistry.ts`, `src/main/ipc/handlers.ts`, `src/shared/ipc.ts`, `src/main.ts`
- Create: `src/main/services/effectiveConfig.ts` (+ test)
- Test: `src/main/services/RepoRegistry.test.ts`, `src/main/ipc/handlers.part1.test.ts`

**Interfaces:**
- Consumes: `mergeConfig`, `RepoOverrides`, `OverrideKey`, `ConfigSource` (Task 1).
- Produces:
  - `RepoRegistry.setOverride<K extends OverrideKey>(repoId: string, key: K, value: RepoOverrides[K] | null): Promise<Repo>` (null deletes; value parsed with `RepoOverridesSchema.shape[key]`).
  - `RepoRegistry.clearOverrides(repoId: string): Promise<Repo>`.
  - `describe` carries `overrides` (add to its `Pick` and return).
  - `loadEffectiveConfig(path: string, deps: { repos: () => Repo[]; tasks: () => Task[]; load?: typeof loadShellieConfig }): Promise<ShellieConfig & { sources: Record<OverrideKey, ConfigSource>; fileError: string | null }>`
    — finds the repo whose `path` is `samePath` to `path`, or whose task worktree (home or extra workspace) is `path`,
    and applies its overrides; an unknown path gets no overrides. A `ShellieConfigError` is caught only when
    `opts.lenient` is true (Settings), returning defaults + overrides and `fileError: message`; other callers still
    get the throw (spec: starting a task still fails).
  - `main.ts` wires `loadConfig: (p) => loadEffectiveConfig(p, { repos: () => registry.list(), tasks: () => store.state.tasks })`.
  - IPC (`src/shared/ipc.ts`):
    - `'repos:config'` result becomes `{ config: ShellieConfig; worktreeRoot: string; sources: Record<OverrideKey, ConfigSource>; file: Partial<RepoOverrides>; fileError: string | null }` (`file` = the values the file alone gives, for "file value" hints). The old `refresh` + base swap goes away (the merge applies `repoBase`).
    - `'repos:setOverride': { args: [repoId: string, key: OverrideKey, value: unknown]; result: Repo }`
    - `'repos:clearOverrides': { args: [repoId: string]; result: Repo }`
    - Both handlers follow the setter pattern (`reposChanged()`), and track `tel.event('settings.repoOverride', { key, reset: value === null })`.
  - Renderer: `invalidateRepoConfig(repoId)` (existing, `hooks/useRepoConfig.ts`) is called on `repos:changed`
    so New task / run tabs see overrides (add the subscription in the hook module if it is not there).

- [ ] **Step 1: Failing tests**
  - RepoRegistry: `setOverride stores and null removes`; `refresh keeps overrides`; `setOverride rejects a wrong type` (e.g. `setup: 'x'` throws).
  - effectiveConfig: `applies the overrides of the repo at that path`; `applies the repo's overrides for a task worktree path`; `unknown path: file only`; `broken yml throws unless lenient`.
  - handlers: `repos:config returns sources and file values`; `repos:setOverride broadcasts repos:changed`.
- [ ] **Step 2:** Run those files → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run typecheck` → PASS (existing `repos:config` tests updated to the new shape).
- [ ] **Step 5:** Commit `Settings: per-repo overrides apply wherever the repo config is read`.

### Task 3: Repo file actions and env file states (main)

**Files:**
- Create: `src/main/services/envFiles.ts` (+ test)
- Modify: `src/main/services/repoInspect.ts` (export the env candidate finder it already has as `findEnvCandidates(top, git)`), `src/main/services/SetupRunner.ts` (export `insideDir`), `src/shared/ipc.ts`, `src/main/ipc/handlers.ts`, `src/shared/types.ts`
- Test: `src/main/services/envFiles.test.ts`, handlers test

**Interfaces:**
- Produces:
  - `type CopyEntryState = 'present' | 'missing' | 'holdsSecrets' | 'notIgnored' | 'outside'` and
    `type CopyEntry = { path: string; state: CopyEntryState; folder: boolean; files?: number; size?: number; modified?: string }` (in `types.ts`).
  - `inspectCopyEntries(repoPath: string, copy: string[], deps: { git: GitClient; secretFiles: (repoPath: string) => Promise<string[]> }): Promise<{ entries: CopyEntry[]; suggestions: string[] }>`
    — precedence: `outside` > `missing` > `notIgnored` > `holdsSecrets` > `present`. `secretFiles` is whatever the
    Secrets feature uses for its `copy` reason (find it via `secrets:status`'s `reasons` kind `copy` in main; reuse,
    do not re-detect). `suggestions` = `findEnvCandidates` minus entries.
  - IPC: `'repos:copyEntries': { args: [repoId: string]; result: { entries: CopyEntry[]; suggestions: string[] } }`;
    `'repos:reveal': { args: [repoId: string, rel: string | null]; result: void }` (null = the repo folder; rel must be inside, uses `Services.revealFile` / `openPath`);
    `'repos:openConfigFile': { args: [repoId: string]; result: void }` (opens `.shellie.yml` or `.miac.yml` with the repo's editor through `EditorService`, else `openPath`);
    `'repos:createConfigFile': { args: [repoId: string]; result: Repo }` — writes keys whose effective value differs
    from what `loadShellieConfig` gives with no file (so lockfile-derived `setup` and the inspected base stay out),
    `wx` flag, then `clearOverrides`, then `refresh`; throws `"<name>: .shellie.yml already exists"` if present.
  - Telemetry: `settings.copyEntries` with counts per state.

- [ ] **Step 1: Failing tests** (real temp git repos via `src/main/test-helpers/gitRepo`):
  - `present, missing and not-ignored entries`; `../x is outside`; `a folder reports folder and file count`;
    `holdsSecrets when secretFiles lists it`; `suggestions exclude listed entries`;
    `createConfigFile writes only non-default keys and clears overrides`; `createConfigFile refuses when a file exists`;
    `repos:reveal refuses a path outside the repo`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `Settings: repo file actions and copied env file states`.

### Task 4: Settings kit (renderer)

**Files:**
- Create: `src/renderer/components/settings/SettingRow.tsx`, `ListEditor.tsx`, `KeyValueEditor.tsx`,
  `settingsSearch.ts`, `useScrollSpy.ts`, and tests next to them
- Modify: `src/renderer/styles/screens.css` (settings styles)

**Interfaces:**
- Produces:
  - `SettingRow(props: { id: string; category: string; title: string; description?: ReactNode; keywords?: string[]; modified?: boolean; source?: ConfigSource | 'app'; onReset?: () => void; extraMenu?: { label: string; onClick: () => void }[]; children: ReactNode })`
    — renders `<div className="setting-row" data-modified>` with a title "`{category}: {title}`" (category part
    muted, VS Code style), description, control, a source label ("default" / "from .shellie.yml" / "Modified by you";
    none for `'app'`), and a ⚙ `IconButton` (aria-label `More actions for {title}`) opening `PopupMenu` with Reset
    (disabled when `onReset` is undefined or not modified). Registers itself with the search context and renders
    `null` when filtered out.
  - `SettingsSearchProvider({ query, children })`, `useSettingsSearch(): { query: string; matches(text: string[]): boolean; register(id, scope, texts): () => void; countOther(scope): number }`. Matching: every whitespace-separated term is a case-insensitive substring of title + description + category + keywords.
  - `SettingsCategory({ id: string; title: string; children })`: a `<section id>` with an `h2`, hidden when none of its rows match.
  - `ListEditor({ label: string; items: string[]; onChange(next: string[]): void; placeholder?: string; mono?: boolean })`: rows with edit-in-place, remove, move up/down, "Add item" (VS Code's list widget). Commit on Enter/blur; Escape cancels; empty item is dropped.
  - `KeyValueEditor({ label; value: Record<string,string>; onChange; keyLabel; valueLabel })`: same for pairs; duplicate key shows an inline error and is not saved.
  - `useScrollSpy(container: RefObject<HTMLElement>, ids: string[]): string | null`.
  - CSS: `.settings-page`, `.settings-toolbar` (search + scope tabs), `.settings-tree`, `.setting-row` (left bar
    `3px solid var(--accent)` when `[data-modified]`), `.setting-source`, `.settings-empty`; phone width is not a
    target (desktop app) but the tree collapses under 720px.

- [ ] **Step 1: Failing tests**: `SettingRow shows Modified by you and Reset calls onReset`; `SettingRow hides when the query does not match`; `ListEditor adds, edits, removes and reorders`; `ListEditor Escape cancels`; `KeyValueEditor refuses a duplicate key`; `search terms all have to match`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `npx vitest run src/renderer/components/settings` + typecheck + lint → PASS.
- [ ] **Step 5:** Commit `Settings: rows, list editors and search`.

### Task 5: Settings shell (search, scopes, tree, deep links)

**Files:**
- Modify: `src/renderer/screens/SettingsScreen.tsx` (rewrite into the shell), `src/renderer/store.ts`
  (`{ kind: 'settings'; section?: string; repoId?: string; scope?: 'user' | 'repo' }`)
- Create: `src/renderer/screens/settings/UserScope.tsx`, `RepoScope.tsx` (filled by Tasks 6-8; this task renders the
  existing sections inside `UserScope` and the existing `RepoRow` content inside `RepoScope` so nothing is lost)
- Test: `src/renderer/screens/SettingsScreen.test.tsx`

**Interfaces:**
- Consumes: Task 4 kit.
- Produces: the shell. `PageHeader` "Settings"; toolbar with search (`aria-label="Search settings"`, Cmd/Ctrl+F
  focuses it while the page is shown) and `Pivots`-style tabs "User" / "Repository"; the Repository tab has a repo
  `select` (`aria-label="Repository"`, discovered repos suffixed " (found in a task)") and "Add folder…"; left tree
  from the scope's category ids with `useScrollSpy` highlighting; "N results in Repository/User" link when the other
  scope has matches; empty state "No settings match “{query}”".
  - Deep links: `section` that belongs to a repo category (`repo-*` ids) or a `repoId` opens the Repository scope;
    the old ids `repos` → Repository scope (first repo), `ado`, `conn-<id>`, `terminals`, `budgets`, `editor`,
    `cost`, `time`, `cost-server`, `appearance` → User scope. Keep the existing settle-and-scroll effect.
  - Remembered scope/repo: localStorage keys `shellie.settings.scope`, `shellie.settings.repoId` (try/catch).
  - Telemetry: `track('settings.scope', { scope })`, `track('settings.search', { results })` debounced 1 s, never the query.
  - Category ids: User — `ado`, `secrets`, `editor`, `terminals`, `cost`, `time`, `budgets`, `cost-server`,
    `appearance`, `about`. Repository — `repo-secrets`, `repo-general`, `repo-setup`, `repo-agents`, `repo-run`,
    `repo-workitems`, `repo-editor`, `repo-changes`, `repo-danger`.

- [ ] **Step 1: Failing tests**: `opens on the User scope by default`; `Repository tab shows the chosen repo`; `deep link section ado scrolls in the User scope`; `deep link repoId opens the Repository scope on that repo`; `search filters across categories and offers the other scope`; `no match shows the empty state`; `no repos: Repository tab shows Add folder`. Update existing tests that clicked "Show setup".
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** full `npm test`, typecheck, lint → PASS.
- [ ] **Step 5:** Commit `Settings: VS Code style shell with search, scopes and deep links`.

### Task 6: Repository scope categories

**Files:**
- Create: `src/renderer/screens/settings/repo/*.tsx` (one file per category: `RepoHeader`, `GeneralCategory`,
  `SetupCategory`, `AgentsCategory`, `RunCategory`, `WorkItemsCategory`, `RepoEditorCategory`, `ChangesCategory`,
  `DangerCategory`), `src/renderer/screens/settings/repo/useRepoSettings.ts` (+ tests)
- Modify: `RepoScope.tsx`, `src/renderer/components/EditorSection.tsx` (split: default editor stays; per-repo row moves)

**Interfaces:**
- Consumes: `repos:config` (new shape), `repos:setOverride`, `repos:clearOverrides`, `repos:openConfigFile`,
  `repos:createConfigFile`, `repos:reveal`, existing `repos:setConnection`, `repos:setWorkItemOnStart`,
  `repos:setAgentCommands`, `repos:setDiscovered`, `repos:remove`, `workItems:types`, `editor:installed`, `saveSettings`.
- Produces: `useRepoSettings(repoId): { config; sources; file; fileError; set<K>(key: K, value: RepoOverrides[K] | null): Promise<void>; reload() }` — reloads on `repos:changed`.
  - Header: name, path, `.shellie.yml` tag, links Open .shellie.yml / Create .shellie.yml (when not found) / Reveal folder; `fileError` banner (`role="alert"`, `--red-bg`).
  - General: Base branch (text, commit on blur/Enter), Branch name pattern with live preview via the existing
    `renderBranch` for `{ type: 'User Story', id: 1234, title: 'Add login page' }`, Connection select (no Reset),
    Found in a task + Make it a normal repo.
  - Setup: Setup commands (`ListEditor`, mono), Agent packages (select Automatic / Off / Choose… + checkboxes
    `claude`, `copilot`, `opencode`).
  - Agents: the two command inputs from `AgentCommandOptions` (moved, not changed).
  - Run: `KeyValueEditor` name → command.
  - Work items on start: two checkboxes + a select per type shown in full (types load on mount when a connection
    exists; without one, the rows are disabled with "Link a connection in General first").
  - Editor: this repo's editor + solution (moved from `EditorSection`).
  - Changes: generated globs `ListEditor`.
  - Danger zone: Remove repository with `ConfirmBar`; an error (open tasks) shows via notify.
  - Every `.shellie.yml` row: `modified = sources[key] !== 'default'`, `source = sources[key]`, Reset only when `sources[key] === 'override'`.

- [ ] **Step 1: Failing tests** (fake api): `editing setup commands sends repos:setOverride setup`; `Reset sends null`; `source label from .shellie.yml`; `branch preview renders`; `work item types shown without a fold`; `no connection disables work item rows`; `Create .shellie.yml shown only without a file`; `broken file shows the banner and still renders rows`; `Remove asks to confirm`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; delete `RepoRow`, `StartOptions`, `AgentCommandOptions`, `renderConfig` from `SettingsScreen.tsx`. **Step 4:** full checks → PASS.
- [ ] **Step 5:** Commit `Settings: everything about a repo in one place, editable`.

### Task 7: Secrets in both scopes

**Files:**
- Create: `src/renderer/screens/settings/SecretsCategory.tsx` (User), `src/renderer/screens/settings/repo/SecretsEnvCategory.tsx` (+ tests)
- Modify: `src/renderer/screens/SecretsScreen.tsx` (export `StatusPanel`; Back/header link to Settings),
  `src/renderer/screens/SecretsImportScreen.tsx` (its `back` keeps going to the manager; unchanged otherwise)

**Interfaces:**
- Consumes: `secrets:status`, `secrets:repoDefault`, `secrets:setRepoDefault`, `secrets:cleanWorktrees`, `repos:copyEntries`, `repos:reveal`, `repos:setOverride('copy' | 'copyAgentConfig')`; re-fetch on `secrets:changed` and `repos:changed`.
- Produces:
  - User › Secrets: header button "Open secrets manager" (`go({ kind: 'secrets' })`); one row per non-discovered repo:
    status word (Protected / Needs attention / Nothing stored), "{n} secrets", first reason in one line, Manage
    (`go({ kind: 'secrets', repoId })`), Import… when empty or a `copy` reason. Keywords: secret, env, .env,
    environment, password, key, token.
  - Repository › Secrets & env (first category): `StatusPanel`; "{n} secrets stored" + default environment select +
    Manage secrets + Import…; "Files copied into each worktree" list with state chips (Present green, Missing warn,
    Holds secrets warn + "Manage" link, Not ignored by git red, Outside the repository red), Reveal and Remove per
    row, Add file… (menu of suggestions + "Choose a file…" via `repos:pickFolder`-style picker limited to the repo:
    add `'repos:pickFile': { args: [repoId: string]; result: string | null }` returning a repo-relative path, refusing
    outside paths); "Copy agent config" switch (`copyAgentConfig`).
  - `SecretsScreen` page header gets a "Settings" back link: `go({ kind: 'settings', repoId, section: 'repo-secrets' })` or `{ kind: 'settings', section: 'secrets' }` for All repositories.
  - Remove the separate "Secrets" link from the old nav (the shell no longer has it).

- [ ] **Step 1: Failing tests**: `User Secrets lists each repo with its status and Manage opens the manager on it`; `Repository Secrets & env shows the status panel and entries with states`; `Remove a copied file sends the shorter copy override`; `Add file offers suggestions`; `search 'env' finds the Secrets category`; `SecretsScreen back link opens Settings on the repo`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (+ main handler `repos:pickFile` with a test). **Step 4:** full checks → PASS.
- [ ] **Step 5:** Commit `Settings: secrets up front in both scopes`.

### Task 8: User scope as rows

**Files:**
- Modify: `src/renderer/screens/settings/UserScope.tsx`, `EditorSection.tsx`, `AgentsSection.tsx`, `CostSection.tsx`,
  `TimeSection.tsx`, `BudgetSection.tsx`, `CostServerSection.tsx`, `ConnectionsSection.tsx`, and the Appearance and
  About parts moved out of `SettingsScreen.tsx` into `settings/AppearanceCategory.tsx`, `settings/AboutCategory.tsx`
- Test: the existing section tests keep passing; add tests in `UserScope.test.tsx`

**Interfaces:**
- Consumes: Task 4 kit; `defaultSettings()` from `src/shared/usage.ts` for `modified` and Reset values.
- Produces: each User setting wrapped in `SettingRow` with `source="app"`, `modified` = differs from
  `defaultSettings()`, Reset = save the default (for Save-button sections, Reset fills the form with the default and
  saves). Record-like blocks (connections list, rates table, cost server form, about) are a single `SettingRow`
  each with keywords so search finds them. Section ids stay as listed in Task 5 so deep links keep working.
  Titles (category: title): `Editor: Default editor`; `Agents and terminals: Default terminals`; `AI cost: Usage
  receiver port`, `AI cost: Rates`; `Time tracking: Working hours`, `Working days`, `Idle minutes`, `Write booked time
  to Azure DevOps`; `Budgets: Claude monthly budget`, `Claude month start`, `Claude warnings`, same for Copilot;
  `Cost server: Connection`; `Appearance: Theme`, `Show splash on start`, `Notify when an agent finishes`, `Send
  anonymous usage data`; `About: Version`, `Get started`; `Connections: Work item tracker`, `Connections: Azure DevOps`.

- [ ] **Step 1: Failing tests**: `theme row shows modified when not system and Reset saves system`; `search 'idle' finds Time tracking: Idle minutes only`; `budgets row is read-only when managed`; `deep link conn-<id> still opens the token form`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** full checks → PASS.
- [ ] **Step 5:** Commit `Settings: app settings as searchable rows`.

### Task 9: "This task will…" summary

**Files:**
- Modify: `src/shared/types.ts` (`TaskSetupSchema.summary`), `src/main/ipc/handlers.ts` (`tasks:create` records it),
  `src/renderer/screens/NewTaskScreen.tsx`, `src/renderer/screens/SetupScreen.tsx`
- Create: `src/renderer/components/TaskSummaryCard.tsx` (+ test)

**Interfaces:**
- Produces:
  - `TaskSummarySchema = z.object({ branch: z.string(), base: z.string(), copy: z.array(z.string()), commands: z.array(z.string()), apm: z.union([z.literal(false), z.array(z.string())]).nullable(), tabs: z.array(z.string()), run: z.array(z.string()), workItem: z.object({ move: z.string().nullable(), assign: z.boolean() }).nullable(), editor: z.string().nullable() })`; `TaskSetupSchema.summary: TaskSummarySchema.nullable().default(null)` (older tasks: null → no card).
  - `tasks:create` fills it from the effective config, the input and the repo's start settings (the In Progress state name when known, else "In Progress").
  - `TaskSummaryCard({ summary: TaskSummary; repoId: string; copyStates?: CopyEntry[]; collapsible?: boolean })`: lines Branch, Env (copy entries with their state icon; Missing/Not ignored as warning lines), Setup, Opens, Run, Work item, Editor; each with an "Edit" link → `go({ kind: 'settings', repoId, section: 'repo-<category>' })`. Heading "This task will…".
  - New task: builds a `TaskSummary` from the form state and current config (live), above "Setup from .shellie.yml"; fetches `repos:copyEntries`.
  - Setup page: card from `task.setup.summary`, collapsed once setup is done (expandable).

- [ ] **Step 1: Failing tests**: `card lists branch, env, setup and work item`; `Edit link opens Settings on the repo category`; `missing env file shows a warning line`; `tasks:create records the summary`; `setup page shows the recorded summary, not the current config` (change override after create; card unchanged); `older task without summary shows no card`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** full checks → PASS.
- [ ] **Step 5:** Commit `New task and setup: show what the task will do, with links to the settings`.

### Task 10: Docs, live check, status

**Files:**
- Modify: `docs/telemetry.md` (`settings.scope`, `settings.search`, `settings.repoOverride`, `settings.copyEntries`), `CLAUDE.md` (Status bullet), `design/README.md` only if it lists Settings mockups as current

- [ ] **Step 1:** Run `npm test && npm run typecheck && npm run lint` → all PASS.
- [ ] **Step 2:** Launch with `SHELLIE_USER_DATA=<scratch dir> npm start` (use the `run` skill), add this repo, check: search, both scopes, a setup command override reaching New task's card, Reset, Secrets in both scopes, light and dark. Fix what the run shows.
- [ ] **Step 3:** Add a CLAUDE.md Status bullet "Settings redesign (spec …) implemented 2026-11-02 on `feature/settings-redesign`: …" with known gaps.
- [ ] **Step 4:** Commit `Settings redesign: docs and status`.
