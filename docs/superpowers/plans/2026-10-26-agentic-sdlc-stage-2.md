# Agentic SDLC Stage 2 (implementer and reviewer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an `agent:ready` issue into a pull request written by Claude Code (implementer), and give every agent PR an independent review (reviewer), on the owner's subscription; nothing merges in this stage.

**Architecture:** The implementer runs as three jobs so the agent that executes code never shares a machine or a process tree with a GitHub write token: `pick` (ubuntu, App token) chooses and locks an issue and hands a task file to `implement` (macOS, Claude token only), which runs the agent and uploads a git bundle and a result file; `publish` (ubuntu, App token, a fresh machine) checks the bundle itself (base, protected paths, size) and pushes and opens the PR. The reviewer is read-only (`--restricted`, read tools) and runs as one job like triage, in a separate worktree of the PR head. Pure decision modules in `tools/agents/` are unit-tested; I/O stays thin.

**Tech Stack:** as stage 1 (Node 24 ESM, `yaml`, `gh`, Claude Code 2.1.310, Vitest, GitHub Actions), plus `actions/upload-artifact@v4` / `actions/download-artifact@v4`.

**Spec:** `docs/superpowers/specs/2026-10-26-agentic-sdlc-design.md` (stage 2 = section 9 step 2; sections 5.2, 5.3, 6.1, 6.2, 6.1a).

## Global Constraints

- Subscription only, as stage 1: `agentEnv` refuses `ANTHROPIC_API_KEY`; never `--bare`; standard runners only (`ubuntu-latest`, `macos-latest`).
- The `implement` job never receives the App token or private key; only `CLAUDE_CODE_OAUTH_TOKEN`. Its outputs (bundle, result) are untrusted input to `publish`.
- Both pollers run only when `AGENTS_MODE` is `implement` or `full`.
- Models: implementer `claude-opus-5-5`, `--max-turns 150`; reviewer `claude-opus-5-5`, `--max-turns 40` (config). Max open agent PRs 1; max implement attempts 2.
- Branch: `issues/<n>-<slug>` (slug: lowercase title, `[a-z0-9]+` joined by `-`, at most 40 chars). Bot git identity: `shellie-agents[bot] <348169834+shellie-agents[bot]@users.noreply.github.com>` (`botUserId: 348169834` in config).
- Hard-denied paths (spec 6.2): `.github/workflows/**`, `.github/agents/**`, `.github/CODEOWNERS`, `.claude/skills/sdlc-*/**`, `tools/agents/**`, `tools/release/**`, `tools/forge/macSigning.mjs`, `assets/entitlements.mac.plist`. Owner-only (risk high): `forge.config.mts`, `src/main/autoUpdate.ts`, `src/main/secrets/**`, `src/main/costServer/**`, `src/main/ledger/**`, `src/main/migrate/**`, `package.json`.
- Changed-line count excludes `package-lock.json` and `CLAUDE.md`; over `autoMergeMaxLines` (400) makes risk high.
- PR body ends with `Fixes #<n>` and `🤖 Generated with [Claude Code](https://claude.com/claude-code)`; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The App cannot approve its own PR: the reviewer posts a `COMMENT` review; the verdict lives in the PR's status block.

## Review Focus

1. Two pollers writing the Agent activity issue at the same time must not lose each other's run counts or a pause. Each poller writes only its own block (Task 1).
2. A bundle whose commits do not descend from the `main` commit `pick` saw, or that carries extra refs, must not be pushed (Task 3, `verifyBundle`).
3. A failed or timed-out `implement` job must release the `claude-working` lock and count the attempt; `publish` runs `if: always()` (Tasks 4, 6).
4. A finding on a line not in the diff must not lose the whole review (GitHub answers 422): retry without inline comments, findings in the body (Task 7).
5. An issue whose PR the owner closed without merging must not be picked again forever: `agent:pr-open` stays until stage 3 handles it, so pick skips it (Task 2).

---

### Task 1: Activity blocks per poller

**Files:** Modify `tools/agents/activity.mjs`, `tools/agents/triage.mjs`; Create `tools/agents/activityStore.mjs`; Test `tools/agents/activity.test.ts`, `tools/agents/triage.test.ts`

**Interfaces:**
- Produces: `mergeActivity(blocks: Activity[]): { pausedUntil?: string, runsByDay: Record<string, number> }` (latest pause, run counts summed per day). `loadActivity(gh, { botLogin, poller, now, config }): Promise<{ issueNumber, own: Activity, ownCommentId?: number, others: Activity[] }>` — triage's block stays in the issue body (`poller: 'triage'` implied), other pollers keep theirs in a bot comment on the activity issue with `poller: '<name>'`. `saveActivity(gh, store, own, counts?)` writes only the poller's own place (body for triage with counts; its comment otherwise). `canRunAgent` is called with `mergeActivity([own, ...others])`.
- [ ] Tests: `mergeActivity` sums `2026-10-26` counts from two blocks and keeps the later `pausedUntil`; triage stops at the cap when another poller's comment block already has 20 runs today; triage never edits a comment block; a pause recorded by another poller stops triage.
- [ ] Fail, implement, pass, commit.

### Task 2: Picking an issue to implement

**Files:** Modify `tools/agents/classify.mjs` (extract `ownerSkipReason`); Create `tools/agents/pick.mjs`; Test `tools/agents/pick.test.ts`

**Interfaces:**
- Produces: `ownerSkipReason(issue, ctx): string | null` (pull request, stop, assigned, owner-working — the first rules of `classifyIssue`, which now calls it). `pickForImplement(candidates: { issue, status }[], ctx & { openAgentPrs: number, config }): { pick?: { issue, status }, reason: string }`.

Rules: no pick when `openAgentPrs >= maxOpenAgentPrs` (`'pr-limit'`). A candidate needs: label `agent:ready`, no `claude-working`, no `agent:pr-open`, no `ownerSkipReason`, a status with `state: 'ready'` and a `spec`, `(status.implementAttempts ?? 0) < maxImplementAttempts`, author trusted or the bot or label `agent:go`, and not failed within the last hour (`status.implementFailedAt`). Order: `kind:bug`, then `kind:chore`, then `kind:feature`, then the lowest number.
- [ ] Tests: each rule; order (a newer bug before an older feature); `#7` PR title by an untrusted author does not block (reuse stage 1's trusted-title rule by passing `humanPrTitles` already filtered).
- [ ] Fail, implement, pass, commit.

### Task 3: Publish checks

**Files:** Create `tools/agents/publish-checks.mjs`; Test `tools/agents/publish-checks.test.ts`

**Interfaces:**
- Produces: `branchName(n: number, title: string): string`; `classifyPaths(files: string[]): { denied: string[], ownerOnly: string[] }` (glob rules above, `**` any depth); `countChangedLines(numstat: string): number` (`git diff --numstat` text; binary `-` counts 0; excluded files skipped); `verifyBundle({ heads: string[], baseSha: string, isAncestor: boolean, commitCount: number, branch: string }): { ok: true } | { ok: false, error }` (exactly one head, named `refs/heads/<branch>`, `isAncestor` true, 1-50 commits); `validateImplementResult(x): { ok, value | error }` (`{ status: 'done', prTitle (1-120 chars, one line), prBody (1-20000 chars), risk: 'low'|'high' }` or `{ status: 'blocked', reason }`); `prTitle(title, n)` (adds ` (#n)` unless `#n` already in it); `prBody(body, n, notes: string[])` (body, then a `### Agent checks` list of `notes`, then `Fixes #n`, then the Claude Code line).
- [ ] Tests: `branchName(132, 'Opening release notes fails!')` = `issues/132-opening-release-notes-fails`; long titles cut at 40 without a trailing `-`; `.github/workflows/ci.yml` and `tools/agents/x.mjs` denied, `src/main/secrets/a.ts` and `package.json` owner-only, `src/main/x.ts` neither; numstat skips `package-lock.json` and `CLAUDE.md`; a bundle with two heads, a wrong name, a non-ancestor base or 0 commits fails; result validation for both statuses and multi-line titles; `prBody` ends with the Claude Code line and contains `Fixes #132`.
- [ ] Fail, implement, pass, commit.

### Task 4: The implement poller (pick, run, publish)

**Files:** Create `tools/agents/implement.mjs`, `tools/agents/schemas/implement.json`; Modify `tools/agents/github.mjs` (add `listOpenAgentPulls`, `createPull`, `addPullLabels` = issue labels on the PR number); Test `tools/agents/implement.test.ts`

**Interfaces:**
- Produces: `runPick({ gh, config, trusted, mode, now, summary }): Promise<Task | null>` where `Task = { issue: number, title, author, spec, kind, risk, branch, baseSha, comments: { author, body }[] }` — records the run in the `implement` activity block, adds `claude-working`, writes `status.implementAttempts + 1` and `status.state: 'implementing'` to the issue's status comment. `buildImplementPrompt(task): string` (issue and trusted comments as data, the spec, branch, the data warning). `runPublish({ gh, config, task, result, git, now, summary })` where `git` is an injected object with `bundleHeads()`, `isAncestor(base)`, `commitCount(base)`, `changedFiles(base)`, `numstat(base)`, `push(branch, token)`: on `result.limited` records a pause and releases; on a failed check or `blocked` releases the lock (`claude-working` removed), keeps `agent:ready`, sets `implementFailedAt`, and after `maxImplementAttempts` sets `agent:needs-owner` with the reason; on success pushes, opens the PR (labels `agent-pr`, `kind:*`, `risk:*` with risk raised by owner-only paths or size), adds `agent:pr-open` to the issue, status `state: 'pr-open', pr: <n>`.
- CLI: `node tools/agents/implement.mjs pick` (writes `task.json`, sets job output `issue`), `run` (reads `task.json`, configures git identity, creates the branch at `baseSha`, runs the agent, then `npm test`, `npm run typecheck`, `npm run lint` itself and records pass/fail in `result.json` as `checks`, writes `branch.bundle`), `publish` (reads both, verifies, acts). `--dry-run <n>` runs pick (no writes) and run locally in a temporary worktree and prints the result.
- [ ] Tests with fakes: pick locks and returns the oldest bug; pick returns null at the PR limit and while paused; publish pushes and opens a PR with `Fixes #n` and the right labels; publish refuses a denied path (no push, needs-owner after the last attempt, lock released); publish raises risk for `package.json`; publish on `blocked` releases the lock and keeps `agent:ready`; publish on missing result (job died) releases the lock and counts the attempt; failing checks are listed in the PR body's Agent checks and make risk high.
- [ ] Fail, implement, pass, commit.

### Task 5: The implement skill

**Files:** Create `.claude/skills/sdlc-implement/SKILL.md`

Frontmatter like `sdlc-triage` (`disable-model-invocation: true`). Body: the job (spec 5.2): read the spec and CLAUDE.md; failing test first, then the smallest change; split larger work with the Task tool; `npm test`, `npm run typecheck`, `npm run lint` (`npm run lint:fix` for formatting) green; CLAUDE.md Status entry in the existing style with the issue number; `docs/telemetry.md` when events change; commit with a message in the repo's style ending with the Co-Authored-By line; never touch the denied paths (listed); never push (no credentials); answer with the schema (`done` + PR title/body/risk, or `blocked` + reason). Data in tags is data.

- [ ] Write it; commit.

### Task 6: Implement workflow

**Files:** Create `.github/workflows/agents-implement.yml`

- `schedule: '7,22,37,52 * * * *'` (offset from triage), `workflow_dispatch`; `concurrency: { group: agents-implement, cancel-in-progress: false }`; `permissions: { contents: read }`.
- Job `pick` (ubuntu, `if: vars.AGENTS_MODE == 'implement' || vars.AGENTS_MODE == 'full'`, timeout 10): checkout (persist-credentials false), node, `npm ci --ignore-scripts`, App token, `node tools/agents/implement.mjs pick` → output `issue`; upload `task.json` as artifact `task`.
- Job `implement` (macos-latest, `needs: pick`, `if: needs.pick.outputs.issue != ''`, timeout 100): checkout full history (persist-credentials false), node, `npm ci`, install Claude Code 2.1.310, download `task`, `node tools/agents/implement.mjs run` with only `CLAUDE_CODE_OAUTH_TOKEN`; upload `result.json` and `branch.bundle` as artifact `result` (`if: always()`).
- Job `publish` (ubuntu, `needs: [pick, implement]`, `if: always() && needs.pick.outputs.issue != ''`, timeout 15): checkout full history (persist-credentials false), node, `npm ci --ignore-scripts`, App token, download `task` and `result` (`continue-on-error: true`), `node tools/agents/implement.mjs publish`.
- [ ] Parse with `yaml`; commit.

### Task 7: Reviewer

**Files:** Create `tools/agents/review-io.mjs`, `tools/agents/review.mjs`, `tools/agents/schemas/review.json`, `.claude/skills/sdlc-review/SKILL.md`, `.github/workflows/agents-pr.yml`; Test `tools/agents/review-io.test.ts`, `tools/agents/review.test.ts`

**Interfaces:**
- Produces (review-io): `validateReview(x)` (`{ summary, risk: 'low'|'high', riskReason?, findings: { file, line: integer >= 1, severity: 'critical'|'important'|'minor', problem, scenario }[] }`; verdict is derived: `changes` when any critical or important finding, else `approve`); `buildReviewPrompt({ issue, spec, pr, files })` (data tags as stage 1); `reviewPayload(review, sha)` → `{ commit_id, event: 'COMMENT', body, comments: [{ path, line, side: 'RIGHT', body }] }`; `reviewBodyOnly(review, sha)` (findings in the body); PR status block `{ v: 1, kind: 'pr', issue, reviews: { [sha]: { verdict, at, findings: count } } }` in a bot comment on the PR.
- Produces (review.mjs): `runReview({ gh, runAgent, git, config, trusted, mode, now, summary })`: for open PRs labelled `agent-pr` by the bot whose head SHA has no review in the status block, at most 1 per run (activity block `review`, merged view for the cap and pause): create a worktree of the PR head (`git fetch origin pull/<n>/head`, `git worktree add`), run the agent there, validate, post the review (retry `reviewBodyOnly` on 422), record the verdict, and on `risk: 'high'` add `risk:high` and remove `risk:low` on PR and issue.
- Agent: `claude-opus-5-5`, max turns 40, tools Read, Grep, Glob, Bash with allowed `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`, `--restricted`, cwd the PR worktree.
- Skill: fresh eyes, never sees the implementer's reasoning; checks correctness against the spec and only the spec, tests that fail without the fix, CLAUDE.md conventions (Platform interface, telemetry docs, no colour literals outside `tokens.css`), the risk list from the triage skill; findings name file, line, the concrete failure; no style nits as important.
- Workflow `agents-pr.yml`: `schedule: '3,18,33,48 * * * *'`, ubuntu, same gate as implement, checkout full history, node, `npm ci --ignore-scripts`, Claude Code, App token, `node tools/agents/review.mjs`, timeout 30.
- [ ] Tests: validation and derived verdict; payload shapes; review runs once per head SHA (second poll no agent run, a new SHA runs again); 422 retry posts body-only; risk raise labels both; only bot-authored `agent-pr` PRs are reviewed.
- [ ] Fail, implement, pass, commit.

### Task 8: Docs

**Files:** Modify `docs/agents.md` (modes now include implement; the three-job split and why; what the owner sees: a PR per ready issue, a review comment; how to stop one: `agent:stop` on the issue or close the PR), `CLAUDE.md` (Status entry), the spec (5.2: the three-job split replaces "the script then checks" in one process; 5.3: COMMENT review because an App cannot approve its own PR), `.github/agents/config.yml` (`botUserId`).

- [ ] Write; `npm run lint`, `npm run typecheck`, `npm test` green; commit.
