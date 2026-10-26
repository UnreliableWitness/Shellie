// The PR poller after the review (spec 5.4-5.5), as steps of .github/workflows/agents-pr.yml:
//   decide       (App token)          bookkeeping for merged/closed PRs, update-branch, merge, or one fix task
//   run          (Claude token only)  the fix agent on the PR branch, checks, bundle
//   publish      (App token)          fast-forward the PR branch with the fix, or count the round
// Like the implementer, the fix agent runs code and never shares a machine with the App token.
import { canRunAgent, recordRun } from './activity.mjs';
import { combined, loadActivity, saveActivity } from './activityStore.mjs';
import { isTrusted } from './config.mjs';
import { decidePr, prBookkeeping } from './pr-decide.mjs';
import {
  claudeMdAddsOnly,
  classifyPaths,
  countChangedLines,
} from './publish-checks.mjs';
import { findStatusComment, parseStatus, renderStatus } from './state.mjs';

const LIVE_MODES = ['implement', 'full'];
export const REQUIRED_CHECKS = [
  'test (macos-latest)',
  'test (windows-latest)',
  'windows-installer',
];

/** The required checks of a head commit: the latest run of each name. */
export function summarizeChecks(runs) {
  const latest = new Map();
  for (const r of runs)
    if (
      REQUIRED_CHECKS.includes(r.name) &&
      (!latest.has(r.name) || r.id > latest.get(r.name).id)
    )
      latest.set(r.name, r);
  if (
    REQUIRED_CHECKS.some(
      (n) => !latest.has(n) || latest.get(n).status !== 'completed',
    )
  )
    return { state: 'pending', failed: [], runs: [...latest.values()] };
  const failed = [...latest.values()].filter(
    (r) => !['success', 'skipped'].includes(r.conclusion),
  );
  return {
    state: failed.length ? 'red' : 'green',
    failed: failed.map((r) => r.name),
    runs: [...latest.values()],
  };
}

async function statusOf(gh, n, bot) {
  const comment = findStatusComment(await gh.listComments(n), bot);
  return { comment, status: comment ? parseStatus(comment.body) : null };
}

async function writeStatus(gh, n, comment, status, summary) {
  const body = renderStatus(status, summary);
  if (comment) await gh.editComment(comment.id, body);
  else return gh.comment(n, body);
  return comment;
}

/** The issue side of a merged PR, whoever merged it. */
async function markMerged(gh, n, bot, { mergeSha, mergedAt, pr }) {
  const { comment, status } = await statusOf(gh, n, bot);
  await gh.addLabels(n, ['agent:merged']);
  for (const l of ['agent:pr-open', 'claude-working'])
    await gh.removeLabel(n, l);
  await writeStatus(
    gh,
    n,
    comment,
    { ...status, state: 'merged', mergeSha, mergedAt },
    `**Merged** in #${pr}. The reporter is told here when a release has it.`,
  );
}

/**
 * @returns {Promise<null | { pr: number, issue: number, branch: string, headSha: string, spec: any, findings: any[],
 *   ciFailures: { job: string, logTail: string }[], comments: { author: string, body: string }[], conflict: boolean, round: number }>}
 */
export async function runDecide({ gh, config, trusted, mode, now, summary }) {
  if (!LIVE_MODES.includes(mode)) {
    summary(`PR poller is off (AGENTS_MODE=${mode || 'unset'}).`);
    return null;
  }
  const bot = config.botLogin;
  const trustedHuman = (login) => login !== bot && isTrusted(trusted, login);

  // issues whose agent PR was merged or closed since the last poll
  for (const issue of (await gh.listOpenIssues()).filter((i) =>
    i.labels.some((l) => l.name === 'agent:pr-open'),
  )) {
    const { comment, status } = await statusOf(gh, issue.number, bot);
    if (!status?.pr) continue;
    const done = prBookkeeping(await gh.getPull(status.pr));
    if (done?.outcome === 'merged') {
      await markMerged(gh, issue.number, bot, { ...done, pr: status.pr });
      summary(`#${issue.number}: PR #${status.pr} was merged`);
    } else if (done?.outcome === 'closed') {
      await gh.addLabels(issue.number, ['agent:needs-owner']);
      for (const l of ['agent:pr-open', 'claude-working'])
        await gh.removeLabel(issue.number, l);
      await writeStatus(
        gh,
        issue.number,
        comment,
        { ...status, state: 'needs-owner' },
        `**Needs the owner:** PR #${status.pr} was closed without merging. Add \`agent:go\` to have it implemented again, or comment.`,
      );
      summary(`#${issue.number}: PR #${status.pr} was closed without merging`);
    }
  }

  const mainGreen = (await gh.latestMainCi())?.conclusion === 'success';
  const pulls = (await gh.listOpenPulls())
    .filter(
      (p) =>
        p.user?.login === bot && p.labels?.some((l) => l.name === 'agent-pr'),
    )
    .sort((a, b) => a.number - b.number);
  let task = null;
  let merged = false;
  for (const listed of pulls) {
    const pr = await gh.getPull(listed.number);
    const sha = pr.head.sha;
    const found = await statusOf(gh, pr.number, bot);
    let prComment = found.comment;
    const status = found.status;
    const issueNumber = Number(
      [...(pr.body ?? '').matchAll(/Fixes #(\d+)/g)].at(-1)?.[1],
    );
    let prState = status ?? {
      v: 1,
      kind: 'pr',
      issue: issueNumber,
      reviews: {},
    };
    const savePr = async (line) => {
      const body = renderStatus(prState, line);
      if (prComment) await gh.editComment(prComment.id, body);
      else prComment = await gh.comment(pr.number, body);
    };

    const checks = summarizeChecks(await gh.listCheckRuns(sha));
    const stats = await gh.listPullFileStats(pr.number);
    const numstat = stats
      .map((f) => `${f.additions}\t${f.deletions}\t${f.filename}`)
      .join('\0');
    const paths = classifyPaths(
      stats.map((f) => f.filename),
      { claudeMdAddsOnly: claudeMdAddsOnly(numstat) },
    );
    const ownerApproved = (await gh.listReviews(pr.number)).some(
      (r) =>
        r.user?.login?.toLowerCase() === trusted.owner &&
        r.state === 'APPROVED' &&
        r.commit_id === sha,
    );
    const trustedComments = (await gh.listPrComments(pr.number))
      .filter((c) => trustedHuman(c.user?.login))
      .map((c) => ({
        id: c.id,
        at: c.created_at,
        author: c.user.login,
        body: c.body,
      }));

    const d = decidePr({
      pr,
      prState,
      checks,
      mainGreen,
      mode,
      config,
      ownerApproved,
      trustedComments,
      paths,
      lines: countChangedLines(numstat),
    });
    summary(
      `PR #${pr.number}: ${d.action}${d.reason ? ` (${d.reason})` : ''}${d.reasons ? `: ${d.reasons.join('; ')}` : ''}`,
    );

    if (d.action === 'update-branch') await gh.updateBranch(pr.number, sha);
    else if (d.action === 'merge' && !merged) {
      // one merge per poll: each merge moves main, and the next PR is checked against the new main next time
      await gh.mergePull(pr.number, sha);
      merged = true;
      const after = await gh.getPull(pr.number);
      await markMerged(gh, prState.issue, bot, {
        mergeSha: after.merge_commit_sha,
        mergedAt: after.merged_at ?? now.toISOString(),
        pr: pr.number,
      });
    } else if (d.action === 'awaits-owner') {
      await gh.addLabels(pr.number, ['agent:awaits-owner']);
      await gh.comment(
        pr.number,
        `**Ready for the owner** (\`${sha.slice(0, 7)}\`): ${d.reasons.join('; ')}.\n\nCI is green and the agent review found nothing blocking. Merge it, approve it (the agents then merge it in full mode), or comment with what to change.`,
      );
      prState = { ...prState, awaitsOwnerSha: sha };
      await savePr(
        `**Agent PR status:** waiting for the owner (${d.reasons.join('; ')}).`,
      );
    } else if (d.action === 'give-up') {
      await gh.addLabels(pr.number, ['agent:hold-merge']);
      await gh.addLabels(prState.issue, ['agent:needs-owner']);
      await gh.comment(
        pr.number,
        `**The agents stopped fixing this PR** after ${config.maxFixRounds} rounds. It needs the owner: push a fix, comment, or close it.`,
      );
      prState = { ...prState, gaveUp: true };
      await savePr(
        '**Agent PR status:** fix rounds used up; waiting for the owner.',
      );
    } else if (d.action === 'fix' && !task) {
      const store = await loadActivity(gh, {
        botLogin: bot,
        poller: 'fix',
        now,
        maxPerDay: config.maxAgentRunsPerDay,
      });
      const can = canRunAgent(
        combined(store, store.own),
        now,
        config.maxAgentRunsPerDay,
      );
      if (!can.ok) {
        summary(`PR #${pr.number}: no fix run (${can.reason})`);
        continue;
      }
      const issueStatus = (await statusOf(gh, prState.issue, bot)).status;
      const failedRuns = checks.runs.filter((r) =>
        d.fixInput.ciFailures.includes(r.name),
      );
      const ciFailures = [];
      for (const r of failedRuns)
        ciFailures.push({
          job: r.name,
          logTail: await gh.jobLogTail(r.id).catch(() => '(log not available)'),
        });
      prState = {
        ...prState,
        fixRounds: (prState.fixRounds ?? 0) + 1,
        lastSeenAt: now.toISOString(),
      };
      await savePr(
        `**Agent PR status:** fix round ${prState.fixRounds} of ${config.maxFixRounds} running.`,
      );
      await saveActivity(gh, store, recordRun(store.own, now), {
        now,
        maxPerDay: config.maxAgentRunsPerDay,
      });
      if (pr.labels.some((l) => l.name === 'agent:awaits-owner'))
        await gh.removeLabel(pr.number, 'agent:awaits-owner');
      task = {
        pr: pr.number,
        issue: prState.issue,
        branch: pr.head.ref,
        headSha: sha,
        spec: issueStatus?.spec ?? null,
        findings: d.fixInput.findings,
        ciFailures,
        comments: d.fixInput.comments.map((c) => ({
          author: c.author,
          body: c.body,
        })),
        conflict: d.fixInput.conflict,
        round: prState.fixRounds,
      };
    }
  }
  return task;
}
