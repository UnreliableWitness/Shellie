# Quiet shell, step 1: command registry and palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every place and action in Shellie is reachable by typing in one palette (Mod+Shift+P), with nothing removed from the UI yet.

**Architecture:** A command is a plain object. Commands that depend only on the store are built by one pure function. Commands that depend on what a component already knows (the task's brain, the editor list, `.shellie.yml` run entries, whether Clean worktree applies) are contributed by that component while it is mounted, into a small zustand store keyed by source. The palette and the shortcut handler both read the merged list. Nothing is fetched because the palette opened.

**Tech Stack:** React, TypeScript, zustand, Vitest with Testing Library; no new dependency.

**Spec:** `docs/superpowers/specs/2026-11-23-quiet-shell-design.md` (sections "The command registry and the palette", "Speed", "Order of work" item 1).

## Global Constraints

- Nothing visible today is removed or moved in this step, except the new "Go to or run" field at the top of the wide nav.
- The palette opens with Mod+Shift+P (Cmd on macOS, Ctrl elsewhere), also while a terminal has focus. Not Mod+K.
- The shortcut listener stays in the capture phase on `window` and stops an event only when it acts.
- Existing shortcuts keep their keys and conditions: Mod+Shift+F Focus, Mod+Shift+D Docs, Mod+Shift+B Brain, Mod+1..9 terminals, Mod+0 Usage; digits match `e.code` (`Digit`/`Numpad`).
- No command's presence or note may await anything at palette open.
- Telemetry carries the command id only; ids are fixed strings or use an index, never a task, project, repo, brain or file name.
- Destructive commands go through their existing confirmation.
- Checks: `npm test`, `npm run typecheck`, `npm run lint`.

## Review Focus

- Mod+Shift+P pressed while the palette is open: it closes, focus returns to where it was.
- A contributed command whose component unmounts while the palette is open (task finishes): the row disappears, Enter on a stale selection does nothing harmful.
- Two connections, a task of the other project selected: `Tasks` lists only the active project's open tasks, as the nav does.
- A query that matches nothing: an empty state line, Enter does nothing.
- Typing in the palette must not reach the terminal or trigger Mod+digit tab switches behind it.

---

### Task 1: Command type, matching, shortcut helpers

**Files:**
- Create: `src/renderer/commands/types.ts`, `src/renderer/commands/match.ts`, `src/renderer/commands/shortcut.ts`
- Test: `src/renderer/commands/match.test.ts`, `src/renderer/commands/shortcut.test.ts`

**Interfaces (produces):**

```ts
// types.ts
export type CommandGroup = 'task' | 'goto' | 'tasks' | 'app';
export const GROUP_TITLE: Record<CommandGroup, string>; // 'This task' | 'Go to' | 'Tasks' | 'App'
export const GROUP_ORDER: CommandGroup[];               // task, goto, tasks, app
/** `code` is KeyboardEvent.code; 'Digit3' also matches 'Numpad3'. Mod is always required, Alt never. */
export type Shortcut = { code: string; shift?: boolean };
export type Command = {
  id: string; title: string; group: CommandGroup;
  shortcut?: Shortcut; note?: string; noteTone?: 'accent';
  run(): void;
};
// match.ts
/** Empty query: the commands as given. Otherwise those whose title contains the query as a case-insensitive
 *  subsequence, best first: a substring match beats a scattered one, an earlier match beats a later one, ties keep order. */
export function rank(query: string, commands: Command[]): Command[];
// shortcut.ts
export function matches(e: Pick<KeyboardEvent,'code'|'shiftKey'|'altKey'|'metaKey'|'ctrlKey'>, s: Shortcut, mac: boolean): boolean;
export function shortcutLabel(s: Shortcut, mod: 'Cmd' | 'Ctrl'): string; // 'Ctrl+Shift+P', 'Cmd+0'
```

- [ ] Tests: `rank('', cs)` returns `cs`; `rank('spr', …)` puts "Sprint" before "Switch to project Rome"; `rank('SC', …)` finds "Show changes"; `rank('zzz', …)` is `[]`. `matches` accepts `Numpad3` for `Digit3`, rejects when Alt is down, when Shift differs, and when the platform's mod key is not down. `shortcutLabel({code:'KeyP',shift:true},'Ctrl') === 'Ctrl+Shift+P'`, `shortcutLabel({code:'Digit0'},'Cmd') === 'Cmd+0'`.
- [ ] Run them failing, implement, run passing, commit.

### Task 2: The registry

**Files:**
- Create: `src/renderer/commands/registry.ts`, `src/renderer/commands/global.ts`
- Modify: `src/renderer/store.ts` (add `paletteOpen: boolean`, `setPaletteOpen(v: boolean): void`)
- Test: `src/renderer/commands/registry.test.tsx`, `src/renderer/commands/global.test.ts`

**Interfaces (produces):**

```ts
// registry.ts
/** Commands a mounted component offers, replaced whenever `commands` changes and withdrawn on unmount.
 *  Pass a memoised array; an empty array withdraws. */
export function useContributeCommands(source: string, commands: Command[]): void;
export function contributed(): Command[];            // every source's commands, sources in insertion order
export function allCommands(): Command[];            // globalCommands(useStore.getState()) then contributed(), in GROUP_ORDER, stable within a group
export function useAllCommands(): Command[];         // the same, as a hook that follows both stores
// global.ts
export function globalCommands(s: StoreState): Command[];
```

`globalCommands` returns, from the store alone:

| id | title | group | when |
|---|---|---|---|
| `goto.home` | Home | goto | always |
| `goto.sprint` | Sprint | goto | always |
| `goto.week` | Week | goto | always |
| `goto.project` | Project | goto | an active connection |
| `goto.settings` | Settings | goto | always |
| `goto.newTask` | New task | goto | always |
| `goto.secrets` | Secrets | goto | always |
| `goto.connection.<index>` | Switch to project `<name>/<project>` | goto | two or more connections, not the active one; sets the connection and opens Project |
| `tasks.open.<index>` | Task `<work item id or name>`: `<title>` | tasks | each open task of the active project, in the nav's order (`listTasks` from `TaskNav.tsx`, exported) |
| `app.focus` | Focus mode | app | shortcut Mod+Shift+F; always (it toggles the preference, as today) |
| `app.nav` | Collapse navigation / Expand navigation | app | always |
| `app.getStarted` | Get started | app | always |

- [ ] Tests for `global.ts`: with one connection there is no `goto.connection.*`; with two, exactly one, and running it calls `setConnectionId` and lands on `project`; `tasks.open.*` excludes done tasks and other projects' tasks; ids contain no task or project name.
- [ ] Tests for `registry.tsx`: a component using `useContributeCommands('x', [a])` makes `a` appear in `allCommands()`; rerendering with `[b]` replaces it; unmounting removes it; `allCommands()` orders task, goto, tasks, app regardless of contribution order.
- [ ] Implement, run, commit.

### Task 3: The palette

**Files:**
- Create: `src/renderer/components/CommandPalette.tsx`, `src/renderer/styles/palette.css` (imported where the other style sheets are)
- Modify: `src/renderer/App.tsx` (`<CommandPalette />` in `Shell`, after `<Notices />`), `docs/telemetry.md`
- Test: `src/renderer/components/CommandPalette.test.tsx`

**Behaviour:**

- Always mounted; renders nothing while `paletteOpen` is false. On open it remembers `document.activeElement`, focuses its field, and clears the query; on close it restores that focus.
- `role="dialog"`, `aria-label="Go to or run"`, a backdrop that closes on mouse down. The field is a combobox over a `role="listbox"`; rows are `role="option"` with `aria-selected`.
- Empty query: groups in `GROUP_ORDER` with `GROUP_TITLE` headings. With a query: `rank`, no headings. No match: one line, "No match".
- Keys, handled on the dialog and stopped there so nothing behind sees them: ArrowDown/ArrowUp move and wrap, Enter runs the selected command, Escape closes. The selection is index 0 on open and after every query change, and is clamped when the list shrinks.
- Running: close first, then `run()`, then `track('palette.run', { command: id })`. Opening tracks `palette.open`.
- A row shows the title, then at the right the note (amber when `noteTone === 'accent'`) or else the shortcut label.
- The foot line reads: "Up and Down to move · Enter to open · Esc to close".
- Look: the canvas screen "The palette"; app tokens (`--panel`, hairline and accent variables already in `styles/`), 600px wide, top at 96px, list scrolls at 60vh.

- [ ] Tests: opening focuses the field; typing "spr" shows Sprint first and no headings; Enter runs it and closes; Escape closes and returns focus to the element focused before; ArrowUp from the first row selects the last; "zzz" shows "No match" and Enter runs nothing; a command withdrawn while open disappears and Enter does not throw; `keydown` events inside the palette do not reach a `window` capture listener's handlers for Mod+digit (assert the active tab is unchanged).
- [ ] Add `palette.open` and `palette.run` (property `command`) to `docs/telemetry.md`.
- [ ] Implement, run, commit.

### Task 4: Shortcuts read from the registry

**Files:**
- Modify: `src/renderer/hooks/useShortcuts.ts`
- Test: `src/renderer/hooks/useShortcuts.test.tsx` (new)

- `useShortcuts` keeps one capture-phase `keydown` listener. Mod+Shift+P toggles `paletteOpen`. While the palette is open no other shortcut runs. Otherwise it runs the first command of `allCommands()` whose `shortcut` `matches` the event, and prevents and stops the event only then.
- The hard-coded D, B and digit branches are deleted; Task 5 contributes those commands. The IPC call on Mod+Shift+B goes.

- [ ] Tests: Mod+Shift+P opens, again closes; a contributed command with `{code:'KeyD',shift:true}` runs on Mod+Shift+D and the event is default-prevented; with no matching command the event is not prevented; with the palette open Mod+Shift+D runs nothing.
- [ ] Implement, run, commit (together with Task 5, so no commit leaves the existing shortcuts dead).

### Task 5: Components contribute their commands

**Files (modify):** `components/TerminalTabs.tsx` (and its `RunChips`), `components/OpenInEditor.tsx`, `components/WorkspaceChips.tsx` (`TaskMenu`), `components/secrets/CleanWorktreeButton.tsx`, `components/secrets/EnvironmentChip.tsx`, `components/TaskNav.tsx`, `components/dreams/DreamsNavItem.tsx`
**Tests:** extend each component's existing test file with one case that renders it and asserts its commands through `allCommands()`.

Each contributes only when it would show its control today (`TerminalTabs`: `visible && ready`), with a memoised array, and each `run` calls the same function the control calls.

| Source | Commands (id: title) |
|---|---|
| `TerminalTabs` | `task.usage`: Show usage and cost (Mod+0); `task.docs`: Show docs (Mod+Shift+D, when `hasGit`); `task.changes`: Show changes (when `hasGit`; note "`n` files" when `changeCount`); `task.brain`: Show brain (Mod+Shift+B, when `brainShown`); `task.terminal.<n>`: Switch to terminal `<n>`: `<label>` (Mod+`n` for 1..9); `task.new.<kind>`: New terminal: `<title>` for each entry of `NEW_TERMINALS` (exported from `NewTerminalMenu.tsx`), and with two or more workspaces one per kind and workspace, `task.new.<kind>.<workspace index>`: New terminal: `<title>` in `<repo>`; `task.new.brain`: New terminal: Brain (when the menu would offer it); `task.finish`: Finish task; `task.discard`: Discard task (`askDiscard`) |
| `RunChips` | `task.run.<workspace index>.<entry index>`: Run `<name>` (in `<repo>` when grouped) |
| `OpenInEditor` | `task.folder`: Open folder; `task.editor`: Open in editor (the chosen one, available before options load); `task.editor.<editor id>`: Open in `<label>` for the others once `opts` is loaded |
| `TaskMenu` | `task.scan`: Scan for other repos; `task.addWorktree`: Add a worktree |
| `CleanWorktreeButton` | `task.cleanWorktree`: Clean worktree (only when the button shows) |
| `EnvironmentChip` | `task.environment`: Switch environment (opens the chip's own menu, so the UAT and Production confirm is unchanged) |
| `TaskNav` | `goto.brain.<index>`: Brain: `<name>` (accent note "something to read" by the existing dot rule); `goto.done`: Done tasks (when there are any; expands the nav if collapsed and opens the Done list) |
| `DreamsNavItem` | `goto.dreams`: Dreams (when it renders; accent note "`n` to review" when the count is above zero) |

"Add to brain" from the spec is `task.brain` in this step: the Brain tab is where adding happens, and the tab has no way to be opened on a sub-view yet. It becomes its own command in step 2 with the on-demand tabs.

- [ ] Write the per-component cases, run failing, implement, run the whole suite, commit with Task 4.

### Task 6: The nav field, and the write-up

**Files:**
- Modify: `src/renderer/components/TaskNav.tsx` (a button above `ProjectTile` in the wide nav: search icon, "Go to or run", the shortcut label at the right; `aria-label="Go to or run"`; it opens the palette. The rail gets the icon only.), its CSS and test
- Create: `docs/changes/2026-11-23-quiet-shell-palette.md` (the spec it follows, how it works, what was verified, known gaps: Windows not run; "Add to brain" folded into Show brain; the palette lists only commands of mounted components)

- [ ] Test: clicking the field sets `paletteOpen`.
- [ ] `npm test`, `npm run typecheck`, `npm run lint` all pass.
- [ ] Run the app on a fresh data folder (`SHELLIE_USER_DATA=<scratch path> npm start`) and check by hand or over CDP: the palette opens over a focused terminal and focus returns to it on Escape; Mod+1, Mod+0, Mod+Shift+D still switch tabs; typing in the palette does not reach the terminal.
- [ ] Commit, push, open the pull request.
