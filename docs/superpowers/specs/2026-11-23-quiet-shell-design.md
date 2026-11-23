# Quiet shell: the terminal, a palette, and things that appear when needed

Date: 2026-11-23. Builds on the calm sidebar of 2026-11-21 (`2026-11-21-calm-sidebar-design.md`), whose rules stay in
force. Mockups: design canvas "Shellie Quiet Shell", https://claude.ai/artifact/WwAVSXyXiLq69UNZcWeskr (four screens:
Working, The palette, Appears when needed, Home as the hub). The mockups show layout and wording; the app's existing
styles, icons (`@fluentui/react-icons`) and tokens decide the look.

## Why

The app has grown and shows too much at once. The owner wants it minimal, with features disclosed progressively, and
fast. The owner's day: Home for the overview, checking cost, Sprint to pick items, adding to the brain and reading,
dealing with dreams, and nearly all the time in terminals.

So every destination is used, but none needs to be on screen while working. What is too much is the chrome around the
terminal. With one task open the window shows about 40 controls: 4 in the header bar (`HeaderBar.tsx`), 17 to 20 in
the nav (`TaskNav.tsx`), about 17 in the task bar (`TerminalTabs.tsx`). Settings, Home and Project each have two entry
points. There is no command palette and no context menu, and the macOS app menu holds only the standard roles
(`src/main/appMenu.ts`), so a visible button is the only way to find any
feature, and every feature has added one.

## Goals

- With a task open, the window shows the terminal and about a dozen controls.
- Every place and every action is reachable from the keyboard through one palette, without leaving the terminal.
- A rule for the future: a new feature goes into the palette and onto Home. It gets permanent screen space only by an
  explicit decision; otherwise it shows itself only when it has something for the user.

## Not goals

- No feature is removed. Every screen, tab and action that exists stays reachable.
- No change to the screens themselves (Sprint, Week, Project, Dreams, Brain, Settings, Finish, New task) beyond what
  Home gets below.
- No user setting to bring the old layout back, and no per-user "hide this" settings.
- No customisable key bindings.
- No change to the collapsed rail beyond the same removals as the wide nav.
- No right-click menus in this project.

## What would make it a failure

- Anything in the nav moving because of a click, a timer or a background refresh (the calm sidebar rule).
- The palette feeling slow: it must be on screen in the frame after the key press and filter on every keystroke
  without waiting for the main process or the network.
- A place or action that can now only be found by knowing its name. Each must be visible in at least one of: the
  palette's unfiltered list, the task menu, Home.
- A shortcut that steals a key the shell or an agent in the terminal needs.

## Approaches

- **A. Terminal first, Home as the hub, a palette for everything.** Chosen by the owner. The nav shrinks to Home,
  tasks and New task; the task bar to terminals, cost and one menu; the header bar goes. About 40 controls become
  about 12, and new features have a place that is not the chrome. The cost: Sprint, Week, Dreams and brains are one
  key press or one click further away than today.
- **B. Keep the layout, trim it.** Remove duplicates, fold the task bar's right side into a menu, add the palette.
  About 25 controls and nothing to relearn, but each feature still gets a permanent place, so it fills up again.
- **C. An icon rail like the VS Code activity bar.** Compact and familiar, but unlabelled icons are the least
  discoverable option and the task list would be toggled all day.

How VS Code does it, which A follows: nearly everything is a command in the palette; visible buttons appear by
context; the rest sits in "..." menus; a Zen mode strips the rest. Visual Studio's search box (Ctrl+Q) shows that
search makes a crowded UI usable but not calm, which is why A also removes chrome.

## The design

### 1. The command registry and the palette

One list of commands is the single source for the palette, the task menu and the shortcut handler
(`hooks/useShortcuts.ts` reads its bindings from it instead of hard-coding them).

A command has: an id, a title, a group (`This task`, `Go to`, `Tasks`, `App`), an optional shortcut, an optional
quiet note at the right (a count such as "3 files", or an amber "1 to review"), a `when` that says whether it applies
now, and what it runs. Commands are built in the renderer from state already in memory; building the list calls
nothing over IPC at open time.

Some of what `when` needs is fetched per component today: whether the task has a brain (`hooks/useBrains.ts`, and an
IPC call on the key press in `useShortcuts.ts`), whether Clean worktree applies (`CleanWorktreeButton.tsx`), the
editor list (`OpenInEditor.tsx`), the `.shellie.yml` run entries. Those commands are contributed by the component
that already holds the data, for as long as it is mounted, and withdrawn when it unmounts. So nothing is fetched
because the palette opened, no new cache or polling is added, and a command whose data has not loaded is absent.
When step 2 removes a control, its component keeps running as a contributor or its data moves to the task menu.

Commands to register (the builder adds any existing action this list misses; none may be dropped):

- **This task** (only on the task screen with a ready task): Show changes, Show usage and cost, Show docs, Show brain
  (only when the task has a brain), Add to brain (opens the task's Brain tab on its Add composer; only when the task
  has a brain), New terminal: one command per kind in `NewTerminalMenu` (Claude Code, Shell, Copilot, OpenCode, Brain
  terminal), one per Run entry of `.shellie.yml`, Open in editor, Open folder, Switch to terminal N, Focus mode,
  Clean worktree (when the button would show today), Scan for repos, Add worktree, Switch environment (opens the environment menu; see the task bar), Finish task, Discard task.
- **Go to:** Home, Sprint, Week, Project, Dreams, one per brain of the active project, Settings, New task, Secrets,
  Done tasks (opens the nav's Done list), and one per connection when there are two or more ("Switch to project X").
- **Tasks:** one per open task of the active project ("Task 398: Export invoices as CSV").
- **App:** Get started (when it applies), What is new, Collapse or expand the nav.

The palette:

- Opens with Mod+Shift+P (Cmd on macOS, Ctrl on Windows) from anywhere, including while the terminal has focus, and
  from the "Go to or run" field at the top of the nav. Not Mod+K: Ctrl+K is "delete to end of line" in a shell, and
  the brain reader uses Cmd+K.
- A centred dialog over a dimmed window: a text field, the list, a foot line with the keys. Escape or a click outside
  closes it and returns focus to where it was (the terminal, usually).
- Empty query: `This task` first (when there is one), then `Go to`, then `Tasks`, then `App`, in registry order.
- Typing filters all groups at once with a simple subsequence match on the title, best match first; group headings
  drop away when filtering. No fuzzy-search dependency.
- Up, Down, Enter; the first row is selected on open and after each keystroke. Running a command closes the palette.
- Destructive commands (Discard task) run their existing confirmation; the palette adds none and skips none.
- `Finish task` and `Discard task` open the same flows the row icons open today.

Telemetry: one event when the palette opens and one when a command runs from it, carrying the command id (ids are
fixed strings, never titles with task or project names). Add both to `docs/telemetry.md`.

### 2. The task bar

Left to right: terminal tabs, any opened view tabs, "+", then at the right the cost figure and the "..." task menu.

- **View tabs on demand.** Usage, Docs, Changes and Brain are no longer always in the row. Each opens as a closable
  tab when asked for (palette, task menu, shortcut, the cost figure for Usage) and stays until closed. Which view
  tabs are open is remembered per task for the session, like the selected tab is today. Their shortcuts keep working
  and open the tab if it is closed.
- **Changes** keeps its count: in the task menu and the palette note while closed, on the tab while open.
- **The "new" dots** that Usage and Docs carry on their tabs today show on the open tab, and on their task menu item
  while the tab is closed. The "..." button itself never carries a dot.
- **Mod+Shift+B** stays with Show brain. Add to brain has no shortcut.
- **Run chips** from `.shellie.yml` leave the row; they are in the "+" menu under the terminal kinds, and in the
  palette.
- **Cost figure** stays, opens Usage.
- **The task menu** ("...", built on `ui/PopupMenu`): a first, non-interactive block with the branch, ahead/behind
  and the environment name (what the header's task callout and the branch text show today); then Changes, Usage and
  cost, Docs, Brain; then Open in editor (the split button's default) with its other editors as items below it, Open
  folder, Focus mode; then Environment, Clean worktree, Scan for repos, Add worktree when they apply; then Finish task
  and Discard task. Shortcuts are shown at the right of their items.
- **Environment** in the task menu is the switcher the chip is today (`secrets/EnvironmentChip.tsx`): the same
  environments, the same confirmation for UAT and Production, shown wherever the chip shows today. The palette's
  Switch environment command opens that same menu.
- **Gone from the row:** the environment chip (its switching moves to the task menu; the UAT/Prod band stays and is
  the warning), the branch and git text,
  the Open in editor split button, the Focus toggle, the separate Clean worktree button.
- **Workspace chips** (tasks with two or more repos) stay in the row: they are context that changes what the terminal
  is in, and they show only for those tasks.
- **Bands** (EnvironmentBand, RunApproveBar, DiscardBar, main-checkout warnings) are unchanged: they already appear
  only when needed.
- **Focus mode** is unchanged in behaviour. Its Finish and Discard buttons move into the task menu, which stays
  visible in Focus mode.

### 3. The nav

Top to bottom: the "Go to or run" field, Home, the Tasks heading with the task list, New task, a spacer, and the "For
you" block at the foot when it has anything.

- **Gone from the nav:** Project tile and switcher, Project, Sprint, Week, Dreams, the brain items, Settings, the
  JoinCard offer (moves to Home and into "For you", below). The collapse control stays, as an unlabelled icon at the
  very foot, and as a palette command.
- **The task list** is exactly the calm sidebar's: same rows, same marks, same Done toggle, same Finish and Discard
  icons on the current row.
- **For you** holds at most one line per kind, each a button that opens the place. A line exists only while its
  reason holds:
  - "N dreams to review" (the count `dreams/DreamsNavItem.tsx` shows today), opening Dreams.
  - "Dreaming about X" while a dream runs (`dreamWords.ts` `navLine`), opening the running panel with Stop this
    dream, as `DreamNavStatus` does today. The other `navLine` states (Dreams off, Dreams on, no limit) are not
    shown in the nav; the Dreams tile on Home carries them.
  - "N long reads waiting", when reading nudges are on and a brain has a reading event (the dot rule the brain nav
    items use today), opening that brain, or Home's reading band when more than one brain has one.
  - "Join a shared brain" when the JoinCard would show.
  - The connection line and the PR-auth note, which already show only when something is wrong.
- The block is pinned to the foot and grows upward, so a line arriving or leaving never moves a task row. When the
  task list is long enough to meet it, the list scrolls and the block stays.
- **The rail** (collapsed nav) shows a search icon for the palette, Home, the task icons as today, New task, and one
  icon with a dot per For you line. It shows no brain, Sprint, Week, Dreams, Project or Settings icons.
- **Focus mode** hides the nav as today, For you included. That is what Focus is for.
- With two or more connections the active project's name shows as a quiet, clickable line under Home (it opens the
  project switcher the tile opens today). With one connection nothing shows.

### 4. The header bar

Removed on every screen. What it carried goes here:

- Logo to Home, project crumb, settings gear: Home in the nav, the palette, Home's quiet links.
- The task crumb's hover callout (branch, ahead/behind, changed files, worktree path, cost): the task menu's first
  block, with the worktree path added as a line that copies on click.
- The environment crumb for non-Development: the existing EnvironmentBand.
- Page labels and the Dreams crumbs: each page already has a `PageHeader` with its title; pages that relied on the
  crumb to go back (a dream inside Dreams, setup, finish, settings sub-pages) get a back link in their `PageHeader`.
- Window dragging and the window controls: the top strip of the nav and the task bar (or the page header on other
  screens) take over as the title bar. Today's drag and inset rules are in `styles/shell.css` and cover the header,
  the Focus task bar and the Focus rail only; the wide nav and `PageHeader` as title bar are new. On macOS the
  traffic lights sit over the top of the nav, which needs its top inset. On Windows the controls overlay sits at the
  top right, where the task menu and `PageHeader` commands are: both must stay clear of it (the titlebar-area
  insets), and nothing interactive may sit in a drag region. This is the riskiest part of the project because
  Windows is not run locally.

### 5. Home

Home becomes the place every destination is reached from. Top to bottom:

1. **For you:** GetStartedBand and WhatsNewBand as today (dismissible), then one row per waiting thing: AwayBand's
   dream result, tasks that wait on the user (the nav's amber mark), the join offer. Like Home's bands today it
   covers every connection, naming the project on a row when there are two or more. Empty: not rendered.
2. **Places:** one tile per destination with one line of state: Sprint (sprint name, items not started), Week
   (hours this week), one per brain (reads waiting, or nothing), Dreams (to review, or next run), Cost (this month's
   total; opens the Stats band below, scrolled into view). A tile is a button; nothing else is in it. Places follow
   the active project, like the nav and the palette; with two or more connections the section heading names it.
3. **The existing bands,** unchanged and in today's order below that: Tasks, Reading, pull requests, sprints, Stats,
   budgets. AwayBand is the only band that moves into For you; the pull request band stays whole.
4. **Quiet links** at the foot: Project, Settings, Done tasks, What is new, Get started. The connection chips and
   Refresh stay in the page header.

## Speed

- The palette component is mounted once and hidden; opening it sets one piece of state. The command list is computed
  on open from state already in memory and memoised while open.
- No command's `when` or note may await anything. A note whose data is not loaded yet is left empty.
- Opening an on-demand view tab must not remount the terminals (they stay mounted behind, as today).
- Removing the header and nav items must not add renders to the terminal path; `TaskNav` should do less work than
  today (no brain or reading hooks unless the For you block needs them).

## Order of work

Three changes, each shippable and each with its own note in `docs/changes/`:

1. **Palette and registry.** Adds the palette, the nav field and the registry; `useShortcuts` reads from it. Nothing
   is removed yet, so nothing can be lost.
2. **Task bar, nav and header.** The task menu, on-demand view tabs, the slim nav with For you, header removed.
3. **Home.** For you, Places, quiet links.

## Decisions made by Claude, not asked

Each can be overturned without changing the rest: Mod+Shift+P as the shortcut; branch and environment in the task
menu; workspace chips staying in the row; For you at the foot of the nav; the project line under Home for two or more
connections; existing Home bands kept below Places; For you on Home across all connections and Places for the active
project; environment switching in the task menu; a running dream as a For you line and the other dream states only on
Home; the rail's For you icons; no nav signals in Focus mode; the "new" dots in the task menu; view tabs remembered per task for the session only; subsequence
matching without a library; the Cost tile opening the Stats band.

## Left to the builder

File layout and names for the registry and palette; the exact match scoring; how view-tab state is stored; CSS; the
wording of palette titles where this document gives none (plain verbs, sentence case); which tests to add beyond: the
registry's `when` rules, palette keyboard behaviour, the shortcut handler still firing before xterm, the nav not
moving when a For you line arrives, and every command in the lists above being present.

## Checking it

`npm test`, `npm run typecheck`, `npm run lint`, and a look at the running app (`SHELLIE_USER_DATA=<path> npm start`)
for: the palette opening over a focused terminal and returning focus to it; each view tab opening and closing; a For
you line arriving without the list moving; window dragging and the traffic lights without the header on macOS.
Windows is the release target and is not run locally: say so in the change note.
