// The triage poller (spec 5.1): classifies every open issue, runs the triage agent on the oldest few,
// and applies its answer. Run by .github/workflows/agents-triage.yml; `--dry-run <n>` runs one issue locally and writes nothing.
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canRunAgent, recordPause, recordRun } from './activity.mjs';
import {
  ACTIVITY_LABEL,
  combined,
  loadActivity,
  saveActivity,
} from './activityStore.mjs';
import { classifyIssue, pickForTriage } from './classify.mjs';
import { runClaude } from './claude.mjs';
import { isTrusted, parseConfig, parseTrusted } from './config.mjs';
import { createGitHub, readTokenFile } from './github.mjs';
import { missingLabels, LABELS } from './labels.mjs';
import { findStatusComment, parseStatus, renderStatus } from './state.mjs';
import {
  buildTriagePrompt,
  planActions,
  validateTriage,
} from './triage-io.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Read-only. No `git grep`: its -O option starts a program; the Grep tool does the same job. */
export const TRIAGE_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git blame:*)',
];
/** A failed issue is tried again at most once an hour (spec 6.1a). */
const RETRY_MS = 60 * 60000;

/**
 * @param {{ gh: ReturnType<typeof createGitHub>, runAgent: (prompt: string) => Promise<{ ok: boolean, output?: unknown,
 *   tokens: number, limited: boolean, error?: string }>, config: ReturnType<typeof parseConfig>,
 *   trusted: ReturnType<typeof parseTrusted>, mode: string, now: Date, summary: (line: string) => void,
 *   clock?: () => number, timeBudgetMs?: number }} o
 *   `timeBudgetMs`: no agent run starts after this much time, so the job's timeout never cuts a run off
 */
export async function runTriage({
  gh,
  runAgent,
  config,
  trusted,
  mode,
  now,
  summary,
  clock = Date.now,
  timeBudgetMs = 25 * 60000,
}) {
  if (!['shadow', 'triage', 'implement', 'full'].includes(mode)) {
    summary(`Agents are off (AGENTS_MODE=${mode || 'unset'}).`);
    return;
  }
  const started = clock();
  const shadow = mode === 'shadow';
  const bot = config.botLogin;
  const trustedLogin = (login) => login === bot || isTrusted(trusted, login);

  for (const label of missingLabels(await gh.listLabels()))
    await gh.createLabel(label);

  const store = await loadActivity(gh, {
    botLogin: bot,
    poller: 'triage',
    now,
    maxPerDay: config.maxAgentRunsPerDay,
  });
  const activityIssue = { number: store.issueNumber };
  let activity = store.own;
  let issues = [];

  // whatever happens below, the run counts, the pause and the failures are saved
  try {
    issues = (await gh.listOpenIssues()).filter(
      (i) => i.number !== activityIssue.number,
    );
    const humanBranches = (await gh.listBranches()).filter((b) =>
      b.startsWith('issues/'),
    );
    // only trusted people's PRs keep the agents off an issue; anyone can open a PR on a public repo
    const humanPrTitles = (await gh.listOpenPulls())
      .filter((p) => p.user?.login !== bot && trustedLogin(p.user?.login))
      .map((p) => p.title);
    const ctx = {
      trusted,
      botLogin: bot,
      now,
      humanBranches,
      humanPrTitles,
      shadowSeen: activity.shadowSeen,
      mode,
      config,
    };

    const items = [];
    for (const issue of issues) {
      const comments =
        issue.comments > 0 ? await gh.listComments(issue.number) : [];
      const decision = classifyIssue(issue, comments, ctx);
      if (decision.action === 'skip')
        summary(`#${issue.number}: skip (${decision.reason})`);
      else if (
        decision.action === 'triage' &&
        now.getTime() - Date.parse(activity.failedAt[issue.number] ?? '') <
          RETRY_MS
      ) {
        summary(`#${issue.number}: skip (failed less than an hour ago)`);
        continue;
      }
      items.push({ issue, comments, decision });
    }

    // go with a spec needs no agent; go without one is triaged again, as the owner's answer.
    // agent:go is used once: it comes off the issue as it is acted on.
    for (const x of items)
      if (x.decision.action === 'go' && !x.decision.status?.spec) {
        x.decision = { ...x.decision, action: 'triage', consumeGo: true };
      }

    // "still broken": a trusted comment on a released issue closed in the last 30 days reopens it once;
    // the next poll triages it again with the comment
    if (!shadow)
      for (const closed of await gh.listRecentlyClosedByLabel(
        'agent:released',
        30,
      )) {
        const comments = await gh.listComments(closed.number);
        const sc = findStatusComment(comments, bot);
        const st = sc ? parseStatus(sc.body) : null;
        if (st?.state !== 'released') continue;
        const fresh = comments.filter(
          (c) =>
            c.id > (st.stillBrokenSeenId ?? st.lastSeenCommentId ?? 0) &&
            c.user?.login !== bot &&
            isTrusted(trusted, c.user?.login) &&
            c.created_at > (st.releasedAt ?? ''),
        );
        if (!fresh.length) continue;
        try {
          // seen first: whatever fails below, the same comment never reopens the issue twice
          await gh.editComment(
            sc.id,
            renderStatus(
              { ...st, stillBrokenSeenId: Math.max(...fresh.map((c) => c.id)) },
              '**Reopened:** a comment says it is still broken; it is triaged again.',
            ),
          );
          await gh.reopen(closed.number);
          await gh.removeLabel(closed.number, 'agent:released');
          summary(`#${closed.number}: reopened (still broken)`);
        } catch (e) {
          summary(`#${closed.number}: could not reopen: ${e.message}`);
        }
      }

    const { agent, script } = pickForTriage(items, config.maxTriagePerRun);
    const apply = async (issue, statusComment, actions) => {
      if (shadow) {
        summary(
          `#${issue.number} (shadow): ${actions.map(describe).join('; ')}`,
        );
        return;
      }
      let status = statusComment;
      for (const a of actions) {
        if (a.type === 'comment') await gh.comment(issue.number, a.body);
        else if (a.type === 'status')
          status = status
            ? (await gh.editComment(status.id, a.body), status)
            : await gh.comment(issue.number, a.body);
        else if (a.type === 'addLabels')
          await gh.addLabels(issue.number, a.labels);
        else if (a.type === 'removeLabels') {
          for (const l of a.labels)
            if (issue.labels.some((x) => x.name === l))
              await gh.removeLabel(issue.number, l);
        } else if (a.type === 'close') await gh.close(issue.number, a.reason);
      }
    };

    for (const { issue, decision } of script) {
      summary(`#${issue.number}: ${decision.action} (${decision.reason})`);
      try {
        await apply(
          issue,
          decision.statusComment,
          scriptActions(issue, decision, now),
        );
      } catch (e) {
        summary(`#${issue.number}: GitHub failed: ${e.message}`);
      }
    }

    let candidates;
    for (const { issue, comments, decision } of agent) {
      const all = combined(store, activity);
      const can = canRunAgent(all, now, config.maxAgentRunsPerDay);
      if (!can.ok) {
        summary(
          `No more agent runs this poll: ${can.reason === 'paused' ? `paused until ${all.pausedUntil}` : 'daily cap reached'}.`,
        );
        break;
      }
      if (clock() - started >= timeBudgetMs) {
        summary('No more agent runs this poll: time budget used.');
        break;
      }
      // titles of issues nobody trusted has vouched for never reach the agent
      candidates ??= (await gh.listRecentIssues(90))
        .filter(
          (i) =>
            trustedLogin(i.user?.login) ||
            i.labels.some((l) => l.name === 'agent:approved'),
        )
        .map((i) => ({ number: i.number, title: i.title, state: i.state }));
      const fromTrusted = (c) =>
        c.user?.login !== bot && isTrusted(trusted, c.user?.login);
      const prompt = buildTriagePrompt({
        issue,
        comments: comments.filter(fromTrusted),
        newCommentIds: (decision.newComments ?? []).map((c) => c.id),
        droppedCount: comments.filter(
          (c) => c.user?.login !== bot && !fromTrusted(c),
        ).length,
        previous: decision.status ?? null,
        candidates: candidates
          .filter(
            (c) =>
              c.number !== issue.number && c.number !== activityIssue.number,
          )
          .slice(0, 150),
      });
      if (decision.consumeGo && !shadow)
        await gh.removeLabel(issue.number, 'agent:go');
      activity = recordRun(activity, now);
      const failed = (why) => {
        summary(`#${issue.number}: ${why}`);
        activity = {
          ...activity,
          failedAt: { ...activity.failedAt, [issue.number]: now.toISOString() },
        };
      };
      const r = await runAgent(prompt);
      if (r.limited) {
        activity = recordPause(activity, now, config.pauseMinutes);
        summary(
          `#${issue.number}: usage limit reached; agents paused until ${activity.pausedUntil}.`,
        );
        break;
      }
      if (!r.ok) {
        failed(`agent failed: ${r.error}`);
        continue;
      }
      const v = validateTriage(r.output);
      if (!v.ok) {
        failed(`invalid answer (${v.error}), nothing written`);
        continue;
      }
      const lastCommentId = Math.max(0, ...comments.map((c) => c.id));
      const actions = planActions(v.value, {
        issue,
        previous: decision.status ?? null,
        lastCommentId,
        tokens: r.tokens,
        now,
      });
      summary(
        `#${issue.number}: ${v.value.decision} (${r.tokens.toLocaleString('en')} tokens)`,
      );
      try {
        await apply(issue, decision.statusComment, actions);
      } catch (e) {
        failed(`GitHub failed: ${e.message}`);
        continue;
      }
      const { [issue.number]: _, ...failedAt } = activity.failedAt;
      activity = { ...activity, failedAt };
      if (shadow)
        activity = {
          ...activity,
          shadowSeen: {
            ...activity.shadowSeen,
            [issue.number]: issue.updated_at,
          },
        };
    }
  } finally {
    const open = new Set(issues.map((i) => String(i.number)));
    const keepOpen = (o) =>
      Object.fromEntries(Object.entries(o).filter(([n]) => open.has(n)));
    if (issues.length)
      activity = {
        ...activity,
        shadowSeen: keepOpen(activity.shadowSeen),
        failedAt: keepOpen(activity.failedAt),
      };
    const counts = Object.fromEntries(
      LABELS.filter(
        (l) => l.name.startsWith('agent:') && l.name !== ACTIVITY_LABEL,
      ).map((l) => [
        l.name,
        issues.filter((i) => i.labels.some((x) => x.name === l.name)).length,
      ]),
    );
    await saveActivity(gh, store, activity, {
      counts,
      now,
      maxPerDay: config.maxAgentRunsPerDay,
    });
  }
}

/** The actions for decisions the script makes without an agent. */
function scriptActions(issue, decision, now) {
  const s = decision.status;
  const reporter = issue.user?.login ? `@${issue.user.login} ` : '';
  const status = (next, summary) => ({
    type: 'status',
    body: renderStatus(next, summary),
  });
  switch (decision.action) {
    case 'await-approval':
      return [
        {
          type: 'comment',
          body: `Thanks for the report! Shellie's agents only pick up issues from a list of known reporters, so the owner will have a look and add \`agent:go\` to let them work on it.`,
        },
        { type: 'addLabels', labels: ['agent:awaiting-approval'] },
      ];
    case 'approve':
      return [
        { type: 'addLabels', labels: ['agent:approved'] },
        {
          type: 'removeLabels',
          labels: ['agent:go', 'agent:awaiting-approval'],
        },
      ];
    case 'go': {
      // a fresh start for the implementer: earlier failed attempts no longer count
      const { implementFailedAt: _, ...rest } = s;
      return [
        { type: 'addLabels', labels: ['agent:ready'] },
        { type: 'removeLabels', labels: ['agent:needs-owner', 'agent:go'] },
        status(
          { ...rest, state: 'ready', implementAttempts: 0 },
          `**Ready for implementation:** the owner said go (${s.kind ?? 'unknown kind'}, ${s.risk ?? 'unknown'} risk).`,
        ),
      ];
    }
    case 'remind':
      return [
        {
          type: 'comment',
          body: `${reporter}a friendly reminder: the questions above are still open. Without an answer this issue is closed in a week; you can always reopen it.`,
        },
        status(
          { ...s, remindedAt: now.toISOString() },
          '**Triage: waiting for the reporter** (reminded).',
        ),
      ];
    case 'close-stale':
      return [
        {
          type: 'comment',
          body: 'Closing this, since the questions above had no answer for three weeks. Reopen it when you have more to add and it is triaged again.',
        },
        { type: 'removeLabels', labels: ['agent:needs-info'] },
        status(
          { ...s, state: 'closed' },
          '**Closed:** no answer to the questions.',
        ),
        { type: 'close', reason: 'not_planned' },
      ];
    default:
      return [];
  }
}

const describe = (a) =>
  a.type === 'addLabels'
    ? `+${a.labels.join(',')}`
    : a.type === 'removeLabels'
      ? `-${a.labels.join(',')}`
      : a.type === 'close'
        ? `close (${a.reason})`
        : `${a.type}: ${a.body.split('\n')[0].slice(0, 120)}`;

function triageAgent(config) {
  return (prompt) =>
    runClaude({
      prompt,
      cwd: ROOT,
      model: config.models.triage,
      maxTurns: config.maxTurns.triage,
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      allowedTools: TRIAGE_ALLOWED_TOOLS,
      timeoutMs: 15 * 60000,
      schema: readFileSync(
        new URL('./schemas/triage.json', import.meta.url),
        'utf8',
      ),
      systemPromptFile: fileURLToPath(
        new URL('../../.claude/skills/sdlc-triage/SKILL.md', import.meta.url),
      ),
    });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const repo = process.env.GITHUB_REPOSITORY ?? 'UnreliableWitness/Shellie';
  const config = parseConfig(
    readFileSync(
      new URL('../../.github/agents/config.yml', import.meta.url),
      'utf8',
    ),
  );
  const trusted = parseTrusted(
    readFileSync(
      new URL('../../.github/agents/trusted.yml', import.meta.url),
      'utf8',
    ),
  );
  const dry = process.argv.indexOf('--dry-run');
  if (dry !== -1) {
    // local check: the real issue and agent, nothing written to GitHub
    const gh = createGitHub(repo, undefined);
    const n = Number(process.argv[dry + 1]);
    const issue = await gh.getIssue(n);
    const comments = await gh.listComments(n);
    const prompt = buildTriagePrompt({
      issue,
      comments: comments.filter((c) => isTrusted(trusted, c.user?.login)),
      newCommentIds: [],
      droppedCount: comments.filter(
        (c) =>
          !isTrusted(trusted, c.user?.login) &&
          c.user?.login !== config.botLogin,
      ).length,
      previous: null,
      candidates: (await gh.listRecentIssues(90))
        .filter((i) => i.number !== n)
        .map((i) => ({ number: i.number, title: i.title, state: i.state })),
    });
    const r = await triageAgent(config)(prompt);
    console.log(JSON.stringify(r, null, 2));
    if (r.ok) {
      const v = validateTriage(r.output);
      console.log(
        v.ok
          ? planActions(v.value, {
              issue,
              previous: null,
              lastCommentId: 0,
              tokens: r.tokens,
              now: new Date(),
            })
              .map(describe)
              .join('\n')
          : `invalid: ${v.error}`,
      );
    }
  } else {
    const out = process.env.GITHUB_STEP_SUMMARY;
    await runTriage({
      gh: createGitHub(repo, readTokenFile(process.env.AGENTS_GH_TOKEN_FILE)),
      runAgent: triageAgent(config),
      config,
      trusted,
      mode: process.env.AGENTS_MODE ?? 'off',
      now: new Date(),
      summary: (line) => {
        console.log(line);
        if (out) appendFileSync(out, `- ${line}\n`);
      },
    });
  }
}
