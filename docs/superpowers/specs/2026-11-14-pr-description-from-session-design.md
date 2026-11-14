# PR description from the session — design

Date: 2026-11-14. Builds on #111 (`docs/changes/2026-10-22-111-draft-pr-description.md`). Reviewed by a builder check
(Fable); the owner answered the two open questions (tab cost, resumed tabs); the other calls are marked *(call)*.

## Why

PRs Shellie opens have thin descriptions. The Finish-page draft (#111) is written by a headless `claude -p` from the
work item **title only**, what the developer typed, the commits and the diff. It never sees how the problem was
actually solved (the agent's own explanations, what was tried, what was verified), and it never sees the work item's
description or acceptance criteria. It also only runs on Claude Code: an OpenCode-only machine gets no draft.

The owner wants the description to be based on the solution that was implemented in the session, working the same
with an OpenCode setup, without making Finish slow.

## Goals

- The draft explains what changed, why, how it works and how it was verified, from the session that did the work.
- Works with Claude Code and OpenCode tabs alike; works on a machine with only one of the two installed.
- Finish stays responsive: no multi-hundred-millisecond main-thread work, no extra network round trip on the critical
  path, the cost stays near today's (~$0.10 headless; one warm-cache turn when a tab is asked).

## Non-goals

- Updating the description of an existing PR that Finish links (still a known gap).
- Copilot tabs as a source or a writer.
- A changed PR title.

## Anti-goals

- Typing into a tab while its agent is working, waiting on the developer, or has unsent text in its input box.
- Anything landing in the branch (commits, stray files) because of the draft.
- Secrets from the session or diff ending up in the PR.
- A request that costs the customer a full cold-cache re-read of a long session.

## Approaches considered

1. **Ask the task's open agent tab** (picked, as the first try): Shellie types a short request into the idle session and
   reads the session's reply. Best quality (it knows the reasoning), cheap when the context is warm, identical for both
   agents. Breaks when there is no open, idle, recently active tab.
2. **Headless writer from a digest of the transcripts** (picked, as the fallback): today's headless run, fed the agent's
   replies as well as the developer's requests, plus the work item text. Always available, bounded cost, less rich on
   the reasoning.
3. **Fork-resume the Claude session headless** (`--resume --fork-session`): rejected — Claude-only, reloads the whole
   conversation cold (slow, expensive), needs a rule for which session.
4. **Agent keeps running notes during the task**: rejected for now — depends on the agent complying all task long.
5. **Have the tab hand the writing to a cheap subagent**: rejected — the cost of asking the tab is the main model
   re-reading the conversation, which the briefing turn pays anyway; a fresh subagent only knows its brief (weaker
   text) and a forked one runs on the parent's model. It adds a run without saving the expensive part. The warm-cache
   window in A is the cost control instead; the cheap-model choice belongs to B, which starts fresh anyway.

The owner chose 1 with 2 as the fallback.

## Design

### A. Ask the open tab

When the Finish page asks for a draft for a PR repo, Shellie first looks for a tab to ask. A tab qualifies when all hold:

- a task terminal of kind `claude` or `opencode` (not brain tabs, not Copilot) whose process is running;
- its saved session has at least one developer turn (Claude transcript by `sessionId`; OpenCode session in the tab's
  folder) — a resumed tab counts (owner);
- its last agent turn ended within the last **60 minutes**, so its prompt cache is likely warm (owner: "only if recently
  active"). Taken from the transcript / OpenCode DB timestamps, so it holds across an app restart *(call: 60 min)*;
- its last reported state is `idle` or `done`, or it has reported nothing since a resume — never `working`, `blocked`
  or `clear` (`clear` means the agent exited);
- its input box is empty: no keystrokes written to it since its last submitted turn and its output quiet for 2 s — the
  guard `ClaudeRetheme` already applies (`unsentAfter`, `typed`), generalised to every claude/opencode task tab.

Several qualify → the most recently active. None → B at once, with the reason (`no-tab`, `busy`, `stale`, `typing`).

`AttentionHub` gains a per-terminal `{ state, at }` map, fed by both paths it already has (Claude's OSC 7501 in
`data()`, OpenCode's plugin signal in `signal()`), cleared on `exit`/`retain`, with a read method. Attention logic is
otherwise unchanged except the suppression below.

**The request** *(call: reply in chat, not a file — Fable's review: writing a file prompts for permission in default
mode, cannot happen in plan mode, and risks stray files)*:

- Shellie writes the full instructions to `.shellie/pr-request-<n>.md` **in the asked tab's own worktree** (git-excluded;
  inside the tab's folder so reading it needs no permission): which repo, worktree, branch and base the PR is for, the
  description shape (What changed / Why / How it works / How it was verified, the last two only when there is something
  to say), the rules (no title, no commit list, no cost line, do not mention AI, nothing invented, language of the
  commits, length limit), the repo's `.shellie-pr.md` style guide when it has one, and: "do not edit, commit or run
  anything; reply with the description only, between the lines `<!-- shellie-pr -->` and `<!-- /shellie-pr -->`".
- Shellie types one line, `Shellie: write the pull request description as asked in .shellie/pr-request-<n>.md`, then
  `\r` after a short delay (as `brainTerminal` does).
- The reply is read from the session itself with the readers of C (Claude transcript / OpenCode DB): the first agent text
  after the request line that contains the markers. Shellie checks after each `done`/`idle` from that tab and stops at:
  - the marked reply → done;
  - `done`/`idle` without it (refusal, plan mode, the agent asked something) → B at once (`no-reply`);
  - the tab exiting → B (`exited`);
  - 3 minutes → B (`timeout`). While the tab is `blocked` the field says so; the clock keeps running.
- The result goes through `tidySummary` and the secrets masking (`diffMatcher`) as today; the request file is deleted.
- **Traces**: the attention tracker does not notify or badge the asked tab's `done` for Shellie's own request. The
  request line and the marked reply are left out of the brain lessons digest and B's digest (recognised by the
  `Shellie: write the pull request description` prefix and the markers).

**Write again** re-runs the same choice (tab if it still qualifies, else B) *(call)*. **Skip** now also cancels in main:
Shellie stops waiting, ignores a late reply and deletes the request file; the tab's turn itself is not interrupted.

Multi-repo tasks ask the same tab once per PR repo, one after the other.

### B. Headless fallback, from the solution

Same pipeline as today (`prSummaryPrompt`, timeout, read-only tools, task OTLP env), with richer input:

- **Work item text**: the home worktree's `.shellie/task.md` (written at setup; holds description, acceptance criteria,
  repro steps and comments), cut to ~6k characters. No network call. Missing file → title only, as today.
- **What was done**: the task's session turns from both agents — developer requests *and* the agent's replies — via the
  readers the brain's lessons use (`sessionTurns`, `opencodeSessionTexts`). Budget ~14k characters, filled newest turn
  first, each turn capped (~1.2k), shown oldest first. Replaces the requests-only section.
- The diff gets what is left of the 60k prompt.
- **Model**: a setting, *PR description model*, Sonnet (default) or Haiku, for the Claude Code writer. Haiku costs
  roughly a third and handles the structured summary well, a little less sharp on the "why". Lives with the other
  settings and shows next to the AI-related ones; the OpenCode writer keeps the user's OpenCode default model.
- **Writer agent**: Claude Code when installed (cost cap `--max-budget-usd 0.50` as today), else OpenCode (`opencode run
  --format json --title <Shellie PR title>`, prompt on stdin, the user's default model) with its **own** permission
  config that denies `edit`, `bash` and `webfetch` (the brain's config allows edits, so it is not reused). OpenCode has
  no budget flag; its cost is bounded only by the prompt size and the timeout. Its session is left out of the task's
  lesson reads by that title. Neither agent installed → the field fails with that reason, the PR gets the commit-list
  description as today.

### C. Faster session readers (shared with the brain lessons)

- **Claude transcripts**: stream the `.jsonl` line by line instead of reading it whole; skip without `JSON.parse` any
  line over ~100 KB and any tool-result line (cheap substring test). Measured: the owner's largest transcript (161 MB)
  takes 324 ms to read and parse whole on the main thread today.
- **OpenCode**: filter text parts in SQL (`json_extract(part.data, '$.type') = 'text'`) so large tool outputs are not
  loaded or parsed in JS.
- Session reading runs in parallel with the git calls of the draft.

### D. Draft state lives in main

`tasks:prSummary` today is one invoke returning `{text, error}`, and the draft state is a renderer module map that goes
stale when Finish unmounts (Fable: jumping to the tab and back leaves the field stuck on "writing"). The draft moves to
main: one draft per task and PR repo with `{ status, source, tab, text, error }`, started and cancelled by invoke,
progress broadcast (`tasks:prDraftChanged`), read again on mount. Statuses: `asking-tab`, `tab-blocked`, `writing`
(headless), `ready`, `failed`, `skipped`. The field shows "Asking Claude Code in <tab>…" with a link to that tab, and
"Writing it without the tab…" after a fallback.

### Telemetry

`pr.summary` gains `source: 'tab' | 'headless'`, `agent: 'claude' | 'opencode'` and the fallback reason (`no-tab`,
`busy`, `stale`, `typing`, `no-reply`, `exited`, `timeout`). `docs/telemetry.md` updated.

## Known gaps to state in the change note

- Windows: typing the line plus a delayed `\r` through ConPTY, and OpenCode headless stdin through the PowerShell shim,
  are unverified (Windows is the release target; #111 already lists the shim gap).
- The 60-minute window is a guess at the cache TTL: a tab just inside it may still be cold (the cache can be 5 minutes
  on some plans), so an occasional ask costs a cold read.

## Left to the builder

- Exact budgets within the figures above, the request file naming, the tool-result substring test.
- The look of the new field states within the existing `PrDescriptionField`.
