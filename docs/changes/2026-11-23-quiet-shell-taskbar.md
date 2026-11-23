# Quiet shell, step 2a: the task bar

Date: 2026-11-23. Spec: `docs/superpowers/specs/2026-11-23-quiet-shell-design.md`, section "The task bar". Follows
the palette (`2026-11-23-quiet-shell-palette.md`). The nav and the header bar are the next two changes.

## What changed

The task bar now shows the terminals, "+", the cost figure and one "..." task menu (plus the repo chips of a task
with two or more repos). Everything else it showed is in the task menu, the palette, or a shortcut:

- **Usage, Docs, Changes and Brain** are no longer always in the tab row. Each opens as a closable tab, after the
  terminals, when asked for (task menu, palette, its shortcut, the cost figure for Usage, a link that opens a doc)
  and stays until closed, per task, for the session. Closing the one showing goes back to the first terminal.
- **The task menu** starts with where the task is (branch, ahead/behind and changed files, environment; "No repo"
  for a task without one), then: the four views; Open in editor, the other editors, Open folder, Focus mode; Switch
  environment, Clean worktree, Scan for other repos, Add a worktree; Finish task, Discard task.
- **Run entries** of `.shellie.yml` are in the "+" menu under the terminal kinds.
- **Gone from the row:** the environment chip, the branch and git text, the Open folder / editor split button, the
  Focus toggle, the Clean worktree button, the old two-item "..." menu, and Finish / Discard in Focus.

## How it works

- `store.ts`: `shownTabsByTask` holds the open view tabs per task; `setTab` and every `open*` action add the tab,
  `closeTab` removes it. `activeTab` is unchanged, so a task without terminals still falls back to Usage, and a view
  that is showing is always in the row.
- `components/TaskBarMenu.tsx` builds its items from the commands the task's components offer (`useContributed`),
  in fixed sections by command id. The menu, the palette and the shortcuts therefore run the same functions.
- The components that used to be buttons (`OpenInEditor`, `EnvironmentChip`, `CleanWorktreeButton`, the workspace
  `TaskMenu`, the run entries) stay mounted `headless`: they render nothing and keep offering their commands, with
  the data they already loaded. The environment menu and its UAT / Production confirm open under the right end of
  the task bar.
- A view with something new (Usage, Docs) shows its dot on the tab when open and on its task menu item when closed.
- The editor commands cover what the editor menu did: the other editors, Visual Studio's solutions, and "No editor
  found: choose one in Settings" when there is none. Opening the task menu looks for editors again (#94).
- The tab row follows only the run entries of the task on screen (`useContributedWith`), so other offers (the nav,
  another task, a changed file count) do not re-render the terminals. The task menu closes when its task leaves
  the screen.

## Verified

- `npm test`, `npm run typecheck`, `npm run lint` pass.
- In the running app on macOS (fresh data folder, a task without a repo): the bar shows the shell tab, "+", the
  cost and "..."; the menu lists its items; Show usage and cost opens a closable Usage tab after the terminal.

## Known gaps

- Windows was not run.
- Not seen in the running app: a task with a repo (branch block, Docs, Changes, run entries, environment switch,
  Clean worktree, several repos). They are covered by tests only.
- Usage's "new" dot no longer shows in the tab row while its tab is closed: it is on the task menu item, and the
  "..." button itself carries no dot (spec). So new usage is not visible until the menu is opened.
- On a task without terminals the Usage tab cannot be closed (it is what shows); its close button does nothing.
- When the worktree goes missing while Docs or Changes shows, the view is blank until another tab is chosen (as
  before, but Usage is no longer in the row to click).
- After a task menu item runs, focus is on the "..." button, not back in the terminal.
- The task menu builds its own Focus mode item, a copy of the palette's.
- "Add to brain" is still Show brain.
- The palette's Switch environment opens the environment menu at the right end of the task bar, not by the palette.
