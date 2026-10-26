# Agentic SDLC: issues in, fixes out, without a human in the loop for the routine work

Date: 2026-10-26.

Owner decisions (from the conversation of 2026-10-26):
- **When someone opens a GitHub issue, an agent analyses it** and either has it implemented (by subagents) or asks the reporter more questions.
- **New feedback is picked up for fixing by itself**: replies to questions, review comments on a PR, "still broken" after a release.
- **It runs on pollers**, as an automated process, with a few dedicated agents/skills that keep improving the software.
- **Users get the fix in their Shellie when it is released.** Releases and auto-update already do this (every merge to `main` releases, open apps update within about 25 minutes, Home shows What's new, see CLAUDE.md, #126); this project feeds that pipeline, it does not rebuild it.
- **No extra costs, very important.** The agents run on the owner's existing Claude subscription (an OAuth token from `claude setup-token`, used as `CLAUDE_CODE_OAUTH_TOKEN`), never an API key or pay-per-use billing. Every other piece must be free too: public-repo Actions minutes on standard runners, a free GitHub App, App Insights queries within the free allowance. The owner's account must have *extra usage* turned off, so hitting the plan's limits pauses the agents instead of charging.
- The owner asked for the setup with Claude's recommended defaults for the other open choices: **trusted reporters: the owner (`UnreliableWitness`) and `maximedebraekeleer`**, and **auto-merge for low-risk bug fixes only** (features and risky changes wait for the owner's approval on the PR).

Everything else marked *(our call)* was decided while writing this spec and has not been confirmed by the owner.

## Why

Most Shellie issues are small, well-scoped bugs from the owner or a teammate (#94-#126: an editor not found, a base branch assumed to be `main`, a notice that cannot be closed). Each one today needs the owner to open a session, point Claude at the issue, wait, review, merge. A local "issue poller" session did part of this before (the `claude-working` label is left from it), but it only ran while the owner's Mac was awake and had a session open, kept no visible state, and had no guardrails beyond the owner watching.

Shellie is used by colleagues for client work, and every merge reaches all of them within half an hour. So the loop has to be fast for the routine case and careful about what it lets through.

## Goals

- An issue from a trusted reporter gets a triage answer within about 30 minutes: either specific questions to the reporter or a short spec of the fix.
- A clear, low-risk bug goes from issue to a merged, released fix with no human action, with tests, CI green on macOS and Windows, and an independent review.
- Features and risky changes arrive as a ready PR that the owner only has to approve.
- Replies, review comments, red CI and merge conflicts are picked up by themselves.
- The reporter is told in the issue which version has the fix and that their Shellie updates itself.
- Agents also find work themselves: new error patterns in the app telemetry, and a small weekly dose of known gaps and housekeeping.
- Users can report a problem from inside Shellie.
- The owner can see the state of every item at a glance (labels) and stop anything with one label or one variable.

## Non-goals

- Replacing the owner's own sessions. Issues the owner works on by hand are left alone (see 3.3).
- Testing on real Windows hardware or driving the app's UI. Agents rely on unit tests and the CI matrix, like the owner's sessions do today.
- Big features and new sub-projects end to end. Triage sends those to the owner (`agent:needs-owner`); the owner can still hand an approved spec to the implementer.
- Recording the agents' AI cost in Shellie's cost ledger or the cost server. The ledger reads local transcripts; runners are not local. Usage is shown per issue instead (section 8).
- A hosted service, a database or a dashboard. State lives on GitHub.
- Telling users inside Shellie which of *their* reports was fixed. Shellie does not know their GitHub identity; the issue comment and What's new cover it.

## Anti-goals (a failure even if it works)

- **Text from an issue steering an agent.** The repo is public, anyone can file an issue, and the agents run with the owner's subscription token and the scripts with push access. Untrusted text must never reach an agent with write power without the owner's say-so.
- A change reaching users that no independent reviewer and no green macOS + Windows CI has seen.
- Agents editing their own workflows, guardrails, the trusted list, release tooling or signing.
- Two agents (or an agent and the owner) working on the same issue.
- A runaway loop: the same issue attempted over and over, comment storms.
- **Any money spent beyond the owner's current subscription**, and the agents using up the owner's plan limits so the owner cannot work in their own sessions.
- Agents merging while `main` is red (a red `main` blocks releases; see the auto-merge memory and #113/#118).
- Asking the reporter vague or many questions. Questions must be few, concrete and answerable.

## 1. Shape

Pollers are scheduled GitHub Actions workflows in this repo *(our call: they run when the owner's Mac sleeps, every run is logged, CI for macOS and Windows is already there, and the setup is reviewable code)*. Each poll is a deterministic Node script that decides what to do, then calls Claude Code headless (`claude -p`) with a dedicated skill for the judgement work, then acts on the agent's structured output itself.

```
new issue ──► Triage ──┬─► agent:needs-info ──(reporter replies)──► Triage again
                       ├─► agent:ready ──► Implementer ──► PR "… (#n)", Fixes #n
                       ├─► agent:needs-owner (big, risky, a product decision)
                       └─► duplicate / not a bug (closed, with the reason)

agent PR ──► CI (mac + win) + Reviewer ──► Fixer (review comments, red CI, conflicts)
         ──► merge (auto for low-risk bugs, owner approval otherwise)
merge ──► existing release job ──► Notifier: "Fixed in vX.Y.Z" on the issue
"still broken" on a released issue ──► reopened ──► Triage again

daily  Health    ── App Insights error patterns ──► new issues ──► Triage
weekly Gardener  ── known gaps, flaky tests, deps ──► new issues ──► Triage
```

### 1.1 The key safety rule: agents decide, scripts act

*(our call)* Agents never hold a GitHub token. The orchestrator script:
1. gathers the input (issue, comments, PR, CI results) and filters it (trusted authors only, section 4),
2. runs `claude -p` in a checkout with `persist-credentials: false` and no `GH_TOKEN`/`GITHUB_TOKEN` in the agent's environment, asking for JSON on stdout against a schema,
3. validates that JSON, then labels, comments, commits and pushes itself, after its own checks (protected paths, size, tests).

So an agent can at worst write bad code or a bad comment into a structured field, which the script and the reviewer still check. The one secret in the agent's environment is `CLAUDE_CODE_OAUTH_TOKEN` (see Risks).

### 1.2 Pieces in the repo

| Path | What |
|---|---|
| `.github/workflows/agents-*.yml` | one workflow per poller (section 2) |
| `tools/agents/` | the orchestrator: Node ESM scripts with Vitest tests for every rule in this spec (selection, state, merge criteria, protected paths, trusted filter). `vitest.config.mts` gains this folder *(our call)* |
| `.claude/skills/sdlc-triage/`, `sdlc-implement/`, `sdlc-review/`, `sdlc-fix/`, `sdlc-health/`, `sdlc-garden/` | one skill per agent; each `SKILL.md` states its job, its output schema and its limits. Named `sdlc-*` with narrow descriptions so they never trigger in the owner's normal sessions |
| `.github/agents/trusted.yml` | trusted GitHub logins |
| `.github/agents/config.yml` | limits and models (section 6), read by the orchestrator |
| `.github/CODEOWNERS` | `@UnreliableWitness` on `.github/`, release tooling, signing and the protected paths |
| `.github/ISSUE_TEMPLATE/bug.yml`, `feature.yml`, `config.yml` | issue forms (section 7) |

Skills are self-contained; the runner does not install the superpowers plugin *(our call: fewer moving parts; the implement skill spells out the TDD and plan steps it needs)*.

## 2. The pollers

All on `schedule` cron (plus `workflow_dispatch` for a manual kick), each with its own `concurrency` group without cancel-in-progress, and a job timeout. Each first checks the repo variable `AGENTS_MODE` (section 9) and exits when `off`.

| Workflow | Cron | Runner | Does |
|---|---|---|---|
| `agents-triage.yml` | every 15 min | ubuntu-latest | triage new issues, re-triage answered `needs-info`, handle "still broken" on recently released issues; at most 5 issues per run |
| `agents-implement.yml` | every 15 min | macos-latest | if fewer than `maxOpenAgentPrs` (1) agent PRs are open, take the oldest `agent:ready` issue (bugs before features) and implement it; one per run; timeout 90 min |
| `agents-pr.yml` | every 15 min | ubuntu-latest (the reviewer only reads; changed 2026-10-26) | for each open `agent-pr`: review if the head SHA has no review, fix if there is something to fix, merge if it qualifies; at most one merge per run |
| `agents-notify.yml` | every 30 min | ubuntu-latest | no LLM: comment on `agent:merged` issues whose fix is in a published release |
| `agents-health.yml` | daily 06:00 UTC | ubuntu-latest | read App Insights, open issues for new or rising error patterns |
| `agents-garden.yml` | Mondays 06:00 UTC | ubuntu-latest | open at most 2 improvement issues |

macOS runners for code work because development is macOS-first and `npm ci` with node-pty is known to work there. Public repos have free Actions minutes on standard runners (`ubuntu-latest`, `macos-latest`, `windows-latest`); larger or GPU runners are never used, since they are billed. If the repo ever becomes private, code work moves to `ubuntu-latest` or a self-hosted runner on the owner's Mac before anything else runs, because private-repo macOS minutes cost money *(our call)*. GitHub may delay cron runs by several minutes; the targets above allow for that.

### 2.1 Token for the scripts

PRs created and merges done with the default `GITHUB_TOKEN` do not trigger other workflows, so CI would not run on agent PRs and the push to `main` would not release. The scripts therefore act as a dedicated GitHub App, **`shellie-agents`** (owner setup), through `actions/create-github-app-token`: permissions Contents, Issues, Pull requests (read & write), Checks and Actions (read). Its bot login (`shellie-agents[bot]`) is what the scripts use to recognise their own comments, PRs and issues.

## 3. State

### 3.1 Labels

| Label | Meaning | Set by |
|---|---|---|
| `agent:awaiting-approval` | from an untrusted reporter; nothing happens until the owner adds `agent:go` | triage script |
| `agent:go` | owner's go-ahead for an untrusted issue, or for a `needs-owner` issue to be implemented as triaged | owner |
| `agent:needs-info` | questions asked, waiting for the reporter | triage |
| `agent:ready` | spec posted, waiting for the implementer | triage |
| `agent:needs-owner` | too big, risky, a product decision, or the agents gave up; says why in the status comment | any |
| `claude-working` | lock: an agent is on it (exists already) | implement/pr scripts |
| `agent:pr-open` | a PR exists | implement script |
| `agent:awaits-owner` | on a PR that is ready but needs the owner's approval to merge (5.5) | pr script |
| `agent:merged` → `agent:released` | merged; then in a published release and the reporter told | pr / notify scripts |
| `agent:stop` | owner: agents leave this issue or PR alone, for good | owner |
| `agent:hold-merge` | owner: keep working on the PR but do not merge | owner |
| `agent-pr` | on PRs the agents own | implement script |
| `kind:bug`, `kind:feature`, `kind:chore` | from triage | triage |
| `risk:low`, `risk:high` | from triage, may be raised (never lowered) by the reviewer | triage, review |
| `source:health`, `source:gardener`, `source:app` | where the issue came from | scripts, issue form |

The existing `bug`/`enhancement` labels stay for humans; triage does not need them.

### 3.2 The status comment

Each issue the agents touch gets one comment from the bot that it edits in place *(our call: one comment, not a stream)*: a human summary on top (state, the spec or the questions, links to the PR and runs, tokens used so far) and a hidden machine block:

```
<!-- shellie-agent {"v":1,"state":"ready","lastSeenCommentId":123,"triageRounds":1,
     "implementAttempts":0,"fixRounds":0,"tokens":184000,"spec":{...}} -->
```

The orchestrator only trusts a block in a comment authored by its own bot login. Questions to the reporter are a separate, normal comment (so they get a notification); the status comment links to it.

### 3.3 Leaving the owner's work alone

An issue is skipped when it is assigned to a human, has `agent:stop`, or a branch or open PR not made by the bot references it (`issues/<n>-*`, or `#n` in a PR title). This keeps agents off issues the owner picked up in their own session. This replaces the old local issue poller; the owner stops running it.

## 4. Trust

- Only text written by logins in `.github/agents/trusted.yml` (initially `UnreliableWitness`, `maximedebraekeleer`) or by the bot itself reaches an agent. For an untrusted author's issue the script adds `agent:awaiting-approval` and a friendly comment, and does nothing else; when the owner adds `agent:go`, the issue body is treated as trusted (the owner vouched for it), its later comments from untrusted people still are not.
- Comments by untrusted people on agent issues and PRs are dropped from the agent's input, and the status comment says so ("1 comment from someone outside the trusted list was not read").
- Even trusted text is data, never instructions about the agent's own rules: every skill says so, and the skill's limits (protected paths, output schema) cannot be changed by issue text.
- Trust is checked again on every poll, so removing someone from the list takes effect at once.

## 5. The agents

Models *(our call, to spare the subscription's limits)*: triage, health, gardener and fixer Sonnet 5.5 (`claude-sonnet-5-5`), implementer and reviewer Opus 5.5 (`claude-opus-5-5`). Each runs `claude -p --output-format json --max-turns <cap>` (turns, not dollars: the subscription has no per-run price) with an explicit `--allowedTools` list and `--json-schema` style output instructions; the script rejects output that does not validate and records the run as failed.

### 5.1 Triage (`sdlc-triage`)

Input: the issue, its trusted comments, the previous status block, `CLAUDE.md`, and a read-only checkout. Tools: Read, Grep, Glob, read-only git.

It reads the code to understand and, where it can, locate the problem, checks duplicates (open and recently closed issues, given in the input) and checks the CLAUDE.md "known gaps". Output, one of:
- `ask`: 1-3 concrete questions to the reporter, each with why it matters ("Which repo's base branch is it: does `git symbolic-ref refs/remotes/origin/HEAD` print something?"). The script posts them @mentioning the reporter and sets `agent:needs-info`.
- `ready`: `kind`, `risk`, and a spec: problem, cause (with file:line), planned change, the test that proves it, docs to update (CLAUDE.md Status, `docs/telemetry.md`), and what it will not do. Script sets `agent:ready`.
- `needs-owner`: with the reason and the question for the owner.
- `duplicate` (of #m) or `not-a-bug` (with the explanation): script comments and closes. Closing as not-a-bug only for trusted reporters' issues once *(our call: a second disagreement goes to `needs-owner`)*.

`risk:high` when any of: touches a protected path (section 6.2), changes stored data formats or migrations, auth/tokens/secrets, cost or time numbers, release/update, deletes user data, or a change over about 400 lines. Features are `kind:feature` and never auto-merge whatever the risk.

Re-triage happens when the reporter (or the owner) replies to `needs-info`, when the owner comments on a `needs-owner` issue and adds `agent:go`, and when someone trusted comments on an `agent:released` issue closed within the last 30 days: the agent decides whether it is still broken (script reopens it, back to triage) or a different problem (script suggests a new issue). `needs-info` without an answer for 14 days gets one reminder; after 21 days the script closes it with "comment to reopen".

### 5.2 Implementer (`sdlc-implement`)

Input: the issue, the spec from the status block, the trusted comments. Tools: Read, Edit, Write, Glob, Grep, Bash limited to `npm`, `npx vitest`, `node`, `git` (no push; there are no credentials), and the Task tool for subagents.

Steps the skill prescribes: branch `issues/<n>-<slug>` from `main`; `npm ci`; write a failing test first; implement, splitting larger work into subagent tasks with a short plan; `npm test`, `npm run typecheck`, `npm run lint` green; update the CLAUDE.md Status (one entry in the existing style, with the issue number) and `docs/telemetry.md` if events change; commit in the repo's style with the attribution line. Output: `done` with a PR title in the repo's style (`Short description (#n)`), a PR body (what changed, why, how it was tested, what is not verified, e.g. Windows only through CI) and the spec's risk re-assessed; or `blocked` with the reason.

*(Changed 2026-10-26 while building stage 2.)* Because the implementer runs code, it runs in its own job on its own machine with only the Claude token; `pick` and `publish` are separate jobs with the App token, and the branch travels as a git bundle. Agent branches are `agent/issues/<n>-<slug>`, since `issues/<n>-` branches mean the owner is working (3.3). The publish job then checks: the bundle (one head, based on the `main` commit pick saw, 1-50 commits), no hard-denied path is touched (6.2), size, and the checks the implement job reported (failures are listed and make the PR `risk:high`; CI on the PR is the real gate). Only then it pushes with the App token, opens the PR (`Fixes #n`, labels `agent-pr`, `kind:*`, `risk:*`), sets `agent:pr-open` and keeps `claude-working`. A failure or `blocked` counts as an attempt; after `maxImplementAttempts` (2) the issue goes to `needs-owner` with the log summary.

### 5.3 Reviewer (`sdlc-review`)

Runs on each new head SHA of an agent PR, in a fresh context that never sees the implementer's reasoning: input is the issue, the triage spec and the diff, with a read-only checkout. Tools: read-only. It checks correctness, that the change does what the spec says and nothing more, tests that really test the fix, CLAUDE.md conventions (Platform interface for shell/path/spawn, telemetry docs, no colour literals outside `tokens.css`), and the anti-goals of the area it touches. Output: `approve` or `changes` with findings (file, line, what is wrong, the failure scenario), and a risk check that may raise to `risk:high` (never lower). The script posts the findings as a PR review from the bot (comments on lines; a `COMMENT` review, since a GitHub App cannot approve its own PR; if GitHub refuses a line, the findings go in the review body) and records the verdict with the SHA in the PR's status block.

### 5.4 Fixer (`sdlc-fix`)

Runs when an agent PR has any of: unresolved review findings from the reviewer or from trusted humans, red CI on the head SHA (the failing job's log tail is the input), or a conflict with `main`. Same tools as the implementer. Conflicts are resolved by merging `main` into the branch (conflicts are usually CLAUDE.md Status lines; the skill says to keep both sides). After its commits the reviewer runs again on the new SHA. After `maxFixRounds` (3) without reaching mergeable, the PR gets `agent:hold-merge`, the issue `needs-owner`.

Owner comments on an agent PR count as feedback the fixer acts on, the same as review findings.

### 5.5 Merge (script only, no LLM)

An agent PR is merged (squash, branch deleted) when all hold:
- head SHA has CI green on both `test` matrix legs and `windows-installer`,
- the reviewer approved this exact SHA, no unresolved review threads,
- branch is up to date with `main` (otherwise the fixer updates it first),
- no `agent:hold-merge`, `agent:stop`; no protected path touched,
- the latest `main` run is green (if red: no merges at all; *changed 2026-10-26: no "main is red" issue is opened, merges just stop and the PR says why*),
- and either (`kind:bug` and `risk:low` and at most `autoMergeMaxLines` (400) changed lines, not counting `package-lock.json` and `CLAUDE.md`), or the owner has approved the PR (a GitHub review "Approve" by `UnreliableWitness`).

PRs that need the owner get `agent:awaits-owner` and a short line in the PR body saying why. After a merge the issue gets `agent:merged`, loses `claude-working` and `agent:pr-open`. The next poll checks the `main` run and that the release job made a tag; if the release did not appear within an hour, the issue gets a comment and `needs-owner` (this is the check from the owner's auto-merge memory, now automated).

### 5.6 Notifier (script only)

For each `agent:merged` issue: find the earliest published release whose tag contains the merge commit (`git tag --contains`, then `gh release view`). Comment: "Fixed in **vX.Y.Z** (released <date>). Shellie updates itself within about half an hour; restart when it offers. macOS: only builds in /Applications update." Set `agent:released`, close the issue if GitHub has not.

### 5.7 Health (`sdlc-health`, daily)

The script queries App Insights `shellie-app` with Azure CLI after `azure/login` with an OIDC federated credential (owner setup; a service principal with *Monitoring Reader* on the resource) — App Insights API keys are being retired, so no key *(our call)*. Queries over the last 24 h against the previous 14 days: exceptions grouped by problem id and app version, `terminal.failed` by `kind`/`reason`, `cleanup.gaveUp`, `update.checkFailed`, `setup.finished` failures by step, `pr.failed` by kind, `home.failed` by kind. The agent gets the aggregated rows (no raw events; telemetry is already scrubbed) plus `docs/telemetry.md`, and returns at most 3 issues a day for patterns that are new, rising, or tied to the latest version, each with the query numbers, users affected and a code hypothesis. The script dedupes on a signature in a hidden marker in the issue body and opens them as the bot with `source:health`. They then go through triage like anything else.

### 5.8 Gardener (`sdlc-garden`, weekly)

Candidates the script gathers: the "known gaps" in CLAUDE.md, tests that failed then passed on re-run in last week's CI runs (flaky), `npm outdated` (minor and patch; Electron, Electron Forge and node-pty majors are always `risk:high`), and lint warnings. The agent picks at most 2 that code can fix (not "verify on real Windows hardware") and writes them as issues with `source:gardener`. Gardener issues are `kind:chore`; chores auto-merge under the same rule as bugs *(our call)*.

## 6. Limits and protected paths

### 6.1 `.github/agents/config.yml`

```yaml
maxOpenAgentPrs: 1
maxImplementAttempts: 2
maxFixRounds: 3
maxTriagePerRun: 5
autoMergeMaxLines: 400
maxTurns:        # --max-turns per run
  triage: 30
  implement: 150
  review: 40
  fix: 60
  health: 20
  garden: 30
maxAgentRunsPerDay: 20   # all agents together
maxIssuesPerDay: { health: 3 }
maxIssuesPerWeek: { gardener: 2 }
```

### 6.1a Staying inside the subscription

There is no money ceiling to set, because nothing is billed per use; the limits that matter are the plan's own usage windows, which the agents share with the owner's interactive sessions. So *(our call)*:
- **Usage-limit pause.** When `claude -p` reports a usage or rate limit, the script records the reset time in the "Agent activity" issue's status block (section 8), and every poller checks it first and exits until then. No retry storms; the item is simply picked up again after the reset.
- **One implementation at a time** (`maxOpenAgentPrs: 1`) and a daily cap on agent runs across all pollers (`maxAgentRunsPerDay`).
- **Owner hours.** Optional repo variable `AGENTS_QUIET_HOURS` (e.g. `08-18 Europe/Brussels`, Mon-Fri) during which only triage and the no-LLM scripts (merge, notify) run, so implementation happens evenings and nights and leaves the plan's limits to the owner during the work day. Off by default; the owner turns it on if the agents get in the way.
- **No paid fallback, ever.** The scripts refuse to start an agent when `ANTHROPIC_API_KEY` is set in the environment (Claude Code would prefer it over the subscription token and bill it), and the run fails with a clear message.
- Failed runs are retried on the next poll at most once per hour per item.

### 6.2 Protected paths

- **Hard-denied** (an agent PR that touches them is never pushed; the script refuses and sets `needs-owner`): `.github/workflows/**`, `.github/agents/**`, `.github/CODEOWNERS`, `.claude/skills/sdlc-*/**`, `tools/agents/**`, `tools/release/**`, `tools/forge/macSigning.mjs`, `assets/entitlements.mac.plist`.
- **Owner-only merge** (allowed, always `risk:high`): `forge.config.mts`, `src/main/autoUpdate.ts`, `src/main/secrets/**`, `src/main/costServer/**`, `src/main/ledger/**`, `src/main/migrate/**`, `package.json`, and (added 2026-10-26 with stage 3) `package-lock.json`, `.claude/**`, `scripts/**`, `.npmrc`, `.mcp.json`, `vite.*.config.mts`, `vitest.config.mts`, and `CLAUDE.md` unless the change only adds lines.

The same lists are in `tools/agents/` with tests, and CODEOWNERS covers them so a human edit also needs the owner.

## 7. Reporting from inside Shellie

- Issue forms: `bug.yml` (what happened, what you expected, steps, Shellie version, OS) and `feature.yml` (the problem, who has it, what would help). Field ids allow prefilling from a URL. `config.yml` keeps blank issues on *(our call, changed 2026-10-26 while building stage 1: the owner files quick issues such as #132 without a form)*.
- Shellie gets a **Report a problem** button in Settings › About and a "Report" link on error notices. It opens the browser on `https://github.com/UnreliableWitness/Shellie/issues/new?template=bug.yml&labels=source:app` with the version, OS and architecture prefilled, and for a notice its text run through the telemetry scrubber (`src/main/telemetry/scrub.ts`). The app holds no GitHub token; the user sees and can edit everything before submitting, and needs a GitHub account.
- New telemetry event `feedback.opened` (`from`: `about` or `notice`; never the text), added to `docs/telemetry.md`.
- Reporters not on the trusted list land in `agent:awaiting-approval` (section 4).

## 8. Visibility and usage

- Every run writes a job summary: what it looked at, what it decided, the tokens used and turns taken (from `claude -p`'s JSON), and links. Claude Code's `total_cost_usd` is an API-equivalent estimate, not a charge on a subscription; it is shown labelled "list-price equivalent, not billed" so the owner can see which issues are heavy *(our call)*.
- The status comment keeps the issue's running token total (triage + implement + review + fix runs).
- A pinned issue "Agent activity" that the triage poller edits once a day *(our call)*: open items per state, PRs waiting for the owner, merges and releases this week, runs today against `maxAgentRunsPerDay`, and whether the agents are paused for a usage limit and until when. Its hidden status block holds the pause.

## 9. Rollout and kill switch

Repo variable `AGENTS_MODE`:
- `off`: every poller exits at once (the kill switch).
- `shadow`: agents run, nothing is posted; decisions and drafts go to the job summary only.
- `triage`: triage, needs-info and the status comment are live; nothing is implemented.
- `implement`: PRs are opened and fixed, but nothing merges by itself.
- `full`: everything, including auto-merge.

Build order, each step usable on its own:
1. Labels, trusted list, config, issue forms, the GitHub App, the triage poller (`shadow`, then `triage`).
2. Implementer and reviewer (`implement`).
3. Fixer, merge, notifier (`full`).
4. Report a problem in Shellie.
5. Health and gardener.

The owner moves `AGENTS_MODE` forward by hand after watching each stage.

## 10. Owner setup (one-time)

1. Create the GitHub App `shellie-agents` (permissions in 2.1), install it on the repo, store `AGENTS_APP_ID` (variable) and `AGENTS_APP_PRIVATE_KEY` (secret).
2. Run `claude setup-token` on the owner's Mac (signed in with the current subscription) and store the token as secret `CLAUDE_CODE_OAUTH_TOKEN`; it lasts a year, so set a reminder to renew it. In claude.ai settings, make sure **extra usage is off**. Never add an `ANTHROPIC_API_KEY` secret to the repo.
3. Azure: a service principal with *Monitoring Reader* on `shellie-app`, a federated credential for this repo's `agents-health.yml`, variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
4. Branch protection on `main`: require the `test` and `windows-installer` checks; allow the App to merge. (Workflow edits stay owner-only through CODEOWNERS.)
5. Set `AGENTS_MODE=shadow`.

These steps go into `docs/agents.md`, together with how to read the labels and how to stop things.

## Risks

- **The owner's subscription token is in the agent's environment.** A trusted-but-compromised issue or a malicious dependency during `npm ci` could exfiltrate it and use the owner's plan. Limits: trusted reporters only, extra usage off (so a stolen token cannot cost money, only use up limits), and the token can be revoked from claude.ai and replaced by running `claude setup-token` again. GitHub write access is never in the agent's environment.
- **The agents compete with the owner for the plan's limits.** A heavy day of agent work can leave the owner rate-limited in their own sessions. Limits: one implementation at a time, the daily run cap, Sonnet where it is enough, the pause on a usage limit, and the optional quiet hours (6.1a).
- **Plan terms.** Using a subscription token in GitHub Actions is the documented way to run Claude Code's GitHub integration on a Pro/Max plan; if Anthropic's terms for automated use change, the pollers are switched `off` until the owner decides.
- **Auto-merge ships to every user in ~30 minutes.** Limits: bug/chore + low risk + size + independent review + CI on both OSes + green `main`; the owner can set `AGENTS_MODE=implement` to stop merges while keeping the rest. A bad release is fixed forward (there is no rollback in the updater today).
- **Windows is only checked by CI.** Same as the owner's sessions today; the reviewer flags Windows-specific risk, which makes it `risk:high`.
- **Agent conflicts in CLAUDE.md.** Every PR used to add a Status line there, so any two open PRs conflicted (#141 needed fix rounds for it). *Resolved 2026-10-26:* each change now gets its own file in `docs/changes/`, and `CLAUDE.md` is owner-only for agents.
- **Cron delay and GitHub outages** only slow things; nothing depends on a poll happening on time.

## Left to the builder

- The exact JSON schemas per agent and how the orchestrator is split into files.
- Whether to call `claude -p` directly (installed with `npm i -g @anthropic-ai/claude-code` at a pinned version) or `anthropics/claude-code-action` at a pinned version, as long as section 1.1 holds (no GitHub token in the agent's environment, structured output, the script acts).
- Prompt wording inside the skills, within what this spec says each agent does and must not do.
- The wording of the comments, within the tone of the existing issues: short, plain, specific.
