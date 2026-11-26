# The brain and Settings back in the nav, and a quicker project switch

Date: 2026-11-26. Asked by the owner in a session: "I want the brain to be accessible as it was. I want to be able
to switch projects easier. I want the settings button back." It takes back three things the quiet shell moved out
of the nav (`2026-11-23-quiet-shell-nav-home.md`, `2026-11-23-quiet-shell-no-header.md`).

## What changed

- **A line per brain** of the active project is back in the nav, between Home (and the project switcher) and the
  tasks, with a dot while the brain has something to read. The For you line "Something to read in ..." is gone:
  the dot says it. Home's brain tiles, the palette and Mod+Shift+B are as they were.
- **Sprint** is back as a line in the nav, above the brains (asked a little later in the same session). Its key,
  Home's tile and the palette are as they were.
- **Settings** is back as a line at the foot of the nav (a gear in the rail).
- **Switching project keeps the page.** Picking a project in the switcher or the palette used to open that
  project's page every time. Now Home, Sprint, Week, Dreams, the Project page, Settings and Secrets stay on screen
  and show the other project; from any other page (a task, a brain, a dream result, a form), which belongs to the
  project left behind, the switch goes Home.
- **Mod+Shift+O is "Next project"** (O for "other"): with two projects it flips between them, with more it goes
  round the list. It is in the palette with its key, and the switcher's tooltip names it. It does nothing with
  one project.

The switcher still shows only with two or more projects.

## How it works

- `store.ts`: `switchProject(id)` sets the picked project and goes Home unless the page is in `FOLLOWS_PROJECT`.
  A task's own pages decide the active project themselves (`activeConnection`), which is why a switch has to leave
  them.
- `commands/global.ts`: `nextProjectCommand()` reads the store when it runs, like `focusCommand()`, so the
  shortcut handler holds one instance (`registry.ts`) and builds nothing per key press.
- `TaskNav.tsx`: `NavItem` takes a `note`, which shows the dot and is said in the item's name ("Acme, something to
  read").
- Telemetry: `project.open` gains `from: 'key'`, and from the switcher and the palette it no longer means the
  Project page opened (`docs/telemetry.md`).

## Verified

- `npm run typecheck`, `npm run lint` and the renderer tests pass.
- In the running app on macOS (fresh data folder, two connections to the test project, one brain): the brain line
  and Settings show in the nav and in the rail and open their pages; a pick in the switcher on Sprint stays on
  Sprint and the brain line follows the project; Mod+Shift+O flips the project, and from the brain's page goes
  Home.

## Known gaps

- Windows was not run, and the Sprint line was added after the look in the running app (a test covers it).
- The dot on a brain line was not seen in the running app (the scratch brain had nothing to read); tests cover it.
- With several brains and a long task list the nav has less room for tasks, as before the quiet shell.
- Home's chips still open the Project page of the project clicked: there the page is what was asked for.
- A switch away from a brain or a task goes Home, not to the other project's brain or last task.
- The key cannot be changed, and Mod+Shift+O was not tried against an agent's own keys in a terminal.
