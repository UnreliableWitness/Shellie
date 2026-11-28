# One ask, the same everywhere

Date: 2026-11-28. Status: the owner picked the approach (A, below) and approved the four mockups ("ok thats
approved"). What the mockups show is the owner's; everything else is Claude's call unless marked.

Mockups (design canvas, page "Ask"): https://claude.ai/artifact/QYitjdh5QGvs3EjqTSboGw

1. One ask, every state. 2. Dream: asking for a change. 3. Task: asking the brain. 4. Brain page: Ask answers in
place.

## Why

The owner asked for a sweep that brings the underdeveloped features up to the level of the rest of the app, and
named "the dream altering" and "the ask functionality". An audit of the code on 2026-11-28 found:

- Five places take a typed request for an agent, each built on its own. Two unrelated components are both named
  `AskBox`. Submit key, verbs, running text, stop, the look of a stop and the behaviour of "Try again" all differ.
- A dream ask shows a dot and "Working on" for up to ten minutes: no time, no step. A stop reads "Could not make
  the change: It was stopped". "Try again" only refills the box. The answer is plain text cut at 1 000
  characters. Nothing shows what one ask changed. Each ask starts from nothing. Leaving the page, nothing says
  when it is done.
- A task's brain ask arrives all at once, lives in renderer memory (lost on restart), cannot be cleared, puts no
  mark on the tab when an answer lands, and Enter during a running ask silently clears the typed question.
- The Brain page's "Ask" opens the brain's terminal with the prompt: no answer in place.
- Long reads, Settle and brain adds have no Stop; a failed long read points at "Activity in Add", which is on
  another view.

## Goals

- One ask experience, the same on a dream's proposal, in a task's Brain tab and on the Brain page: one way to
  send, stop, try again; the same words.
- While the agent works you see what it does (its steps, the time), and a brain answer is written out as it comes.
- When it is done you see what it did: on a dream, the lines this ask changed, with its own Undo.
- Nothing is lost: by a restart, by leaving the page, by typing while a run is under way.
- You are told when a run finishes while you look elsewhere.

## Non-goals

- A chat panel beside every screen, or one ask box for the whole app.
- Asks that span a dream's proposals, or that make a new proposal.
- Sharing questions and answers with colleagues: they stay on this computer and are not part of the brain.
- Changing what an ask may read or write. The guards of both runs stay exactly as they are (see Constraints).
- The other ask-like surfaces' own forms (pull request description, review comments, Docs "Send to"): they keep
  their shape. Only their wording is aligned where it is free (see Jobs and wording).

## Anti-goals

- A regression of any guard: a brain question that can write, a dream ask that touches another proposal.
- Progress that is noise: raw tool output, token counts ticking, the agent's thinking. Steps are short lines.
- A signal for something you are looking at.
- A second way to do the same thing left standing next to the new one (the old Brain page Ask box goes).

## What this overrules

The dream ask's own spec (`2026-11-26-dream-ask-for-a-change-design.md`) listed as an anti-goal "a page that moves
by itself: no counters, no streaming text", and as a non-goal "a conversation with memory across asks". Both were
Claude's calls. The owner approved mockups that show steps, a running time and a second ask that knows the first,
so both are overruled here, for the ask only. The calm rule still holds for the rest of the page: nothing
reorders, the diff changes only when a run ends.

The quiet-shell rule says a feature gets permanent screen space only by an explicit decision. "Ask" as a view of
the Brain page (beside Read, Add, Explore, History) is that decision: the owner approved mockup 4.

## Constraints

- A brain question stays read-only: Claude Code with only `Read,Glob,Grep` and `--strict-mcp-config`; OpenCode
  with `askOpencodePermission` and the config scan, a plain message, never `--command` (`src/main/brain/ask.ts`).
- A dream ask stays a dream run: the dream's worktree, environment and arguments, hooks off, the model rule, the
  revert of anything outside the proposal's files and the allowed folders (`src/main/dreams/dreamHandlers.ts`).
- Text read from sessions, pages and earlier answers is material, never instruction. Earlier asks given to a
  dream run are the developer's words and are marked as history, not as the instruction.
- All spawn logic stays behind `Platform`. Windows is the release target.
- Telemetry: new events go in `docs/telemetry.md`; no question or answer text is ever sent.

## Approaches

For the whole sweep the owner chose between: **A**, one project at a time with Ask first (picked); B, all shared
pieces first, then apply; C, one wide sweep of about forty items as they stand. C patches each ask surface
separately, which is how they diverged; B shows nothing for a long first stretch.

For the ask itself:

1. **A shared thread and composer, two engines** (picked, Claude's call). One set of renderer components draws
   an exchange in each state; the brain's `BrainAsks` and the dream's `dream:adjust` keep their own runs and
   guards and feed it through one small shape. Cheapest way to make them the same without touching the guards.
2. One ask service in main that both runs go through. Tidier on paper, but it would move the dream's and the
   brain's guards into shared code for no gain the user sees, and risks them.
3. Embed an agent terminal next to each surface. Full back-and-forth for free, but it is the "another place"
   the dream ask was built to avoid, and it cannot show what changed.

## The design

### The parts (renderer)

A folder `src/renderer/components/ask/`:

- `AskComposer`: the box. A textarea that grows from two rows to eight, then scrolls. Enter sends, Shift+Enter
  starts a new line, IME composition never sends. An optional "About" chip for selected text, Escape or its × to
  remove. A hint line under an empty box until the first ask of the thread was sent: "Enter sends · Shift+Enter
  starts a new line", plus the surface's own words (the select-text hint, the brain's agent). The button reads
  "Ask". While a run is under way the box stays usable and its placeholder says the text is sent when the run is
  done (see Queue). A reason it is off shows under it as today.
- `AskExchange`: one ask and what came of it, in one of five states.
  - **Working**: the steps so far (finished ones with a tick, the current one marked), then the answer's text
    as far as it has come (brain), then "Working · 42 s" (dream) or "Answering · 11 s" (brain) and **Stop**.
  - **Done, changed** (dream): the note as Markdown, a strip with the changed files and their added and removed
    lines, "Show what this changed", **Undo**, and a foot "Took 1 min 12 s · €0.04 · 3 steps".
  - **Done, answer**: the answer as Markdown; the surface's actions; a foot with the time, the cost when known,
    the count of pages read, and for the brain the changed-or-not sentence it has today.
  - **Stopped**: "Stopped after 18 s. Nothing was changed." and **Ask again**. Not an alert, not red, not amber.
  - **Could not finish**: an alert with the reason in words, **Try again**, a second button that leads to where
    the cause can be fixed when Shellie knows one (the dream's settings for a model problem, the brain's
    terminal, Settings for a cap or held skills), and "What the agent said" unfolding the raw message.
- `AskThread`: the exchanges oldest first and the composer at the foot; it scrolls to a new exchange, keeps focus
  where the run's start and end put it (as the dream box does today), and says the outcome for a screen reader.

**Ask again** and **Try again** run the same ask at once and the new exchange takes the old row's place. They
are off while another run of that surface is under way.

The surfaces pass actions, the second failure button and the extra foot words; they do not restyle states.
Both existing `AskBox` components go. The dream's CSS for the ask and `brain-qa-*` are replaced by one `ask.css`.

### Steps and writing out (main)

- `runWithInput` gets an optional `onLine` callback: it buffers the chunks into whole lines and keeps calling
  after the 4 MB cap on collected output is reached. In production the run happens in the pty host (a utility
  process, `src/main/ptyHost/`), so the protocol gains one message from host to client carrying a batch of lines
  for a run, flushed at most every 250 ms; the client calls `onLine` for each. Runs without the callback send
  nothing new.
- Brain question on Claude Code: `--output-format stream-json --verbose` in place of `json`; on OpenCode
  `--format json` already prints one event per line. Dream ask: OpenCode's event lines the same way.
  The builder must check both formats against the installed CLIs before relying on a field (the brain code names
  OpenCode 1.19.3). The stream's result line is read by a new function beside `claudeResultWithSession`, which
  stays as it is for the pull request summary.
- A small pure module per agent turns an event into at most one step: `{ kind: 'read' | 'search' | 'edit' |
  'write' | 'other', label }`. Labels are short and in words: "Read wiki/connections.md", "Searched the brain for
  “retry”", "Editing .claude/skills/review/SKILL.md". Paths are shown relative to the run's folder; anything
  outside it is "a file outside the folder". Unknown events make no step. Consecutive equal steps collapse. A
  run keeps at most 40 steps; older ones fold into "12 earlier steps".
- Text events of the final answer are forwarded for the brain, so the answer is written out. If an agent gives
  no text events the answer simply arrives whole, as today. Text arriving a message at a time is acceptable; if
  the installed Claude Code takes `--include-partial-messages`, use it for finer text. The dream's note is not streamed (it is read from
  `adjust.json` when the run ends).
- Main sends `ask:progress` (`{ key, steps, text }`, at most four times a second) to the renderer. Progress is
  never saved. After a restart a run that was under way is "Could not finish: Shellie was closed": the dream does
  this today; for the brain it is new (main marks the kept threads' running exchanges when it starts).
- If an agent's events cannot be read at all, the exchange shows the time and Stop without steps. That is the
  floor, and it is already better than today's dream ask.

### The brain: kept threads, and Ask on the Brain page

- Threads move from the renderer's store to main: `brain-asks.json` in the data folder, written through the
  existing atomic-write helper. A thread: `{ id, brainId, taskId | null, title (the first question), startedAt,
  exchanges[] }`; an exchange as `AskExchange` has it today plus `steps` (the final list), `pagesRead` (the
  distinct pages among its read steps; left out when no steps could be read) and a real `stopped` status in
  place of a failure whose message is the stopped phrase. The
  renderer reads with `brainAsk:list(brainId)` / `brainAsk:thread(id)` and follows `brainAsk:changed`.
- Kept: the newest 50 threads per brain; older ones are dropped whole. A removed brain's threads are dropped. A
  finished or removed task's threads stay (they show under "Asked in tasks").
- A task's Brain tab shows the task's current thread. **New question** starts an empty thread (the old one is
  kept); **Earlier questions (n)** lists the task's own threads to reopen one. The start view's ask box becomes
  the composer; the suggestion chips stay.
- The Brain page gets the view **Ask**: the brain's threads on the left (its own first, then "Asked in tasks"
  with the task's tag, which opens that thread read-only with "Open the task"), the open thread on the right, the
  composer at its foot. `focus: 'ask'` opens it with the cursor in the box; Project's "Ask" link and the palette's
  brain commands lead there. The old disclosure that opened the terminal goes; "Continue in the terminal" on an
  answer remains the way there.
- A follow-up resumes the agent's session as today. When the brain's agent or model changed since the thread's
  last answer, the follow-up starts a fresh session and the exchange says so in its foot ("a new conversation: the
  brain's agent changed"), instead of failing.
- Selected text in an answer or in a brain page opened from the thread becomes the composer's "About" chip, and
  is sent as a quoted block ahead of the question.
- **Add to the brain as a note** on an answer opens the Add composer with the question as the title and the answer
  as the text, not yet sent. **Copy** says "Copied" in place for two seconds. "Send to this task's agent" only in
  a task, as today.
- One run per thread: `BrainAsks` is keyed by the thread's id where it is keyed by the task's today, and Stop
  and `ask:progress` use the same key. "New question" while an answer is still coming is allowed; the old thread
  finishes and signals like any other. A task and the Brain page may ask the same brain at once (questions only
  read and are outside the brain's lock already). The cap and held skills keep their meaning and are "Could not
  finish" with the matching second button.

### The dream: memory, what an ask changed, undo and redo

- The thread is the proposal's `adjustments`, drawn by `AskThread`. The schema gains, all optional so old results
  load: `outcome` (`changed | answer | stopped | failed`; missing means what `changed` says), `reason` (for
  failed), `after` (`{ commit, files, title, why }`, the proposal as the ask left it), `durationMs`, `costEur`,
  `steps`, `stat` (`{ path, added, removed }[]`), `undone` (boolean). A stopped or failed ask is now a row of the
  proposal's own list, so each thread keeps its own; `adjustFailed` is still read for an old result and no longer
  written. "Ask again" and "Try again" replace that row.
- One run per dream stays. While a change to one proposal is being made, the other proposals' boxes are off with
  the sentence that says which one, as today; only the running proposal's box takes a queued ask.
- **Memory**: `adjustPrompt` gets the earlier asks about this proposal that are not undone, newest ten, each with
  its note, under a heading that says they are what the developer asked before and what was done, for context
  only; the one instruction is still the new ask.
- **What this changed**: the diff pane's head gets "Showing: The whole proposal | The last ask". "Show what this
  changed" on an exchange picks that ask: the diff from its `before.commit` to its `after.commit`. Asks from
  before this change have no `after` and offer no such link.
- **Undo and redo** work as a stack. Undo is offered on the newest change that is not undone and puts `before`
  back; the exchange stays in the list, struck through, with **Redo**. Redo is offered on the oldest undone change
  directly above the current state and puts `after` back. A new ask that changes the proposal drops the redo of
  anything undone (those rows stay, struck through, without a button). Undo no longer deletes later answers.
- The note is Markdown, up to 8 000 characters. The cost is read from the ledger for the run's time window, as
  the brain does, and may be missing right after the run. It is attributed the way a dream's usage is today (by
  the dream's worktree); if that cannot tell this run from another in the same window, the cost is left out.
- "Open as a task" becomes a visible button in the page's head, beside Discard. While a run is under way the
  line under the head says what Create pull request waits for (it is a tooltip today).
- A proposal's row in the list says "working" and, after asks, "changed twice" or "1 answer".

### Queue

One next ask can be written while a run is under way, on every surface. It is kept with the thread (a draft, so
it also survives leaving the page) and sent by itself when the run ends in Done. If the run is stopped or could
not finish, the draft stays in the box, unsent. It is sent whether or not the thread is on screen (a dream
  change made that way has its Undo like any other), and the done-elsewhere signal comes once, when nothing more
  is running or queued in that thread. Drafts are kept per thread in the renderer's store and in
`localStorage`; the dream page's per-proposal drafts move there too.

### Done while you were elsewhere

- "Elsewhere" means the thread is not on screen (another page, another task, another tab, another proposal), or
  the window is not focused.
- A task's Brain tab gets a dot in the tab row until the tab is shown.
- A notice with one action: "The brain answered “How do we refresh…”" / "The change to “Rebase before review” is
  ready" / "…could not be made", with **Show**, which goes to the thread. For this `notify` gains an optional
  `action: { label, run }`; a notice with an action stays until dismissed or acted on.
- A line under For you in the nav until the thread has been shown.
- No sound, no system notification.

### Keys

- Mod+L puts the cursor in the page's ask box on the dream page, the Brain page (switching to Ask) and a task's
  Brain tab. It does nothing while a terminal has the focus (Ctrl+L clears a shell). It is listed in the palette.
- Escape in the box removes the About chip first, then leaves the box.

### Jobs and wording

- Brain job rows (adds in Activity, long reads, Settle's waiting rows) get **Stop** while running and the same
  "Stopped" / "Could not finish" + **Try again** rows, drawn with the exchange's status strip. A stopped job is
  not a failed job in the brain's health.
- A failed long read links to its row ("Show in Activity" switches to Add and scrolls to it).
- Words, everywhere a request goes to an agent: "Ask" to send a question or a change, "Stop", "Ask again" after a
  stop, "Try again" after a failure. "Retry" on job rows becomes "Try again". The pull request description keeps
  "Write again" and "Skip" (it writes, it does not answer); its failure becomes an alert like the others. The
  Changes tab's disabled send button says "Open an agent tab first".

### Fixed along the way

- Enter in the Brain tab's start box during a running ask no longer clears what was typed (it queues).
- A failed brain exchange no longer stays in the thread under its retry.

## Order of building

Each step is releasable on its own:

1. The shared parts and the five states, on the dream and the Brain tab, with the wording and the two fixes.
   Data: only the brain's `stopped` status and the dream's `outcome`, `reason` and `durationMs`.
2. Steps and writing out (`onLine`, the event readers, `ask:progress`).
3. Kept brain threads, New question, Earlier questions, the Ask view on the Brain page.
4. The dream's memory, what an ask changed, undo and redo, the visible "Open as a task".
5. Queue, done-elsewhere signals, Mod+L.
6. Jobs: Stop and Try again, the long-read link.

## Checking

- Unit tests for the event readers (recorded lines of both CLIs as fixtures), the undo/redo stack, the thread
  store's limits, the queue rule, and the elsewhere rule.
- Component tests for each state of `AskExchange` and for both surfaces.
- In the running app on macOS with scratch data: a real brain question on the free OpenCode model
  (`opencode/big-pickle`) and a real dream ask on a hand-written dream (recipes in the change notes of
  2026-11-26), in dark and light: steps appear, Stop, Ask again, a failure, restart keeps the thread, the dot and
  the notice.
- The change note lists what was not seen for real. Windows is not run locally.

## Left to the builder

- The exact event fields of both CLIs and the step labels for tools not named here.
- The file format details of `brain-asks.json` and the IPC names.
- Layout details the mockups do not settle (narrow windows: the brain answer's source cards go under the answer
  below 900 px of pane width, as they do today).
