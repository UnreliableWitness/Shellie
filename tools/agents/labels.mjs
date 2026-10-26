// The labels the agents use to show where an issue or PR is (spec section 3.1).
export const LABELS = [
  {
    name: 'agent:awaiting-approval',
    color: 'fbca04',
    description: 'From outside the trusted list: agents wait for agent:go',
  },
  {
    name: 'agent:approved',
    color: 'c2e0c6',
    description:
      'The owner approved this reporter for the agents (from agent:go)',
  },
  {
    name: 'agent:go',
    color: '0e8a16',
    description: "Owner's go-ahead for the agents",
  },
  {
    name: 'agent:needs-info',
    color: 'd876e3',
    description: 'Agents asked the reporter questions',
  },
  {
    name: 'agent:ready',
    color: '1d76db',
    description: 'Triaged: a fix spec is posted, waiting for the implementer',
  },
  {
    name: 'agent:needs-owner',
    color: 'b60205',
    description: 'Needs a decision from the owner',
  },
  {
    name: 'claude-working',
    color: '7e57c2',
    description: 'A Claude agent is working on this issue',
  },
  {
    name: 'agent:pr-open',
    color: '5319e7',
    description: 'An agent PR exists for this issue',
  },
  {
    name: 'agent:awaits-owner',
    color: 'e99695',
    description: 'Agent PR ready, waiting for the owner to approve',
  },
  {
    name: 'agent:merged',
    color: '0e8a16',
    description: 'Agent fix merged, not released yet',
  },
  {
    name: 'agent:released',
    color: '006b75',
    description: 'Fix released and the reporter told',
  },
  {
    name: 'agent:stop',
    color: '000000',
    description: 'Agents leave this alone',
  },
  {
    name: 'agent:hold-merge',
    color: 'c5def5',
    description: 'Agents keep working but do not merge',
  },
  {
    name: 'agent-pr',
    color: '7e57c2',
    description: 'A pull request the agents own',
  },
  {
    name: 'agent:activity',
    color: 'ededed',
    description: "The agents' own bookkeeping issue",
  },
  { name: 'kind:bug', color: 'd73a4a', description: 'Triage: a bug' },
  {
    name: 'kind:feature',
    color: 'a2eeef',
    description: 'Triage: a feature (never auto-merges)',
  },
  { name: 'kind:chore', color: 'cfd3d7', description: 'Triage: housekeeping' },
  { name: 'risk:low', color: 'c2e0c6', description: 'Triage: low risk' },
  {
    name: 'risk:high',
    color: 'f9d0c4',
    description: 'Triage: high risk, owner approves the merge',
  },
  {
    name: 'source:health',
    color: 'bfdadc',
    description: 'Opened by the health agent from app telemetry',
  },
  {
    name: 'source:gardener',
    color: 'bfdadc',
    description: 'Opened by the gardener agent',
  },
  {
    name: 'source:app',
    color: 'bfdadc',
    description: 'Reported from inside Shellie',
  },
];

/**
 * @param {string[]} existing label names already on the repo
 * @returns {typeof LABELS} the labels still to create
 */
export function missingLabels(existing) {
  const have = new Set(existing);
  return LABELS.filter((l) => !have.has(l.name));
}
