# Shellie's agents

Agents triage GitHub issues, implement them as pull requests and review those PRs; later stages fix review findings, merge and announce the fixes. Design: `docs/superpowers/specs/2026-10-26-agentic-sdlc-design.md`.

| Poller | Workflow | Every 15 min it… |
|---|---|---|
| Triage (stage 1) | `agents-triage.yml` | reads new issues and either asks the reporter questions or posts a fix spec |
| Implement (stage 2) | `agents-implement.yml` | takes one `agent:ready` issue (bugs first) and opens a PR with the fix |
| PR (stages 2-3) | `agents-pr.yml` | reviews each new commit of an agent PR; then fixes red CI, review findings, your comments and conflicts; merges in `full` mode |
| Notify (stage 3) | `agents-notify.yml` | every 30 min: tells the reporter which release has the fix |
| Nightly | `agents-nightly.yml` | once a night (03:27 UTC): files issues for problems in App Insights telemetry and for simpler code in the day's merges ([below](#the-nightly-agent)) |

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

4. **Project token** (for the board, optional): a classic personal access token (https://github.com/settings/tokens/new) with only the scopes **`project`** and **`public_repo`**, saved as repo secret `AGENTS_PROJECT_TOKEN` (`gh secret set AGENTS_PROJECT_TOKEN -R UnreliableWitness/Shellie` in a terminal, not in a chat). A GitHub App cannot change a personal account's projects, so the board sync uses this token; it is used only in the sync and in the implementer's pick (to read the Ready order), never where an agent runs. Draft cards become issues in the token owner's name. Without it, the board is not synced and the implementer keeps its own order.

5. **Azure login for the nightly agent's telemetry** (optional; without it the health pass is skipped). On your Mac, logged in with `az login`:
   ```sh
   app=$(az ad app create --display-name shellie-nightly-telemetry --query appId -o tsv)
   az ad sp create --id "$app"
   az ad app federated-credential create --id "$app" --parameters '{"name":"agents-nightly-main","issuer":"https://token.actions.githubusercontent.com","subject":"repo:UnreliableWitness/Shellie:ref:refs/heads/main","audiences":["api://AzureADTokenExchange"]}'
   az role assignment create --assignee "$app" --role "Monitoring Reader" --scope "$(az group show -n shellie-telemetry --query id -o tsv)"
   gh variable set AZURE_HEALTH_CLIENT_ID -R UnreliableWitness/Shellie --body "$app"
   gh variable set AZURE_HEALTH_TENANT_ID -R UnreliableWitness/Shellie --body "$(az account show --query tenantId -o tsv)"
   ```
   The role is on the resource group, so it covers `shellie-app` and its `shellie-logs` workspace. It can only read telemetry; there is no secret, GitHub's OIDC token is exchanged at each run.

Branch protection on `main` comes in a later stage; its steps will be listed here.

## Modes (`AGENTS_MODE` repo variable)

| Mode | What happens |
|---|---|
| unset or `off` | Nothing. The workflow does not even start a runner. This is the kill switch. |
| `shadow` | The agent triages, but nothing is written to issues; decisions go to the run's summary (Actions › Agents · triage › a run). An unchanged issue is looked at once. |
| `triage` | Live: questions, status comments and labels on issues. |
| `implement` | Triage, implementer, reviewer, fixer and notifier. **Nothing merges by itself**: a PR that is green and reviewed gets `agent:awaits-owner` and a comment, and you merge it. |
| `full` | Everything, and the agents merge a PR themselves when it meets the merge rule below. |

Run a poller by hand: Actions › Agents · triage (or · implement, · PR, · notify) › Run workflow.

**When they run.** The 15-minute schedules are only a safety net: GitHub starts scheduled runs late, or not at all, under load (20-40 minutes apart was seen). Each poller also starts as soon as something happens:

| Poller | Starts on |
|---|---|
| Triage | an issue opened, reopened or labelled, a comment on an issue (not the agents' own) |
| Implement | triage finished; a PR closed (the one agent PR slot may be free) |
| PR | CI finished on any branch (a new or fixed agent PR, or `main`); a review or comment on a PR (not the agents' own) |
| Notify | CI finished on `main` |
| Nightly | only its schedule (and Run workflow) |

The scripts ignore whatever does not concern them, so an extra start costs a minute of free runner time and no Claude usage. Every agent job checks out `main`, whatever the event, so a PR's own code never runs with the App token.

## Labels

| Label | Meaning |
|---|---|
| `agent:awaiting-approval` | Reporter is not in `.github/agents/trusted.yml`; nothing happens until you add `agent:go`. |
| `agent:go` | Your go-ahead, used once: the agents remove it as they act on it. On an untrusted reporter's issue it approves the reporter (it becomes `agent:approved`). On a `needs-owner` issue it sends it to implementation as triaged, with a fresh count of attempts. Add it again whenever you want another go. |
| `agent:approved` | Set by the agents from your `agent:go`: this untrusted reporter's issue may be worked on. Their later comments are still not read. |
| `agent:needs-info` | Questions asked; triaged again when the reporter answers. Reminder after 14 days, closed after 21. |
| `agent:ready` | A fix spec is in the status comment. |
| `agent:needs-owner` | The agent needs your decision; the status comment says what. Comment to have it triaged again. |
| `agent:stop` | Agents leave this issue alone for good. |
| `kind:*`, `risk:*` | Triage's call. Features and high-risk changes never merge without your approval. |
| `source:health`, `source:simplify` | Opened by the nightly agent, from telemetry or from its review of the day's merges. |

The agents keep one **status comment** per issue that they edit in place. Its hidden `<!-- shellie-agent … -->` block is their memory; it is trusted only in comments by the app.

They leave alone any issue that is assigned to someone, or that has a branch `issues/<n>-…` or an open PR mentioning `#<n>` not made by the app. So picking up an issue yourself is enough to keep them off it.

## How an issue becomes a PR

1. **Pick** (a small Linux job with the app's token): the oldest `agent:ready` issue, bugs before chores before features, while fewer than 3 agent PRs are open (`maxOpenAgentPrs`). After publishing a PR it starts the next implementation at once, so up to 3 issues are worked on side by side. It adds `claude-working` (the lock) and notes the attempt in the status comment.
2. **Implement** (a macOS job with only your Claude token, no GitHub token): Claude Code (Opus) writes a failing test, the fix, a change note in `docs/changes/`, runs `npm test`, typecheck and lint, and commits on `agent/issues/<n>-<slug>`. The job packs the branch into a git bundle.
3. **Publish** (a fresh Linux job with the app's token): checks the bundle itself: one branch, starting from the `main` commit pick saw, at most 50 commits, no change to the agents' own files, workflows, release or signing. Then it pushes and opens the PR (`Fixes #n`, labels `agent-pr`, `kind:*`, `risk:*`). Touching owner-only files (dependencies, the updater, secrets, cost, migrations), more than 400 changed lines, or failing checks make it `risk:high` and are listed in the PR under "Agent checks".

The agent runs code (tests), so it never shares a machine with a GitHub write token; publish trusts nothing it hands over.

If no PR comes out, the lock is released and the issue is tried again after an hour; after 2 attempts, or when the agent says it is blocked, the issue goes to `agent:needs-owner` with the reason. A lock left by a job that died is released after 3 hours.

**Review:** for each new head commit of an agent PR, a fresh Claude Code (Opus, read-only, it never saw the implementer's reasoning) reviews the diff against triage's spec and posts a comment review with findings on the lines. The app cannot approve its own PR, so the verdict ("changes needed" or "no blocking findings") is in the review text and the PR's status comment. A review can raise the risk to high on the PR and the issue.

**What you do in this stage:** read the PR and the review, then merge, push your own fixes to the branch, or close it. To stop the agents on an issue: `agent:stop`. Closing an agent PR without merging leaves `agent:pr-open` on the issue, so it is not picked again until stage 3 handles that (remove the label and set `agent:ready` by hand to retry).

## After the PR is open (stage 3)

Every 15 minutes, after the review, the PR poller looks at each agent PR and does one of these:

- **Waits** while CI runs or the review of the newest commit is not in yet.
- **Re-runs** a red CI's failed jobs once per commit before anything else (no Claude, so a flaky test costs no fix round). The decide job uses the workflow's own token for this.
- **Fixes**: when CI is red, the review found something critical or important, you commented on the PR (you or another trusted person), or the PR conflicts with `main`. A fix runs like the implementer: a macOS job with only the Claude token (Sonnet) gets the review findings, the end of the failing CI log and your comments, commits on the PR branch, and a fresh job checks the commits (they must build on the PR head: no history rewrite, no protected paths) and pushes them. Then CI and the reviewer run again. After 3 fix rounds it stops: `agent:hold-merge` on the PR, `agent:needs-owner` on the issue.
- **Updates the branch** with `main` when `main` has moved on and the PR could otherwise merge (GitHub's update-branch, no agent; CI and the review then run again on the new commit).
- **Merges** (only in `full` mode), squash, when all of these hold for the newest commit: the three CI checks are green (`test (macos-latest)`, `test (windows-latest)`, `windows-installer`), the agent review found nothing blocking, `main`'s last CI run is green, no `agent:hold-merge` or `agent:stop`, and either it is a low-risk change (bug, chore or feature, since 2026-10-26) of at most 400 changed lines touching no owner-only file, or **you approved it** (an Approve review on that commit). One merge per poll.
- **Asks you** otherwise (`agent:awaits-owner` and one comment per commit and set of reasons saying why: high risk, size, an owner-only file, your Request changes, or `implement` mode). While `main`'s CI is red or still running, a PR that could merge just waits.

**What you can do on an agent PR:** comment (the fixer acts on it), **Request changes** (the text goes to the fixer, and nothing merges until your latest review is an Approve), **Approve** (lets the agents merge in `full` mode what only you may merge; never past a red `main` or `agent:hold-merge`), push commits yourself, or close it. When the fixer has given up (`agent:hold-merge`), taking that label off lets it start over with 3 new rounds. A fix that changed nothing is retried after an hour, not on the next poll.

Owner-only files, which never merge without your approval: dependencies (`package.json`, `package-lock.json`), the updater, secrets, cost, migrations, `forge.config.mts`, `.claude/`, `scripts/`, `.npmrc`, `.mcp.json`, the vite and vitest configs, and `CLAUDE.md` (agents write change notes to `docs/changes/` instead).

**Dependabot PRs** (#193, `.github/dependabot.yml`): npm and GitHub Actions, weekly version updates (minor and patch grouped into one PR per ecosystem, each major on its own) plus security updates as soon as an advisory is out. Version updates only offer a release once it is 7 days old (14 for an npm major; `cooldown`), so a hijacked version is usually caught and pulled before it reaches Shellie; security updates skip that wait. The same poller handles every open PR whose author is exactly `dependabot[bot]` on a branch of this repo (never judged by the branch name), with no agent review and no fixer: CI is the gate. It **merges** (full mode, squash, sha pinned, one merge per poll for all PRs together) a patch or minor update when the three CI checks are green, `main` is green, and there is no `agent:hold-merge`, `agent:stop` or Request changes from you. The update type comes from the commits' metadata (`update-type: version-update:semver-*`), else from the "from 1.2.3 to 1.2.4" versions in the title and body (a 0.x minor bump counts as major). It **asks you** (`agent:awaits-owner`, one comment per commit and reasons) for a major or unknown update, a GitHub Actions bump (it changes `.github/workflows/`), and CI that is still red after one re-run of its failed jobs; your Approve on that commit lets it merge, never past red CI. A conflict is left for Dependabot to rebase; a branch behind `main` is updated. Merged updates that change `package.json` or `package-lock.json` ship with the next scheduled release, which installed apps download by themselves. Dependabot alerts and security updates are switched on in Settings › Code security (not in a file).

If you merge an agent PR yourself, or close it, the agents notice: a merge goes on to the release notice, a close hands the issue back to you (`agent:needs-owner`; `agent:go` has it implemented again).

**Releases are bundled:** a merge only runs the tests; at 12:00 and 17:00 Brussels time (13:00 and 18:00 in summer) the app changes merged since the last release become one version (Actions › CI › Run workflow on `main` releases right away). At the merge the reporter reads that the fix ships with the next release.

**Release notice:** when a published release contains the merge, the notifier comments on the issue ("Fixed in **vX.Y.Z** … Shellie updates itself within about half an hour"), labels it `agent:released` and closes it. If no release has it 26 hours after the merge (a scheduled release was missed: it failed, or `main` was red), it tells you once with `agent:needs-owner`. A merge that changes no app files (tests, docs, tooling) is closed at once: there is no version for it.

**Still broken:** a comment from a trusted person on a released issue (closed in the last 30 days) reopens it, and triage looks at it again.

## The project board

The GitHub Project **"Shellie"** on the owner's account (created by the first sync, linked to the repo) shows every open issue as a card. `agents-project.yml` syncs it after every agent run and every 15 minutes:

| Column | When |
|---|---|
| Inbox | new, not triaged yet (also an untrusted reporter's issue waiting for `agent:go`) |
| Needs info / Needs you | `agent:needs-info` / `agent:needs-owner` |
| Ready | `agent:ready` |
| In progress | `claude-working` |
| In review | `agent:pr-open` |
| Waiting for you | the agent PR has `agent:awaits-owner` or `agent:hold-merge` |
| Merged / Released / Closed | `agent:merged` / `agent:released` / closed otherwise |

The labels stay the source of truth: a card moved by hand goes back where its labels say on the next sync, except for the moves that steer:

- **A draft card** (+ Add item on the board, without picking an issue) becomes an issue in the repo, created as the owner, and triage picks it up.
- **A "Needs you" card dragged to Ready** is the owner's go-ahead (`agent:go`): it is implemented as triaged.
- **The order of the Ready column is the implementer's priority**: it takes the top card first; issues not on the board come after, bugs before chores before features, oldest first.

GitHub sends no event when a card moves on a personal account's board, so a move is seen at the next sync (within about 15 minutes).

## The nightly agent

Spec: `docs/superpowers/specs/2026-11-10-nightly-agent-design.md`. Two read-only passes, one Claude run each, at 03:27 UTC:

- **Health** (`sdlc-health`, Sonnet): a separate job logs in to Azure (step 5 above) and runs fixed queries over App Insights `shellie-app` (`tools/agents/nightly-telemetry.mjs`): exceptions grouped by a normalised signature (App Insights' `problemId` changes with every release), crashes and hangs, main-process stalls and memory from `app.health`, `ipc.ms`/`git.ms` per operation, startup and setup times, failure events, renderer long tasks, failing or slow dependencies, each for the last 24 h against the 13 days before. The agent gets only those aggregated rows, reads the code to find the cause, and files at most 3 issues for what is new, rising, a crash, or back after a fix.
- **Simplify** (`sdlc-simplify`, Opus): the app code (`src/`) merged since the last night's run (or the last 24 h). It looks for reuse, simplification, efficiency and logic in the wrong layer, and files at most 2 issues. No app code merged: no run.

The issues are opened by the app with `source:health` or `source:simplify` and a hidden signature; triage picks them up on its next poll and never asks the bot questions (it goes to `needs-owner` instead). An open issue with the same signature is not filed again; a closed one is filed as "seen again after #n was closed". Both runs count against `maxAgentRunsPerDay`; a usage limit pauses every agent.

**Mode:** besides `AGENTS_MODE`, the repo variable **`AGENTS_NIGHTLY_MODE`**: unset or `shadow` runs both agents and lists the issues it would open in the run's summary (Actions › Agents · nightly › a run), `live` files them, `off` stops it. It starts in shadow even when `AGENTS_MODE` is `full`; set it to `live` once the summaries look right (`gh variable set AGENTS_NIGHTLY_MODE -R UnreliableWitness/Shellie --body live`).

Try it locally (your `gh` and `az` logins, nothing written):

```sh
APPINSIGHTS_CONNECTION_STRING="$(gh variable get APPINSIGHTS_CONNECTION_STRING -R UnreliableWitness/Shellie)" \
  node tools/agents/nightly-telemetry.mjs /tmp/telemetry.json
node tools/agents/nightly.mjs --dry-run /tmp/telemetry.json
```

## Limits

`.github/agents/config.yml`: at most 5 issues triaged per run, one agent PR open at a time, one review per run, 30 agent runs a day across all agents (an implementation is one run, but a big one: Opus, up to 150 turns), `--max-turns` per agent. On a usage-limit error every agent pauses for an hour. Each poller keeps its own block on the Agent activity issue (triage in the body, the others in a comment each) and reads all of them for the cap and the pause.

The **Agent activity** issue (label `agent:activity`) is their bookkeeping: runs today, whether they are paused and until when, and open issues per label. Do not edit its hidden block by hand.

## Trust

Only text from people in `.github/agents/trusted.yml` (and from the app) reaches an agent; comments from anyone else are left out and counted. The App token reaches the triage and review scripts in a file they read and delete at start, never through the environment, so an agent they start cannot find it. Issue text is treated as data, never as instructions. The agent's environment holds the Claude token but no GitHub token: the script reads the agent's answer and does the writing.

## Trying it locally

```sh
node tools/agents/triage.mjs --dry-run 132
```

Triages issue 132 with your own `gh` login and Claude Code, prints the answer and the actions it would take, and writes nothing.
