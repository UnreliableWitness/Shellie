# Quiet shell, step 2c: no header bar

Date: 2026-11-23. Spec: `docs/superpowers/specs/2026-11-23-quiet-shell-design.md`, section "The header bar". The
last change of the quiet shell, after the palette, the task bar, and the nav with Home.

## What changed

The 40 px header bar (logo, breadcrumb, settings gear) is gone on every screen. With a task open the window is the
nav, the task's tab row and the terminal.

Where its contents went:

- **Home:** the nav's Home item and the palette.
- **Project and Settings:** Home's quiet links and the palette.
- **The task crumb's card** (work item link, branch, git state, worktree path, cost): the task menu. It starts with
  the branch, git state and environment, and gains "Open <work item> in Azure DevOps" and "Copy worktree path". The
  cost per tool is on the Usage tab.
- **The environment crumb** for UAT and Production: the environment band, which was already there.
- **Page names:** each page's own heading.
- **The Dreams crumb above a dream result:** a "Dreams" back button in that page's head.

## The window's title bar

The header was also the title bar (#49). Now:

- **A task's tab row** drags the window, is 40 px high to match the window controls, and keeps clear of them: on
  Windows of the controls at its right end, on macOS of the traffic lights when the nav is hidden (Focus) or is the
  rail. These are the rules Focus mode already used, now always on.
- **macOS:** the nav leaves the traffic lights' row free at its top, and that row drags the window. A page's own
  header drags the window too (its buttons, inputs, links and tab lists do not).
- **Any other page** gets an empty 40 px strip at the top where the window controls would cover it: always on
  Windows (the controls are drawn over the top right, where a page's buttons are), on macOS only beside the rail
  (the lights are wider than the rail). On macOS with the wide nav there is no strip, so pages gain the 40 px.
- A system title bar (Linux) needs none of this.

## How it works

- `App.tsx`: `HeaderBar` is no longer rendered (the component and its test are deleted); a `.titlestrip` div is
  rendered above the page whenever no task tab row shows. CSS decides whether it takes space.
- `styles/shell.css`: the title bar rules, rewritten around the tab row, the strip, the nav and `.pagehead`.
- `TerminalTabs.tsx` offers `task.workItem` and `task.copyPath`; `TaskBarMenu.tsx` lists them.

## Verified

- `npm test`, `npm run typecheck`, `npm run lint` pass (one test in `src/main/brain/share/merge.test.ts` failed in
  two local runs, a different one each time; that file is not touched here).
- In the running app on macOS (fresh data folder), by screenshot and computed style: no header on Home and on a
  task; the tab row is 40 px and a drag region; the nav has 40 px free at its top; with the rail a page gets the
  strip and the tab row starts 30 px in; in Focus without the nav the tab row starts 78 px in; a page's header is a
  drag region.

## Known gaps

- **Windows was not run.** The strip and the tab row's right padding come from the rules Focus mode used on
  Windows, but pages under the strip, and the palette and menus near the window controls, were never seen there.
- Dragging the window, the traffic lights themselves and full screen were not tried by hand: the check read styles
  and screenshots, which do not show the window frame.
- On macOS a page without a `PageHeader` can be dragged only by the nav's top.
- The sprint's name is no longer shown outside the Sprint page and Home's Sprint tile.
- On Windows pages do not gain the header's 40 px: the strip takes it.
