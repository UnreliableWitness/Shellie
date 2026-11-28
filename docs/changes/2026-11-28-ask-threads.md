# Questions to a brain are kept, and the Brain page answers in place

Date: 2026-11-28. Step 3 of six of `docs/superpowers/specs/2026-11-28-ask-everywhere-design.md` (the owner's sweep
of thin features, see `2026-11-28-ask-shared-states.md` and `2026-11-28-ask-steps.md`); plan
`docs/superpowers/plans/2026-11-28-ask-step-3-threads.md`.

## What changed

- **Kept.** What was asked of a brain and what it answered survives a restart. It is kept on this computer
  (`brain-asks.json` in the data folder): not in the brain's folder, so not shared with colleagues. The newest 50
  threads per brain are kept; a removed brain's go; a removed task's stay.
- **New question, Earlier questions.** A task's Brain tab can start a new question (the thread so far is put
  away) and get an earlier thread back from "Earlier questions (n)", on the tab's start and in the answers.
- **Ask on the Brain page.** "Ask" is a view between Read and Add. A question is answered in place, with the
  steps while it runs; the box in the page's head that opened the brain's terminal is gone. The left side lists
  the brain's own questions and, under "Asked in tasks", the tasks' threads, which open to read only with "Open
  the task". The Project page's "Ask" link opens the view with the cursor in the box.
- **After the brain's agent changed**, a follow-up starts a new conversation and its foot says so. It failed
  with the CLI's own words about the session id.
- **A question that was being answered when Shellie closed, or when the window was reloaded,** reads "Could not
  finish" with "Try again".

## How it works

- An asker has a key (`askOwner` in `src/shared/brainAsk.ts`): a task's id, or `brain:<brainId>` for the brain's
  own page. One question runs per asker; `ask:progress` and Stop use the key. `brain:ask` takes the task (or
  null), the key and the agent that held the session it resumes; main refuses a key that is not the asker's.
- The renderer's store owns a thread while the app runs: `brainAsksByTask` (the current exchanges per asker, as
  before), `brainAskThread` (which thread that is) and `brainAskEarlier`. `useAskThreads` reads the kept threads
  once at the start (`brainAsk:load`) and saves all of them half a second after a change (`brainAsk:save`);
  nothing is saved before the read came back or when it failed.
- `AskThreadStore` (`src/main/brain/askThreads.ts`) applies the limits on save, and on load turns a running
  exchange into one that could not finish. `brainAsk:load` does the same for a window that asks again (a
  reload) and stops the run nobody waits for. A file that could not be read at all is neither given nor written.
- `BrainAsks.ask` drops the resume when the agent that held the session is not the brain's agent now, and the
  answer carries `agent` and `restarted`.
- `BrainAnswers` takes the asker, an optional thread to read only, and whether its bar shows; `BrainAsk.tsx` is
  the Brain page's view.

## Rulings (the design says otherwise; Claude's calls)

- The design moved threads to main. Here the window keeps the live thread and saves it to main: the same for the
  person, far less to change. Cost: a window reloaded in the middle of a question loses that answer.
- "New question" is off while an answer is coming. Cost: a wait, or Stop.
- Asking about selected answer text and "Add to the brain as a note" move to step 5.

## Verified

- `npm run typecheck`, `npm run lint`; the renderer tests and the main tests for brain and IPC pass (3325 tests
  in the last run).
- A fresh reviewer read the branch: no critical finding; its two important ones are fixed (a reloaded window
  left a thread running for ever; a task's running question read on the Brain page had a Stop wired to the
  page's own asker), and so are an unreadable file being overwritten, a thread taken in twice and a key that is
  not the asker's.
- In the running app on macOS, dark and light, the free OpenCode model only: a thread back after a full quit,
  with its feet and step folds, and the file's shape; New question, Earlier questions on the start and in the
  answers; the Ask view's empty state, an answer in place with steps and no terminal, the list, a task's thread
  read only and "Open the task"; "Could not finish" after the app was killed mid-question, and Try again; a
  follow-up still continuing its conversation; the view at 900 px. Also seen fixed from step 2: no "Wrote a file
  outside the folder" on a dream ask, an empty start of a follow-up, a long link wrapping.
- That check found the Earlier questions list clipped on the tab's start, no cursor in the box after New
  question or from the Project page's link with a thread open, and list rows as long as their question; all are
  fixed, after the check.

## Known gaps

- The fixes made after the app check were not seen in the app. Windows was not run. No Claude Code question was
  asked in this check, so the new conversation after an agent switch was seen only in tests.
- The Brain page scrolls sideways by 20 px at 900 px (its head's "…" button); it did before.
- When the app is killed, the agent's process of a running question is left running.
- A file written by a newer Shellie (another `version`) is set aside as unreadable and the app starts with no
  threads.
- Only the count of threads is bounded, not the length of a thread or an answer; every save sends all threads.
- A quit within half a second of an answer can lose it.
- The Earlier questions list does not close on Escape or a click outside.
- A task moved to another brain can reopen a thread of the old one and follow up against the new.
- The telemetry action `ask` has no caller any more and is still listed.
