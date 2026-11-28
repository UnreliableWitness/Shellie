# One ask everywhere, step 3: kept threads, and Ask on the Brain page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A brain's questions and answers survive a restart, a task can start a new question and get an earlier
one back, and the Brain page answers in place in a view of its own.

**Architecture:** The renderer's store stays the owner of a thread while the app runs (as today) and saves every
change to main (`brain-asks.json`); main keeps the limits and hands the threads back at start. An "owner" is a
task (its id) or a brain's own page (`brain:<brainId>`); each owner has one current thread and earlier ones.

**Spec:** `docs/superpowers/specs/2026-11-28-ask-everywhere-design.md`, "The brain: kept threads, and Ask on the
Brain page".

## Global Constraints

- Questions and answers stay on this computer: `brain-asks.json` in the data folder, never in the brain's folder.
- Kept: the newest 50 threads per brain; a removed brain's threads go; a removed task's threads stay.
- An exchange that was running when Shellie closed loads as "Could not finish: Shellie was closed while this was
  being answered".
- The read-only guards of a question do not change.

## Rulings made while planning (the spec is the authority; these narrow it for this step)

- The spec moves threads to main; here the renderer keeps the live thread and saves it to main. Cheaper and the
  person sees the same. Cost: a renderer reload in the middle of a question loses that answer (it loads as "Could
  not finish").
- "New question" is off while an answer is coming (the spec allows it). Cost: one wait or Stop.
- The "About" chip for selected answer text and "Add to the brain as a note" move to step 5.

## Review Focus

- A `brain-asks.json` that is corrupt, or from a newer version: the app starts with no threads, and does not
  overwrite the file before the first real change.
- Two windows of time: a save racing a load at start (threads asked before the load finished are not lost).
- A thread with a very long answer and many exchanges: the save is debounced, not on every keystroke.
- A task thread opened from the Brain page: nothing can be asked in it there.
- Switching the brain's agent between two questions: the follow-up starts a new session and says so.

---

### Task 1: Shapes and the store in main

**Files:** `src/shared/brainAsk.ts` (move `AskExchange` here from `store.ts`; `AskThread = { id, brainId, taskId:
string | null, startedAt: number, current: boolean, exchanges: AskExchange[] }`; `ASK_THREADS_MAX = 50`;
`ASK_LEFT_BY_QUIT`; `askOwner(taskId | null, brainId)`), `src/main/brain/askThreads.ts` (+ test):
`class AskThreadStore { load(): Promise<void>; list(): AskThread[]; save(threads: AskThread[]): Promise<void>;
dropBrain(brainId): Promise<void> }` on `JsonFileStore`, IPC `brainAsk:load` → `AskThread[]`, `brainAsk:save`
(`threads`) in `brainHandlers.ts`, wired in `main.ts`.

- [ ] Tests: save keeps the newest 50 per brain (by the last exchange's `startedAt`, current ones first); load
  turns running exchanges into failed with the phrase; threads of a brain that no longer exists are dropped on
  save; a corrupt file loads as empty.

### Task 2: The agent in an answer, and a fresh session after a switch

**Files:** `src/shared/brainAsk.ts` (`BrainAnswer.agent?: BrainAgent`, `restarted?: true`), `src/main/brain/ask.ts`
(`ask(key, brainId, question, resume, resumeAgent?)`), `brainHandlers.ts` and `src/shared/ipc.ts`
(`brain:ask` args `[brainId, taskId | null, question, resume, key, resumeAgent | null]`; `brain:askStop [key]`),
`main.ts` (progress key is the owner key).

- [ ] Tests: a resume whose agent differs from the brain's runs without `--resume` / `--session` and the answer
  has `restarted: true`; the same agent resumes; a missing `resumeAgent` resumes as today; no task (null) asks
  the question without the task's context sentence.

### Task 3: The renderer's threads

**Files:** `src/renderer/store.ts` (+ `store.brainAsk.test.ts`), a `useAskThreads` hook mounted in `App.tsx`
(load once, save debounced 500 ms after a change).

**Produces (store):** `brainAsksByTask` stays the current exchanges per owner; `brainAskThread: Record<owner,
{ id, brainId, startedAt }>`; `brainAskEarlier: AskThread[]`; `newBrainQuestion(owner)`;
`openBrainThread(owner, threadId)`; `loadBrainThreads(threads)`; `brainThreadsToSave(): AskThread[]`;
`askBrain(owner, brainId, question, via, replaceId?)` (owner in place of taskId; a task's owner is its id).

- [ ] Tests: asking creates the owner's thread; New question files the current one under earlier and empties
  the box; opening an earlier one swaps them; nothing happens while an answer is coming; load fills current and
  earlier and does not overwrite an owner that already asked; a removed task's thread is kept (moved to earlier
  as that task's); the resume passes the agent of the answer it resumes.

### Task 4: The Brain tab's bar

**Files:** `BrainAnswers.tsx` (props `owner`, `taskId: string | null`, `readOnly?`), `BrainTab.tsx`, tests.

- [ ] Tests: "New question" and "Earlier questions (n)" in the bar; the list shows each earlier thread's first
  question and day, and opens one; a restarted answer's foot says "a new conversation: the brain's agent changed";
  `readOnly` shows no box, no Ask again, no Try again.

### Task 5: Ask on the Brain page

**Files:** `BrainScreen.tsx` (view `ask`, the old `AskBox` in the head goes; `focus: 'ask'` opens it),
`components/brain/BrainAsk.tsx` (new: the list of questions on the left, the thread on the right), delete
`components/brain/AskBox.tsx`, `brain.css`, tests.

- [ ] Tests: the view lists the brain's own threads and, under "Asked in tasks", the tasks' threads with the
  task's tag; asking from the empty state creates the brain's thread and shows the answer in place; a task's
  thread opens read-only with "Open the task"; the head has no Ask box.

### Task 6: The change note, the app, the review, the release
