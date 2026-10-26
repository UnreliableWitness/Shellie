# Shellie

A desktop app for running development tasks as isolated workspaces, with AI cost tracking per task. The app was called MIAC ("Me, I'm Counting", after a Culture ship) until 2026-10-18.

## What it does

- **Task = worktree + branch + terminals**, tied to an Azure DevOps work item.
  - Create a git worktree and branch from a work item.
  - Run per-repo setup (e.g. `npm ci`) after creating the worktree.
  - Open the task's terminals: Claude Code, GitHub Copilot, PowerShell, dev server.
  - Clean up the worktree and branch when the task is done.
- **AI cost tracking per task.**
  - Track Claude Code and Copilot token usage per task, using OpenTelemetry tagged with the task id.
  - Price usage with our own rate table, in EUR.
  - Keep every AI request as a priced record in a local cost ledger, attributed to the task's work item, and send the records to the company's cost server (opt-in, since 2026-10-23); nothing about cost is written to Azure DevOps.
  - Why: we use consumption-based licences and invoice customers for AI cost.

## Tech

- Electron + xterm.js + node-pty.
- Electron Forge (Vite + React + TypeScript), Vitest.
- **Windows is the release target**, but development happens on macOS first (decided 2026-10-14). All shell, path and spawn logic goes behind the `Platform` interface so the Windows implementation is a module swap, not a rewrite.

## Conventions

- Per-repo setup file: `.shellie.yml` (setup commands, terminals, dev server, etc.).
- CLI entry point: `shellie start <workitem>`.

## External resources

- Design doc and mocks (design canvas): https://claude.ai/artifact/4kbfLSRgmPYqtrJWZ6yoMJ
  - Local snapshot of the 7 mockup screens: `design/mockups/`, see `design/README.md` for what each screen shows. Use them as the UI reference.
- Azure DevOps project: https://dev.azure.com/unreliablewitness/Shellie
  - Access needs a PAT. Never paste a PAT in chat or commit it; read it from the environment or a credential store.
  - Shellie must support multiple Azure DevOps organizations (connections), each repo linked to one.
- GitHub repo: https://github.com/UnreliableWitness/Shellie

## Status

Shellie ships from `main`: every merge releases the next minor version for Windows and macOS (Apple Silicon), and installed apps update themselves (`src/main/autoUpdate.ts`, `docs/macos-release.md`). Issues are triaged, implemented, reviewed, fixed and merged by agents on GitHub Actions (`docs/agents.md`).

**What changed and why lives in `docs/changes/`, one file per change** (`YYYY-MM-DD-[issue-]topic.md`): the spec it followed, how it works, what was verified and its known gaps. Read the notes for the area you touch. Each change adds its own new file there; never add change notes to this file (every PR editing the same lines here conflicted with every other).

- Run with `npm start` (`SHELLIE_USER_DATA=<absolute path> npm start` runs on a separate, fresh data folder; ignored by packaged builds); checks are `npm test`, `npm run typecheck`, `npm run lint`. Run `npm install` after pulling: a `postinstall` step fixes node-pty's spawn-helper permissions.
- App telemetry (issue #14, merged in PR #17): anonymous usage events, errors and timings to Azure Application Insights `shellie-app` (resource group `shellie-telemetry`; `miac-app` in `miac-telemetry` before 2026-10-18) via a dependency-free client in `src/main/telemetry/` (not OpenTelemetry, so it cannot clash with the OTLP receiver). The connection string is the repo variable `APPINSIGHTS_CONNECTION_STRING`, baked in at build time by `vite.main.config.mts`; local builds send nothing. Setting `sendTelemetry` (Settings > Appearance, default on), `SHELLIE_TELEMETRY=0` turns it off for a launch. Renderer code calls `track()`/`trackScreen()` from `src/renderer/telemetry.ts`; main scrubs paths and repo/task/work item/org names. What is collected is listed in `docs/telemetry.md`; keep it in sync when adding events.
- Azure DevOps test project `unreliablewitness/Shellie` (named MIAC until 2026-10-18; Basic process, Sprint 1, team `Shellie Team`) has seeded items 1-4 from `tools/ado/seed-test-items.mjs`. PAT for dev scripts lives in the macOS Keychain (account `shellie`, service `shellie-ado-unreliablewitness`); the app itself stores connections in `connections.json`, encrypted with safeStorage.
- Specs live in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`.
