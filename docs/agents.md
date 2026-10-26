# Shellie's agents

Agents triage GitHub issues, implement them as pull requests and review those PRs; later stages fix review findings, merge and announce the fixes. Design: `docs/superpowers/specs/2026-10-26-agentic-sdlc-design.md`.

| Poller | Workflow | Every 15 min it… |
|---|---|---|
| Triage (stage 1) | `agents-triage.yml` | reads new issues and either asks the reporter questions or posts a fix spec |
| Implement (stage 2) | `agents-implement.yml` | takes one `agent:ready` issue (bugs first) and opens a PR with the fix |
| PR (stage 2) | `agents-pr.yml` | reviews each new commit of an agent PR, read-only, and comments on it |

They run on the owner's **Claude subscription**, never on an API key, and only on free GitHub runners. Nothing they do costs money beyond the subscription.

## One-time setup (owner)

1. **GitHub App** `shellie-agents` (Settings › Developer settings › GitHub Apps › New):
   - no webhook; repository permissions: Contents, Issues, Pull requests: read & write; Checks, Actions: read.
   - Install it on `UnreliableWitness/Shellie` only.
   - Repo variable `AGENTS_APP_ID` (the App ID) and repo secret `AGENTS_APP_PRIVATE_KEY` (a generated private key, the whole `.pem`).
   - If the app's slug is not `shellie-agents`, set `botLogin: <slug>[bot]` in `.github/agents/config.yml`.
2. **Claude subscription token**: on your Mac, signed in to the plan you use, run `claude setup-token` and save the token as repo secret `CLAUDE_CODE_OAUTH_TOKEN`. It lasts a year: put a reminder in your calendar to renew it.
   - In claude.ai settings, make sure **extra usage is off**. Then running into the plan's limits pauses the agents instead of charging.
   - **Never add an `ANTHROPIC_API_KEY` secret.** Claude Code would prefer it and bill it; the scripts refuse to run when it is set.
3. Repo variable **`AGENTS_MODE=shadow`** to start.

Later stages add an Azure login for the health agent and branch protection on `main`; their steps will be listed here.

## Modes (`AGENTS_MODE` repo variable)

| Mode | What happens |
|---|---|
| unset or `off` | Nothing. The workflow does not even start a runner. This is the kill switch. |
| `shadow` | The agent triages, but nothing is written to issues; decisions go to the run's summary (Actions › Agents · triage › a run). An unchanged issue is looked at once. |
| `triage` | Live: questions, status comments and labels on issues. |
| `implement` | Triage, plus the implementer opens PRs and the reviewer reviews them. **Nothing merges by itself**: you merge or close agent PRs. |
| `full` | Stage 3 (not built yet): fixes review findings and merges low-risk bug fixes. For now the same as `implement`. |

Run a poller by hand: Actions › Agents · triage (or · implement, · PR) › Run workflow.

## Labels

| Label | Meaning |
|---|---|
| `agent:awaiting-approval` | Reporter is not in `.github/agents/trusted.yml`; nothing happens until you add `agent:go`. |
| `agent:go` | Your go-ahead: for an untrusted reporter's issue, or to implement a `needs-owner` issue as triaged. Used once per issue; to go again, comment. |
| `agent:needs-info` | Questions asked; triaged again when the reporter answers. Reminder after 14 days, closed after 21. |
| `agent:ready` | A fix spec is in the status comment. |
| `agent:needs-owner` | The agent needs your decision; the status comment says what. Comment to have it triaged again. |
| `agent:stop` | Agents leave this issue alone for good. |
| `kind:*`, `risk:*` | Triage's call. Features and high-risk changes never merge without your approval. |

The agents keep one **status comment** per issue that they edit in place. Its hidden `<!-- shellie-agent … -->` block is their memory; it is trusted only in comments by the app.

They leave alone any issue that is assigned to someone, or that has a branch `issues/<n>-…` or an open PR mentioning `#<n>` not made by the app. So picking up an issue yourself is enough to keep them off it.

## How an issue becomes a PR

1. **Pick** (a small Linux job with the app's token): the oldest `agent:ready` issue, bugs before chores before features, when no other agent PR is open. It adds `claude-working` (the lock) and notes the attempt in the status comment.
2. **Implement** (a macOS job with only your Claude token, no GitHub token): Claude Code (Opus) writes a failing test, the fix, the CLAUDE.md Status line, runs `npm test`, typecheck and lint, and commits on `agent/issues/<n>-<slug>`. The job packs the branch into a git bundle.
3. **Publish** (a fresh Linux job with the app's token): checks the bundle itself: one branch, starting from the `main` commit pick saw, at most 50 commits, no change to the agents' own files, workflows, release or signing. Then it pushes and opens the PR (`Fixes #n`, labels `agent-pr`, `kind:*`, `risk:*`). Touching owner-only files (dependencies, the updater, secrets, cost, migrations), more than 400 changed lines, or failing checks make it `risk:high` and are listed in the PR under "Agent checks".

The agent runs code (tests), so it never shares a machine with a GitHub write token; publish trusts nothing it hands over.

If no PR comes out, the lock is released and the issue is tried again after an hour; after 2 attempts, or when the agent says it is blocked, the issue goes to `agent:needs-owner` with the reason. A lock left by a job that died is released after 3 hours.

**Review:** for each new head commit of an agent PR, a fresh Claude Code (Opus, read-only, it never saw the implementer's reasoning) reviews the diff against triage's spec and posts a comment review with findings on the lines. The app cannot approve its own PR, so the verdict ("changes needed" or "no blocking findings") is in the review text and the PR's status comment. A review can raise the risk to high on the PR and the issue.

**What you do in this stage:** read the PR and the review, then merge, push your own fixes to the branch, or close it. To stop the agents on an issue: `agent:stop`. Closing an agent PR without merging leaves `agent:pr-open` on the issue, so it is not picked again until stage 3 handles that (remove the label and set `agent:ready` by hand to retry).

## Limits

`.github/agents/config.yml`: at most 5 issues triaged per run, one agent PR open at a time, one review per run, 20 agent runs a day across all agents (an implementation is one run, but a big one: Opus, up to 150 turns), `--max-turns` per agent. On a usage-limit error every agent pauses for an hour. Each poller keeps its own block on the Agent activity issue (triage in the body, the others in a comment each) and reads all of them for the cap and the pause.

The **Agent activity** issue (label `agent:activity`) is their bookkeeping: runs today, whether they are paused and until when, and open issues per label. Do not edit its hidden block by hand.

## Trust

Only text from people in `.github/agents/trusted.yml` (and from the app) reaches an agent; comments from anyone else are left out and counted. Issue text is treated as data, never as instructions. The agent's environment holds the Claude token but no GitHub token: the script reads the agent's answer and does the writing.

## Trying it locally

```sh
node tools/agents/triage.mjs --dry-run 132
```

Triages issue 132 with your own `gh` login and Claude Code, prints the answer and the actions it would take, and writes nothing.
