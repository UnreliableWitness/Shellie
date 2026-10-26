# Agentic SDLC Stage 3 (fixer, merge, notifier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop: an agent PR with red CI, review findings, owner comments or a conflict is fixed by an agent; a PR that meets the merge rules is merged (in `full` mode); the reporter is told which release has the fix; a "still broken" on a released issue reopens it. Plus the fixes the first real run (#132 → PR #138) showed.

**Architecture:** The PR poller (`agents-pr.yml`) becomes four jobs: `review` (as stage 2), `decide` (ubuntu, App token, no LLM: bookkeeping for merged/closed PRs, update-branch, merge, or a fix task), `fix` (macOS, Claude token only: the fix agent on the PR branch, checks, bundle) and `publish-fix` (ubuntu, App token: verify and fast-forward push). The fix steps reuse the implement machinery (`runJob`, `bundleGit`, `verifyBundle`, `classifyPaths`) with the PR head as the base. A new `agents-notify.yml` (ubuntu, no LLM) tells reporters about releases. Pure decisions live in tested modules.

**Tech Stack:** as stages 1-2.

**Spec:** `docs/superpowers/specs/2026-10-26-agentic-sdlc-design.md` (sections 5.1 "still broken", 5.4, 5.5, 5.6, 6.2, 9 step 3).

## Global Constraints

- Subscription only; the fix agent never shares a machine with the App token (same split as implement).
- Fixer runs in `implement` and `full`; **merging only in `full`**. Fixer model `claude-sonnet-5-5` (config), `--max-turns 60`, `maxFixRounds` 3.
- Merge rule (spec 5.5): head SHA green on `test (macos-latest)`, `test (windows-latest)` and `windows-installer`; reviewer verdict `approve` for that SHA; no `agent:hold-merge`/`agent:stop`; up to date with `main`; latest `main` CI run green; no denied path; and either (`kind:bug` or `kind:chore`) with `risk:low` and ≤ 400 changed lines, or an `APPROVED` review by the owner on that SHA. Squash merge, delete branch.
- Protected paths for `full` (from the stage 2 review): owner-only adds `.claude/**`, `scripts/**`, `.npmrc`, `.mcp.json`, `vite.*.config.mts`, `vitest.config.mts`, `package-lock.json`; `CLAUDE.md` is owner-only unless the diff only adds lines.
- Notifier text: "Fixed in **vX.Y.Z** (released <date>). Shellie updates itself within about half an hour; restart when it offers. macOS: only builds in /Applications update." A merge with no release after 90 minutes gets one comment and `agent:needs-owner`.

## Review Focus

1. A fix bundle must fast-forward the PR head it was given; a force-push that rewrites history must never happen (Task 4).
2. The fixer must not loop: a PR waits for CI and for the review of its head before a fix, and stops after 3 rounds (Task 2).
3. A merge must never happen on a SHA other than the one checked (the merge call passes `sha`) (Task 3).
4. A closed-unmerged agent PR must release its issue, not leave `agent:pr-open` forever (Task 2).
5. An issue merged by the owner by hand must still get the release notice (Task 5).

---

### Task 1: Fixes from the first run

**Files:** Modify `tools/agents/implement.mjs`, `tools/agents/publish-checks.mjs`, `.github/workflows/agents-implement.yml`; Test `implement.test.ts`, `publish-checks.test.ts`

- `task.json` and `result.json` live in `$RUNNER_TEMP/agents/` (env `AGENTS_WORK`), never in the checkout (they made `npm run lint` fail in the agent's job on #132); the bundle too.
- `runJob` keeps the last 60 lines of each failing check's output in `result.checkOutput[name]`; publish shows them in the PR under "Agent checks" in a collapsed `<details>` block, through the same text masking (no tokens on that machine, but keep it to 4000 chars).
- `prBody` drops a "Generated with Claude Code" line the agent already wrote (it appeared twice on #138).
- `classifyPaths(files, { claudeMdAddsOnly })`: the owner-only additions above; `CLAUDE.md` owner-only when `claudeMdAddsOnly` is false (publish computes it from numstat: deletions 0).
- [ ] Tests: lint-clean location (task file path from `AGENTS_WORK`), check output in the PR body, single attribution line, new owner-only paths, CLAUDE.md rule both ways.

### Task 2: PR decisions

**Files:** Create `tools/agents/pr-decide.mjs`; Test `tools/agents/pr-decide.test.ts`

**Interfaces:**
- Produces: `decidePr({ pr, prState, checks, mainGreen, mode, config, ownerApproved, trustedComments, paths, lines }): Decision` with `Decision = { action: 'wait' | 'update-branch' | 'fix' | 'merge' | 'awaits-owner' | 'give-up', reason, fixInput? }`.
  - `checks`: `{ state: 'pending' | 'green' | 'red', failed: string[] }` from the head's check runs (the three required names).
  - Order: `agent:stop` → wait; CI pending → wait; review of head missing → wait; `fixRounds >= maxFixRounds` → give-up (once; `prState.gaveUp`); red CI, verdict `changes`, new trusted comments (id > `prState.lastSeenCommentId`) or `mergeable_state === 'dirty'` → fix with the inputs; `behind` → update-branch; mode `full` and merge rule met → merge; else awaits-owner (with the reasons: feature, high risk, size, owner-only path, main red).
- `prBookkeeping(issueStatus, pr)`: for an issue with `agent:pr-open` whose PR is merged → `merged`; closed unmerged → `released-to-owner`.
- [ ] Tests: each rule and the order; give-up once; awaits-owner reasons; mode `implement` never merges; `bookkeeping` both ways.

### Task 3: The decide step

**Files:** Create `tools/agents/pr.mjs` (CLI `decide | run | publish`); Modify `tools/agents/github.mjs` (`getPull`, `listCheckRuns(sha)`, `latestMainCi()`, `updateBranch(n, sha)`, `mergePull(n, sha)`, `listReviews(n)`, `listPrComments(n)`, `closeIssue`), `tools/agents/review.mjs` (store critical/important findings in `reviews[sha].items`, at most 20, each text ≤ 500 chars); Test `tools/agents/pr.test.ts`

- `runDecide({ gh, config, trusted, mode, now, summary })`: bookkeeping first for issues with `agent:pr-open`; then for open bot `agent-pr` PRs (oldest first) apply `decidePr`: `update-branch` (API, then wait), `merge` (`mergePull(n, headSha)` squash; issue → `agent:merged`, minus `claude-working`/`agent:pr-open`, status `merged`, `mergedAt`, `mergeSha`), `awaits-owner` (label once, PR comment once with the reasons), `give-up` (`agent:hold-merge` on the PR, `agent:needs-owner` on the issue), `fix` → at most one fix task per run: `{ pr, issue, branch, headSha, spec, findings, ciFailures: { job, logTail }[], comments, conflict }`, `fixRounds + 1` written before handing over, activity run recorded (poller `fix`).
- CI log tail: `gh run view --log-failed` equivalent through the API (`/actions/jobs/{id}/logs`, last 150 lines, ≤ 8000 chars).
- [ ] Tests with fakes: merge passes the head SHA and only in `full`; a closed PR releases its issue; a fix task carries findings and CI tails; update-branch on behind; awaits-owner labels once.

### Task 4: Fix and publish-fix

**Files:** Modify `tools/agents/pr.mjs`, `tools/agents/implement.mjs` (export `runJob` generalised: `{ branch, startSha, prompt, skill, model, maxTurns }`; `bundleGit` unchanged); Create `tools/agents/schemas/fix.json`, `.claude/skills/sdlc-fix/SKILL.md`; Test `tools/agents/pr.test.ts`

- `run`: checkout the PR head, `git merge origin/main` when the task says conflict (the agent resolves; the skill says keep both CLAUDE.md lines), the fix agent with the findings, CI tails and comments as data, checks, bundle `headSha..branch`.
- `publish`: `verifyBundle` with `baseSha = headSha` (the PR head must be an ancestor: fast-forward only), `classifyPaths` over `origin/main...branch`; push without `--force`; PR comment summarising what was fixed; on failure the round still counts.
- Fix answer: `{ status: 'done', summary } | { status: 'blocked', reason }`; blocked → give-up.
- [ ] Tests: fast-forward only (a bundle not descending from the head is refused); denied path refused; the push is not forced.

### Task 5: Notifier and "still broken"

**Files:** Create `tools/agents/notify.mjs`, `.github/workflows/agents-notify.yml`; Modify `tools/agents/classify.mjs`, `tools/agents/triage.mjs`; Test `tools/agents/notify.test.ts`, `classify.test.ts`, `triage.test.ts`

- `runNotify`: issues (open or closed) with `agent:merged`: the merge commit from the status (`mergeSha`) or, for an owner's manual merge, from bookkeeping; the earliest published release whose tag contains it (`compare/{sha}...{tag}` status `ahead` or `identical`, newest 20 releases); comment with the text above, `agent:released` instead of `agent:merged`, close if open. No release 90 minutes after `mergedAt` → one comment and `agent:needs-owner`.
- "Still broken": the triage poller also lists issues closed in the last 30 days with `agent:released`; a new trusted non-bot comment reopens the issue (status `state: 'released'` stays); `classifyIssue` treats an open issue with state `released` as `triage` (reason `reopened`).
- Workflow: every 30 minutes, ubuntu, App token, mode `implement` or `full`.
- [ ] Tests: release found → comment, labels, close; none after 90 min → owner once; a manual merge is noticed; still-broken reopen; reopened released issue is triaged.

### Task 6: Workflow and docs

**Files:** Modify `.github/workflows/agents-pr.yml` (jobs `review` → `decide` → `fix` → `publish-fix`, artifacts in `$RUNNER_TEMP`), `docs/agents.md` (stage 3, `full` mode, branch protection as owner setup), `CLAUDE.md`, the spec (5.5: no "main is red" issue, merges just stop; Task 1 path list in 6.2).

- [ ] `npm run lint`, `npm run typecheck`, `npm test` green; workflows parse; commit.
