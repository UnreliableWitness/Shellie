// The GitHub Project board: which column an issue's card belongs in, from its agent labels (the labels stay the
// source of truth), and what the owner meant by moving a card. Pure: tools/agents/project.mjs fetches and acts.

export const COLUMNS = [
  'Inbox',
  'Needs info',
  'Needs you',
  'Ready',
  'In progress',
  'In review',
  'Waiting for you',
  'Merged',
  'Released',
  'Closed',
];

/**
 * @param {{ state: string, labels: string[] }} issue state OPEN or CLOSED, label names
 * @param {{ prWaitsForOwner?: boolean }} [o] the issue's agent PR waits for the owner (awaits-owner or hold-merge)
 * @returns {string} one of COLUMNS: the furthest step the labels show
 */
export function columnFor(issue, { prWaitsForOwner = false } = {}) {
  const has = (l) => issue.labels.includes(l);
  if (has('agent:released')) return 'Released';
  if (has('agent:merged')) return 'Merged';
  if (issue.state !== 'OPEN') return 'Closed';
  if (has('agent:pr-open'))
    return prWaitsForOwner ? 'Waiting for you' : 'In review';
  if (has('claude-working')) return 'In progress';
  if (has('agent:ready')) return 'Ready';
  if (has('agent:needs-owner')) return 'Needs you';
  if (has('agent:needs-info')) return 'Needs info';
  return 'Inbox';
}

/**
 * What the owner meant by a card's column when it differs from the labels. Only one move steers: a card
 * dragged to Ready while it needs the owner is a go-ahead (agent:go). Any other difference is undone
 * by the next sync, since the labels decide.
 * @param {{ column: string, issue: { state: string, labels: string[] } }} card
 * @returns {'go' | null}
 */
export function ownerIntent({ column, issue }) {
  const has = (l) => issue.labels.includes(l);
  if (
    column === 'Ready' &&
    issue.state === 'OPEN' &&
    !has('agent:go') &&
    has('agent:needs-owner')
  )
    return 'go';
  return null;
}
