# Telemetry across the app: timings, health, logged errors, jank

Asked for: telemetry in all crucial parts of the app, to measure performance, usage and failures in Application Insights (`shellie-app`).

Feature usage was already well covered (about 80 events, `docs/telemetry.md`), as were IPC failures, crashes and Azure DevOps requests. What was missing was performance outside boot and setup, the health of a long-running session, and the many failures main recovers from and only logs. This change adds those, mostly in a few central places instead of at every call site.

## What changed

- **Timing summaries** (`src/main/telemetry/perf.ts`). `PerfStats` sums samples in memory per operation and outcome, and `report` sends one aggregated metric item for each (App Insights `MetricData` kind Aggregation: count, sum, min, max). A busy session sends a few dozen items every 10 minutes, not one per call. The app's one instance, `perf`, is fed by:
  - `trackHandlerFailures` (`helpers.ts`): every IPC call, `ipc.ms` by channel.
  - `GitClient.run`: every git command, `git.ms` by `gitOperation(args)` (subcommand plus action word, nothing else from the arguments). A `GitTimeoutError` counts as `timeout`.
  - `UsageReceiver.handle`: every post, `usage.receive.ms` by route; a refused post carries its status in `op`.
- **Health** (`src/main/telemetry/health.ts`). `startHealthReports` (started after `app.started`) sends the timing summaries and an `app.health` event every 10 minutes and once on quit: memory and CPU from `app.getAppMetrics()`, main's heap and RSS, main's event loop delay (`monitorEventLoopDelay`, p50/p99/max since the last report), open terminals, uptime.
- **Frozen window**: `window.unresponsive` (flushed at once) and `window.responsive` with how long it hung, from the BrowserWindow events in `createWindow`.
- **Logged errors** (`src/main/telemetry/loggedErrors.ts`). `reportLoggedErrors` wraps main's `console.error`/`console.warn` (output unchanged) and reports each as an exception (`source: log`, the text in `log`), a warning at App Insights severity 2. This covers the 75 or so `console.error`/`console.warn` sites (ledger, budget and cost-server passes, brain scheduler, finish side steps, secrets, store saves) without touching them. At most 3 per message and 200 per launch. `AppInsightsClient.exception` now sends the same error object only once, and the unhandled-rejection and boot handlers report before they log, so those are not counted twice.
- **More dependencies**: `timedFetch` takes an `operation` namer; `pathOperation(target)` names a request by method and path on a fixed target. The cost server's requests (`hello`, `records`) are dependencies on `cost-server` (never its address), What's new's GitHub request on `api.github.com`.
- **Renderer jank** (`src/renderer/telemetry.ts`). `installLongTaskTracking` observes Chromium long tasks (50 ms or more) and sends `renderer.longTasks` (count, total, max, tasks of 200 ms or more) every 10 minutes and on page hide. Renderer events can now carry measurements (`trackMeasured`; the schema validates them as finite numbers, at most 20).
- `Telemetry.metric` takes optional `stats` for an aggregated item; `Severity` gains `warning`; `exceptionParts` takes a severity.

## Verified

- Unit tests: `perf.test.ts`, `health.test.ts`, `loggedErrors.test.ts`, new cases in `AppInsightsClient.test.ts` (aggregation envelope, warning level, one send per error object), `helpers.test.ts` (IPC timing, path-named dependencies without host or query, renderer measurements) and `renderer/telemetry.test.ts` (`LongTasks`).
- `npm test`, `npm run typecheck`, `npm run lint`.
- Not verified against the live App Insights resource: local builds have no connection string, so nothing is sent until a CI build ships.

## Known gaps

- Long tasks are not tied to a screen; a slow screen shows up only as more long tasks in that session.
- The health report on quit is best effort (the quit waits at most 2 s for the send), and the renderer's last long-task sums are lost when the app quits before the page hides.
- Errors logged before the telemetry client exists (early in boot) are not sent.
- Child processes other than git (agent detection, editors, `prSummary`, the brain's headless runs) are not timed here; brain runs and PR summaries already have their own events with durations.
