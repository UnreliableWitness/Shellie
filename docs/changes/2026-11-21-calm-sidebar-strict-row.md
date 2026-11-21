# Calm sidebar: no mark on the current row

Follows `docs/superpowers/specs/2026-11-21-calm-sidebar-design.md` ("Finish and discard"), as the owner asked on
2026-11-21 after the first version (`2026-11-21-calm-sidebar.md`) kept an amber or red mark beside the icons.

## How it works

On the current task's row, while Finish and Discard show (task ready, Finish page not open), no mark is drawn: the
two icons take its place, whatever the mark would be. The row's tooltip still starts with the mark's text (for
example "CI failing: PR build"), and the collapsed rail still shows its corner dot. One line in `Row` in
`src/renderer/components/TaskNav.tsx`.

## Verified

- `TaskNav.test.tsx`: a current task with failing CI shows Finish and no mark, and its tooltip names the failure
  (failed before the change); a blocked agent on a merged task still shows amber when the task is not the current one.
- `npm test`, `npm run typecheck`, `npm run lint`.

## Known gaps

- Not looked at in the running app.
- Failing CI or a blocked agent on the task you are on is no longer visible in the list itself, only in the row's
  tooltip, the task's own tabs and the rail.
