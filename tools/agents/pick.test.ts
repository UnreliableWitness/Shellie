import { describe, expect, it } from 'vitest';
import { ownerSkipReason } from './classify.mjs';
import { parseConfig, parseTrusted } from './config.mjs';
import { pickForImplement } from './pick.mjs';

const bot = 'shellie-agents[bot]';
const now = new Date('2026-10-26T12:00:00Z');
const labels = (...names: string[]) => names.map((name) => ({ name }));
const issue = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  body: '',
  user: { login: 'maximedebraekeleer' },
  labels: labels('agent:ready', 'kind:bug'),
  assignees: [],
  created_at: '',
  updated_at: '',
  ...over,
});
const status = (over: Record<string, unknown> = {}) => ({
  v: 1,
  state: 'ready',
  spec: { problem: 'p', cause: 'c', change: 'c', test: 't' },
  kind: 'bug',
  risk: 'low',
  lastSeenCommentId: 0,
  triageRounds: 1,
  tokens: 0,
  ...over,
});
const ctx = (over: Record<string, unknown> = {}) => ({
  trusted: parseTrusted(
    'owner: UnreliableWitness\nlogins: [maximedebraekeleer]',
  ),
  botLogin: bot,
  now,
  humanBranches: [] as string[],
  humanPrTitles: [] as string[],
  openAgentPrs: 0,
  config: parseConfig(''),
  ...over,
});
const pickNumber = (
  c: { issue: ReturnType<typeof issue>; status: unknown }[],
  x = ctx(),
) => pickForImplement(c as never, x as never).pick?.issue.number;

describe('ownerSkipReason', () => {
  it('names why the agents must leave an issue alone, or null', () => {
    expect(ownerSkipReason(issue(1, { pull_request: {} }), ctx())).toBe(
      'pull-request',
    );
    expect(
      ownerSkipReason(issue(1, { labels: labels('agent:stop') }), ctx()),
    ).toBe('stopped');
    expect(
      ownerSkipReason(issue(1, { assignees: [{ login: 'x' }] }), ctx()),
    ).toBe('assigned');
    expect(
      ownerSkipReason(issue(1), ctx({ humanBranches: ['issues/1-x'] })),
    ).toBe('owner-working');
    expect(ownerSkipReason(issue(1), ctx())).toBeNull();
  });
});

describe('pickForImplement', () => {
  it('picks nothing while an agent PR is open', () => {
    const r = pickForImplement(
      [{ issue: issue(1), status: status() }] as never,
      ctx({ openAgentPrs: 1 }) as never,
    );
    expect(r).toEqual({ reason: 'pr-limit' });
  });
  it('needs agent:ready, a ready status with a spec, and no lock or open PR', () => {
    expect(
      pickNumber([
        { issue: issue(1, { labels: labels('kind:bug') }), status: status() },
      ]),
    ).toBeUndefined();
    expect(
      pickNumber([
        { issue: issue(1), status: status({ state: 'needs-info' }) },
      ]),
    ).toBeUndefined();
    expect(
      pickNumber([{ issue: issue(1), status: status({ spec: undefined }) }]),
    ).toBeUndefined();
    expect(
      pickNumber([
        {
          issue: issue(1, { labels: labels('agent:ready', 'claude-working') }),
          status: status(),
        },
      ]),
    ).toBeUndefined();
    expect(
      pickNumber([
        {
          issue: issue(1, { labels: labels('agent:ready', 'agent:pr-open') }),
          status: status(),
        },
      ]),
    ).toBeUndefined();
    expect(pickNumber([{ issue: issue(1), status: null }])).toBeUndefined();
    expect(pickNumber([{ issue: issue(1), status: status() }])).toBe(1);
  });
  it('respects the owner, the attempt limit and the hour after a failure', () => {
    expect(
      pickNumber([
        {
          issue: issue(1, { labels: labels('agent:ready', 'agent:stop') }),
          status: status(),
        },
      ]),
    ).toBeUndefined();
    expect(
      pickNumber([
        { issue: issue(1), status: status({ implementAttempts: 2 }) },
      ]),
    ).toBeUndefined();
    expect(
      pickNumber([
        { issue: issue(1), status: status({ implementAttempts: 1 }) },
      ]),
    ).toBe(1);
    expect(
      pickNumber([
        {
          issue: issue(1),
          status: status({ implementFailedAt: '2026-10-26T11:30:00Z' }),
        },
      ]),
    ).toBeUndefined();
    expect(
      pickNumber([
        {
          issue: issue(1),
          status: status({ implementFailedAt: '2026-10-26T10:30:00Z' }),
        },
      ]),
    ).toBe(1);
  });
  it("needs a trusted author, the bot, or the owner's agent:go", () => {
    const stranger = { login: 'stranger' };
    expect(
      pickNumber([{ issue: issue(1, { user: stranger }), status: status() }]),
    ).toBeUndefined();
    expect(
      pickNumber([
        {
          issue: issue(1, {
            user: stranger,
            labels: labels('agent:ready', 'agent:go'),
          }),
          status: status(),
        },
      ]),
    ).toBe(1);
    expect(
      pickNumber([
        { issue: issue(1, { user: { login: bot } }), status: status() },
      ]),
    ).toBe(1);
  });
  it('takes bugs, then chores, then features, oldest first', () => {
    const feature = {
      issue: issue(1, { labels: labels('agent:ready', 'kind:feature') }),
      status: status({ kind: 'feature' }),
    };
    const chore = {
      issue: issue(2, { labels: labels('agent:ready', 'kind:chore') }),
      status: status({ kind: 'chore' }),
    };
    const bug9 = { issue: issue(9), status: status() };
    const bug5 = { issue: issue(5), status: status() };
    expect(pickNumber([feature, chore, bug9, bug5])).toBe(5);
    expect(pickNumber([feature, chore])).toBe(2);
  });
});
