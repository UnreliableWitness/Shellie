// Where each poller keeps its activity block on the "Agent activity" issue: triage in the issue body
// (with the summary people read), every other poller in its own bot comment. A poller writes only its
// own place, so two pollers running at once never overwrite each other's counts or pause.
import { emptyActivity, mergeActivity, renderActivity } from './activity.mjs';
import { parseStatus, renderStatus } from './state.mjs';

export const ACTIVITY_LABEL = 'agent:activity';

/**
 * @param {any} gh
 * @param {{ botLogin: string, poller: string, now: Date, maxPerDay: number }} o
 * @returns {Promise<{ issueNumber: number, poller: string, own: any, ownCommentId?: number, others: any[] }>}
 */
export async function loadActivity(gh, { botLogin, poller, now, maxPerDay }) {
  const issue =
    (await gh.findIssueByLabel(ACTIVITY_LABEL)) ??
    (await gh.createIssue(
      'Agent activity',
      renderActivity(emptyActivity(), {}, now, maxPerDay),
      [ACTIVITY_LABEL],
    ));
  const body = {
    ...emptyActivity(),
    failedAt: {},
    ...parseStatus(issue.body ?? ''),
  };
  const blocks = (await gh.listComments(issue.number))
    .filter((c) => c.user?.login === botLogin)
    .map((c) => ({ id: c.id, block: parseStatus(c.body) }))
    .filter((x) => x.block?.poller);
  if (poller === 'triage')
    return {
      issueNumber: issue.number,
      poller,
      own: body,
      others: blocks.map((x) => x.block),
    };
  const mine = blocks.find((x) => x.block.poller === poller);
  return {
    issueNumber: issue.number,
    poller,
    own: { ...emptyActivity(), failedAt: {}, ...mine?.block, poller },
    ownCommentId: mine?.id,
    others: [body, ...blocks.filter((x) => x !== mine).map((x) => x.block)],
  };
}

/** The pause and the run counts of every poller, with `own` as it is now. */
export const combined = (store, own) => mergeActivity([own, ...store.others]);

/**
 * What counts against a poller's daily budget: triage has its own (config `triageRunsPerDay`), so expensive
 * implement, review and fix runs can never starve the first reaction to a new issue; those three share
 * `maxAgentRunsPerDay` without triage's runs. A usage-limit pause stops everyone.
 * @param {{ poller: string, others: any[] }} store
 * @param {any} own
 */
export function budgetFor(store, own) {
  const all = mergeActivity([own, ...store.others]);
  // triage keeps its block in the issue body, without a poller name
  const isTriage = (b) => !b.poller || b.poller === 'triage';
  const counted =
    store.poller === 'triage'
      ? [own]
      : [own, ...store.others].filter((b) => !isTriage(b));
  return {
    runsByDay: mergeActivity(counted).runsByDay,
    ...(all.pausedUntil ? { pausedUntil: all.pausedUntil } : {}),
  };
}

/**
 * @param {any} gh
 * @param {Awaited<ReturnType<typeof loadActivity>>} store
 * @param {any} own the poller's block to save
 * @param {{ counts?: Record<string, number>, now: Date, maxPerDay: number }} o counts: shown in the issue body (triage)
 */
export async function saveActivity(
  gh,
  store,
  own,
  { counts = {}, now, maxPerDay },
) {
  if (store.poller === 'triage') {
    await gh.editIssueBody(
      store.issueNumber,
      renderActivity(own, counts, now, maxPerDay, combined(store, own)),
    );
    return;
  }
  const body = renderStatus(
    own,
    `Bookkeeping of the ${store.poller} agent; edited by the agents.`,
  );
  if (store.ownCommentId) await gh.editComment(store.ownCommentId, body);
  else store.ownCommentId = (await gh.comment(store.issueNumber, body)).id;
}
