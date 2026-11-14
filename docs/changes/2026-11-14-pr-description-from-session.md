# PR description from the session

PR description from the session (2026-11-14, `feature/pr-description-from-session`). Spec:
`docs/superpowers/specs/2026-11-14-pr-description-from-session-design.md`; plan:
`docs/superpowers/plans/2026-11-14-pr-description-from-session.md`. Builds on #111
(`2026-10-22-111-draft-pr-description.md`).

## Why

The Finish draft (#111) only knew the work item's title, what the developer typed, the commits and the diff, so
descriptions were thin: they never said how the problem was solved or checked. It also only ran on Claude Code.

## How it works

- **Ask the tab first** (`src/main/prDraft/`). When Finish wants a draft, `pickTab` looks at the task's Claude Code
  and OpenCode tabs. A tab is asked when:
  - it runs and isn't paused by the leak watch;
  - its session has an agent turn from the last 60 minutes, so the prompt cache is likely warm (Claude: the
    transcript's tail; OpenCode: the session's `time_updated`);
  - its agent reports `idle`/`done`, or nothing since a resume;
  - nothing was typed since the last Enter, and its output has been quiet for 2 s.

  Several tabs qualify → the most recently active is asked. Shellie writes `.shellie/pr-request-<n>.md` in that tab's
  folder (the repo, branch, base, the shape, the style guide, "edit nothing") and types one line, `Shellie: write the
  pull request description as asked in .shellie/pr-request-<n>.md`, then Enter. `askTab` reads the answer from the
  session itself (Claude: the transcript from the byte it had before the request; OpenCode: the session's turns from
  the request time). It wants the text between `<!-- shellie-pr -->` and `<!-- /shellie-pr -->`.
  - A finished turn without the markers falls back at once, after one more read 1.5 s later.
  - A finished turn before the request line is even in the session does not count, but a line still missing after
    20 s falls back: the tab moved to another session (`/clear`, `/resume`, OpenCode's `/new`) or it is another
    tab's. For OpenCode, the session is looked up again at each read.
  - 3 minutes, or the tab exiting, also falls back.
  - The request file is removed in every case.
- **No traces:**
  - `AttentionHub.muteNextDone` turns the asked tab's next `done` into `idle`: no notification or badge, but a
    permission prompt raised during the turn is still notified and then cleared.
  - `withoutPrRequests` keeps the request and its answer out of the brain lessons digest and out of the headless
    prompt.
- **Headless fallback** (`src/main/services/prSummary.ts`). Same pipeline as #111, with richer input:
  - the home worktree's `.shellie/task.md` (description, acceptance criteria, comments; cut at 6k);
  - a "What was done" section: the developer's and the agent's turns from both agents, newest first within 14k, each
    cut at 1.2k, shown oldest first;
  - the prompt asks for What changed / Why / How it works / How it was verified / How to review.

  The writer:
  - Claude Code with the model from Settings › Agents and terminals › *PR description model* (Sonnet default, or
    Haiku).
  - When Claude Code is missing, OpenCode. Missing means detection says so, or the run finds no `claude`:
    `programMissing` checks ENOENT, exit 127, or PowerShell's "not recognized" / `CommandNotFoundException`; an
    error such as "model not found" does not count. The OpenCode run:
    `opencode run --format json --title "Shellie PR description"`, prompt on stdin. Its inline config denies edit,
    bash and webfetch, and the worktree's secret files for read. Its session is left out of the task's own sessions
    by that title.
  - Secrets are masked as before.
- **Faster readers:**
  - `src/main/sessions/claudeTranscript.ts` streams transcripts and skips tool-result and over-100 KB lines before
    `JSON.parse`. The owner's largest transcript (161 MB) took 324 ms to read and parse whole on the main thread.
  - OpenCode text reads filter `json_extract(part.data, '$.type') = 'text'` in SQL, guarded by `json_valid`.
  - The brain lessons digest uses the same readers.
- **Drafts live in main.**
  - `PrDrafts` with the `prDrafts:get|write|skip|edit` channels and the `prDrafts:changed` event replace
    `tasks:prSummary` and the renderer's module map.
  - Leaving Finish to look at the tab ("Show tab") and coming back shows the live state.
  - Skip aborts in main, so a late answer is ignored. Write again stops the running one, and a headless process
    is killed (`runWithInput` takes a signal).
  - Only asking a tab is queued per task, so a tab is never asked for two repos at once. Headless runs for several
    repos still run side by side.
  - Drafts are dropped once the task is done or discarded.
- **Field:** "Asking Claude Code…" / "Claude Code is waiting for you" with Show tab and Skip; "Writing it without the
  agent tab…" after a fallback. When ready: "Written by <tab> from this task's session.", or the reason it was written
  without the tab.
- **Telemetry:** `pr.summary` gains `source`, `agent`, `reason` and `failure` (`docs/telemetry.md`).

## Verified

- Unit tests for the readers, the protocol, `pickTab`, `askTab` (fake timers), `PrDrafts`, `TabActivity`, the hub's
  mute, the prompt and the writers.
- Handler tests: headless with Claude, the OpenCode fallback with its deny config, the work item and agent turns in the
  prompt with Shellie's own request left out, the drafts API.
- Finish page tests: remount mid-ask, Show tab, the edit kept in main.
- `npm test`, `npm run typecheck`, `npm run lint`.

## Known gaps

- Not run against a real Claude Code or OpenCode tab: the typed line, the `\r` after 150 ms and reading the marked reply
  are tested with fakes only. On Windows, typing through ConPTY and OpenCode's stdin through the PowerShell shim are
  unverified.
- The 60-minute window is a guess at the prompt cache's lifetime: on a 5-minute cache an ask can still be a cold read.
- OpenCode has no budget flag: the headless OpenCode run is bounded only by the prompt size and the 120 s timeout.
- A tab resumed with `--continue` (no `sessionId`) is never asked.
- An OpenCode tab's session is the newest in its folder, so two OpenCode tabs in one folder may read each other's.
- A PR that Finish links (already open) still keeps its description.
- The hub's mute is used up by the first `idle`/`done` after the request is typed, so a tab that reports one early
  can still notify when the real answer ends (cosmetic).
- Reviewed twice by a Fable advisor (plan and branch). Everything found was fixed except the cosmetic mute and the
  unverified real-tab run above.
