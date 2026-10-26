# Shellie's agents

Agents triage GitHub issues, and in later stages implement, review, fix, merge and announce the fixes. Design: `docs/superpowers/specs/2026-10-26-agentic-sdlc-design.md`. Stage 1 (this) is the **triage poller**: every 15 minutes it reads new issues and either asks the reporter questions or posts a fix spec.

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
| `implement`, `full` | Later stages; for triage they behave like `triage`. |

Run the poller by hand: Actions › Agents · triage › Run workflow.

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

## Limits

`.github/agents/config.yml`: at most 5 issues triaged per run, 20 agent runs a day across all agents, `--max-turns` per agent. On a usage-limit error every agent pauses for an hour.

The **Agent activity** issue (label `agent:activity`) is their bookkeeping: runs today, whether they are paused and until when, and open issues per label. Do not edit its hidden block by hand.

## Trust

Only text from people in `.github/agents/trusted.yml` (and from the app) reaches an agent; comments from anyone else are left out and counted. Issue text is treated as data, never as instructions. The agent's environment holds the Claude token but no GitHub token: the script reads the agent's answer and does the writing.

## Trying it locally

```sh
node tools/agents/triage.mjs --dry-run 132
```

Triages issue 132 with your own `gh` login and Claude Code, prints the answer and the actions it would take, and writes nothing.
