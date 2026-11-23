# Week page: days as columns of task cards

Date: 2026-11-23. Replaces the table of the week overview (#340, `docs/changes/2026-11-19-340-week-overview.md`).
Mockup: design canvas "Shellie Week", https://claude.ai/artifact/GpEL6W6X6UNUtKHAMjgcWE, option B (snapshot:
`design/mockups/week/Week.dc.html`).

## Why

The owner found the table "rather hard to read": a grid of quarter-hour numbers says little at a glance. He asked
for a visually attractive way to show the tasks per day and how long they took.

## Approaches

- **A. Day columns as stacked bars** with the task list under them. Reads totals well; the owner preferred B.
- **B. A timeline** of when each task ran. Chosen, then changed by the owner in two steps: the days became columns
  ("turn the days into columns"), and the scale became hours worked instead of the clock ("switch the hours from
  actual hours of the day to 0 - 10 hours").
- **C. The table with bars in its cells.** The smallest change and the least visual.

## The design (as the owner approved it)

- Seven columns, Monday to Sunday, each headed by the day, its date and the day's total.
- A scale of hours worked at the left, 0 at the top. It runs to 10, **and that is not a limit**: it grows by whole
  hours to fit the week's longest day ("if i work 14 hours it should also work"). An hour is always the same
  height, so the page scrolls for a long week instead of squeezing it.
- A line across every column at 8 hours.
- Each day's work is stacked from 0 as cards, in the order worked: one card per task per stretch of work, as tall
  as the time it took. A card shows the hours, then **the work item id before the title** (owner, while it was
  being built).
- **A click on a card copies its task to the clipboard** (owner, while it was being built).
- Under the columns: the tasks with their colour, project and week total.

## Decisions made by Claude, not asked

- **What a stretch is.** Work on a task that resumes within 30 minutes belongs to the same stretch, and only the
  time worked counts. Without this, switching windows a few times would cut a morning into slivers.
- **What is copied.** The card's own line: id and title ("412 Fix login redirect"), or the title alone without a
  work item. A notice says what was copied.
- **Colour means the task**, by the order tasks were first worked on in the week, so a task keeps its colour while
  the week's hours grow. Eight colours (checked for colour-blind separation and contrast in both themes); further
  tasks share a neutral one and are still named on their cards and in the list.
- **Small cards.** A card too low for two lines shows hours and task on one; a sliver shows no text, the hover and
  the list name it.
- Numbers stay rounded to the quarter with the exact h:mm on hover, as before. Nothing about how time is measured
  changed.

## Not in this change

No export, no booking or editing of time, no weeks starting on Sunday (as before).
