# Home and Project, ordered

Date: 2026-11-28. Status: the owner asked for it ("focus on the 'home' and 'project' screens, they contain MANY
things so we want that to be ordered and focused") and approved the two mockups ("its perfect"). What the mockups
show is the owner's; everything else is Claude's call. Second project of the sweep that began with
`2026-11-28-ask-everywhere-design.md`.

Mockups (design canvas, page "Home and Project"): https://claude.ai/artifact/QYitjdh5QGvs3EjqTSboGw

## Why

Home is one column of up to twelve bands in a fixed order (What's new, Get started, While you were away, Places,
My tasks, Reading, Reviews for me and My pull requests, My sprints, Stats, Claude budget, Copilot budget, links).
What waits for the owner sits between things that do not, and the page is long. Project is three bands: the
recently finished tasks are inside the Brains band, the repositories show only as a graph, and nothing says how
the project stands at a glance. The owner's day, in their words: "Home for overview. Cost usage checking. Sprint
to pick items, adding items to brain and reading dealing with dreams".

## Goals

- Home answers three questions in this order, on one screen at 1280 × 900: what needs me, what am I working on,
  how do cost and time stand.
- Everything that waits for the owner is in one list, the same list the nav's For you shows.
- Project shows how the project stands (five facts), then its work, then what it knows and runs on.
- Nothing that Home or Project shows today is lost: it stays, moves to a page one click away, or becomes a line.

## Non-goals

- New data. Every figure in the mockups is one Shellie already has. The per-task cost breakdown, the month's
  export and a cost filter are the later cost project.
- Changing the nav, the palette or the Sprint and Week pages.
- Customising Home (reordering, hiding).

## Anti-goals

- A Needs you line for something that does not need the owner (a counter, an advert for a feature).
- Two lists that disagree: For you in the nav and Needs you on Home showing different things.
- A Home that scrolls for a normal day.

## Approaches

1. **Three zones** (picked, the mockup): Needs you across the top, work in a wide column, cost, time and places
   in a narrow one. One screen, an order that matches the owner's day.
2. Keep the bands, add collapse and a saved order. Least work, but the owner asked for order, not for knobs, and
   the page stays as long as its longest state.
3. Tabs on Home (Today, Cost, Sprint). Short pages, but an overview you have to click through is not one.

## Home

### Head

Title, "Updated n ago", one chip per connection (as today: it opens that project), Refresh, and **New task** as
the page's primary button.

### Needs you

One card, a row per thing that waits, most urgent first, each with a kind word, a sentence, how long it has
waited and one button. It is built by one pure function, `needsYou(...)`, in the renderer, from what the bands
read today; the nav's For you block renders the same list (compact). The kinds and their order:

1. **Shellie**: a connection whose token was refused ("Update the token"), usage capture not listening ("Open
   settings"). These were warning lines.
2. **Task**: a task whose agent waits for the owner, or whose pull request's CI failed ("Open").
3. **Review**: a pull request that waits for the owner's review ("Open"). Was the Reviews for me band.
4. **Dream**: results to review, per project ("Review"); a dream that was switched off ("Open Dreams"). Was the
   While you were away band. Other projects' dreams are listed too, with the project's name.
5. **Brain**: pages a colleague added to a shared brain ("Read"), conflicts to settle ("Settle"), a brain
   offered to join ("Join"), and at most one reading nudge ("Read"). Was the Reading band, the join card in the
   nav, the arrival chip.
6. **Shellie**: an update that is ready to install, and "Version x is installed: what is new" ("Show"), which
   stays until shown or dismissed. Was the What's new card; "What is new" also becomes a palette command, so the
   card can be reopened.

A row leaves when its cause is gone; rows that are only news (kind 6, the reading nudge) have a dismiss ×. The
card shows up to five rows and "n more". With nothing waiting the card is one muted line, "Nothing needs you",
and never disappears (the page does not jump). During first run (no repository yet) the Get started band takes
this card's place, as today.

Asks that finished elsewhere (the Ask project's signal) are a Task or Dream row here, from the same source.

### Your work (wide column)

- **My tasks**: a row per open task: tag, title, one state phrase (the same word the nav's mark stands for; amber
  only when it waits for the owner, red only for failed CI), today's active time, the task's cost. A click opens
  the task. Empty: "No open tasks" with "New task".
- **Up next**: the head names the sprint and the days left, "Open the sprint" on the right. Up to five of the
  owner's sprint items without a task, each with Start. With several projects, a card per project that has
  items. This takes over the My sprints band; the sprint's own figures live on the Sprint page.
- **My pull requests**: a row each with approvals and CI. Hidden when there are none.

### Side column (300 px)

- **AI cost · month**: the amount in Shellie's tasks, then a bar per vendor budget that is configured, with its
  percentage; over 90 % the figure is amber, over 100 % red. "Open Cost".
- **Time · today**: the owner's active time and the agents' time. "Open Week".
- **Places**: a plain list with one state word each: Sprint, each brain of the active project, Dreams, Project,
  Secrets, Settings, and Get started while it is unfinished. Takes over the Places tiles and the foot links.

Under 1000 px of page width the side column goes under the work column.

### The Cost page

A new screen `{ kind: 'cost' }`, title "Cost", holding what leaves Home unchanged: the Stats band with its period
switch and both budget bands. It gets a palette command and the Places row is not needed (the card links to it).
The cost project builds on this page later.

## Project

### Head

As today: the project's name, the connection's state, Project settings, New task.

### Facts

One strip of five, each a link: the sprint (days left, items done of total; opens Sprint), tasks (open, how many
wait; opens the first waiting task, else nothing), the month's AI cost in this project with its task count
(opens Cost), the brain (pages over all the project's brains, "n new to read" when there is; opens the brain, or
the first with something new), dreams (to review, or when the next one is; opens Dreams; absent when dreaming is
not set up, with "Set up" in its place). A fact that is still loading shows a dash, never a shifting layout.

### Work (wide column)

- **Sprint · mine**: the owner's items; an item with a task has "Open task", one without has "Start", a finished
  one neither. "Open the sprint".
- **Recently finished**: the last five finished tasks with their pull request link, date and cost; "All finished
  tasks" unfolds the nav's Done list as the palette command does today.

### What the project knows and runs on (380 px)

- **Brains**: a row each: name, pages, "shared" when it is, refreshed when; **Ask** (the Brain page's Ask view)
  and **Add**. "New" and "Manage" in the head. The join offer shows as a row here as well as in Needs you.
- **Repositories**: a row each: name, open tasks, setup state ("setup ready", "no .shellie.yml" in amber with a
  click to the repository's settings). "Show as a graph" swaps the list for today's graph in place and is
  remembered; "Add" opens Add repository. Repositories used from other projects are listed under a small
  "Used from other projects" head, as the graph groups them.
- **Dreams**: one line of state with its button, the same sentence Needs you uses. Absent when not set up.

Under 1000 px the right column goes under the left.

## What goes

`WhatsNewBand`, `AwayBand`, `ReadingBand`, `PlacesBand` with `MoreLinks`, `SprintsBand`, the Reviews half of
`PrBand` and Home's warning paragraphs as components on Home; their data hooks stay and feed `needsYou` or the
new cards. `home.clicked` telemetry keeps its event with new band names; `docs/telemetry.md` is updated.

## Order of building

1. `needsYou` with tests, the Needs you card on Home, the nav's For you on the same list.
2. Home's work column and side column, the Cost page, the bands removed.
3. Project: facts, work, the right column with the repository list.

## Checking

- Unit tests: `needsYou` (order, each kind, leaving, the cap of five), the facts.
- Component tests for Home and Project in the empty, loading and full states, and the narrow layout.
- In the running app on macOS, scratch data seeded as in `2026-11-23-theme-polish.md` (the ADO test project, a
  hand-written brain, a hand-written dream), dark and light, at 1280 × 900 and at 900 px wide.
- The change note lists what was not seen for real.

## Left to the builder

- Each row's exact sentence, following the words the bands use today.
- How a task "waits for the owner" is read: the same rule the nav's mark uses.
- Whether today's time comes from the Week page's data or the Usage tab's; whichever is already loaded on Home.
