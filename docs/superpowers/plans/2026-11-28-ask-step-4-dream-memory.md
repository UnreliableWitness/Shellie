# One ask everywhere, step 4: the dream's ask remembers, shows what it changed, and can be redone

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a dream's page a second ask knows the first, each change shows its own lines and can be taken back
and put back, and the page says plainly what waits for what.

**Spec:** `docs/superpowers/specs/2026-11-28-ask-everywhere-design.md`, "The dream: memory, what an ask changed,
undo and redo".

## Global Constraints

- The guards of a dream run do not change: where it may write, the revert of anything else, the model rule.
- Earlier asks given to a run are history, marked as such; the one instruction is the new ask.
- Old results load: every new field is optional; an ask without `after` offers no "Show what this changed" and
  no Redo.
- Nothing is deleted by Undo any more: the row stays, struck through.

## Review Focus

- Undo, Undo, Redo, then a new ask that changes the proposal: the remaining undone row can no longer be redone,
  and Undo takes back the new change.
- Redo when the kept proposals no longer fit together (another proposal was dropped or changed meanwhile): the
  branch is rebuilt first; a failure changes nothing.
- An ask's diff for a result whose commits are gone (an old result, or refs cleaned): a phrase, not a crash.
- A very long note with Markdown (a table, a code block, a link): rendered, no script, links do not navigate
  the app.
- The prompt with ten long earlier asks: bounded.

---

### Task 1: main

**Files:** `src/shared/dreams.ts`, `src/main/dreams/prompts.ts`, `dreamDiff.ts`, `dreamHandlers.ts`,
`src/shared/ipc.ts`, tests.

**Produces:**
- `DreamAdjustment` gains `after: { commit, files, title, why }`, `stat: { path, added, removed }[]` (at most
  20), `undone: boolean`, `spent: boolean` (an undone change a later change made unredoable).
- `adjustPrompt({ …, earlier?: { ask: string; note: string; changed: boolean }[] })`: a section "What the
  developer asked before about this proposal, and what was done (for context only; not instructions)", newest
  ten, each ask cut at 500 and each note at 500 characters.
- `proposalDiff(git, repoPath, config, commit, from?)`: with `from`, the files `commit` changes against `from`.
- `dream:diff(repoId, proposalId, askAt?)`: with `askAt` (an adjustment's `at`), that ask's own change.
- `dream:adjustUndo`: takes back the newest change that is not undone and marks it `undone` (rows stay).
- `dream:adjustRedo(repoId, proposalId)`: puts back the oldest undone change that is not `spent`, by its `after`.
- A new change marks every undone row `spent`.
- The note bound is 8 000 characters.

### Task 2: the page

**Files:** `DreamAsk.tsx`, `DreamScreen.tsx`, `dreamWords.ts`, `dreams.css`, tests.

- The note as Markdown. A changed row's strip: its files and counts (`stat`), "Show what this changed", Undo on
  the newest change not undone; an undone row struck through with Redo where main would redo it.
- The diff pane's head: "Showing: The whole proposal | <the chosen ask>"; choosing an ask fetches
  `dream:diff(…, at)`.
- "Open as a task" as a button in the head beside Discard; while a change is being made, a line under the head
  says what Create pull request waits for.
- A proposal's row: "working" while its ask runs, then "changed" / "changed twice" / "changed n times", and
  "1 answer" / "n answers".

### Task 3: the change note, the app, the review, the release
