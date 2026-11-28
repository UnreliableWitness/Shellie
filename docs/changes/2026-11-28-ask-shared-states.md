# One ask, the same on a dream and in a task's Brain tab

Date: 2026-11-28. Asked by the owner in a session: a sweep of the features that shipped as a thin first version,
naming "the dream altering" and "the ask functionality". This is step 1 of six of the design
`docs/superpowers/specs/2026-11-28-ask-everywhere-design.md` (mockups approved on the design canvas,
https://claude.ai/artifact/QYitjdh5QGvs3EjqTSboGw); plan `docs/superpowers/plans/2026-11-28-ask-step-1-shared-states.md`.

## What changed

**One set of parts** (`src/renderer/components/ask/`, `styles/ask.css`). The dream's ask and the brain's ask were
two unrelated components, both named `AskBox` in spirit, each with its own keys, running row, stop and retry.
Both are now drawn from:

- `AskComposer`: the box. As tall as its text from two lines to eight, Enter sends, Shift+Enter starts a new
  line, a composition never sends. A hint under an empty box until the first ask. The "About" chip for selected
  text. While a run is under way the box stays usable and sends nothing, with a sentence that says so.
- `AskWorking`: "Working · 42 s" (dream) or "Answering · 11 s" (brain) and Stop. Only the word is in the live
  region; the counting time is not, so a screen reader hears it once.
- `AskStopped`: "Stopped after 18 s. Nothing was changed." and "Ask again". Not an alert, not red.
- `AskFailed`: an alert, "Could not finish." and the reason, "Try again", and a second button where Shellie
  knows the way to the cause.
- `AskFoot` and `tookWords`: "Took 1 min 12 s".

"Ask again" and "Try again" run the same ask at once and the new run takes the old row's place. Before, the
dream's "Try again" only put the text back in the box, and the brain's left the failed exchange in the thread.

**The dream** (`components/dreams/DreamAsk.tsx`, was `AskBox.tsx`).

- A run that was stopped or could not finish is a row of the proposal's own list (`DreamAdjustment` gains
  `outcome`, `reason`, `durationMs`, `fix`, all optional), written by one function, `endAsk` in
  `src/shared/dreams.ts`, from the three places that end a run without a change: the run's end, Stop with no run
  left, and the clean-up after a quit. So each proposal keeps its own, with how long it ran, and it is still
  there after leaving the page. `result.adjustFailed` is no longer written; one stored by an older version still
  shows, as the proposal's last row.
- The next ask about a proposal removes its stopped and failed rows.
- A wrong-model failure offers "Open the dream's settings".
- The running ask shows above the box with its time; a very long one scrolls in a few lines of its own.
- The list of asks shows its end, so the newest row is in view when there are more than fit.
- A finished ask says how long it took.

**The brain** (`BrainAnswers.tsx`, `BrainTab.tsx`, `store.ts`, `src/main/brain/ask.ts`).

- A stopped question is `status: 'stopped'` (main says `stopped: true`); it was a failure whose message was the
  word "Stopped", shown as a red alert.
- `askBrain(..., replaceId)` puts a retry in the place of the exchange it replaces, resuming the session of the
  answers before it.
- The start box and the follow-up are the shared box, so questions can have several lines. The follow-up stays
  while an answer is coming.
- Fixed: Enter in the start box while a question was being answered cleared what was typed and asked nothing.
- A held brain's failure offers "Open settings"; the others keep "Open the brain's terminal".
- Copy says "Copied" for two seconds.
- A long question without spaces wraps.

**Words.** "Retry" on a brain job (Activity, Settle) is "Try again". The Changes tab's send button, when no agent
tab is open, says "Open an agent tab first" (OpenCode tabs count too). A pull request description that could not
be written is an alert in the error colour; it was muted text.

## Verified

- `npm run typecheck`, `npm run lint`; the renderer tests (179 files) and the main tests for brain, dreams and
  shared pass.
- A fresh reviewer read the whole branch: no critical finding; its four important ones are fixed (this note, the
  long running ask, the long question, the ticking live region).
- In the running app on macOS, scratch data, the free OpenCode model only, dark and light:
  - Brain tab: the start box and its hint, growing on Shift+Enter; a real question with "Answering", then the
    answer and its foot; Enter during an answer keeping the text; Stop, the Stopped row, "Ask again" in its place
    with the thread no longer; a failure (a model that does not exist) with "Try again" and the terminal button,
    and the retry answering; Copy.
  - Dream page (a hand-written dream): the box and hint; "Working" with Stop and the box usable; the other
    proposal's box off; Stop, the Stopped row with its time, still there after Home and back; "Ask again" ending
    in a change with "Took 23 s"; a failure with "Try again".
  - A 1 000-character word in each box, in a brain question and in a dream row: no sideways scroll, at 1440 and at
    an emulated 900 px.
- That check found a second focus ring inside the box, the newest dream row out of view under three others, the
  box wider than its rows and a box that grew only on line breaks; all four are fixed and were seen fixed in a
  second run. The second run found that a 2 000-character running ask hid its own time and Stop; the text now
  scrolls in three lines above them (this last change was not seen in the app).

## Known gaps

- Windows was not run.
- Not seen for real: "Open settings" on a held brain, "Open the dream's settings" (no wrong-model failure was
  provoked), "Send to this task's agent", a real window of 900 px (the viewport was emulated).
- The rewritten dream tests and the component were written together, so most of those tests were not seen
  failing first.
- The dream page's head scrolls sideways by a few pixels at 900 px ("Push branch" past the edge); it did before.
- At 900 px the dream's foot covers much of a proposal once it has several asks.
- Left for the later steps of the design: the agent's steps and written-out answers, threads kept over a restart
  and the Ask view on the Brain page, a dream ask that knows the earlier ones, what one ask changed, redo, an
  ask queued behind a running one (a draft typed while a run works is still lost on leaving the page), signals
  for a run that finished elsewhere, Mod+L, Stop on brain jobs.
- Deferred, from the review: a dream failure is said twice to a screen reader (the alert and the outcome line)
  and again when the page is reopened; a brain stop is not announced; a retry in the middle of a brain thread
  resumes the session before it and can sit above newer answers; retries count as `ask-typed`; an unused field
  and two stale comments naming `adjustFailed`; the select-text hint goes once a proposal has only a stopped row.
