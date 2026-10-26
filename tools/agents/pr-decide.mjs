// What the PR poller does next with one agent PR (spec 5.4, 5.5). Pure: the caller fetches and acts.

/**
 * @param {{ pr: any, prState: any, checks: { state: 'pending' | 'green' | 'red', failed: string[] }, mainGreen: boolean,
 *   mode: string, config: any, ownerApproved: boolean, trustedComments: { id: number, author: string, body: string }[],
 *   paths: { denied: string[], ownerOnly: string[] }, lines: number }} o
 * @returns {{ action: 'wait' | 'fix' | 'give-up' | 'update-branch' | 'merge' | 'awaits-owner', reason?: string,
 *   reasons?: string[], fixInput?: { ciFailures: string[], findings: any[], comments: any[], conflict: boolean } }}
 */
export function decidePr({
  pr,
  prState,
  checks,
  mainGreen,
  mode,
  config,
  ownerApproved,
  trustedComments,
  paths,
  lines,
}) {
  const has = (name) => pr.labels.some((l) => l.name === name);
  const label = (prefix) =>
    pr.labels.find((l) => l.name.startsWith(prefix))?.name.slice(prefix.length);
  const wait = (reason) => ({ action: /** @type {const} */ ('wait'), reason });
  const sha = pr.head.sha;
  const review = prState.reviews?.[sha];

  if (has('agent:stop')) return wait('stopped');
  if (pr.mergeable_state === 'unknown') return wait('mergeable-unknown');

  // a conflict needs fixing whatever CI says about the old head
  const conflict = pr.mergeable_state === 'dirty';
  if (!conflict && checks.state === 'pending') return wait('ci-pending');
  if (!conflict && !review) return wait('review-pending');

  const fresh = trustedComments.filter(
    (c) => c.id > (prState.lastSeenCommentId ?? 0),
  );
  const ciFailures = checks.state === 'red' ? checks.failed : [];
  const findings = review?.verdict === 'changes' ? (review.items ?? []) : [];
  if (conflict || ciFailures.length || findings.length || fresh.length) {
    if ((prState.fixRounds ?? 0) >= config.maxFixRounds)
      return prState.gaveUp
        ? wait('gave-up')
        : { action: 'give-up', reason: 'fix rounds used up' };
    return {
      action: 'fix',
      reason: 'needs a fix',
      fixInput: { ciFailures, findings, comments: fresh, conflict },
    };
  }
  if (review?.verdict === 'changes') return wait('changes-without-findings');

  if (pr.mergeable_state === 'behind')
    return { action: 'update-branch', reason: 'behind main' };

  const reasons = [];
  if (review?.verdict === 'error') reasons.push('the agent review failed');
  if (has('agent:hold-merge')) reasons.push('agent:hold-merge');
  if (!mainGreen) reasons.push('main is red');
  if (paths.denied.length) reasons.push(`touches ${paths.denied.join(', ')}`);
  const ownerOnly = [];
  if (!['bug', 'chore'].includes(label('kind:'))) ownerOnly.push('a feature');
  if (label('risk:') !== 'low') ownerOnly.push('high risk');
  if (lines > config.autoMergeMaxLines)
    ownerOnly.push(`${lines} changed lines`);
  for (const f of paths.ownerOnly) ownerOnly.push(`touches ${f}`);
  // the owner's approval covers what only the owner may merge, never a red main, a hold or a failed review
  if (!ownerApproved) reasons.push(...ownerOnly);
  if (mode !== 'full' && !reasons.length)
    reasons.push('implement mode: nothing merges by itself');

  if (!reasons.length)
    return {
      action: 'merge',
      reason: ownerApproved ? 'owner approved' : 'meets the merge rule',
    };
  if (prState.awaitsOwnerSha === sha) return wait('owner-told');
  return { action: 'awaits-owner', reasons };
}

/** @param {{ state: string, merged_at: string | null, merge_commit_sha?: string }} pr */
export function prBookkeeping(pr) {
  if (pr.merged_at)
    return {
      outcome: 'merged',
      mergeSha: pr.merge_commit_sha,
      mergedAt: pr.merged_at,
    };
  if (pr.state === 'closed') return { outcome: 'closed' };
  return null;
}
