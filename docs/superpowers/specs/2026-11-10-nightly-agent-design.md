# Nightly agent: health from App Insights, simplify on yesterday's merges

Date: 2026-11-10. Builds on the agentic SDLC (`2026-10-26-agentic-sdlc-design.md`), which planned a daily Health agent (5.7) and a weekly Gardener (5.8); this replaces the Health plan and leaves the Gardener for later.

## Why

The owner asked for a nightly agent that finds performance and code-quality work, "especially powerful if we can address issues detected from Azure Monitor". Telemetry already tells us about real problems nobody filed (2026-10-27 → 11-10, 3 installs, 52 sessions): "Unknown terminal" is 85 % of all exceptions and still fires on `terminals:resize` after #180 was closed; half the `app.health` reports of 1.89/1.90 show a main-process stall of ≥ 1 s; `git worktree remove` fails 99 % of its calls. The agents merge a lot of code a day, and a fresh `/simplify`-style look at it catches duplication while it is small.

## Goals

- Every night, look at the last day of telemetry against the previous 13 days and file issues for what is **new, rising, or back after a fix**: errors, crashes and hangs, stalls, slow operations.
- Every night, review the app code merged to `main` since the last run for reuse, simplification and efficiency, and file issues for what is worth changing.
- Issues go into the existing pipeline (triage → Ready → implementer → review → merge rules); the owner steers with the board as for any issue.

## Non-goals

- No PRs from the nightly agent itself. It files issues; the implementer does the work.
- No code-only performance hunting without data: performance comes from telemetry.
- No Gardener work (dependencies, flaky tests) yet.
- No change to the app or its telemetry.

## Anti-goals (failure even if it runs)

- Noise: a stream of taste-level refactors, or the same telemetry pattern re-filed every night or every release.
- Spending money: everything stays on free runners and the owner's Claude subscription (no API key, no paid Azure feature; reading App Insights is free).
- Starving the issue work: the nightly runs count against the shared daily cap and run when nothing else does.
- Weakening the trust model: the agent never holds a GitHub token or the Azure login.

## How it works

### Workflow `agents-nightly.yml`

`cron: '27 3 * * *'` (04:27 Brussels in winter, far from the 11:00/16:00 UTC releases) plus `workflow_dispatch`. Gated like the others on `AGENTS_MODE` not empty and not `off`. Two jobs on `ubuntu-latest`:

1. **`telemetry`** (only when repo variable `AZURE_HEALTH_CLIENT_ID` is set): `id-token: write`, `azure/login` with OIDC (`client-id: vars.AZURE_HEALTH_CLIENT_ID`, `tenant-id: vars.AZURE_HEALTH_TENANT_ID`, `allow-no-subscriptions: true`), then `node tools/agents/nightly-telemetry.mjs` runs the fixed queries and writes one JSON file, uploaded as an artifact. No Claude, no GitHub token on this machine. The App Insights app id comes from the existing repo variable `APPINSIGHTS_CONNECTION_STRING` (`ApplicationId=`). Queries go to `https://api.applicationinsights.io/v1/apps/{appId}/query` with a token from `az account get-access-token --resource https://api.applicationinsights.io` (no CLI extension needed).
2. **`nightly`** (`needs: telemetry`, runs `always()` so a failed or skipped telemetry job only skips the health half): downloads the artifact if there is one, App token in a file as in the other pollers, runs `node tools/agents/nightly.mjs`.

The Azure login and the agent never share a machine, so the agent cannot read the Azure token. `agents-project.yml` also syncs the board after this workflow.

### Modes

`AGENTS_MODE` off → nothing. Otherwise the repo variable **`AGENTS_NIGHTLY_MODE`** decides: unset or `shadow` (default) → the agents run and the step summary lists the issues they would open, nothing is written except the agent's own activity block; `live` → issues are opened; `off` → nothing. *(Our call: the owner has `AGENTS_MODE=full`, and a new agent should prove itself in shadow first.)*

### The two passes (one `claude -p` run each)

**Health** (`sdlc-health` skill, Sonnet, 30 turns, read-only tools as triage): input is the telemetry JSON (aggregated rows only), the known nightly issues (below), and the repo checkout to locate the code. Queries (24 h window vs the 13 days before, by app version):

1. exception signatures: type + source + IPC channel + message with UUIDs and numbers replaced by `#` (App Insights' `problemId` changes with every release because the minified stack frame holds the version, so it is not used), with sessions, users, versions, first and last seen;
2. crashes and hangs: `process.gone`, `window.unresponsive`/`responsive`, Critical exceptions;
3. main-process stalls from `app.health` (`loopDelayMaxMs` between 1 s and 10 min; above is laptop sleep), memory p95 per version;
4. `ipc.ms`/`git.ms` per op: calls, mean, max (capped at 10 min), failure share, from the pre-aggregated `valueCount/valueSum/valueMax`;
5. startup and setup: `app.started` and `setup.step.*`/`setup.finished` p50/p95 per version, failed setups by step;
6. known-failure events (`cleanup.*`, `pr.failed`, `home.failed`, `update.checkFailed`, `costServer.*`, `terminal.failed`/`exitedEarly`, `notice` errors);
7. renderer long tasks per version;
8. failed or slow (> 5 s) dependencies.

The skill tells the agent the pitfalls found on real data: few installs (weigh sessions, not users), duplicates (an IPC failure is reported by the handler and as the renderer's unhandled rejection), ≥ 2 sessions on a version before "new in version X" counts, sleep in maxima, stall profiles are local only (the issue tells the owner where to find `diagnostics/stalls`). Max `maxIssuesPerDay.health` (3) issues.

**Simplify** (`sdlc-simplify` skill, Opus, 40 turns, read-only tools plus `git diff`): the range is the nightly agent's last seen `main` commit (kept in its activity block) to the checked-out `main`; the first run, or when that commit is gone, uses the last commit older than 24 h. Only `src/` counts: when no file there changed, the pass is skipped without a Claude run. The agent reads the diff and the code around it and looks for reuse (an existing helper not used), simplification, efficiency, and altitude (logic in the wrong layer), in the house style of `docs/changes/2026-11-06-simplify-whole-app.md`. It does not file what the change notes in `docs/changes/` already list as known gaps or parked items, style preferences, or anything that changes behaviour without saying so. Max `maxIssuesPerDay.simplify` (2) issues.

### The issues

Both passes answer with the same schema: `summary` and up to N `issues`, each `{ signature, title, problem, evidence, cause, suggestion, regressionOf? }`. The script validates in code (as triage does), then for each issue:

- **signature**: lowercase, `[a-z0-9:._-]`, stable across versions (e.g. `exception:ipc:terminals:resize:unknown-terminal`, `stall:main-loop`, `simplify:src/main/foo.ts:duplicate-retry`). The script keeps it in a hidden status block at the end of the issue body (`<!-- shellie-agent {"v":1,"source":"health","signature":…} -->`, the house format).
- **dedupe**: issues with `source:health`/`source:simplify` (open and closed) are read; an issue whose signature matches an **open** one is not filed again. One matching a **closed** one is filed with a line "Seen again after #n was closed" (a regression). The agent also gets the list (number, state, title, signature) so it can reuse a signature instead of inventing a near-twin.
- labels `source:health` or `source:simplify` (new); triage sets kind and risk.
- the body says which agent found it and when, the evidence (query numbers, versions, sessions; or the commits and `file:line`), the likely cause, a suggested change, and for stalls where the local profiles are.

Bot-authored issues have no reporter to ask, so triage must never choose `ask` for them: `planActions` turns an `ask` on a bot issue into `needs-owner` with the questions, and the triage skill says so.

### Budget and bookkeeping

Its own block on the Agent activity issue (poller `nightly`): runs per day (shared `maxAgentRunsPerDay` with implement/review/fix: two runs at 03:27 UTC on a fresh UTC day), the usage-limit pause (a limit stops the remaining pass and pauses every agent, as elsewhere), `lastMainSha`, `lastRunAt`. `lastMainSha` advances only when the simplify pass completed or had nothing to review.

## Owner setup (one time)

An app registration `shellie-nightly-telemetry` with a federated credential for subject `repo:UnreliableWitness/Shellie:ref:refs/heads/main`, **Monitoring Reader** on resource group `shellie-telemetry` (covers the component and its `shellie-logs` workspace), repo variables `AZURE_HEALTH_CLIENT_ID` and `AZURE_HEALTH_TENANT_ID`. Without them the health half is skipped with a summary line and the simplify half still runs.

## Left to the builder

Exact KQL (verified against the real data), prompt wording, row caps per query (≈ 25), turn counts, tests in the style of `tools/agents/*.test.ts` (fakes, no mocks), the change note and `docs/agents.md`.
