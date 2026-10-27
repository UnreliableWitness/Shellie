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
import { carriedReview } from './carry.mjs';
import { createGitHub, readTokenFile } from './github.mjs';
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
      // publish writes the issue into the PR's status block; else the script's own Fixes line, which is last
      const issueNumber = Number(
        [...(pr.body ?? '').matchAll(/Fixes #(\d+)/g)].at(-1)?.[1],
      );
      const prState = (prComment && parseStatus(prComment.body)) ?? {
        v: 1,
        kind: 'pr',
        issue: issueNumber,
        reviews: {},
      };
      if (prState.reviews[sha]) continue;
      // only GitHub's merges of main since the last review: record that review for this commit, no new run
      const carried = await carriedReview(gh, sha, prState.reviews);
      if (carried) {
        const next = {
          ...prState,
          reviews: {
            ...prState.reviews,
            [sha]: { ...carried.review, carriedFrom: carried.sha },
          },
        };
        const body = renderStatus(
          next,
          `**Agent PR status:** the review of \`${carried.sha.slice(0, 7)}\` carries over \`${sha.slice(0, 7)}\` (only merges of main since).`,
        );
        if (prComment) await gh.editComment(prComment.id, body);
        else await gh.comment(pr.number, body);
        summary(
          `PR #${pr.number}: review carried over from ${carried.sha.slice(0, 7)}`,
        );
        continue;
      }
      if (!Number.isInteger(prState.issue)) {
        summary(`PR #${pr.number}: skip (no "Fixes #n" to find its issue)`);
        continue;
      }
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
      const writePrState = async (state, line) => {
        const body = renderStatus(state, line);
        if (prComment) await gh.editComment(prComment.id, body);
        else await gh.comment(pr.number, body);
      };
      /** A failed review is tried again after an hour, and given up on for this commit after two failures. */
      const failed = async (why) => {
        summary(`PR #${pr.number}: ${why}`);
        const key = `${pr.number}:${sha}`;
        const count = (own.reviewFailures?.[key] ?? 0) + 1;
        own = {
          ...own,
          failedAt: { ...own.failedAt, [pr.number]: now.toISOString() },
          reviewFailures: { ...own.reviewFailures, [key]: count },
        };
        if (count >= 2)
          await writePrState(
            {
              ...prState,
              reviews: {
                ...prState.reviews,
                [sha]: {
                  verdict: 'error',
                  at: now.toISOString(),
                  reason: why.slice(0, 300),
                },
              },
            },
            `**Agent PR status:** the review of \`${sha.slice(0, 7)}\` failed twice and is not tried again for this commit.`,
          ).catch(() => {});
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
        await failed(`review failed: ${r.error}`);
        continue;
      }
      const v = validateReview(r.output);
      if (!v.ok) {
        await failed(`invalid review (${v.error})`);
        continue;
      }
      const review = v.value;
      try {
        try {
          await gh.createReview(pr.number, reviewPayload(review, sha));
        } catch (e) {
          // GitHub refuses a comment on a line outside the diff with 422
          if (!/HTTP 422/.test(e.message)) throw e;
          await gh.createReview(pr.number, reviewBodyOnly(review, sha));
        }
      } catch (e) {
        await failed(`posting the review failed: ${e.message}`);
        continue;
      }
      const next = {
        ...prState,
        reviews: {
          ...prState.reviews,
          [sha]: {
            verdict: review.verdict,
            at: now.toISOString(),
            findings: review.findings.length,
            // what the fixer works from: the blocking findings, kept short
            items: review.findings
              .filter((f) => f.severity !== 'minor')
              .slice(0, 20)
              .map((f) => ({
                ...f,
                problem: f.problem.slice(0, 500),
                scenario: f.scenario.slice(0, 500),
              })),
            tokens: r.tokens,
          },
        },
      };
      await writePrState(
        next,
        `**Agent PR status:** last review of \`${sha.slice(0, 7)}\`: ${review.verdict === 'changes' ? 'changes needed' : 'no blocking findings'}.`,
      );
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
    gh: createGitHub(repo, readTokenFile(process.env.AGENTS_GH_TOKEN_FILE)),
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
