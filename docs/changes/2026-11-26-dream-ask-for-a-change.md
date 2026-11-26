# Ask for a change, on the dream's page

Date: 2026-11-26. Asked by the owner in a session: "I had trouble with adjusting a dream. It opens a new task and
you dont get the context really. Can you make this an integrated experience", then, of three approaches, "1 should
be as integrated as possible". Design: `docs/superpowers/specs/2026-11-26-dream-ask-for-a-change-design.md`.

## What changed

- A proposal's pane on the dream's page ends in a box that stays in view under the diff: **Ask for a change to
  this proposal**. Type what should change and press Enter; the dream's own agent works on that one proposal in
  the background and the diff, title and reason change in place. No task, no form, no terminal.
- Text selected in the diff, the title or the reason goes along as "About: ...".
- What was asked and what came of it stays listed with the proposal. The newest change has **Undo**. A question
  gets an **Answer** and changes nothing.
- While an ask is worked on: "Working on: ..." with **Stop**, a dot on the proposal's row, the other boxes and
  Create pull request off. The page can be left and come back to.
- A failed or stopped ask leaves the proposal as it was and offers **Try again**.
- "Change with an agent" left the header; the old way is in the palette as "Open this dream as a task".

## How it works

- `dream:adjust`, `dream:adjustStop`, `dream:adjustUndo` in `src/main/dreams/dreamHandlers.ts`. The run is a dream
  run (`dreamCall` in `dreamRun.ts`, shared with `DreamRunner`): OpenCode with the project's dream model in the
  dream's worktree, the dream's environment, the model rule, 10 minutes at most. Its usage counts as a dream's.
  It runs whatever the day's limit says (the owner agreed: the limit is for what Shellie does by itself).
- Shellie, not the agent, makes the change: only the proposal's own paths (and new or unowned files in the
  allowed folders) go into a new commit with the old commit's parent (`remadeCommit` in `dreamGit.ts`, a
  temporary index and `commit-tree`); everything else the run touched is wiped by the rebuild and named in the
  ask ("Left as they were"). The branch stays the base plus one commit per kept proposal, so the diff, Create
  pull request and the dream's task read the changed proposal as they read any other.
- Each ask is stored on the proposal (`adjustments`) with the proposal as it was before, which is what Undo puts
  back. Replaced commits stay reachable through `refs/shellie/dreams/<dream>/<sha>` until the dream closes.
- The agent reports through `<data>/adjust.json` (title, reason, note), by `adjustPrompt` in `prompts.ts`.
- The page: `src/renderer/components/dreams/AskBox.tsx`, used by `DreamScreen.tsx`.
- Telemetry: `dream.adjust` with its outcome only (`docs/telemetry.md`).

## Decisions Claude made

- Asks are refused without a tested dream model and a repo that is set up to dream.
- An answer cannot change the title or reason (there would be nothing to undo).
- A change that would leave the proposal empty fails with "drop it instead".
- Drop is off while an ask is worked on; drafts are kept per proposal; a stopped ask shows in the warning colour,
  not red.

## Verified

- `npm run typecheck`, `npm run lint`; the dream and renderer tests (184 files, 2422 tests), with real temporary
  git repos and a stand-in for OpenCode on the main side.
- In the running app on macOS, a hand-made dream with two proposals on a scratch repo and the real OpenCode on
  its free model (`opencode/big-pickle`): a line selected in the diff became the "About" chip; the ask "Drop this
  line and the logging line, and say why a 404 is never retried in one short sentence" showed "Working on" with
  Stop and Push branch off, then the diff went from 7 to 5 lines with the reason extended and the row marked
  "changed"; Undo put back the first commit, text and diff; a question got an answer and no change; the worktree
  was clean afterwards. Dark and light.

## Known gaps

- Windows was not run. Stop, a failure with Try again, "Left as they were", and sending a changed dream as a pull
  request were not seen in the app (tests cover them).
- Each ask is one run without memory of earlier asks; the agent sees the proposal as it now is.
- Refs left by a crash in the middle of a dream are not swept at launch; nothing stops an ask on quit (the next
  start clears it and says so).
- Between sending and the page hearing the run started there can be a brief moment with an empty box.
