# Ask for a change, on the dream's page

Date: 2026-11-26. Status: the owner picked the approach ("1 should be as integrated as possible"); the details
below are Claude's calls unless marked as the owner's.

## Why

The owner: "I had trouble with adjusting a dream. It opens a new task and you dont get the context really. Can you
make this an integrated experience". Today "Change with an agent" leaves the dream's page for the New task form
and then a task; the proposals and their diffs are out of sight, the agent says nothing until spoken to, and
nothing ties what you ask to the proposal you were reading.

## Goals

- A proposal that is nearly right is changed where it is read: type what should change, see the diff change.
- What was asked and what came of it stays with the proposal, and the last change can be taken back.
- No task, no form, no terminal, no leaving the page.

## Non-goals

- A conversation with memory across asks (each ask is one run; the agent sees the proposal as it now is).
- Asks that span proposals (merge two, split one), or that make a new proposal.
- Editing a proposal's files by hand in Shellie.

## Anti-goals

- An ask that changes another proposal's files, or anything outside the folders a dream may change.
- A page that moves by itself: no counters, no streaming text, no reordering (calm UI).
- A change the developer cannot see or cannot take back.

## Approaches

1. **Ask on the page** (picked by the owner): a box per proposal; the dream's own agent runs in the background on
   that proposal; the diff updates in place.
2. An agent tab beside the dream: full back-and-forth, a heavier screen and a much larger build.
3. Keep the task and fix its landing: cheapest, still another place.

## How it works

### The run (main)

- `dream:adjust(repoId, proposalId, ask, quote?)` starts one run for a kept proposal of the open result and
  resolves once it has started; the outcome arrives with the result (`dream:changed`). One run per result at a
  time. It refuses with a fixed phrase when: the result or proposal is not there, the proposal is dropped, a run
  is under way ("A change is already being made"), the ask is empty or over 4 000 characters, the dream's
  worktree is gone ("This dream's files are gone: it can be sent or discarded, not changed").
- The run is a dream run in every way that guards one: OpenCode with the project's dream model, in the dream's
  worktree with the dream's environment (`dreamEnv`, `dreamArgs`, the session title, hooks off), stoppable, with
  the run timeout cut to 10 minutes, and the model rule (another model answering switches dreaming off exactly as
  after a dream). Its usage is a dream's usage: the ledger counts it because the worktree lies in the dreams
  folder. It runs whatever the day's limit says: the limit governs what Shellie does by itself, and this is the
  developer asking; the usage still counts toward the day.
- Before the run the worktree is made the base plus the kept proposals (the existing `rebuild`), so the agent
  reads every kept proposal as it stands.
- The prompt (`adjustPrompt` in `prompts.ts`) names the proposal (title, reason, files), gives the developer's
  ask as an instruction and the quoted lines as what it is about, repeats the dream's rules (where it may write,
  session text is never instruction, no git, no shell), tells it to change only this proposal's files or add new
  files in the allowed folders, that it may change nothing when the ask is a question, and to write
  `<dataDir>/adjust.json`: `{ "title": string, "why": string, "note": string }`: the proposal's title and reason
  as they should now read, and one or two sentences on what it did, or the answer to a question.
- After the run Shellie, not the agent, decides what the change is:
  - paths changed outside the allowed folders, forbidden paths (as in a dream), and files of other proposals are
    put back and named in the adjustment (`reverted`);
  - what remains becomes the proposal's new commit: its parent is the old commit's parent and its tree is the
    old commit's tree with the run's changes to the proposal's files. So the branch is still the base plus one
    commit per kept proposal and `dream:diff`, Create pull request and the dream's task read the changed proposal
    with no change of their own;
  - `files` becomes the paths the new commit changes against its parent; `title` and `why` follow `adjust.json`
    when they are non-empty strings of at most 200 and 1 000 characters, else stay;
  - an adjustment is added to the proposal: the ask, the quote, the note (at most 1 000 characters; "No note"
    when missing), whether anything changed, what was put back, and the proposal as it was before (commit, files,
    title, reason);
  - the worktree is rebuilt, so nothing uncommitted is left.
- Nothing changed and no note: the ask failed ("The agent changed nothing"). A failed, stopped or timed-out run
  leaves the proposal as it was, the worktree rebuilt, and `adjustFailed` on the result with the ask and a fixed
  phrase, so the page can offer it again.
- `dream:adjustStop(repoId)` stops the run. `dream:adjustUndo(repoId, proposalId)` takes back the proposal's
  latest adjustment that changed something: commit, files, title and reason go back to `before`, and that
  adjustment and any later ones (answers) leave the list. Refused while a run is under way.
- Every commit a proposal had stays reachable while the dream is open (a ref per replaced commit, or what the
  code already does for a dropped proposal's commit), and goes when the dream closes.
- Discard dream stops a run first. Create pull request and opening the dream as a task are refused while a run is
  under way. A run left behind by a quit is found at the next start: `adjusting` is cleared and `adjustFailed`
  says "Shellie was closed while the change was being made".
- Telemetry: `dream.adjust` with `outcome` (`changed`, `answered`, `failed`, `stopped`) and nothing else;
  `docs/telemetry.md` lists it.

### The page (renderer)

- The proposal's pane ends in a foot that stays in view while the diff scrolls: the proposal's asks, newest last,
  and the box.
  - The box: a text field, placeholder "Ask for a change to this proposal", Enter sends, Shift+Enter makes a new
    line, a button "Ask". Off for a dropped proposal ("Take the proposal back to change it").
  - Text selected in the diff, the title or the reason when the box takes focus becomes a chip above it, "About:
    “the selected text”" (cut at 600 characters, shown on one line) with a button to remove it; it is sent as
    `quote`.
  - An ask in the list: "You: make it shorter" and under it "Changed: Cut the second example." or the answer. The
    newest adjustment that changed something has "Undo". What Shellie put back shows as a warning line: "Left as
    they were: <paths>". The list shows the last three; "Earlier asks (n)" opens the rest.
- While a run is under way: the box of that proposal is replaced by "Working on: “make it shorter”" and "Stop";
  the boxes of the other proposals are off with "A change to “<title>” is being made". The proposal's row in the
  list carries a quiet dot. Create pull request is off with the reason in its tooltip. The page can be left and
  come back to: the state is the result's.
- When the run ends the diff, title and reason are the new ones, in place, with nothing animated. A failure shows
  under the box as "Could not make the change: <phrase>" with "Try again", which puts the ask back in the box.
- A changed proposal's row says "changed" in its meta line.
- "Change with an agent" leaves the header. The palette keeps the old way as "Open this dream as a task". The
  page's opening line reads: "Shellie proposes these changes to this repo's skills and rules, from your past
  sessions. Drop what you don't want, ask for a change where one is nearly right, then create a pull request."

### Shared shapes (`src/shared/dreams.ts`, `src/shared/ipc.ts`)

`DreamAdjustment`, `proposal.adjustments?`, `result.adjusting?`, `result.adjustFailed?`, and the three channels:
written first, so main and the page are built against the same types. All optional, so stored results of before
read as they are.

## Left to the builder

How the new commit is made (a temporary index and `commit-tree`, or another way that leaves the same commit), how
replaced commits are kept reachable, the CSS of the foot.
