// The nightly agent (spec docs/superpowers/specs/2026-11-10-nightly-agent-design.md): one read-only run over the
// last day of App Insights telemetry (health) and one over the app code merged since the last night (simplify),
// each filing at most a few issues that go through triage like any other. Run by .github/workflows/agents-nightly.yml;
// `--dry-run [telemetry.json]` runs both passes locally and writes nothing.
import { execFile as execFileCb } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canRunAgent, recordPause, recordRun } from './activity.mjs';
import { budgetFor, loadActivity, saveActivity } from './activityStore.mjs';
import { runClaude } from './claude.mjs';
import { parseConfig } from './config.mjs';
import { createGitHub, readTokenFile } from './github.mjs';
import { missingLabels } from './labels.mjs';
import {
  buildHealthPrompt,
  buildSimplifyPrompt,
  knownIssues,
  planIssues,
  validateNightly,
} from './nightly-io.mjs';
import { TRIAGE_ALLOWED_TOOLS } from './triage.mjs';

const execFile = promisify(execFileCb);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AGENT_MODES = ['shadow', 'triage', 'implement', 'full'];
const DAY_MS = 86400000;

export const SIMPLIFY_ALLOWED_TOOLS = [
  ...TRIAGE_ALLOWED_TOOLS,
  'Bash(git diff:*)',
];

/**
 * @param {{ gh: any, runAgent: { health: (prompt: string) => Promise<any>, simplify: (prompt: string) => Promise<any> },
 *   git: { head(): Promise<string>, hasCommit(sha: string): Promise<boolean>, commitBefore(iso: string): Promise<string | null>,
 *     changedFiles(base: string, head: string): Promise<string[]>, log(base: string, head: string): Promise<{ sha: string, subject: string }[]> },
 *   telemetry: any | null, telemetryNote?: string, config: any, mode: string, nightlyMode?: string, now: Date,
 *   summary: (l: string) => void }} o
 *   `telemetry`: the JSON nightly-telemetry.mjs wrote, or null (no Azure login yet, or its job failed: say why in `telemetryNote`)
 *   `nightlyMode`: AGENTS_NIGHTLY_MODE: unset or `shadow` reports what it would file, `live` files, `off` stops it
 */
export async function runNightly({
  gh,
  runAgent,
  git,
  telemetry,
  telemetryNote = 'no telemetry file',
  config,
  mode,
  nightlyMode,
  now,
  summary,
}) {
  const nm = nightlyMode || 'shadow';
  if (!AGENT_MODES.includes(mode) || nm === 'off') {
    summary(
      `Nightly agent is off (AGENTS_MODE=${mode || 'unset'}, AGENTS_NIGHTLY_MODE=${nightlyMode || 'unset'}).`,
    );
    return;
  }
  const live = nm === 'live' && mode !== 'shadow';
  if (!live)
    summary(
      'Shadow: the issues below are what the nightly agent would open; nothing is filed (AGENTS_NIGHTLY_MODE=live files them).',
    );
  if (live)
    for (const label of missingLabels(await gh.listLabels()))
      await gh.createLabel(label);

  const store = await loadActivity(gh, {
    botLogin: config.botLogin,
    poller: 'nightly',
    now,
    maxPerDay: config.maxAgentRunsPerDay,
  });
  let own = store.own;
  try {
    const known = knownIssues([
      ...(await gh.listIssuesByLabel('source:health')),
      ...(await gh.listIssuesByLabel('source:simplify')),
    ]);

    /** @returns {Promise<'done' | 'skipped' | 'failed' | 'limited'>} */
    const pass = async (source, prompt, context) => {
      const can = canRunAgent(
        budgetFor(store, own),
        now,
        config.maxAgentRunsPerDay,
      );
      if (!can.ok) {
        summary(`${source}: no run (${can.reason}).`);
        return 'skipped';
      }
      own = recordRun(own, now);
      const r = await runAgent[source](prompt);
      if (r.limited) {
        own = recordPause(own, now, config.pauseMinutes);
        summary(
          `${source}: usage limit; agents paused until ${own.pausedUntil}`,
        );
        return 'limited';
      }
      if (!r.ok) {
        summary(`${source}: the agent failed: ${r.error}`);
        return 'failed';
      }
      const max = config.maxIssuesPerDay[source];
      const v = validateNightly(r.output, max);
      if (!v.ok) {
        summary(`${source}: invalid answer (${v.error}), nothing filed`);
        return 'failed';
      }
      summary(
        `${source}: ${v.value.summary.replace(/\s+/g, ' ')} (${r.tokens.toLocaleString('en')} tokens)`,
      );
      const plan = planIssues(v.value.issues, {
        source,
        known,
        max,
        now,
        context,
      });
      for (const s of plan.skipped)
        summary(`${source}: not filed \`${s.signature}\` (${s.why})`);
      for (const i of plan.file) {
        if (!live) {
          summary(`${source}: would open "${i.title}" \`${i.signature}\``);
          continue;
        }
        try {
          const created = await gh.createIssue(i.title, i.body, i.labels);
          known.push({
            number: created.number,
            state: 'open',
            title: i.title,
            source,
            signature: i.signature,
            closedAt: null,
          });
          summary(`${source}: opened #${created.number} "${i.title}"`);
        } catch (e) {
          summary(`${source}: opening "${i.title}" failed: ${e.message}`);
        }
      }
      return 'done';
    };

    let health = 'skipped';
    if (telemetry?.queries?.length)
      health = await pass(
        'health',
        buildHealthPrompt({
          telemetry,
          known,
          maxIssues: config.maxIssuesPerDay.health,
        }),
        'the last 24 h against the 13 days before',
      );
    else summary(`health: skipped (${telemetryNote}).`);

    if (health !== 'limited') {
      const head = await git.head();
      const base =
        own.lastMainSha && (await git.hasCommit(own.lastMainSha))
          ? own.lastMainSha
          : await git.commitBefore(
              new Date(now.getTime() - DAY_MS).toISOString(),
            );
      if (!base || base === head) {
        summary('simplify: nothing merged since the last night.');
        own = { ...own, lastMainSha: head };
      } else {
        const files = await git.changedFiles(base, head);
        if (!files.length) {
          summary(
            `simplify: no app code (src/) changed in ${base.slice(0, 7)}..${head.slice(0, 7)}.`,
          );
          own = { ...own, lastMainSha: head };
        } else {
          const commits = await git.log(base, head);
          const done = await pass(
            'simplify',
            buildSimplifyPrompt({
              base,
              head,
              commits,
              files,
              known,
              maxIssues: config.maxIssuesPerDay.simplify,
            }),
            `commits ${base.slice(0, 7)}..${head.slice(0, 7)}`,
          );
          // a failed or skipped review keeps its range, so the next night covers it
          if (done === 'done') own = { ...own, lastMainSha: head };
        }
      }
    }
    own = { ...own, lastRunAt: now.toISOString() };
  } finally {
    await saveActivity(gh, store, own, {
      now,
      maxPerDay: config.maxAgentRunsPerDay,
    });
  }
}

/** The checked-out `main`, read with plain git (the job fetches the whole history). */
function repoGit() {
  const git = async (...args) =>
    (
      await execFile('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    ).stdout.trim();
  return {
    head: () => git('rev-parse', 'HEAD'),
    hasCommit: (sha) =>
      git('merge-base', '--is-ancestor', sha, 'HEAD').then(
        () => true,
        () => false,
      ),
    commitBefore: async (iso) =>
      (await git('rev-list', '-1', `--before=${iso}`, 'HEAD')) || null,
    changedFiles: async (base, head) =>
      (await git('diff', '--name-only', `${base}..${head}`, '--', 'src'))
        .split('\n')
        .filter(Boolean),
    log: async (base, head) =>
      (await git('log', '--format=%H %s', `${base}..${head}`))
        .split('\n')
        .filter(Boolean)
        .map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })),
  };
}

function nightlyAgent(config, source) {
  return (prompt) =>
    runClaude({
      prompt,
      cwd: ROOT,
      model: config.models[source],
      maxTurns: config.maxTurns[source],
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      allowedTools:
        source === 'simplify' ? SIMPLIFY_ALLOWED_TOOLS : TRIAGE_ALLOWED_TOOLS,
      timeoutMs: 20 * 60000,
      schema: readFileSync(
        new URL('./schemas/nightly.json', import.meta.url),
        'utf8',
      ),
      systemPromptFile: fileURLToPath(
        new URL(
          `../../.claude/skills/sdlc-${source}/SKILL.md`,
          import.meta.url,
        ),
      ),
    });
}

/** @returns {{ telemetry: any | null, note: string }} */
function readTelemetry(path) {
  if (!path || !existsSync(path))
    return {
      telemetry: null,
      note: 'no telemetry file: the telemetry job did not run (AZURE_HEALTH_CLIENT_ID unset) or failed',
    };
  try {
    return { telemetry: JSON.parse(readFileSync(path, 'utf8')), note: '' };
  } catch (e) {
    return { telemetry: null, note: `unreadable telemetry file: ${e.message}` };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const repo = process.env.GITHUB_REPOSITORY ?? 'UnreliableWitness/Shellie';
  const config = parseConfig(
    readFileSync(
      new URL('../../.github/agents/config.yml', import.meta.url),
      'utf8',
    ),
  );
  const dry = process.argv.indexOf('--dry-run');
  const { telemetry, note } = readTelemetry(
    dry !== -1 ? process.argv[dry + 1] : process.env.NIGHTLY_TELEMETRY_FILE,
  );
  const out = process.env.GITHUB_STEP_SUMMARY;
  const summary = (line) => {
    console.log(line);
    if (out) appendFileSync(out, `- ${line}\n`);
  };
  const runAgent = {
    health: nightlyAgent(config, 'health'),
    simplify: nightlyAgent(config, 'simplify'),
  };
  if (dry !== -1) {
    // local check with your own gh login: the real agents, a fake activity store, nothing written to GitHub
    const real = createGitHub(repo, undefined);
    const gh = {
      listIssuesByLabel: real.listIssuesByLabel,
      findIssueByLabel: async () => ({ number: 0, body: '' }),
      listComments: async () => [],
      comment: async () => ({ id: 1 }),
      editComment: async () => {},
    };
    await runNightly({
      gh,
      runAgent: {
        health: async (p) => {
          const r = await runAgent.health(p);
          console.log(JSON.stringify(r.output ?? r, null, 2));
          return r;
        },
        simplify: async (p) => {
          const r = await runAgent.simplify(p);
          console.log(JSON.stringify(r.output ?? r, null, 2));
          return r;
        },
      },
      git: repoGit(),
      telemetry,
      telemetryNote: note,
      config,
      mode: 'shadow',
      nightlyMode: 'shadow',
      now: new Date(),
      summary,
    });
  } else {
    await runNightly({
      gh: createGitHub(repo, readTokenFile(process.env.AGENTS_GH_TOKEN_FILE)),
      runAgent,
      git: repoGit(),
      telemetry,
      telemetryNote: note,
      config,
      mode: process.env.AGENTS_MODE ?? 'off',
      nightlyMode: process.env.AGENTS_NIGHTLY_MODE,
      now: new Date(),
      summary,
    });
  }
}
