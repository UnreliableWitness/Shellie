// What the PR poller does next with one agent PR (spec 5.4, 5.5). Pure: the caller fetches and acts.

/**
 * @param {{ pr: any, prState: any, checks: { state: 'pending' | 'green' | 'red', failed: string[] }, mainGreen: boolean,
 *   mode: string, config: any, ownerApproved: boolean, trustedComments: { id: number, at: string, author: string, body: string }[],
 *   paths: { denied: string[], ownerOnly: string[] }, lines: number, behindMain: boolean,
 *   ownerChangesRequested: boolean, now: Date }} o
 *   behindMain: main has commits the PR lacks (GitHub reports `behind` only under strict branch protection)
 * @returns {{ action: 'wait' | 'rerun' | 'fix' | 'give-up' | 'update-branch' | 'merge' | 'awaits-owner', reason?: string,
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
  behindMain,
  ownerChangesRequested,
  now,
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
    (c) => !prState.lastSeenAt || c.at > prState.lastSeenAt,
  );
  const ciFailures = checks.state === 'red' ? checks.failed : [];
  const findings = review?.verdict === 'changes' ? (review.items ?? []) : [];
  if (conflict || ciFailures.length || findings.length || fresh.length) {
    // only red CI: re-run the failed jobs once for this commit before spending a fix round (flaky tests)
    if (
      !conflict &&
      !findings.length &&
      !fresh.length &&
      prState.ciRerunSha !== sha
    )
      return { action: 'rerun', reason: 'ci-red' };
    // a fix that changed nothing (same head) is tried again after an hour, not on the next poll
    if (
      prState.lastFixSha === sha &&
      now.getTime() - Date.parse(prState.lastFixAt ?? '') < 60 * 60000
    )
      return wait('fix-retry-later');
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
  const reasons = [];
  if (review?.verdict === 'changes')
    reasons.push(
      'the agent review wants changes but listed no findings to fix',
    );
  if (ownerChangesRequested) reasons.push('the owner requested changes');
  if (review?.verdict === 'error') reasons.push('the agent review failed');
  if (has('agent:hold-merge')) reasons.push('agent:hold-merge');
  if (paths.denied.length) reasons.push(`touches ${paths.denied.join(', ')}`);
  const ownerOnly = [];
  // features merge like bugs and chores when low risk (the owner's call, 2026-10-26)
  if (label('risk:') !== 'low') ownerOnly.push('high risk');
  if (lines > config.autoMergeMaxLines)
    ownerOnly.push(`${lines} changed lines`);
  for (const f of paths.ownerOnly) ownerOnly.push(`touches ${f}`);
  // the owner's approval covers what only the owner may merge, never a red main, a hold or a failed review
  if (!ownerApproved) reasons.push(...ownerOnly);
  if (mode !== 'full' && !reasons.length)
    reasons.push('implement mode: nothing merges by itself');

  // brought up to date only when it could merge: an update re-runs CI and the review
  if (!reasons.length && (behindMain || pr.mergeable_state === 'behind'))
    return { action: 'update-branch', reason: 'behind main' };
  // main red or its CI still running is not the owner's call: wait for it
  if (!reasons.length && !mainGreen) return wait('main-not-green');
  if (!reasons.length)
    return {
      action: 'merge',
      reason: ownerApproved ? 'owner approved' : 'meets the merge rule',
    };
  if (
    prState.awaitsOwnerSha === sha &&
    prState.awaitsOwnerReasons === reasons.join('; ')
  )
    return wait('owner-told');
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

/**
 * Whether main's CI is green: the newest run that was not cancelled (a cancelled run was replaced by a newer
 * one); false while that run is still going, so nothing merges onto a main whose CI is not known yet.
 * @param {{ status: string, conclusion: string | null }[]} runs newest first
 */
export function mainCiGreen(runs) {
  const run = runs.find((r) => r.conclusion !== 'cancelled');
  return run?.status === 'completed' && run.conclusion === 'success';
}
