# Quiet shell, steps 2b and 3: the nav and Home

Date: 2026-11-23. Spec: `docs/superpowers/specs/2026-11-23-quiet-shell-design.md`, sections "The nav" and "Home".
Follows the palette and the task bar (`2026-11-23-quiet-shell-palette.md`, `2026-11-23-quiet-shell-taskbar.md`).
The header bar is the last change.

## What changed

**The nav** holds the "Go to or run" field, Home, the task list with New task, and at its foot a "For you" block.
Project, Sprint, Week, Dreams, the brain items and Settings are gone from it; they are on Home, in the palette, and
(Settings) still in the header for now.

- The project switcher shows only with two or more projects, under Home.
- The task list is exactly the calm sidebar's.
- **For you** has a line only while its reason holds: "N dreams to review" (opens Dreams), "Dreaming about X"
  while a dream runs (its panel with Stop this dream, as before), "Something to read in <brain>" by the same rule
  the brain items' dot followed (opens the brain; with several, Home), and the offer to join the team's brain. The
  heading shows only with a line. The block sits under the scrolling list, so a line coming or going never moves a
  task.
- The foot keeps the connection line and the pull request note, which show only when something is wrong, and the
  collapse button.
- The rail has the palette icon, Home, the task icons and the For you lines as icons with a dot.

**Home** gets a Places band after the bands that ask for something (What's new, Get started, the dream result):
Sprint (its name once known), Week, Dreams (what waits, or its state), one tile per brain of the active project
(with "Something to read"), and Cost (the month's total; it scrolls to Stats). With two or more projects the band
names the active one. At the foot, quiet links: Project, Settings, Secrets, Get started. The other bands are as
they were.

## How it works

- `TaskNav.tsx` renders the For you block from data it already had (brains, reading, dreams); `DreamNavStatus`
  takes `onlyRunning`. `DreamsNavItem.tsx` is deleted. The heading hides with CSS `:has()` when no line is rendered,
  because two of the lines (the running dream, the join offer) decide for themselves whether they show.
- `components/home/PlacesBand.tsx`: the tiles and the links. It asks for the brains itself (one more `brain:list`
  when Home opens) and for the month's stats (`home:stats`).
- Telemetry: `home.clicked` gains `place-sprint`, `place-week`, `place-dreams`, `place-brain`, `place-cost`.

## Verified

- `npm test`, `npm run typecheck`, `npm run lint` pass.

## Known gaps

- Windows was not run.
- Home's "For you" is not a section of its own: tasks that wait on the user are in My tasks as before, and the join
  offer is in the nav only. The dream states "off", "on" and "no limit" are on the Dreams tile, not in the nav.
- The Sprint tile shows the sprint's name only after the Sprint page has loaded it once; the Week tile has no figure.
- "Done tasks" and "What is new" are not among the quiet links: the Done list is in the nav, and the What's new card
  cannot be reopened.
- In Focus mode the nav and its For you block are hidden, as the spec says.
