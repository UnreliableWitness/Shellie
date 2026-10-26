// The PR poller's reviewer (spec 5.3): one fresh-context review per head commit of each agent PR.
// Read-only: the agent runs --restricted with read tools in a worktree of the PR head.
import { execFile as execFileCb } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canRunAgent, recordPause, recordRun } from './activity.mjs';
import { combined, loadActivity, saveActivity } from './activityStore.mjs';
import { runClaude } from './claude.mjs';
import { parseConfig, parseTrusted } from './config.mjs';
import { createGitHub } from './github.mjs';
import {
  buildReviewPrompt,
  reviewBodyOnly,
  reviewPayload,
  validateReview,
} from './review-io.mjs';
import { findStatusComment, parseStatus, renderStatus } from './state.mjs';

const execFile = promisify(execFileCb);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LIVE_MODES = ['implement', 'full'];
const RETRY_MS = 60 * 60000;

export const REVIEW_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
];

/**
 * @param {{ gh: any, runAgent: (prompt: string, cwd: string) => Promise<any>,
 *   git: { worktree(pr: number, sha: string): Promise<string>, removeWorktree(path: string): Promise<void> },
 *   config: any, trusted: any, mode: string, now: Date, summary: (l: string) => void }} o
 */
export async function runReview({
  gh,
  runAgent,
  git,
  config,
  mode,
  now,
  summary,
}) {
  if (!LIVE_MODES.includes(mode)) {
    summary(`Reviewer is off (AGENTS_MODE=${mode || 'unset'}).`);
    return;
  }
  const bot = config.botLogin;
  const store = await loadActivity(gh, {
    botLogin: bot,
    poller: 'review',
    now,
    maxPerDay: config.maxAgentRunsPerDay,
  });
  let own = store.own;
  try {
    const pulls = (await gh.listOpenPulls()).filter(
      (p) =>
        p.user?.login === bot && p.labels?.some((l) => l.name === 'agent-pr'),
    );
    let reviewed = 0;
    for (const pr of pulls) {
      if (reviewed >= 1) break;
      const sha = pr.head.sha;
      const prComment = findStatusComment(
        await gh.listComments(pr.number),
        bot,
      );
      const issueNumber = Number(/Fixes #(\d+)/.exec(pr.body ?? '')?.[1]);
      const prState = (prComment && parseStatus(prComment.body)) ?? {
        v: 1,
        kind: 'pr',
        issue: issueNumber,
        reviews: {},
      };
      if (prState.reviews[sha]) continue;
      if (
        now.getTime() - Date.parse(own.failedAt?.[pr.number] ?? '') <
        RETRY_MS
      ) {
        summary(`PR #${pr.number}: skip (review failed less than an hour ago)`);
        continue;
      }
      const all = combined(store, own);
      const can = canRunAgent(all, now, config.maxAgentRunsPerDay);
      if (!can.ok) {
        summary(`No review run: ${can.reason}.`);
        break;
      }

      const issue = (await gh.listOpenIssues()).find(
        (i) => i.number === prState.issue,
      ) ?? { number: prState.issue, title: '', body: '', labels: [] };
      const issueStatusComment = findStatusComment(
        await gh.listComments(prState.issue),
        bot,
      );
      const spec = issueStatusComment
        ? parseStatus(issueStatusComment.body)?.spec
        : null;
      const files = await gh.listPullFiles(pr.number);
      const prompt = buildReviewPrompt({ issue, spec, pr, files });

      own = recordRun(own, now);
      reviewed++;
      const failed = (why) => {
        summary(`PR #${pr.number}: ${why}`);
        own = {
          ...own,
          failedAt: { ...own.failedAt, [pr.number]: now.toISOString() },
        };
      };
      const path = await git.worktree(pr.number, sha);
      let r;
      try {
        r = await runAgent(prompt, path);
      } finally {
        await git.removeWorktree(path);
      }
      if (r.limited) {
        own = recordPause(own, now, config.pauseMinutes);
        summary(
          `PR #${pr.number}: usage limit; agents paused until ${own.pausedUntil}`,
        );
        break;
      }
      if (!r.ok) {
        failed(`review failed: ${r.error}`);
        continue;
      }
      const v = validateReview(r.output);
      if (!v.ok) {
        failed(`invalid review (${v.error})`);
        continue;
      }
      const review = v.value;
      try {
        await gh.createReview(pr.number, reviewPayload(review, sha));
      } catch (e) {
        if (!/422/.test(e.message)) throw e;
        await gh.createReview(pr.number, reviewBodyOnly(review, sha));
      }
      const next = {
        ...prState,
        reviews: {
          ...prState.reviews,
          [sha]: {
            verdict: review.verdict,
            at: now.toISOString(),
            findings: review.findings.length,
            tokens: r.tokens,
          },
        },
      };
      const body = renderStatus(
        next,
        `**Agent PR status:** last review of \`${sha.slice(0, 7)}\`: ${review.verdict === 'changes' ? 'changes needed' : 'no blocking findings'}.`,
      );
      if (prComment) await gh.editComment(prComment.id, body);
      else await gh.comment(pr.number, body);
      if (review.risk === 'high')
        for (const n of [pr.number, prState.issue]) {
          const labels = n === pr.number ? pr.labels : issue.labels;
          if (!labels.some((l) => l.name === 'risk:high'))
            await gh.addLabels(n, ['risk:high']);
          if (labels.some((l) => l.name === 'risk:low'))
            await gh.removeLabel(n, 'risk:low');
        }
      summary(
        `PR #${pr.number}: reviewed ${sha.slice(0, 7)}: ${review.verdict} (${review.findings.length} findings, ${r.tokens.toLocaleString('en')} tokens)`,
      );
    }
  } finally {
    await saveActivity(gh, store, own, {
      now,
      maxPerDay: config.maxAgentRunsPerDay,
    });
  }
}

function worktreeGit() {
  const git = (...args) =>
    execFile('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return {
    worktree: async (pr, sha) => {
      await git(
        'fetch',
        '--no-tags',
        'origin',
        `+refs/pull/${pr}/head:refs/agent-review/${pr}`,
      );
      const path = join(mkdtempSync(join(tmpdir(), `review-${pr}-`)), 'pr');
      await git('worktree', 'add', '--detach', path, sha);
      return path;
    },
    removeWorktree: (path) =>
      git('worktree', 'remove', '--force', path).catch(() => {}),
  };
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
  const out = process.env.GITHUB_STEP_SUMMARY;
  await runReview({
    gh: createGitHub(repo, process.env.AGENTS_GH_TOKEN),
    git: worktreeGit(),
    runAgent: (prompt, cwd) =>
      runClaude({
        prompt,
        cwd,
        model: config.models.review,
        maxTurns: config.maxTurns.review,
        tools: ['Read', 'Grep', 'Glob', 'Bash'],
        allowedTools: REVIEW_ALLOWED_TOOLS,
        schema: readFileSync(
          new URL('./schemas/review.json', import.meta.url),
          'utf8',
        ),
        systemPromptFile: fileURLToPath(
          new URL('../../.claude/skills/sdlc-review/SKILL.md', import.meta.url),
        ),
        timeoutMs: 20 * 60000,
      }),
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
