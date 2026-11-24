# Collapsed sidebar: a task folds open on hover

Date: 2026-11-24. Asked by the owner in a session: in the collapsed sidebar the text on hovering a task looked
weird, and Finish and Discard should fold open to the right on hover instead of always showing.

## What changed

- Pointing at a task's icon in the collapsed sidebar (the rail) folds the row open to the right, over the page:
  the work item id and title, what the task's mark tells (CI failing, merged, waiting), and Finish and Discard.
  Moving onto the fly-out keeps it open; leaving it, a click on one of its buttons, or Escape folds it again.
- Finish and Discard are no longer two extra rows under the current task's icon, so the icons below it no longer
  move when another task is opened. The fly-out has them for every task that is ready, not only the current one
  (not on the task's own Finish page).
- The icon has no tooltip any more: the system tooltip was the "weird text" (Claude's reading of the report: it
  came late, in the system's own style, and hid what was under it). The fly-out says the same and comes at once.
- The icon's name for a screen reader now includes what its mark tells.

## How it works

`RailRow` in `src/renderer/components/TaskNav.tsx` wraps the icon and the fly-out in one element, so the pointer
moving from the icon onto the fly-out never leaves it. The fly-out is `position: fixed` at the row's place in the
window, because the task list scrolls and would clip it; it opens on pointer enter and on focus, so Tab from an
icon reaches its Finish and Discard. It folds open with a 120 ms clip, none under reduced motion (`.rail-fly` in
`shell.css`).

## Verified

- `npm run typecheck`, `npm run lint` and the tests of the nav pass.
- In the running app on macOS, dark and light: the fly-out of a current and another task, moving the pointer onto
  it, and leaving it.

## Known gaps

- Windows was not looked at.
- The fly-out does not follow the list when it is scrolled with the pointer resting on an icon; it folds on the
  next pointer move off the row.
- Home, New task and the For you icons in the rail keep their system tooltips.
- A touch screen has no hover: there a tap opens the task, and Finish and Discard are reached from the task
  itself or the wide sidebar.
