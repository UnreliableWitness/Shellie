# Fixes from a UX review, and a rail that tells tasks apart

Date: 2026-11-26. Asked by the owner in a session: "critically review the UX of the app", then "make a plan and
fix all + release also make sure the minimized left navbar is optimized". The review walked every screen of the
dev app on scratch data; the plan is `docs/superpowers/plans/2026-11-26-ux-review-fixes.md`.

## What changed

**The collapsed nav (the rail)**

- A task in the rail is a small tag, its work item's id or the initials of a blank task ("SN" for "Scratch
  notes"), where every blank task used to be the same document icon. The fly-out on hover shows the type icon,
  id and title as before (`railTag.ts`).
- Under 860 px of window width the nav is the rail whatever the setting; the setting is left alone and counts
  again when there is room. The expand button hides meanwhile (`useNarrowWindow.ts`).
- The New terminal menu is as wide as its items; it stretched across the whole tab row.

**Cost**

- While the usage receiver is not listening, the task bar's cost chip carries a warning mark with the reason, and
  the Usage tab and Home's Claude budget band show the same sentence with "Open settings". Before, a toast at
  start-up was the only sign and the chip showed €0.00 as if it were measured. All three go when a port change
  makes the receiver listen (`useReceiverStatus.ts`, on the existing `usage:receiverStatus` channel).
- Home's Cost tile says "in tasks this month": it counts Shellie's tasks, the budget band counts the vendor's
  whole month, and both said "this month" with different amounts.
- Usage without a price is a warning line, "Not in the total: no price for <model> (<tokens> tokens)", and the
  headline amount carries the mark. It was a muted footnote.

**Finish and Discard**

- Only real risks are amber on Finish: files not viewed and terminals still running are plain rows.
- With uncommitted changes the foot offers "Commit…" as the primary button beside the red "Discard changes and
  clean up", which was the only way forward. "Keep task" is "Back to task". "Add a worktree…" sits under the
  checks, not between two of them.
- The discard confirmation lies over the page instead of pushing it down.
- Discard is red and set apart from Finish in the task menu, and red in the palette.

**New task**

- Cancel and Create task are pinned at the foot of the side panel, and a disabled Create says why ("Pick a work
  item", "Give the branch a name", ...).
- The panel's heading follows the tab (it said "Blank task" on the Work item tab). "Typed" is "Enter by hand".
- The folder is one line cut at its start, the whole path in its tooltip.
- The table keeps its Title in a narrow window: Assigned to goes under 620 px of table width, State under 420 px.

**Home, Project, Sprint, Get started**

- A sprint that is over reads "Ended 32 days ago", not "Ends today".
- Project's sprint rows lose the words "To do ·" (they stood beside the item's real state) and offer no Start on
  a finished item.
- Get started's cards lose the number repeated in the title; step 4 without a project reads "Connect a project";
  an agent's version loses a trailing dot (`agentDetector.ts`).
- Up next's Start buttons are plain, so My tasks has no row of primary buttons.
- Week with nothing measured says how time gets measured; an empty brain's Read view has "Add a source".
- Sprint page: narrower fixed columns give Title 100 px more, and the "Shellie" column's header says what it
  shows.
- Home, Project and Secrets put their actions in the title row, like Sprint and Week.

## Verified

- `npm run typecheck`, `npm run lint`, and the renderer tests (169 files, 2024 tests) pass.
- In the running app on macOS (scratch data, the Azure DevOps test project, a scratch repo, three tasks, an
  empty brain, the usage port taken by another Shellie): Home with the capture-off line, the unpriced warning and
  the Cost tile; the rail with a fly-out in dark and light, and at 820 px; the task bar's chip and menus; the
  discard overlay; Finish with uncommitted changes; New task at 1440 and 900 px; Project, Week and the brain's
  Read view.

## Known gaps

- Windows was not run.
- Not seen for real: the capture-off mark going after a port change (tests cover it), Finish in a task with
  several repositories, the rail tag of a task with a work item (tests cover it), the State column going.
- Left as they are, on purpose: Finish and Discard as icons on the current task's row and the palette listing
  "This task" first (owner's choices of 2026-11-21 and 2026-11-23); the diff's side-by-side in a narrow pane (the
  View menu picks); the work item list's order (most recently changed first, from the tracker query); pull
  request titles starting with the work item id (Shellie's own default title, `prTitle()`); Home's length and
  its footer links.
- Changed files still show only in the task menu until the Changes tab is always in the row (pull request #387).
- With unpushed commits and no pull request, Finish still offers only the red button; no "Push" was added.
- `claude-fable-5-2` has no rate in the table, so its usage stays out of every total; the warning now says so,
  the price is not added here.
- A window under about 900 px with the wide nav still crowds New task; under 860 px the rail makes room.
