# Settings redesign: VS Code style, repo scope, env files

Date: 2026-11-02. Status: design, not built.

## Why

Settings is one long page. The repo part is the worst: a repo's settings sit in four places (a crowded row in
Repositories, the "Move to In Progress / Assign to me" block under it, the per-repo editor in the Editor section
further down, and a read-only dump of `.shellie.yml` behind Show setup). What the owner most wants to change per
repo is the editor and the commands, and the commands cannot be changed in the app at all. The env files a task
copies (`copy:` in `.shellie.yml`) are one line in a text dump, though they hold the secrets a worktree needs.

The owner chose VS Code's Settings editor as the model.

## Goals

- One settings page shaped like VS Code's: search, scope tabs (User | Repository), a category tree, uniform rows.
- Everything about one repo in one place, grouped, editable.
- Repo settings the user changes are personal overrides kept in Shellie; `.shellie.yml` is never written by them.
- Env files ("Secrets & env") prominent per repo, with their state checked.
- New task and the setup page show a summary of what the task will do, with links to the setting behind each line.

## Non-goals

- Shellie holding env values itself (an encrypted key/value store). Discussed and rejected for now: two copies of
  the truth drift apart, and the worktree still gets a plain file. Env files stay in the main checkout.
- Writing overrides back into `.shellie.yml` or "promote to team". Personal only, for now.
- Overriding User settings per repo beyond what is already per repo (e.g. default terminals per repo). Not now.
- Changing Connections and the onboarding pages (Connect, Add repository, Agents) beyond restyling and links.

## Anti-goals

- A second place to edit: the New task / setup summary only shows and links; the one-off ticks New task already
  has (setup commands, copy) stay as they are.
- Silent surprises: a value must always say where it came from (default, `.shellie.yml`, you).
- Losing anything that exists today (every current control has a home, see the mapping below).

## Layout

The Settings screen keeps `PageHeader` and becomes:

- **Search box** at the top. Filters rows in the current scope by title, description and category, as you type;
  categories with no match hide; an empty result says so. A search hit in the other scope is offered as
  "N results in Repository" (or User) and switches scope on click.
- **Scope tabs** under it: **User** | **Repository ▾**. Repository has a repo dropdown (all registered repos;
  discovered ones marked "Found in a task"). The last chosen scope and repo are remembered (`shellie.*` UI pref in
  localStorage, try/catch). With no repos, the Repository tab shows the empty state with "Add folder…".
- **Category tree** on the left, per scope. Click scrolls to the category; scrolling highlights the current one
  (scroll spy), as the current `settings-nav` partly does.
- **Rows.** Every setting is a row: bold title "Category: Name" (VS Code's style), a one-line description, then the
  control. A row whose value is not the default has a **blue bar** on its left. A ⚙ button on hover (and keyboard
  focus) opens a menu with **Reset** (and, in the repo scope, "Copy value"). Saving stays immediate, as now.
- `settings.section` deep links (`go({ kind: 'settings', section })`) keep working; they gain an optional `repoId`
  so a link can open the Repository scope on a repo and category (used by the New task summary).

Connections and the repo list are records, not settings: the User scope keeps Connections as today's list with its
Update token / edit flow. Repos are reached through the Repository scope's dropdown; "Add folder…" and
"Remove repository" live there.

## User scope categories

In this order, each converted into real rows (title, description, default, Reset), so search, the blue bar and Reset
work in both scopes (design call: VS Code is the model, and a page where only half the settings search would feel
broken). Record-like parts (the Connections list, the budget's month chart if any, About) stay as blocks that search
matches by their category name. Behaviour unchanged:

1. **Connections** (today's ConnectionsSection).
2. **Editor**: the default editor and Look again. The per-repo editor rows move to the Repository scope.
3. **Agents and terminals** (default terminals, detected agents).
4. **AI cost and invoicing**.
5. **Time tracking**.
6. **Claude budget**.
7. **Appearance** (theme, splash, notify on done, telemetry).
8. **About** (version, Get started).

## Repository scope

Header: repo name, path (mono), a tag "`.shellie.yml` found" / "No `.shellie.yml`", and two links: **Open
.shellie.yml** (opens the file in the repo's editor; when there is none, "Create .shellie.yml" writes the effective
values as a starting file, the one place Shellie writes it, on an explicit click) and **Reveal folder**.

Categories:

1. **Secrets & env** (first, so it is prominent). See below.
2. **General**: base branch, branch name pattern (`{type}/{id}-{slug}`, with a live preview for an example work
   item), connection (dropdown, as today), "Found in a task" with "Make it a normal repo" when discovered.
3. **Setup**: setup commands (list editor: add, edit, remove, reorder), agent packages (apm: Automatic from the
   tabs / Off / a chosen list of `claude`, `copilot`, `opencode`).
4. **Run**: named run commands (`run:`), a name/command list editor.
5. **Work items on start**: move to In Progress, assign to me, and the In Progress state per work item type shown
   in full (no "Override per type" fold; types load when the category scrolls into view or the scope opens).
   Disabled with a hint when the repo has no connection.
6. **Editor**: this repo's editor (Automatic or a detected one) and, for Visual Studio, the solution; today's
   `editor.repos[repoId]`.
7. **Changes**: files to collapse as generated (`review.collapse`).
8. **Danger zone**: Remove repository (with an in-page confirm bar, as Changes' discard does).

### Where each value comes from

Three layers, like VS Code's Default < User < Workspace:

**Shellie's defaults < the repo's `.shellie.yml` < your override in Shellie**

- Each `.shellie.yml` row shows the effective value and a source label: "default", "from .shellie.yml", or
  "Modified by you". The blue bar means "not the default" (from the file or from you); "Modified by you" is the
  label that says it is your override.
- Changing a value stores an override. Reset removes the override, so the file's (or default) value applies again.
- Lists (setup commands, copy, run, apm list, review collapse) are overridden as a whole: the first edit copies the
  effective list into the override; Reset drops the whole override. (Builder's call made in design: item merges
  confuse.)
- Rows already owned by Shellie (connection, work items on start, editor) keep their current storage and have no
  file layer; their Reset goes back to the app default.
- The file can change under the user (a pull). Overrides win regardless; a row whose override equals the file's
  value again may show "same as .shellie.yml" next to Reset. (Builder may skip this nicety.)
- A broken `.shellie.yml` (today `ShellieConfigError`) shows an error banner in the repo header with the message
  and Open .shellie.yml; rows then show defaults plus overrides, and starting a task still fails as today.

### Storage

- Overrides live on the repo record in `state.json`: a new optional `Repo.overrides` (zod, default `{}`) with the
  same keys as `ShellieYmlSchema` (`base`, `branch`, `copy`, `setup`, `run`, `apm`, `review`), each optional.
  Validated with the same schema pieces.
- The repo's `baseBranch` stays what it is today (inspected base, used when there is no file); `overrides.base`
  takes precedence over both.
- New IPC: `repos:setOverride(repoId, key, value | null)` (null resets), broadcasting `repos:changed` like the other
  repo setters. `repos:config` returns, besides the effective `config`, the per-key `source`
  (`default | file | override`) and the file's own values, so the UI can show labels and a "file value" hint.

### Effective config everywhere

Today `loadShellieConfig(path)` is called from `RepoRegistry.describe`, `handlers.ts` (create task, reopen,
`repos:config`) and the Changes page's `collapseOf(worktreePath)`. All of these must read the merged config:
defaults, then the file, then the repo's overrides. Note `collapseOf` reads the *worktree's* file (the task branch's
version); it must map the worktree back to its repo to apply that repo's overrides. Setup, Start (`startTask.ts`),
New task, the run commands in `TerminalTabs`, reopen and multi-repo extra workspaces all go through `repos:config`
or the handlers, so they pick the overrides up once the merge is in one function.

## Secrets & env

Purpose: make clear which secret files each new worktree gets, where from, and whether that will work.

- Intro line: "Copied from your main checkout into each new worktree. They never leave this machine and Shellie
  does not store their contents."
- One row per entry in the effective `copy` list, with its state, checked when the category is shown and on focus:
  - **Present** (green): exists in the main checkout. Shows size and last modified.
  - **Missing** (warning): not in the main checkout; setup will skip it.
  - **Not ignored by git** (red): the path is not git-ignored, so it could be committed. Checked with
    `git check-ignore`, as `repoInspect` does.
  - **Outside the repository** (red): the path escapes the repo (`insideDir` fails); setup skips it.
  - A folder entry shows "folder" and its file count.
- Row actions: **Open** (in the repo's editor), **Reveal** (Finder / Explorer), **Remove** (edits the override).
- **Add file…**: a picker restricted to the repo, plus suggestions: the git-ignored `.env*` and
  `appsettings.*.local.json` files `repoInspect` already finds, minus those already listed.
- Since `copy` is a `.shellie.yml` key, adding or removing is an override like any other list.
- Never read or show file contents in Settings. Telemetry: counts and states only, never names (check
  `docs/telemetry.md` and the scrubber).

The same check feeds the New task summary.

## New task and setup summary

A compact **"This task will…"** card, on New task (above "Setup from .shellie.yml") and at the top of the setup page
while a task boots:

- **Branch** `<rendered name>` from `<base>`
- **Env**: each copy entry with its state icon; a missing or not-ignored one is a warning line
- **Setup**: the commands (and "node_modules cloned" when that applies), apm targets
- **Opens**: the tabs; **Run**: the run commands
- **Work item**: move to `<state>`, assign to me (or "unchanged")
- **Editor**: the repo's editor

Each line ends with an **Edit** link to Settings → Repository → that repo → that category (`go({ kind: 'settings',
section, repoId })`). New task's own one-off ticks stay where they are and the card reflects them. On the setup page
the card is read-only and collapses once setup is done. Start from Sprint / Home opens the setup page, so it
shows the card there.

## Mapping from today

| Today | New home |
| --- | --- |
| Repositories row: name, path, base | Repository scope header, General |
| `.shellie.yml` found / defaults tag | Repository scope header |
| Connection dropdown | Repository → General |
| Show setup (read-only dump) | Repository → Setup, Run, Secrets & env, Changes (editable) + Open .shellie.yml |
| Remove | Repository → Danger zone |
| Found in a task / Make it a normal repo | Repository → General |
| Move to In Progress / Assign / Override per type | Repository → Work items on start |
| Editor: per-repo rows | Repository → Editor |
| Editor: default + Look again | User → Editor |
| Add folder… | Repository scope (dropdown and empty state) |
| Other sections | User scope, restyled |

## Constraints

- Follow the existing look (ADO palette, Fluent icons, `tokens.css` colours only; `tokens.test.ts` forbids colour
  literals elsewhere), light and dark.
- Windows and macOS: Reveal uses `shell.showItemInFolder`; paths through the `Platform` interface where it matters.
- Keyboard: search focusable with Cmd/Ctrl+F on the page, rows and ⚙ menus reachable by Tab.
- Tests with Vitest as the existing sections have; the merge function gets unit tests for every key and source.
- Telemetry: screen and a few events (scope switched, override set/reset by key, env state counts), added to
  `docs/telemetry.md`.
- Update `CLAUDE.md`'s status when done.

## Left to the builder

- Component structure (a generic `SettingRow` and list editors are expected).
- Search matching details and highlighting.
- Exact copy for descriptions.
- Search, when the Repository tab is active, covers the selected repo only (plus the "N results in User" hint).
- apm "Automatic" is stored as its own sentinel in the override (the file schema has no way to say it).
- The connection row has no Reset (it would unlink the repo); "No connection" is a choice in its dropdown.
- `.miac.yml` repos: Open .shellie.yml opens the `.miac.yml`.
- Env files that are not git-ignored are still copied by setup, as today; Settings and the summary only warn.

## Calls made in design (owner to check)

- User scope sections become real rows, not only restyled.
- "Create .shellie.yml" writes only the keys whose effective value differs from Shellie's defaults (computed defaults
  such as `setup: [npm ci]` from the lockfile and the inspected base are left out so they stay computed), then
  clears the overrides it wrote, so the rows read "from .shellie.yml". `repos:setOverride` gets a clear-all form
  (`repos:clearOverrides(repoId)`).
- The setup page's card shows what the task was given, not the repo's current settings: the task records its
  resolved copy list, branch, base, setup commands, apm targets and work item action at creation (extend
  `TaskSetupSchema`, defaults for older tasks); an override changed during setup applies to the next task. New task's
  card shows the current settings, since nothing has started yet.
