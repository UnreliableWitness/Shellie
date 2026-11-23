# Quiet shell: the simplify pass

Date: 2026-11-23. A `/simplify` review of the whole quiet shell change (`2026-11-23-quiet-shell-*.md`): four reviews
(reuse, simplification, efficiency, depth of fix), then the fixes below. No behaviour was meant to change, with the
two exceptions named under "Faster".

## Faster

- **The shortcut handler** (`hooks/useShortcuts.ts`) ran on every key press with Ctrl or Cmd down, which in a shell
  is every Ctrl+C, and built the whole command list each time (the task list filtered and sorted, every place).
  It now ignores the mod key itself and a held key, and asks only for the commands that have a shortcut
  (`shortcutCommands` in `commands/registry.ts`): what components offer, and Focus mode.
- **Looking for editors** ran each time the task menu opened; in main that starts processes on Windows. It now runs
  at most once per five minutes of menu openings (`EDITORS_EVERY_MS` in `TerminalTabs.tsx`). An editor installed
  while Shellie runs therefore shows up after at most that long, or when the task is opened again.
- **The palette** followed every store change while open; it now follows the tasks, the projects and what is on
  screen (`useAllCommands`), and numbers its rows from one map instead of a search per row.

## One place instead of several

- `hooks/useProjectBrains.ts`: the active project's brains and which have something to read. The nav, the
  palette's places and Home's tiles each had their own copy of that rule.
- `hooks/useLatest.ts`: the "ref that holds the last render's value", written out six times for commands.
- `focusCommand()` in `commands/global.ts`: the task menu rebuilt Focus mode and its shortcut itself.
- The view tabs' shortcuts are stated once (`VIEW_TABS` in `TerminalTabs.tsx`); `hasTerminals` from `TaskScreen.tsx`
  decides in `App.tsx` whether a task shows its tab row.

## Removed

- The buttons of four components that the task bar no longer shows and that were mounted only to offer commands.
  They render nothing now and are named for what they are: `EditorCommands` (was `OpenInEditor`),
  `CleanWorktreeCommand` (was `CleanWorktreeButton`), `WorkspaceCommands` (was `TaskMenu` in `WorkspaceChips.tsx`)
  and `EnvironmentMenu` (was `EnvironmentChip`: the menu and confirm stay, the chip is gone). Their tests run the
  commands instead of clicking buttons.
- `DreamNavStatus`'s states other than "a dream runs": nothing showed them since the nav's For you block.
- The project tile for a single project and its "No project" avatar, the nav item's `note`, the store's
  `sprintName` (only the header read it), and the styles of the breadcrumb, the task card, the Dreams count, the run
  chips, the branch text and the environment chip.

## Verified

- `npm test`, `npm run typecheck`, `npm run lint` pass.
- In the running app on macOS: Cmd+0 opens Usage from a focused terminal, the palette runs Focus mode, the task
  menu lists its items and its Focus mode item turns Focus off.

## Left as it is, from the reviews

- **Who owns the tabs.** Which view tabs exist and which is showing is still decided partly in the store and
  partly in `TerminalTabs.tsx`. One function owning both would also fix Usage not closing on a task without
  terminals and the blank view when a worktree disappears; that changes behaviour, so it is not in this pass.
- **Command sections.** The task menu still picks its items by command id (`SECTIONS` in `TaskBarMenu.tsx`), the
  "+" menu by an id prefix, and the registry orders with `FIRST_SOURCE` and `last`. A `section` on each command
  would replace all four; a new task command today needs a line in `SECTIONS` or it is missing from the menu.
- **Brains asked for twice.** Home's Places and the nav each call `brain:list`; a shared cache in `useBrains.ts`
  would make it one and let the palette's places always be mounted. The month's stats are likewise asked for by
  both the Cost tile and the Stats band.
- The environment menu still finds its place through a hidden anchor in the task bar.
- Copying to the clipboard with an error notice is written out in four places (three older than this work), and
  "open Project and count it" in five.
- The changed-file count re-offers the task's whole command list when it moves.
