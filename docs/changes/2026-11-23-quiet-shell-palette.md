# Quiet shell, step 1: the command palette

Date: 2026-11-23. Spec: `docs/superpowers/specs/2026-11-23-quiet-shell-design.md` (step 1 of 3). Plan:
`docs/superpowers/plans/2026-11-23-quiet-shell-1-palette.md`. Mockups: design canvas "Shellie Quiet Shell",
https://claude.ai/artifact/WwAVSXyXiLq69UNZcWeskr.

## What changed

Every place and action can now be reached by typing. Mod+Shift+P (Cmd on macOS, Ctrl on Windows), or the "Go to or
run" field at the top of the nav, opens a palette: this task's actions, the places, the open tasks, the app's
switches. Nothing was removed from the UI in this step; steps 2 and 3 take chrome away now that the palette can
reach everything.

## How it works

- A command is a plain object (`src/renderer/commands/types.ts`): id, title, group, optional shortcut and note.
- `commands/global.ts` builds the commands that need only the store: Home, Sprint, Week, Project, New task,
  Settings, Secrets, the switch to another project, the active project's open tasks, Focus mode, the nav toggle,
  Get started.
- Components offer the commands only they can know, for as long as they are mounted (`useContributeCommands` in
  `commands/registry.ts`): the task bar (tabs, terminals, new terminals, Finish, Discard), its run entries, the
  editor button, the task menu, Clean worktree, the environment chip, the nav (brains, Done tasks) and the Dreams
  item. So nothing is fetched because the palette opened, and a command whose data has not loaded is not listed.
  Hidden task layers offer nothing.
- `hooks/useShortcuts.ts` no longer hard-codes keys: it runs the command whose shortcut matches. The keys are the
  same as before. While the palette is open no other shortcut runs.
- `components/CommandPalette.tsx` is mounted once and renders only while open. It filters by subsequence
  (`commands/match.ts`), keeps its key presses from everything behind it, and gives focus back on close.
- Telemetry: `palette.open` and `palette.run` with the command id (fixed strings or an index), in `docs/telemetry.md`.

## Verified

- `npm test`, `npm run typecheck`, `npm run lint` pass.
- In the running app on macOS, on a fresh data folder, driven over CDP: the palette opens on Cmd+Shift+P over Home
  and over a focused shell terminal; typing filters; Enter on "Sprint" opens Sprint; typed letters do not reach the
  shell; Escape returns focus to the terminal; "usage" then Enter opens the Usage tab; Cmd+1 and Cmd+0 still switch
  tabs.

## Known gaps

- Windows was not run.
- Not seen in the running app: brains, Dreams, run entries, other editors, Clean worktree and Switch environment in
  the palette (the test data folder had no project or repo). Of these, Clean worktree, run entries, the other
  editors and Dreams have no test either.
- Mod+Shift+B now works once the task's Brain tab is there; in the first moments after a task opens the key goes to
  the terminal. Before, the key asked main for the brain on each press.
- "Add to brain" is not its own command yet: Show brain opens the tab where adding happens. Step 2 gives it one.
- With two or more repos in a task, the palette lists a new-terminal command per kind and repo, which is long.
