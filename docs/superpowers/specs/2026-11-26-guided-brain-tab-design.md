# A guided Brain tab in a task

Date: 2026-11-26. Mockups (design canvas "Shellie: a guided Brain tab for a task"):
https://claude.ai/artifact/E7jJ3C83pibTQaDNhKkKeD. The owner picked direction A (the screens "A. Guided Brain tab:
first open" and "A. Guided Brain tab: an answer, in place"). The mockups show layout and wording; the project,
pages, times and amounts in them are sample content.

## Why

A task with a brain can end up with a tab labelled "<name> brain" that is a bare agent terminal in the brain's
folder: an empty prompt, no word on what a brain is, what to type or why it sits in the task. The owner called it
confusing. The view that does help (`BrainTab.tsx`: ask, search, the pages for this task, drop files) is a second
tab that stays hidden until it is opened from the menu, and its Ask sends the question to that same terminal.

The owner wants one Brain tab that guides a person: what the brain is, what they can do with it for this task, and
answers without having to read a terminal.

## Goals

- A person who has never seen a brain understands from the tab alone what it is and what to do next.
- A question is asked and answered inside the tab, with the pages the answer comes from.
- The bare terminal is never the first thing a person meets. It stays reachable for people who want it.

## Non-goals

- The Brain screen (Read, Add, Explore, Settle, Health) does not change.
- The brain's skills do not change: no new skills version, no "Update skills" needed.
- Direction B from the canvas (a guide panel on top of the terminal) is not built.
- No AI for the suggested questions or for choosing the pages: both stay free.
- Answers are not written into the brain and not kept across app restarts.

## Anti-goals

- A tab that costs AI usage by being opened. Only pressing Ask may start an agent.
- A wall of explanation. The guidance is the three step headings and one short paragraph.

## Approaches

- **A. Guided Brain tab (picked).** One tab: Ask, Read what applies, Add what you learn; answers in place; the
  terminal behind a link. Removes the empty prompt instead of explaining it. Costs a headless ask run, which is new.
- **B. Keep the terminal, add a guide panel on it.** Small to build, but the person still ends up reading a
  terminal, and the helpful view stays a separate hidden tab.
- **A plus B.** Both. Left out: with A the terminal is an expert's escape hatch, and a guide there is a second thing
  to keep in step with the skills.

## The tab

`BrainTab.tsx` is reworked in place; it keeps its props, the drop target over the whole tab, the pending files,
problems and added notes, and opening a page in place with back and forward (`useBrainNav`, `BrainPage`). Top to
bottom, in a centred column (about 920 px at most), when no page is open:

1. **Head.** The brain's name as a small label with "Open the whole brain" (goes to the Brain screen, as "Open
   brain" does today). A heading, "What the project already knows about this task", and one paragraph: "The brain
   keeps the project's decisions, documents and meeting notes as pages. Ask it, read what applies to <work item
   title, else the task's name>, and add what you learn."
2. **1 · Ask.** A question field and an Ask button, always open (not behind a button as `AskBox` is today). Under
   it "Try" with three fixed suggestions, each asked at once when clicked:
   - "What should I know before I start on this?"
   - "What has been decided that affects this?"
   - "Who knows most about this?"

   Then one line: "Answers name the pages they come from. Asking runs the brain's agent (<agent>, <model>) and is
   counted on the brain, not on this task."
3. **2 · Read what applies.** One grid of cards: the long reads `BeforeYouStart` lists today (first, marked "Long
   read · N min"), then the pages from `brain:relevant` (`PageCard`). `BeforeYouStart` no longer renders as its own
   block on this tab. The long-read cards keep today's rules and behaviour: only unread or changed reads, from the
   brains of the task's connection, none when the reading nudges are off, `reading.nudge` tracked when shown, and a
   click opens the read in the Brain screen's reader (`openPiece`), which keeps the read marks. Only wiki pages open
   in place. Beside the heading: "Picked from the work item's words. No AI used." With no cards: "No page
   mentions this task yet. Ask, or search." Under the grid the search (`BrainSearch`), and the full page list
   (`PageSections`) behind a closed disclosure "All pages (n)". While a search is active the cards and the
   disclosure hide, as the lists do today.
4. **3 · Add what you learn.** A dashed box: "Drop a file anywhere on this tab, or write a note", a line on what
   happens to it and that Finish offers to save the task's lessons, and two buttons: "Choose files" (a file picker
   feeding the same path as a drop) and "Write a note" (opens the Brain screen on its Add view).
5. **Foot.** "Prefer to work with the brain's agent yourself? Open the brain's terminal" (opens the brain terminal
   tab, as the New terminal menu does today).

A brain without any page: step 2 says "This brain has no pages yet. Add a first document below." Ask stays.

Styling follows the app's tokens and `brain.css`; the step headings are small spaced-out labels as on the canvas.
Both themes.

## Asking in place

Pressing Ask (or a suggestion) replaces the three steps with the answer view; "Back to the brain's start" returns.

- **Running.** The question as the heading, "Reading the brain…" with the seconds elapsed, and Stop.
- **Done.** The answer rendered as Markdown with the brain's renderer; a path in it (`wiki/…` or `sources/…`, with
  or without an anchor) is a link that opens the page or source in place. No numbered markers: the canvas shows
  `[1]` `[2]`, the ask skill writes paths, and the skill does not change. Beside it "Where this comes from": one
  card per page or source the answer names that exists (title, type, and for a page whether a person verified it),
  in the order first named. The canvas's "Know the answer to the open point?" block is not built. A footer line: pages read are not counted;
  it shows the duration, the cost in EUR when the ledger has it, and "nothing was changed in the brain".
- **Actions.** "Send to this task's agent", Copy (the Markdown), "Continue in the terminal", and a follow-up field.
- **Failed or stopped.** The error in plain words, "Try again", and "Open the brain's terminal".

How it runs (main process, new channel `brain:ask` plus a way to stop it and an event for the result):

- A headless run of the brain's agent in the brain's folder with the same prompt the terminal gets today
  (`askPrompt`), the brain's model, and the brain's environment (`brainJobEnv`), so usage lands on the brain as
  a brain terminal's does. Claude Code and OpenCode both, through `Platform`, as the job runner spawns them.
- **Read-only, enforced.** The run must not be able to write, edit or run any command (no git either), whatever
  the skill text says. The brain's own rules do not give that (`brainOpencodePermission` allows edits and five git
  commands, the brain's `.claude/settings.json` allows git), so an ask run gets its own stricter setup: on Claude
  Code only the read, glob and grep tools, on OpenCode an inline config that denies every edit and every bash
  command. It is not `acceptEdits`. A follow-up run gets the same setup.
- **Held like jobs.** When the brain's jobs are held because its skills are too old for its agent or newer than
  this Shellie, Ask is refused with the reason, as for the cap.
- An OpenCode ask session's title starts with `BRAIN_JOB_TITLE`, so the brain terminal never adopts it.
- **Outside the job queue.** A question does not wait behind a capture and takes no brain lock: it only reads.
  One question at a time per task; a second Ask is disabled while one runs. Time limit 3 minutes.
- **The daily token cap counts.** At or over the brain's cap, Ask is refused with "The brain reached today's
  limit. Open the brain's terminal to ask anyway, or raise the limit in Settings."
- **Task context.** Every question from a task is sent with one added line naming the work item (id and title, else
  the task's name), so "this" in a suggestion means something.
- **Follow-up.** Resumes the same agent session with the new question. The answer view stacks every exchange,
  oldest first, each with its own source cards; the follow-up field is under the last. The thread is kept
  in the renderer's store per task, so switching tabs or tasks keeps it; an app restart drops it.
- **Continue in the terminal.** Opens the brain terminal on that session, the way a job's "Continue in terminal"
  does.

**Send to this task's agent.** Shown when the task has an agent tab (Claude Code or OpenCode). It runs in the main
process on the rules `src/main/prDraft/pickTab.ts` already has: a tab is only typed into when it runs, is not paused
by the leak watch, is not busy and has nothing typed since the last Enter; of several, the one with the latest agent
turn. Shellie writes the question and answer to `.shellie/brain-answer-<n>.md` in that tab's own folder (its repo's
worktree, so the relative path resolves in a task with several repos) and types one line, without Enter: "Read
.shellie/brain-answer-<n>.md: what the project's brain says about <question>". The person adds their instruction
and sends it. The tab becomes the active one. When no tab qualifies the button stays and says why ("The agent is
busy. Try again when it is done."); nothing is written or typed.

## When the tab appears

- The brain's option `openBrainTerminalOnStart` changes meaning: it now puts the **Brain tab** in a ready task's
  tab row (not selected, once per app session per task) instead of opening the terminal. Its label in Settings
  becomes "Show the Brain tab when a task starts". The stored key stays, so nobody's setting is lost.
- The New terminal menu's brain entry is renamed "<name> brain terminal", and the terminal's tab carries the same
  label, so the two are never confused. "Show brain" in the task menu and palette and its shortcut stay.

## Telemetry

New `brain.screen.action` values, without names or content: a question asked (typed, suggested or follow-up), a
question stopped, an answer sent to the agent, an answer copied, the terminal opened from the tab. `docs/telemetry.md`
is updated.

## Checks

- Unit tests for the tab (each state: first open, running, done, failed, cap reached, empty brain), the ask runner
  (read-only flags, cap, time limit, stop, follow-up on the same session, both agents) and the send-to-agent line.
- The dev app with the fake agent used for earlier brain work, in both themes.
- One real ask per agent (Claude Code on the owner's subscription, OpenCode on a free model), with a question that
  tells the agent to write a file and run a command: neither may happen, on the first run and on a follow-up. The
  fake agent cannot prove this.
- Not checked: Windows, and a real answer's quality on a real brain.

## Calls made by Claude, not by the owner

- The three fixed suggestions and their wording.
- The option's new meaning and the terminal's new label.
- Send to the agent types the line without pressing Enter.
- Answers are kept for the app session only.
- The source cards come from paths found in the answer, not from a change to the ask skill; no numbered markers.
- Long-read cards open in the Brain screen's reader, as today; only wiki pages open in place.
- Ask runs with no commands at all, is proven read-only on both real agents, and is refused while jobs are held.
- Send to the agent follows the pull request draft's rules for when a tab may be typed into.

## Open, for the owner

- Whether the Brain tab is in a task's tab row from the start for every task with a brain. As written it is not:
  the option above is off by default, so a newcomer still has to find "Show brain".

## Left to the builder

Component and file split, the store's shape for the thread, the IPC names beyond `brain:ask`, how the answer's
cost is read from the ledger (leave the amount out when it is not there yet), the exact CSS.
