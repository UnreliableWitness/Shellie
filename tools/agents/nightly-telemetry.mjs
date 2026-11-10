// The nightly agent's telemetry input (spec docs/superpowers/specs/2026-11-10-nightly-agent-design.md): fixed queries
// over App Insights `shellie-app`, the last 24 h against the 13 days before, written as one JSON file.
// Runs in its own job after an OIDC `azure/login`; no agent and no GitHub token on that machine.
import { execFile as execFileCb } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFile = promisify(execFileCb);

const RECENT = 'let recent = ago(1d);\n';
// a GUID or a number in a message makes every occurrence its own group
const NORMALISE = String.raw`@"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d+"`;
const OS = `os = iff(client_OS startswith "10.", "windows", "macos")`;
// values above 10 minutes are a laptop that slept mid-operation, not a slow operation
const SLEEP_MS = 600000;

export const QUERIES = [
  {
    name: 'overview',
    about:
      'sessions, installs and versions seen, to weigh every other number (few installs: weigh sessions, not users)',
    kql: `union customEvents, exceptions
| summarize sessions24h = dcountif(session_Id, timestamp > recent), sessions = dcount(session_Id),
    installs = dcount(user_Id), versions24h = make_set_if(application_Version, timestamp > recent, 10),
    exceptions24h = countif(itemType == "exception" and timestamp > recent), exceptions = countif(itemType == "exception")`,
  },
  {
    name: 'exceptions',
    about:
      'exception signatures (type|source|channel|message with ids as #); problemId is not used because it changes every release',
    kql: `exceptions
| extend source = tostring(customDimensions.source), channel = tostring(customDimensions.channel)
| extend msg = replace_regex(substring(coalesce(outerMessage, innermostMessage), 0, 160), ${NORMALISE}, "#")
| extend sig = strcat(type, "|", source, "|", channel, "|", msg)
| summarize last24h = countif(timestamp > recent), sessions24h = dcountif(session_Id, timestamp > recent),
    before = countif(timestamp <= recent), sessionsBefore = dcountif(session_Id, timestamp <= recent),
    users = dcount(user_Id), versions = make_set(application_Version, 8), firstSeen = min(timestamp), lastSeen = max(timestamp)
    by sig
| order by sessions24h desc, last24h desc, sessionsBefore desc
| take 25`,
  },
  {
    name: 'crashes',
    about:
      'process.gone, window hangs and Critical exceptions: rare, every one counts',
    kql: `union
  (customEvents | where name in ("process.gone", "window.unresponsive", "window.responsive")
    | extend what = name, detail = trim(" ", strcat(tostring(customDimensions.process), " ", tostring(customDimensions.reason),
        " ", tostring(customDimensions.exitCode))), hungMs = todouble(customMeasurements.ms)),
  (exceptions | where severityLevel == 4
    | extend what = "critical-exception", detail = replace_regex(substring(outerMessage, 0, 160), ${NORMALISE}, "#"), hungMs = real(null))
| summarize last24h = countif(timestamp > recent), before = countif(timestamp <= recent), sessions = dcount(session_Id),
    maxHungMs = max(hungMs), versions = make_set(application_Version, 8), lastSeen = max(timestamp) by what, detail
| order by last24h desc, lastSeen desc
| take 25`,
  },
  {
    name: 'stalls',
    about: `main-process event-loop stalls and memory from app.health (every 10 min); stalls between 1 s and 10 min (longer is sleep)`,
    kql: `customEvents | where name == "app.health"
| extend maxMs = todouble(customMeasurements.loopDelayMaxMs), p99 = todouble(customMeasurements.loopDelayP99Ms),
    mem = todouble(customMeasurements.appMemoryMb), rss = todouble(customMeasurements.mainRssMb), ${OS}
| summarize reports = count(), last24h = countif(timestamp > recent), sessions = dcount(session_Id),
    stalls1s = countif(maxMs between (1000 .. ${SLEEP_MS})), stalls5s = countif(maxMs between (5000 .. ${SLEEP_MS})),
    worstStallMs = maxif(maxMs, maxMs <= ${SLEEP_MS}), loopP99Ms_p95 = percentile(p99, 95),
    appMemoryMb_p95 = percentile(mem, 95), mainRssMb_p95 = percentile(rss, 95), lastSeen = max(timestamp)
    by application_Version, os
| order by lastSeen desc
| take 20`,
  },
  {
    name: 'operations',
    about:
      'ipc.ms and git.ms per op from the pre-aggregated 10-minute metrics: calls, failed calls, mean and max ms (both leave out 10-minute buckets that held a sleep)',
    kql: `customMetrics | where name in ("ipc.ms", "git.ms")
| extend op = tostring(customDimensions.op), failed = tostring(customDimensions.outcome) != "ok", r = timestamp > recent,
    awake = valueMax <= ${SLEEP_MS}
| summarize calls24h = sumif(valueCount, r), failed24h = sumif(valueCount, r and failed),
    ms24h = sumif(valueSum, r and awake), n24h = sumif(valueCount, r and awake), max24h = maxif(valueMax, r and awake),
    callsBefore = sumif(valueCount, not(r)), failedBefore = sumif(valueCount, not(r) and failed),
    msBefore = sumif(valueSum, not(r) and awake), nBefore = sumif(valueCount, not(r) and awake),
    maxBefore = maxif(valueMax, not(r) and awake)
    by name, op
| extend mean24h = iff(n24h > 0, round(ms24h / n24h), real(null)),
    meanBefore = iff(nBefore > 0, round(msBefore / nBefore), real(null))
| order by ms24h desc, msBefore desc
| project name, op, calls24h, mean24h, max24h, failed24h, callsBefore, meanBefore, maxBefore, failedBefore
| take 30`,
  },
  {
    name: 'startup-and-setup',
    about:
      'app.started and setup.finished per version and OS (ms), failed setups with the failing step',
    kql: `customEvents | where name in ("app.started", "setup.finished")
| extend ready = todouble(customMeasurements.readyMs), visible = todouble(customMeasurements.visibleMs),
    dur = todouble(customMeasurements.durationMs), ok = tostring(customDimensions.ok), step = tostring(customDimensions.kind), ${OS}
| summarize n = count(), last24h = countif(timestamp > recent), readyP50 = percentile(ready, 50), readyP95 = percentile(ready, 95),
    visibleP95 = percentile(visible, 95), durationP50 = percentile(dur, 50), durationP95 = percentile(dur, 95),
    failed = countif(ok == "false"), failedSteps = make_set_if(step, ok == "false", 8), lastSeen = max(timestamp)
    by name, application_Version, os
| order by lastSeen desc
| take 30`,
  },
  {
    name: 'setup-steps',
    about: 'setup.step.* durations (ms): last 24 h against before',
    kql: `customMetrics | where name startswith "setup.step."
| summarize n24h = countif(timestamp > recent), p50ms24h = percentile(iff(timestamp > recent, value, real(null)), 50),
    p95ms24h = percentile(iff(timestamp > recent, value, real(null)), 95), nBefore = countif(timestamp <= recent),
    p50msBefore = percentile(iff(timestamp <= recent, value, real(null)), 50), p95msBefore = percentile(iff(timestamp <= recent, value, real(null)), 95)
    by name
| order by p95ms24h desc`,
  },
  {
    name: 'failure-events',
    about:
      'events that mean something went wrong, with their kind/reason/code/status; notice messages normalised',
    kql: `customEvents
| where name in ("cleanup.deferred", "cleanup.gaveUp", "pr.failed", "home.failed", "update.checkFailed", "costServer.sendFailed",
    "costServer.connectFailed", "connection.probeFailed", "terminal.failed", "terminal.exitedEarly", "secrets.leakDetected")
  or (name in ("brain.job", "brain.refresh") and tostring(customDimensions.outcome) == "failed")
  or (name == "notice" and tostring(customDimensions.level) == "error")
  or (name == "workitem.startUpdated" and tostring(customDimensions.failed) == "true")
| extend d = customDimensions
| extend detail = trim(" ", replace_regex(strcat(tostring(d.kind), " ", tostring(d.reason), " ", tostring(d.code), " ", tostring(d.status), " ",
    tostring(d.exitCode), " ", replace_regex(substring(tostring(d.message), 0, 120), ${NORMALISE}, "#")), @" +", " "))
| summarize last24h = countif(timestamp > recent), sessions24h = dcountif(session_Id, timestamp > recent),
    before = countif(timestamp <= recent), sessions = dcount(session_Id), versions = make_set(application_Version, 6),
    lastSeen = max(timestamp) by name, detail
| order by sessions24h desc, last24h desc, sessions desc
| take 30`,
  },
  {
    name: 'renderer-long-tasks',
    about:
      'renderer.longTasks per version: tasks over 200 ms and the longest (ms)',
    kql: `customEvents | where name == "renderer.longTasks"
| summarize reports = count(), last24h = countif(timestamp > recent), sessions = dcount(session_Id),
    over200 = sum(todouble(customMeasurements.over200)), worstMs = max(todouble(customMeasurements.maxMs)),
    totalMs = sum(todouble(customMeasurements.totalMs)), lastSeen = max(timestamp) by application_Version
| order by lastSeen desc
| take 15`,
  },
  {
    name: 'dependencies',
    about:
      'outgoing calls (Azure DevOps, cost server, GitHub) that failed or are slow (ms)',
    kql: `dependencies
| summarize calls24h = countif(timestamp > recent), failed24h = countif(timestamp > recent and success == false),
    slow24h = countif(timestamp > recent and duration > 5000), p95ms24h = percentile(iff(timestamp > recent, duration, real(null)), 95),
    callsBefore = countif(timestamp <= recent), failedBefore = countif(timestamp <= recent and success == false),
    p95msBefore = percentile(iff(timestamp <= recent, duration, real(null)), 95), failedCodes = make_set_if(resultCode, success == false, 6)
    by type, target, name
| where failed24h + failedBefore > 0 or p95ms24h > 2000 or p95msBefore > 2000
| order by failed24h desc, p95ms24h desc
| take 25`,
  },
];

/** The App Insights application id from the connection string the app is built with. */
export function appIdFrom(connectionString) {
  return /(?:^|;)ApplicationId=([0-9a-f-]{36})/i.exec(
    connectionString ?? '',
  )?.[1];
}

/**
 * A query result (`{ tables: [{ columns, rows }] }`) as plain rows: numbers rounded, so the agent reads less, and
 * `dynamic` columns (the API sends them as JSON text) parsed.
 */
export function toRows(result) {
  const table = result?.tables?.[0];
  if (!table) return [];
  const cell = (v, type) => {
    if (type === 'dynamic' && typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v) : v;
  };
  return table.rows.map((row) =>
    Object.fromEntries(
      row.map((v, i) => [
        table.columns[i].name,
        cell(v, table.columns[i].type),
      ]),
    ),
  );
}

/**
 * @param {{ query: (kql: string) => Promise<any>, now: Date }} o
 * @returns {Promise<{ generatedAt: string, window: string, queries: { name: string, about: string, rows?: any[], error?: string }[] }>}
 *   one failed query is reported in place, the others still run
 */
export async function collectTelemetry({ query, now }) {
  const queries = [];
  for (const q of QUERIES) {
    try {
      queries.push({
        name: q.name,
        about: q.about,
        rows: toRows(await query(RECENT + q.kql)),
      });
    } catch (e) {
      queries.push({
        name: q.name,
        about: q.about,
        error: String(e.message).slice(0, 300),
      });
    }
  }
  return {
    generatedAt: now.toISOString(),
    window:
      'last24h = the 24 hours before generatedAt; before = the 13 days before that',
    queries,
  };
}

/** Runs KQL against App Insights with the Azure CLI's login (`azure/login` in CI, the owner's `az login` locally). */
export function azureQuery(appId) {
  let token;
  return async (kql) => {
    token ??= (
      await execFile('az', [
        'account',
        'get-access-token',
        '--resource',
        'https://api.applicationinsights.io',
        '--query',
        'accessToken',
        '-o',
        'tsv',
      ])
    ).stdout.trim();
    const res = await fetch(
      `https://api.applicationinsights.io/v1/apps/${appId}/query`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: kql, timespan: 'P14D' }),
      },
    );
    if (!res.ok)
      throw new Error(`App Insights ${res.status}: ${await res.text()}`);
    return res.json();
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const appId = appIdFrom(process.env.APPINSIGHTS_CONNECTION_STRING);
  const out = process.argv[2];
  if (!appId || !out) {
    console.error(
      'usage: APPINSIGHTS_CONNECTION_STRING=… node tools/agents/nightly-telemetry.mjs <out.json>',
    );
    process.exit(2);
  }
  const result = await collectTelemetry({
    query: azureQuery(appId),
    now: new Date(),
  });
  writeFileSync(out, JSON.stringify(result, null, 1));
  for (const q of result.queries)
    console.log(
      `${q.name}: ${q.error ? `failed (${q.error})` : `${q.rows.length} rows`}`,
    );
}
