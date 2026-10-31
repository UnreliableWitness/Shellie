// Which agent:ready issue the implementer takes next (spec 5.2). Pure: the caller fetches and acts.
import { ownerSkipReason } from './classify.mjs';
import { isTrusted } from './config.mjs';

const RETRY_MS = 60 * 60000;
const KIND_ORDER = ['bug', 'chore', 'feature'];

/**
 * @param {{ issue: any, status: any }[]} candidates open issues with their status block (null without one)
 * @param {{ trusted: any, botLogin: string, now: Date, humanBranches: string[], humanPrTitles: string[],
 *   openAgentPrs: number, config: { maxOpenAgentPrs: number, maxImplementAttempts: number },
 *   rank?: Map<number, number> }} ctx rank: issue number to its position on the project board
 * @returns {{ pick?: { issue: any, status: any }, reason: string }}
 */
export function pickForImplement(candidates, ctx) {
  if (ctx.openAgentPrs >= ctx.config.maxOpenAgentPrs)
    return { reason: 'pr-limit' };
  const has = (issue, name) => issue.labels.some((l) => l.name === name);
  const eligible = candidates.filter(({ issue, status }) => {
    if (
      !has(issue, 'agent:ready') ||
      has(issue, 'claude-working') ||
      has(issue, 'agent:pr-open')
    )
      return false;
    if (ownerSkipReason(issue, ctx)) return false;
    if (status?.state !== 'ready' || !status.spec) return false;
    if ((status.implementAttempts ?? 0) >= ctx.config.maxImplementAttempts)
      return false;
    if (
      ctx.now.getTime() - Date.parse(status.implementFailedAt ?? '') <
      RETRY_MS
    )
      return false;
    const author = issue.user?.login;
    return (
      author === ctx.botLogin ||
      isTrusted(ctx.trusted, author) ||
      has(issue, 'agent:approved')
    );
  });
  const kindRank = ({ status }) => {
    const i = KIND_ORDER.indexOf(status.kind);
    return i === -1 ? KIND_ORDER.length : i;
  };
  // the owner's order on the project board first (cards not on it come after), then bugs, chores, features
  const boardRank = ({ issue }) => ctx.rank?.get(issue.number) ?? Infinity;
  eligible.sort(
    (a, b) =>
      boardRank(a) - boardRank(b) ||
      kindRank(a) - kindRank(b) ||
      a.issue.number - b.issue.number,
  );
  return eligible.length
    ? { pick: eligible[0], reason: 'picked' }
    : { reason: 'nothing-ready' };
}
