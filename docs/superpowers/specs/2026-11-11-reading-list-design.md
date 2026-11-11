# The reading list and nudges in Shellie

Project 2 of 3 of "teach the operators what the brain knows", built last in the owner's order (1: the brain writes,
#276; 3: the phone reading site, #277; 2: this). The owner said "Ok go" to it after project 3 and had earlier
skipped the design questions, so the open points below were decided while building. They are marked **(call)**.

## Why

The owner: "I lost engagement. Could you nudge a user in Shellie?" A brain now writes long reads and letters, and
they are on the phone, but nothing in Shellie says what to read next, how far you are, or that something you read
has changed. Shellie knows moments a reading app never sees: the work in your sprint, the task you start, the
build that just finished.

## What the owner decided

- A prioritised reading list with progress, in this order: work in front of you this sprint, changes to things you
  already read, the foundations in book order, later.
- Nudges live in Shellie, "Not on the Phone". The three moments agreed in the brainstorm: when you start a task,
  when a brain build finishes, and a quiet line on Home and the Brain screen.
- No points, streaks, flashcards or guilt. A nudge points at a real event, never at "you have not read in 3 days".
- A short list: what is "up next" is a handful, the rest waits.

## Goals

- In Shellie, each brain's long reads are a reading list in the owner's order with a progress line, the same list
  the phone shows.
- "For your work this sprint" has content, in Shellie and on the phone.
- Three nudges: at task start, when something you read changed or a long read for your work was written, and a
  band on Home plus a dot on the brain in the sidebar.
- One switch turns the nudges off.

## Not goals

- No notifications on the phone, no OS notifications, no e-mail.
- No reading statistics, history or time-spent tracking. Nothing about reading leaves the machine except the
  counts in telemetry (below).
- No AI in the matching of work to long reads, so no extra cost.
- No reading list across people; the list is this install's.

## Would make it a failure

- A nudge with no event behind it, or one that repeats for the same piece.
- A pile: Home listing everything unread.
- A title, topic or work item title in telemetry.

## How it works

### Which long read bears on which work

**(call)** Nothing in a brain links a page to a work item, so the link is made by words, the way the task's Brain
tab already finds "relevant pages" (`taskWords`, `relevantPages` in `src/main/brain/browse.ts`):

- The work in front of you is: the items assigned to you in your current sprints (Home's snapshot), except those
  whose state reads as completed or removed, plus the work items of your open tasks. **(call)**
- An item looks for one long read in the brain of its project (same connection, same project). Its words are the
  4+ letter words of its title (and the task's name, for a task).
- A long read scores 2 for each word in its title, 1 for each in its summary, and 1 for each of the item's five
  most relevant pages that it was written from (its `pages:`, the record in `brain/reads.json`, and its chapter's
  pages). The best long read with a score of 3 or more is the one; with no such long read the item has none.
  **(call)** One long read per item keeps the section short.
- The result is `work: [{ id, title }]` on a long read: in Shellie's list, and in the shelf the phone gets
  (`ReaderRead.work`, there since #277). It is worked out again whenever it is asked for; nothing is stored.

### The list (`reading:get`)

Main answers, per brain that is not archived and has a long read or letter: the book's chapters, the long reads
(each with `work`), the letters, and the read marks main keeps (`reader.json`). The renderer makes the list with
`readingList` from `src/shared/reader.ts`, the function the phone uses, so both show the same order and counts.

Main keeps what it read of a brain's files until that brain changes (`brain:changed`) or five minutes pass.
The renderer keeps one copy for the whole app (the store), fetched at launch and again, a moment later, when a
brain changes, a mark changes, Home's snapshot is rebuilt or a task with a work item opens or closes.

`upNext(list, 3)` is what the nudges show: unread long reads for your work, then what changed in things you read,
then the one next unread foundation in book order. **(call)** Three at most. "Later" is never up next.

A long read for your work that you have not read is not listed under "Later" as well; in "Foundations" it keeps
its place, the book being the map. **(call)**

### Where it shows

- **Brain › Read › Long reads** becomes the reading list: a bar and "9 of 31 read · about 1 h 50 min left", then
  "For your work this sprint", "Changed since you read it", "Foundations" (the book's chapters in order; a chapter
  without a long read keeps its Write button), "Later" (long reads on a topic, and the field to ask for one) and
  "Letters" (the letters not listed under "Changed": about a long read you have not read, or read already).
  A row under "For your work" names the work item (`#412 Return flow`). A long read you read that was written
  again since still counts as read in the progress and in "2 of 3 read"; its row says "read, changed since".
  **(call)**
- **Home › Reading** (a band right under "My tasks", above reviews, pull requests and sprints **(call)**): per brain with something up next, its name, the progress line
  and the up-next rows, each with why it is there ("for #412", "changed since you read it", "next in the book").
  A click opens the piece in the brain's Read view. A brain with nothing up next is not listed; with no such brain
  the band is absent. **(call)**
- **The sidebar**: a brain has a dot while its list has something for your work or something changed. Unread
  foundations make no dot: they are the pile, not an event. **(call)**
- **Task start**: the task's setup page and the task's Brain tab show "Before you start" with the long read(s) its
  work item bears on that you have not read, or that changed since you did, minutes included, and open them in the
  brain's Read view. It looks only at the brains of the task's own connection: a work item's id says nothing in
  another organization. **(call)**
- **When a build finishes**: a notice, bottom right like the update notice, when the list gains something that
  changed in a thing you read (a letter, or the long read itself), or a newly written long read that bears on your
  work. Its heading is "Something you read no longer holds" (a letter), "Something you read was brought up to
  date" (the long read itself) or "A long read for your work". It says what and how long, has "Read" and a close
  button, and leaves by itself after 20 seconds (it waits while the pointer or focus is on it). It shows once per
  text; with several at once it names the first and says how many more. Nothing is shown for what was already
  there when Shellie started, nor for a long read that was there and only now bears on your work (a sprint item
  assigned to you later): that one shows in the band and the list, without a notice. **(call)**

Opening a piece from any of these goes to `{ kind: 'brain', brainId, open: { path, n } }` (`n` counts up, so the
same piece opens a second time): the brain screen switches to Read and opens the path, as a link from the Add view
does.

### The switch

Settings › User › Appearance › "Reading nudges" (`readingNudges`, on by default) **(call)**. Off: no Home band, no
sidebar dot, no "Before you start", no notice. The reading list on the brain's Long reads page stays: it is the
page you went to yourself.

### Telemetry

- `reading.nudge`: a nudge was shown; `kind` (`task`, `changed`, `work`).
- `reading.open`: a piece was opened from a nudge or the list; `from` (`home`, `notice`, `task`, `list`), `why`
  (`work`, `changed`, `next`, `foundations`, `later`), `kind` (`read`, `letter`).

Never a title, a topic, a path, a work item id or a brain's name.

## Left to the builder

File layout, the cache, styling within the existing bands and rows.

## Known limits

- The work link is a guess from words in titles and summaries. A work item titled with words no page uses finds
  nothing; one with common words may find the wrong long read. It is never worse than a missing first section.
- A completed state is told by its name (`stateCategory` without the type's metadata), which main does not have.
- The phone learns a new work link at Shellie's next push (within 15 minutes).
- The marks the list uses are main's; a mark set in the Read view reaches them at once, one set on the phone at
  the next exchange.
- Main keeps what it read of a brain for five minutes or until a job ends, so a long read edited by hand in the
  brain's folder shows up to five minutes late. What a job writes shows when the job ends.
