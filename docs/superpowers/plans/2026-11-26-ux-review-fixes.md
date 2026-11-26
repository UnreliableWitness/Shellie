# UX Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix what the UX review of 2026-11-26 found on the running app, and make the collapsed nav (the rail) tell tasks apart.

**Architecture:** No new screens and no new permanent controls. Each fix changes the component that showed the problem; a warning shows only while something is wrong. Five task groups touch disjoint components, so they run in parallel in one working tree and land as one pull request.

**Tech Stack:** Electron, React, TypeScript, zustand store, Vitest with Testing Library, plain CSS with tokens.

**Spec:** the review itself (the session of 2026-11-26); its findings are restated per task below, so this file stands alone.

## Global Constraints

- Calm UI (owner, 2026-11-21 and 2026-11-23): nothing moves by a click, a timer or a background refresh; status is one quiet mark plus words on demand; a feature gets permanent screen space only by an explicit decision.
- Colours only through the existing CSS tokens; both themes.
- No change to telemetry event names, IPC channel names or stored data shapes unless a task says so; `docs/telemetry.md` stays in sync if an event is added.
- Format with `oxfmt` (`npx oxfmt --write <files>`), never prettier. Checks: `npm run typecheck`, `npm run lint`, `npx vitest run <touched test files>`.
- Agents working in parallel: edit only the files of your task, do not commit, do not run the whole test suite.
- Owner decisions that stay: Finish and Discard as icons on the current task's row; the palette lists "This task" first; Home keeps its bands; the diff's side-by-side or inline is the user's pick in View.

## Review Focus

- A sprint with no finish date, and one that ends today: the label must stay "Ends today" or absent, never "Ended 0 days ago".
- The usage receiver comes up after a port change in Settings: the capture-off mark must go without a restart.
- A task with no uncommitted changes: Finish keeps one primary button, "Finish and clean up".
- A work item id of five or more digits, and a task name of one word or starting with a symbol: the rail tag must still fit 48 px and show something.
- A window dragged across the narrow breakpoint while the rail fly-out is open: no stuck fly-out, and the saved collapsed setting is not changed.

---

### Task 1: Cost signals

**Files:** `src/renderer/components/TerminalTabs.tsx` (the cost chip), `src/renderer/components/UsagePanel.tsx`, `src/renderer/components/home/PlacesBand.tsx`, `src/renderer/components/home/BudgetBand.tsx`, their tests and CSS; main-side IPC only if no channel already reports the receiver's state (see `src/main/ipc/handlers.ts` near "AI usage capture is off").

- [ ] **Capture off is visible while it is off.** When the usage receiver is not listening, the task bar's cost chip carries a warning mark and its title says `AI usage capture is off: <error>. Pick another port in Settings > AI cost and invoicing.`; the Usage tab and Home's budget band show the same sentence as a warning line with a button "Open settings" (opens Settings at AI cost). All three go when the receiver listens again. Tests: chip with receiver off and on; the line on Usage.
- [ ] **One "this month" on Home.** Find what Places' Cost tile (`month.costEur`) and the budget band's headline each count. The tile must show the same quantity as the headline, or say what it counts (for example "€0.00 in tasks this month"). Test pins the tile's text against a fixture where both differ.
- [ ] **Unpriced usage is not a footnote.** When a period has unpriced tokens, the "Unpriced:" line is a warning line reading `Not in the total: no price for <model> (<tokens> tokens)` and the headline amount carries the warning mark with that sentence as its title. Test with one unpriced model and with none.
- [ ] Run the touched tests and `npm run typecheck`.

### Task 2: Finish, Discard and the task's menus

**Files:** `src/renderer/screens/FinishScreen.tsx` and test, the discard confirmation (find `askDiscard`'s banner) and its CSS, `src/renderer/components/TaskBarMenu.tsx`, `src/renderer/components/CommandPalette.tsx` and tests.

- [ ] **Only real risks are amber.** "N files not viewed" and "N terminal(s) still running" become neutral information rows (the style of "Nothing to push" without the green tick); uncommitted and unpushed work stay warnings. Tests assert the row classes.
- [ ] **A way forward that does not destroy.** With uncommitted changes the foot reads: `Back to task`, `Commit…` (primary; the same action as the row's Commit…), `Discard changes and clean up` (danger). Without them: `Back to task`, `Finish and clean up` (primary). "Keep task" is renamed "Back to task" wherever that button shows. Tests for both states.
- [ ] **"Add a worktree…" moves** under the last safety check, out from between two of them.
- [ ] **The discard confirmation lies over the page** (absolute at the top of the content, with the card shadow) so the page under it does not move. Focus and keys as they are.
- [ ] **Discard is marked as destructive** in the task menu (a separator between Finish and Discard, Discard in the danger colour) and in the palette (danger colour).
- [ ] Run the touched tests and `npm run typecheck`.

### Task 3: New task

**Files:** `src/renderer/screens/NewTaskScreen.tsx` and test, its CSS in `src/renderer/styles/screens.css`.

- [ ] **Create is always on screen.** Cancel and Create task sit in a foot pinned to the bottom of the side panel; the rest of the panel scrolls above it.
- [ ] **A disabled Create says why**, in a muted line left of the buttons, from the screen's own validation (for example "Pick a work item", "Give the branch a name").
- [ ] **The panel's heading follows the tab.** "Blank task" only on Blank; on Work item with nothing picked: "Work item" over "Pick a work item"; on the hand-typed tab: its own words.
- [ ] **The tab "Typed" is named "Enter by hand".** Telemetry values and test ids keep their names.
- [ ] **The folder is one line**, cut at its start with an ellipsis, the whole path in `title`.
- [ ] **The table keeps its Title** at any width: Title takes the free width with a floor of 160 px; under 620 px of table width the Assigned to column goes. Test or a manual check at a 900 px window.
- [ ] **Row order.** If the list is in the tracker's backlog order, leave it; if it is in no deliberate order, sort by id ascending. Say which in the report.
- [ ] Run the touched tests and `npm run typecheck`.

### Task 4: Home, Project, Sprint, Get started, empty states

**Files:** `src/renderer/components/home/SprintsBand.tsx`, `src/renderer/screens/project/SprintBand.tsx`, `src/renderer/screens/GetStartedScreen.tsx` and Home's get-started band, the Up next card, `src/renderer/screens/WeekScreen.tsx`, `src/renderer/components/brain/BrainRead.tsx`, `src/renderer/screens/SprintScreen.tsx`, page headers; tests and CSS of each.

- [ ] **`daysLeft(finish)`** returns `Ended yesterday` / `Ended N days ago` for a finish date before today, `Ends today` on the day, the existing words after it, null without a date. Tests with a fixed clock: finish 2026-10-25, now 2026-11-26 gives `Ended 32 days ago`.
- [ ] **Project's sprint rows**: the words "To do ·" go; a row without a task shows only the `Start` link, and none when the item's state is a completed one.
- [ ] **Get started**: titles lose the doubled number ("Agents", not "1 · Agents"); Home's band and the wizard's step chips read the same step state for Agents; a version's trailing dot is trimmed ("1.0.57", not "1.0.57."); step 4's button without a project reads "Connect a project".
- [ ] **Up next**: its Start buttons use the plain button style, not primary.
- [ ] **Empty states**: Week says how time gets measured (check the mechanism and write what is true) ; the brain's Read view with no pages has a button "Add a source" that opens Add.
- [ ] **Sprint page**: the Title column takes the free width; the "Shellie" column's header has a `title` saying what it shows.
- [ ] **Page headers**: if `PageHeader` has a slot for actions, Home, Project and Secrets put their actions in the title row like Sprint and Week; if not, leave them.
- [ ] Run the touched tests and `npm run typecheck`.

### Task 5: The rail and the nav

**Files:** `src/renderer/components/TaskNav.tsx` and test, `src/renderer/styles/shell.css`, `src/renderer/styles/app.css`, `src/renderer/components/NewTerminalMenu.tsx`.

**Interfaces:** `railTag(task: TaskView): string` in `src/renderer/components/railTag.ts`: the work item id (its last four digits after "…" when longer than five characters), else the initials of the task name's first two words in upper case (one word: its first two letters; no letter or digit: "•").

- [ ] **A task in the rail is its tag, not a document icon**: the work item id or the initials, in a small tile; the fly-out keeps the type icon, id and title. Tests for `railTag` (id, long id, two words, one word, symbols).
- [ ] **The nav is the rail under 860 px of window width**, whatever the saved setting, which stays as it is; the expand button hides while the width forces the rail. Test with a mocked `matchMedia`.
- [ ] **The New terminal menu is as wide as its items**, not the tab row.
- [ ] Run the touched tests, `npm run typecheck`, `npm run lint`.

### Task 6: Check in the running app, change note, release

- [ ] Dev app on scratch data (the recipe of the review): every fixed screen in dark and light, the rail with the pointer on a task, a 900 px window.
- [ ] `docs/changes/2026-11-26-ux-review-fixes.md`: what changed, what was verified, known gaps.
- [ ] Pull request, green on macOS and Windows, squash merge, release confirmed.
