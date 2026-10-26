// What the triage poller does with one open issue (spec 3.3, 4, 5.1). Pure: the caller fetches and acts.
import { isTrusted } from './config.mjs';
import { findStatusComment, parseStatus } from './state.mjs';

const DAY = 86400000;

/**
 * @typedef {{ number: number, user: { login: string } | null, labels: { name: string }[], assignees?: { login: string }[],
 *   pull_request?: unknown, created_at: string, updated_at: string, title: string, body: string | null }} Issue
 * @typedef {{ id: number, user: { login: string } | null, body: string, created_at: string }} Comment
 * @typedef {{ action: 'skip' | 'await-approval' | 'triage' | 'go' | 'remind' | 'close-stale', reason: string,
 *   newComments?: Comment[], status?: any, statusComment?: Comment | null }} Decision
 */

/**
 * @param {Issue} issue
 * @param {Comment[]} comments in creation order
 * @param {{ trusted: { owner: string, logins: Set<string> }, botLogin: string, now: Date, humanBranches: string[],
 *   humanPrTitles: string[], shadowSeen: Record<string, string>, mode: string,
 *   config: { needsInfoRemindDays: number, needsInfoCloseDays: number } }} ctx
 * @returns {Decision}
 */
export function classifyIssue(issue, comments, ctx) {
  const n = issue.number;
  const has = (name) => issue.labels.some((l) => l.name === name);
  const skip = (reason) => ({ action: /** @type {const} */ ('skip'), reason });

  if (issue.pull_request) return skip('pull-request');
  if (has('agent:stop')) return skip('stopped');
  if ((issue.assignees ?? []).some((a) => a.login !== ctx.botLogin)) return skip('assigned');
  if (
    ctx.humanBranches.some((b) => b.startsWith(`issues/${n}-`)) ||
    ctx.humanPrTitles.some((t) => new RegExp(`#${n}(?!\\d)`).test(t))
  )
    return skip('owner-working');

  const trustedLogin = (login) => login === ctx.botLogin || isTrusted(ctx.trusted, login);
  if (!trustedLogin(issue.user?.login) && !has('agent:go'))
    return has('agent:awaiting-approval') ? skip('awaiting-approval') : { action: 'await-approval', reason: 'untrusted' };

  if (ctx.mode === 'shadow' && ctx.shadowSeen[n] === issue.updated_at) return skip('shadow-seen');

  const statusComment = findStatusComment(comments, ctx.botLogin);
  const status = statusComment ? parseStatus(statusComment.body) : null;
  if (!status) return { action: 'triage', reason: 'new', newComments: trustedComments(comments, trustedLogin, ctx.botLogin, 0) };

  const fresh = trustedComments(comments, trustedLogin, ctx.botLogin, status.lastSeenCommentId);
  const base = { status, statusComment, newComments: fresh };
  // the poller only sees open issues: a closed one that is open again was reopened by someone
  if (status.state === 'closed') return { ...base, action: 'triage', reason: 'reopened' };
  if (status.state === 'needs-owner') {
    if (has('agent:go') && !status.goHandled) return { ...base, action: 'go', reason: 'owner-go' };
    if (fresh.length) return { ...base, action: 'triage', reason: 'owner-replied' };
    return skip('waiting');
  }
  if (status.state === 'needs-info') {
    if (fresh.length) return { ...base, action: 'triage', reason: 'answered' };
    const days = (ctx.now.getTime() - Date.parse(status.askedAt)) / DAY;
    if (days >= ctx.config.needsInfoCloseDays) return { ...base, action: 'close-stale', reason: 'no-answer' };
    if (days >= ctx.config.needsInfoRemindDays && !status.remindedAt) return { ...base, action: 'remind', reason: 'no-answer' };
  }
  return skip('waiting');
}

/** Comments after `afterId` by trusted people other than the bot. */
function trustedComments(comments, trustedLogin, botLogin, afterId) {
  return comments.filter((c) => c.id > afterId && c.user?.login !== botLogin && trustedLogin(c.user?.login));
}

/**
 * @template {{ issue: Issue, decision: Decision }} T
 * @param {T[]} items
 * @param {number} max agent runs allowed in this poll
 * @returns {{ agent: T[], script: T[] }} the oldest `triage` items up to `max`, and every item the script handles alone
 */
export function pickForTriage(items, max) {
  const byAge = [...items].sort((a, b) => a.issue.number - b.issue.number);
  return {
    agent: byAge.filter((x) => x.decision.action === 'triage').slice(0, max),
    script: byAge.filter((x) => !['triage', 'skip'].includes(x.decision.action)),
  };
}
