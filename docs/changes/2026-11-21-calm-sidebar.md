# Calm sidebar: one fixed task list, one quiet mark per row

Branch `feat/calm-sidebar`. Spec: `docs/superpowers/specs/2026-11-21-calm-sidebar-design.md`, plan:
`docs/superpowers/plans/2026-11-21-calm-sidebar.md`. Replaces the lifecycle groups of
`2026-11-18-task-lifecycle-groups.md` in the left list; how PR status is read is unchanged.

The owner found the sidebar too busy: chips, dots, five group headings, and tasks that moved when one was opened, after
four idle hours and on every PR status refresh. It is now one list that stays put.

## The list

Open tasks of the active project in one list under "Tasks", newest first by `createdAt` (ties, and unreadable dates, by
id). Nothing else orders it: not a click, not time, not PR status (`listTasks` in
`src/renderer/components/TaskNav.tsx`). No group headings, no counts. Done stays behind its toggle.

## The one mark

A row is type icon, id, title, and at most one mark at the right, the first that applies (`taskMark` in
`src/renderer/taskMark.ts`):

1. red dot: the worktree folder is missing, or setup failed;
2. accent dot: setting up or finishing;
3. amber dot: something waits on the developer (CI failing, merge conflict, changes asked, unanswered comments, or an
   agent tab blocked on them);
4. green check: every live PR is merged.

The amber dot of a PR opens that PR, the green check opens the Finish page; the other marks only tell. What the mark
means, the repo ("webshop +1 repo") and the cost so far are in the row's tooltip (`rowTitle`). A blocked agent's mark
says what the agent asks ("Needs permission: …"). Chips, the cost, the repo name, muted titles and the dot for an agent
that merely finished its turn are gone from open rows; a done row still shows its cost.

`src/shared/pulse.ts` no longer decides groups. `taskSignal` returns `waits`, `merged` or `none` with the story line;
time plays no part, so `pulse:get` and `pulse:refresh` return the snapshot alone (no `lastActive`) and `usePulse` no
longer re-reads on `time:changed`.

## Finish and Discard

They are two icons inside the current task's row (ready, and not on its Finish page), so selecting a task changes no
row's height or position. The line under the row is gone. The merged check gives way to the Finish icon on that row;
an amber or red mark stays beside the icons (the spec said the icons take the mark's place: kept, because failing CI
or a blocked agent on the task you are on would otherwise be invisible).

## The rail and the foot

The collapsed rail shows the icons in list order with a corner dot (red, accent, amber) or a small green corner check.
The count pill, the separators, the dimming and the hollow Finish square are gone; Finish and Discard stay under the
current icon. The foot's connection line shows only without a connection or when its status is not ok.

Telemetry: `nav.chipClicked` keeps its name; `kind` is now `waits` or `merged` (`docs/telemetry.md`).

## Verified

- Vitest: `src/shared/pulse.test.ts` (the signal), `src/renderer/taskMark.test.ts` (mark precedence, tooltip),
  `TaskNav.test.tsx` (order pinned across opening a task and a `pulse:changed`, marks, inline Finish, rail, foot),
  `handlers.part4.test.ts` (`pulse:get`). Full `npm test`, `npm run typecheck` and `npm run lint` pass.
- Real app (macOS, `npm start` on a fresh `SHELLIE_USER_DATA` folder, tasks put into the renderer store by hand): the
  list in newest-first order; red, accent and amber dots; selecting a task left every row at the same top and height
  (measured before and after); Finish and Discard inside the current row; the rail with corner dots; the foot's
  "not connected" line.

## Not verified, and known gaps

- The green check, the amber dot of a PR and opening a PR from it were not seen in the real app (no Azure DevOps
  connection in the fresh folder); tests only. A quiet foot with a working connection likewise.
- "In review" and "parked" are no longer told apart at a glance, and an agent that finished its turn no longer marks
  its task in the list (the task's own tab still does).
- On the current row an amber mark plus the two icons leave little room for the title at the default 240 px width.
- In the rail, Finish and Discard under the current icon still push the icons below it down when a task is selected.
- Windows was not run.
