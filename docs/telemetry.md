# App telemetry

Shellie sends anonymous usage, error and performance data to Azure Application Insights (resource `shellie-app`, resource group `shellie-telemetry`) so we can see which features are used, what breaks, and what is slow.

This is separate from the AI usage capture (the OTLP receiver on 127.0.0.1:4319 that prices Claude Code and Copilot usage). App telemetry uses its own small client (`src/main/telemetry/AppInsightsClient.ts`) that posts JSON to the App Insights ingestion endpoint; it does not use OpenTelemetry.

## Turning it off

- Settings > Appearance > **Send anonymous usage and error data** (on by default). Turning it off takes effect at once: queued items are dropped and nothing more is sent.
- Environment variable `SHELLIE_TELEMETRY=0` disables it for a launch.
- Builds without the `APPINSIGHTS_CONNECTION_STRING` environment variable at build time (all local builds, `npm start`) send nothing. CI injects it from the repo variable of the same name.

## Sent with every item

| Field | Example |
| --- | --- |
| App version | `1.0.0` |
| OS and OS version | `win32`, `10.0.26100` |
| CPU architecture | `x64` |
| Electron version | `44.7.2` |
| Packaged build | `true` |
| Install id | random UUID created on first launch, stored in `<userData>/telemetry-id` |
| Session id | random UUID per launch |

## Usage events

| Name | Properties / measurements |
| --- | --- |
| Screen views (page views) | `sprint`, `task`, `new-task`, `setup`, `finish`, `settings`, `home`, `add-repo`, `connect`, `get-started`, `agents`, `secrets`, `secrets-import` |
| `app.started` | splash on/off; counts of repos, open tasks, connections; whether the usage receiver listens; boot step timings (see Performance) |
| `app.quit` | session length in minutes |
| `home.refreshed` | the Home page's data was rebuilt; number of connections, number that failed; duration in ms |
| `home.failed` | a connection failed in a Home rebuild; `kind` (`unauthorized`, `unreachable`, `timeout`, `step`) |
| `home.clicked` | a click on Home; `band` (`task`, `up-next`, `review`, `team-review`, `my-pr`, `sprint`, `stats-period`, `budget-month`, `budget-settings`) |
| `budget.alert` | a budget alert fired (main); `vendor` (`claude`, `copilot`), `kind` (`at80`, `forecastOver`, `at100`) |
| `costServer.connected`, `costServer.disconnected` | Settings › Cost server saved or forgot a connection; none (never the address, email or key) |
| `costServer.connectFailed` | Settings › Cost server's test of a connection failed; `kind` (`network`, `auth`, `server`, `rejected`) |
| `costServer.sendFailed` | sending ledger records (or the hourly hello) to the cost server failed; `kind` (as above), `status` (HTTP status, 0 without one) |
| `ledger.records` | the cost ledger's record counts, at most once per local day; `claudeCode`, `opencode`, `copilotCli` (by tool), `task`, `repo`, `none` (by attribution); counts only, no amounts or names |
| `onboarding.shown` | the Get started page opened; none |
| `onboarding.dismissed` | Skip for now on Get started, or Dismiss on its Home band; `repos`, `connections` (counts) |
| `onboarding.step` | a step of first-run setup was left; `step` (`agents`, `connect`, `repository`), `outcome` (`continued`, `skipped`, `back`) |
| `update.ready` | an update finished downloading (Windows); sent again when a newer one downloads while the first waits (#126); none |
| `update.restart`, `update.later` | the choice on the update notice; none |
| `update.move`, `update.moveLater` | the choice on the Move to Applications card (macOS build outside /Applications); none |
| `update.checkFailed` | the first failed update check of a launch (Windows, #126; later failures are only logged); none, not the error text |
| `whatsNew.shown` | Home showed the What's new card after an update (#126); `releases` (count covered), `fetched` (whether GitHub's release notes loaded) |
| `whatsNew.dismissed`, `whatsNew.opened` | Dismiss on the What's new card, or its Release notes on GitHub link; none |
| `task.created` | has a work item; copy files, start Claude, open shell, open Copilot, open OpenCode (booleans); number of setup commands |
| `task.finished` | remove worktree, delete branch, close terminals, has a work item (booleans); task age in hours, number of workspaces finished, pull requests asked for and workspaces dropped |
| `task.discarded` | a ready task was thrown away with Discard task (#124); `blank` (no commits since the base and nothing uncommitted in any workspace); measurements `commitsLost` (commits on the removed branches that no remote has), `workspaces` (worktrees removed), `deferred` (folders left to the background retry) and `ageHours`. Never names or paths |
| `cleanup.deferred` | Finish (or Discard task) could not remove a worktree folder yet and left it to the background retry (#115); the error code only (`EPERM`, `EBUSY`, another fs code, `in-use`, `git` or `other`), no path |
| `cleanup.done` | a background retry removed a leftover folder (and its branch); the code it first failed with; attempts in all and minutes since Finish |
| `cleanup.gaveUp` | a leftover folder still could not be removed a day after Finish, so the user got one notice (retries go on); the last error code; attempts so far |
| `workitem.startUpdated` | setup moved the work item to In Progress (`moved`), assigned it (`assigned`), or the update failed (`failed`) |
| `pr.created` | Finish created a draft pull request; none |
| `pr.linked` | Finish linked an existing active pull request instead of creating one; none |
| `pr.summary` | Finish asked Claude Code to write a PR's "what changed and why" (#111); `ok`; `reason` when it failed (`no-base`: the branch's start is unknown, `no-agent`: Claude Code is not installed, `timeout`, `empty`, `failed`); `style`: the repo has a `.shellie-pr.md`; measurements `ms` and, when written, `chars`. Never the text, the prompt or the diff |
| `pr.failed` | Finish stopped because the push or pull request failed; `kind` (`git`, or the Azure DevOps error kind: `unauthorized`, `not-found`, `unreachable`, `http`) |
| `setup.finished` | ok; retry; kind of the failed step (`fetch`, `worktree`, `copy`, `task-file`, `command`, `terminals`); duration; step count |
| `setup.retried`, `setup.cancelled` | none |
| `task.reopened` | where the branch came from (`folder`: worktree kept, `branch`, `origin`, `commit`, `base`) |
| `task.reopenCancelled` | none |
| `migration.miac` | first start after the rename from MIAC copied its data folder, or gave up after the third failed attempt; `result` (`ok`, `failed`); `tokens` (`migrated`, `partial`, `refused`, `none`; `none` when the copy gave up); `copied` (number of top-level entries), `ms` |
| `workspace.joined` | a worktree of another repo joined a task; `source` (`log`: found in a Claude session log, `branch`: found by the task branch, `manual`: added by hand) |
| `workspace.removed` | a joined worktree was removed from its task; none |
| `agents.detected` | the agent CLI check ran; `claude`, `copilot`, `opencode` (true when found; never versions or paths) |
| `terminal.opened` | kind (`claude`, `copilot`, `opencode`, `shell`, `run`); opened by setup or by hand |
| `terminal.closed` | kind |
| `terminal.restarted` | kind; after an app relaunch or not (a Claude Code restart resumes its session); `withoutProjectConfig` when OpenCode was started again without the repo's config (#109) |
| `terminal.failed` | an agent tab (`claude`, `copilot`, `opencode`) whose exit needed explaining (#109); `kind`; `reason` (`missing-cli`: the program is not installed or not on PATH, `invalid-config`: OpenCode refused its configuration, `crashed`: a non-zero exit within 30 s of the start, `spawn-failed`: the pty could not start it); `exitCode` (`none` for a spawn failure); measurement `runMs`. Never the terminal output or the config file's name |
| `terminal.exitedEarly` | any other tab (`shell`, `run`) that exited non-zero within 30 s of its start; `kind`, `exitCode`; measurement `runMs` |
| `usage.opened` | via the tab or the task strip |
| `time.booked` | Finish booked time; `closest`: the measure the booked time is closest to (`measured`, `realistic`, `wallClock`), or `custom` when it is more than 5 minutes from all of them |
| `docs.opened` | view (`rendered`, `source`); from (`list`, `link`, `terminal`); the file opened automatically with the tab is not tracked |
| `docs.sessionView` | mode chosen in the Docs file list (`session`: the task's session docs, `all`: every doc in the worktree) |
| `docs.sentTo` | kind of the target terminal (`claude`, `copilot`, `shell`, `run`) |
| `terminal.linkOpened` | type of the clicked terminal link (`md`, `html`, `file`, `url`) |
| `editor.opened` | `editor` (`vscode`, `visualstudio`); `at` (`folder`, or `file` when opened at a line from Changes, Docs or a terminal link) |
| `review.opened` | scope (`all`, `uncommitted`, `commits`); number of files; number of repos |
| `review.fileViewed` | none |
| `review.commentsSent` | number of comments sent |
| `review.commentResolved` | `outdated`: whether the comment was outdated when resolved |
| `review.repoFiltered` | `via`: how the Changes tab was narrowed to one repo or back to all (`chip`, `key`, `breadcrumb`, `commit`, `comment`) |
| `review.repoCollapsed` | `how`: a repo group folded by hand (`manual`) or by itself once every file was viewed (`auto`) |
| `review.fileDiscarded` | `scope`: the Changes scope the file's changes were discarded or the new file deleted in (`all`, `uncommitted`) |
| `usage.exportCsv` | none |
| `focus.toggled`, `nav.toggled` | on / collapsed |
| `settings.changed` | names of the changed settings (not their values) |
| `workItems.search` | picker scope (`sprint` or `mine`); whether search text was typed (not the text) |
| `secrets.discovered` | Shellie looked for a repo's secrets (the import page opened); measurements only: `values` found, `secretLike`, `unassigned` (no environment from the file or profile name), `skipped` (names that cannot be environment variables), and the number of values per source kind (`dotenv`, `appsettings`, `launchSettings`, `userSecrets`, `vscode`, `compose`, `localSettings`, `secretsFolder`, `other`). Never a name, value, path or source |
| `secrets.imported` | an import saved values; `environments`: the environments it saved values for, from the fixed four (`development`, `test`, `uat`, `production`, comma-separated); `rewriteWorktreeCopies`; measurements `values`, `worktreesRewritten`, `filesChanged` (main-checkout files the import took the keys out of) |
| `secrets.environmentSwitched` | a running task switched environment; `from`, `to` (the fixed four); `confirmed` (the UAT or Production confirm was given) |
| `secrets.productionExpired` | a task's Production bound passed and it went back to Development (also when the bound passed during setup); none. Finish ending Production is not counted |
| `secrets.leakDetected` | a stored value showed up; `where` (`agent`: in an agent tab's output, once per name per tab; a `shellie run`'s output is masked for the agent and not counted; `diff`: in the Changes of a task, once per task and environment per launch; `push`: Finish refused to push a branch that adds one); `environment`: the gravest environment among the values found (the fixed four); for `agent`, `paused` (a Production value paused the tab) |
| `secrets.runStarted` | an agent's `shellie run` started its tab (after the approve on UAT and Production); `kind` (`run`, `test`, `setup`); `environment` (the fixed four). Never the command's name, line or arguments |
| `secrets.worktreesCleaned` | Clean worktrees ran; `from` (`secrets`: the Secrets page, `task`: the task bar); measurement `count` (tasks cleaned) |
| `repo.added`, `repo.removed`, `repo.connectionLinked`, `connection.saved`, `connection.removed` | counts or linked/unlinked only; `repo.added` also has `wroteConfig` (true when Shellie wrote `.shellie.yml`) |
| `connection.probeFailed` | the Connect page's Test failed: `status`, the HTTP status Azure DevOps answered with (0 when it could not be reached); never the URL, organization or token |
| `repo.inspected` | a folder was inspected for adding: `remote` (`azure-devops`, `github`, `other` or `none`), `lockfile` (`npm`, `pnpm`, `yarn` or `none`), and `linked`, `dotnet`, `devScript`, `apm`, `existingConfig`, `secrets` (whether discovery found a secret-like value) (booleans); never paths, URLs, names or values |

## Errors

- Uncaught exceptions in the main process (monitored only: Electron's own handling is unchanged) and unhandled promise rejections.
- Renderer `window.onerror` and `unhandledrejection`.
- A failed boot (the splash or the "Shellie could not start" dialog).
- Every IPC call that fails (error type, message, stack and the channel name such as `tasks:create`; never the arguments).
- An unexpected setup failure.
- A terminal whose program could not be spawned (`source: terminal`, the tab's kind; the message is scrubbed like every other).
- Every warning or error notice shown in the app (`notice` event: level and message).
- `process.gone`: a renderer or child process (GPU, utility) that crashed or was killed, with the reason and exit code.

## Performance

- `app.started` measurements: settings load, telemetry init, task/connection load, usage store load, IPC setup, usage receiver start, main window load (`windowMs`), boot to window ready (`readyMs`, also sent as metric `app.startup.readyMs`) and process start to window shown (`visibleMs`, includes the splash).
- Metric `setup.step.<kind>` per setup step in ms (`setup.step.worktree` is worktree creation), with the step status.
- `setup.finished` duration.
- Azure DevOps requests as dependencies: method and API route with ids and project names replaced (`GET _apis/wit/workitems/{id}`), host (`dev.azure.com` or `visualstudio.com`), duration, status code, success.

## Never sent

Work item titles or ids, repo names or paths, branch names, task names, Azure DevOps organization or project names, user names or e-mail addresses, PATs, terminal content, file contents, AI usage records, secret names, values or sources (only counts, source kinds and the four environment names), `shellie run` command names or arguments.

Before anything is sent, main scrubs every message, stack trace and string property: the home folder and any other user folder become `~`, the names and paths of your repos, tasks, branches, work item titles, connection organizations, projects and users become `<redacted>`, URLs become `<url>` and e-mail addresses `<email>`. Messages are capped at 1000 characters, properties at 200.

## Delivery

Items are queued in memory (at most 500; the count of dropped items is reported as metric `telemetry.dropped`) and posted in batches of up to 100 to `<IngestionEndpoint>/v2/track` 15 seconds after the first queued item, when a batch is full, and on quit (the quit waits at most 2 seconds). A failed send is dropped, never retried and never shown to the user.
