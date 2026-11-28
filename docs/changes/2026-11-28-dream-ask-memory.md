# A dream's ask remembers, shows what it changed, and can be put back

Date: 2026-11-28. Step 4 of six of `docs/superpowers/specs/2026-11-28-ask-everywhere-design.md` (the owner's sweep
of thin features: "the dream altering"); plan `docs/superpowers/plans/2026-11-28-ask-step-4-dream-memory.md`.
Builds on `2026-11-26-dream-ask-for-a-change.md`, whose known gaps (each ask one run with no memory, one level of
Undo) this closes.

## What changed

- **Memory.** An ask is told what was asked before about the proposal and what came of it, as history; the one
  instruction is still the new ask. "Make that example shorter" after "add an example" shortens the example.
- **What one ask changed.** A changed row names its files with the lines added and removed. "Show what this
  changed" turns the pane to that ask's own lines ("What this ask changed", with a switch back to the whole
  proposal).
- **Undo keeps the row, Redo puts it back.** Undo takes back the newest change that stands; its row stays, struck
  through, "Taken back". Redo puts back the oldest change that was taken back. Once the proposal is changed
  again, what was taken back before can no longer be put back. Undo used to remove the ask and every answer
  after it.
- **Notes** are Markdown, up to 8 000 characters (plain text cut at 1 000 before).
- **The head.** "Open as a task" is a button beside "Discard dream" (it was in the palette only). While a change
  is being made, a line says what Create pull request (or Push branch) waits for (a tooltip before).
- **The proposal list** says "working" while an ask runs, then "changed" / "changed twice" / "changed n times"
  and "1 answer" / "n answers", counting what stands.

## How it works

- `DreamAdjustment` (`src/shared/dreams.ts`) gains `after` (the proposal as the ask left it), `stat`, `undone`
  and `spent`, all optional. `undoAt` and `redoAt` there say which row each button acts on; main and the page use
  the same two. A row of before `after` was kept offers no Redo, and none past it.
- `dream:adjustUndo` marks the row; `dream:adjustRedo` restores `after`. Both rebuild the dream's branch first,
  so one that does not fit changes nothing. A new change marks every undone row `spent`. The commits Undo and
  Redo need are the ones `keepCommits` already holds until the dream closes.
- `adjustPrompt` takes `earlier`: the asks that stand (not taken back, not stopped or failed), the newest ten,
  each ask and note on one line, without angle brackets, cut at 500 characters, in an `<earlier>` block after the
  ask, said to be context and not instructions.
- `proposalDiff(…, commit, from?)` and `dream:diff(repoId, proposalId, askAt?)`: with an ask's `at`, the diff
  from its `before` to its `after`. Both commits are checked to be full hashes before git sees them.
- The page keeps which ask shows per proposal; an ask that was taken back shows the whole proposal again. A diff
  that could not be read is asked for again on the next click. One ask's lines offer no "Open in full diff"
  (that reads the whole proposal's file).

## Verified

- `npm run typecheck`, `npm run lint`; the renderer tests and the main tests for dreams and shared pass (2924
  tests in the last run).
- A fresh reviewer read the branch: no critical finding. It confirmed the undo and redo chain, the kept commits
  and the hash checks; its four important findings are fixed (Redo past a row of an older version; the history's
  wording and a note that could close its block; the full diff of one ask's lines; a diff that failed kept as
  failed).
- In the running app on macOS, dark and light, the free OpenCode model, a fresh hand-written dream: a second ask
  that shortened the first one's example, a question answered with nothing changed; the row's label, note, strip,
  foot and steps; each ask's own lines and the switch back; Undo, Undo, Redo, Redo, then Undo and a new change
  (no Redo left on the old row); a title following Undo and Redo; the list's words; the head's button and line.
  Also seen fixed from step 3: the Earlier questions list unclipped, the cursor in the box, two-line list rows.
- That check found notes padded like a document, the head's buttons past the edge at 900 px and the foot covering
  the proposal in a low window; all three are changed, after the check.

## Known gaps

- The changes made after the app check were not seen in the app (the note's padding, the head wrapping at
  900 px, the foot capped at 60 % of the window's height). Windows was not run.
- After the window is made narrower the newest row can slip below the list's fold until the next ask.
- After Redo the pane goes back to that ask's own lines when they were showing before.
- An answer given while a change stood stays in the history after that change is taken back.
- Counting an ask's lines runs the whole diff once more.
- After Undo took a file out of a proposal, another proposal's ask may claim it; Redo is then refused, or both
  name the file.
- Not tested: Redo failing on a conflict, Redo on a dropped proposal.
- Still to come in the design: an ask queued behind a running one, signals for a run that finished elsewhere,
  Mod+L, asking about selected answer text, "Add to the brain as a note", Stop on brain jobs.
