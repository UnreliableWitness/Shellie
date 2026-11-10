# Nightly agent: issues from App Insights telemetry and from a review of the day's merges

Spec: `docs/superpowers/specs/2026-11-10-nightly-agent-design.md`. It replaces the planned daily Health agent (5.7 of the agentic SDLC spec); the weekly Gardener is still not built.

## How it works

- `.github/workflows/agents-nightly.yml`, 03:27 UTC and Run workflow. The `telemetry` job (only when `AZURE_HEALTH_CLIENT_ID` is set) logs in to Azure with OIDC and runs `tools/agents/nightly-telemetry.mjs`: ten fixed KQL queries against `https://api.applicationinsights.io/v1/apps/{appId}/query`, the app id read from `APPINSIGHTS_CONNECTION_STRING`, token from `az account get-access-token`. The result (aggregated rows, about 40 KB) goes to the `nightly` job as an artifact, so the Azure login and the agent never share a machine.
- `tools/agents/nightly.mjs` runs two read-only passes, one `claude -p` each: **health** (`.claude/skills/sdlc-health`, Sonnet, 30 turns) over the telemetry, **simplify** (`.claude/skills/sdlc-simplify`, Opus, 40 turns) over `git diff <last night's main>..main -- src`. Both answer with `tools/agents/schemas/nightly.json`; `nightly-io.mjs` validates, dedupes on a signature kept in the issue body's hidden block (open: not filed; closed: filed as "seen again after #n"), caps at `maxIssuesPerDay.health` (3) and `.simplify` (2), and files with `source:health` / `source:simplify`.
- `AGENTS_NIGHTLY_MODE`: unset or `shadow` lists the would-be issues in the run summary, `live` files them, `off` stops it. `AGENTS_MODE` off stops it too, and `AGENTS_MODE=shadow` keeps it in shadow.
- Its block on the Agent activity issue (poller `nightly`) keeps `lastMainSha` (advanced only when the simplify pass finished or had nothing to do), `lastRunAt`, and its runs, which count against `maxAgentRunsPerDay`.
- Triage: an `ask` on an issue the bot opened becomes `needs-owner` (`planActions`, `bot` in its context), and the triage skill says so; the bot's issues have no reporter to answer.
- The queries handle what the real data showed: `problemId` holds the minified bundle path with the version, so exceptions are grouped by `type|source|channel|message` with ids and numbers as `#`; values over 10 minutes (sleep) are left out of stalls and operation means and maxima; `ipc.ms`/`git.ms` are read from `valueCount/valueSum/valueMax`; `percentileif` does not exist in App Insights, so `percentile(iff(…))`.

## Verified

- `npm test`, `npm run typecheck`, `npm run lint`; new tests in `nightly.test.ts` (modes, shadow, filing, dedupe, regression, no telemetry, nothing merged, usage limit, invalid answer, daily cap, telemetry parsing) and `nightly-io.test.ts`, and the bot-ask case in `triage-io.test.ts`.
- All ten queries ran against the real `shellie-app` (2026-11-10, 3 installs, 52 sessions in 14 days).
- `node tools/agents/nightly.mjs --dry-run telemetry.json` on that data: health proposed 3 issues (the renderer OOM crash on 1.89.0; "Unknown terminal" still thrown by `terminals:resize`, traced to `TerminalManager.ts:330` and the unhandled `invoke` in `TerminalView.tsx:140`, which #180's fix did not cover; main-process stalls still on 1.90/1.91), 139k tokens. Simplify reviewed the three merges of the day and filed nothing, leaving out a known gap a change note lists, 210k tokens.

## Known gaps

- The workflow itself has not run in Actions yet; the Azure app registration, federated credential and Monitoring Reader role (`docs/agents.md`, setup step 5) are owner setup. Without them only the simplify pass runs.
- In shadow nothing is filed, so the same finding is reported every night until it goes live.
- Few installs make "new" and "rising" judgement calls; the skill weighs sessions, but a busy day of one user can still look like a trend.
- Stall profiles and crash dumps stay on the user's machine; issues say where to find them.
