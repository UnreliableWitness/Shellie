import { describe, expect, it } from 'vitest';
import { classifyIssue, pickForTriage } from './classify.mjs';
import { parseConfig, parseTrusted } from './config.mjs';
import { renderStatus } from './state.mjs';

const bot = 'shellie-agents[bot]';
const now = new Date('2026-10-26T12:00:00Z');
const daysAgo = (d: number) =>
  new Date(now.getTime() - d * 86400000).toISOString();

const issue = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'Something breaks',
  body: 'It breaks',
  user: { login: 'maximedebraekeleer' },
  labels: [] as { name: string }[],
  assignees: [] as { login: string }[],
  created_at: daysAgo(1),
  updated_at: daysAgo(1),
  ...over,
});
const labels = (...names: string[]) => names.map((name) => ({ name }));
const comment = (id: number, login: string, body = 'text') => ({
  id,
  user: { login },
  body,
  created_at: daysAgo(0),
});
const status = (state: Record<string, unknown>, id = 10) =>
  comment(
    id,
    bot,
    renderStatus(
      { v: 1, triageRounds: 1, tokens: 0, lastSeenCommentId: id, ...state },
      'x',
    ),
  );

const ctx = (over: Record<string, unknown> = {}) => ({
  trusted: parseTrusted(
    'owner: UnreliableWitness\nlogins: [maximedebraekeleer]',
  ),
  botLogin: bot,
  now,
  humanBranches: [] as string[],
  humanPrTitles: [] as string[],
  shadowSeen: {} as Record<string, string>,
  mode: 'triage',
  config: parseConfig(''),
  ...over,
});

describe('classifyIssue: skips', () => {
  it('never triages a pull request', () => {
    expect(
      classifyIssue(issue({ pull_request: { url: 'x' } }), [], ctx()).action,
    ).toBe('skip');
  });
  it('leaves agent:stop alone', () => {
    expect(
      classifyIssue(issue({ labels: labels('agent:stop') }), [], ctx()).reason,
    ).toBe('stopped');
  });
  it('leaves an issue assigned to a person alone', () => {
    expect(
      classifyIssue(
        issue({ assignees: [{ login: 'UnreliableWitness' }] }),
        [],
        ctx(),
      ).reason,
    ).toBe('assigned');
  });
  it('leaves an issue the owner works on in a branch or PR alone', () => {
    expect(
      classifyIssue(issue(), [], ctx({ humanBranches: ['issues/7-fix'] }))
        .reason,
    ).toBe('owner-working');
    expect(
      classifyIssue(issue(), [], ctx({ humanPrTitles: ['Fix it (#7)'] }))
        .reason,
    ).toBe('owner-working');
  });
  it('does not mistake #12 or issues/70 for issue 7... but does for #7', () => {
    const c = ctx({
      humanBranches: ['issues/70-x'],
      humanPrTitles: ['Other (#12)', 'Thing #77'],
    });
    expect(classifyIssue(issue(), [], c).action).toBe('triage');
  });
});

describe('classifyIssue: trust', () => {
  it('asks the owner to approve an untrusted reporter once', () => {
    const i = issue({ user: { login: 'stranger' } });
    expect(classifyIssue(i, [], ctx()).action).toBe('await-approval');
    expect(
      classifyIssue(
        { ...i, labels: labels('agent:awaiting-approval') },
        [],
        ctx(),
      ).action,
    ).toBe('skip');
  });
  it("turns the owner's agent:go on an untrusted reporter's issue into a lasting approval", () => {
    const i = issue({
      user: { login: 'stranger' },
      labels: labels('agent:awaiting-approval', 'agent:go'),
    });
    expect(classifyIssue(i, [], ctx()).action).toBe('approve');
  });
  it("triages an approved untrusted reporter's issue", () => {
    const i = issue({
      user: { login: 'stranger' },
      labels: labels('agent:approved'),
    });
    expect(classifyIssue(i, [], ctx()).action).toBe('triage');
  });
  it("treats the bot's own issues as trusted", () => {
    expect(
      classifyIssue(issue({ user: { login: bot } }), [], ctx()).action,
    ).toBe('triage');
  });
});

describe('classifyIssue: state', () => {
  it('triages an issue without a status', () => {
    expect(
      classifyIssue(issue(), [comment(5, 'maximedebraekeleer')], ctx()).action,
    ).toBe('triage');
  });
  it('does not triage again after an edit without new comments', () => {
    const i = issue({ updated_at: daysAgo(0) });
    expect(classifyIssue(i, [status({ state: 'ready' })], ctx()).action).toBe(
      'skip',
    );
  });
  it('triages again when the reporter answers', () => {
    const d = classifyIssue(
      issue(),
      [
        status({ state: 'needs-info', askedAt: daysAgo(1) }),
        comment(11, 'maximedebraekeleer', 'answer'),
      ],
      ctx(),
    );
    expect(d.action).toBe('triage');
    expect(d.newComments?.map((c) => c.id)).toEqual([11]);
  });
  it('ignores answers from people outside the trusted list', () => {
    const d = classifyIssue(
      issue(),
      [
        status({ state: 'needs-info', askedAt: daysAgo(1) }),
        comment(11, 'stranger'),
      ],
      ctx(),
    );
    expect(d.action).toBe('skip');
  });
  it('triages a released issue that someone reopened', () => {
    expect(
      classifyIssue(issue(), [status({ state: 'released' })], ctx()).reason,
    ).toBe('reopened');
  });
  it('triages again when a closed issue is reopened', () => {
    expect(
      classifyIssue(issue(), [status({ state: 'closed' })], ctx()).reason,
    ).toBe('reopened');
  });
  it('reminds after 14 days once, and closes after 21', () => {
    expect(
      classifyIssue(
        issue(),
        [status({ state: 'needs-info', askedAt: daysAgo(14) })],
        ctx(),
      ).action,
    ).toBe('remind');
    expect(
      classifyIssue(
        issue(),
        [
          status({
            state: 'needs-info',
            askedAt: daysAgo(15),
            remindedAt: daysAgo(1),
          }),
        ],
        ctx(),
      ).action,
    ).toBe('skip');
    expect(
      classifyIssue(
        issue(),
        [
          status({
            state: 'needs-info',
            askedAt: daysAgo(21),
            remindedAt: daysAgo(7),
          }),
        ],
        ctx(),
      ).action,
    ).toBe('close-stale');
  });
  it('moves needs-owner to ready on agent:go, and re-triages on an owner comment', () => {
    expect(
      classifyIssue(
        issue({ labels: labels('agent:go') }),
        [status({ state: 'needs-owner' })],
        ctx(),
      ).action,
    ).toBe('go');
    expect(
      classifyIssue(
        issue(),
        [status({ state: 'needs-owner' }), comment(12, 'UnreliableWitness')],
        ctx(),
      ).action,
    ).toBe('triage');
    expect(
      classifyIssue(issue(), [status({ state: 'needs-owner' })], ctx()).action,
    ).toBe('skip');
  });
});

describe('classifyIssue: shadow', () => {
  it('runs an unchanged issue only once in shadow mode', () => {
    const i = issue();
    expect(
      classifyIssue(
        i,
        [],
        ctx({ mode: 'shadow', shadowSeen: { 7: i.updated_at } }),
      ).reason,
    ).toBe('shadow-seen');
    expect(
      classifyIssue(
        i,
        [],
        ctx({ mode: 'shadow', shadowSeen: { 7: daysAgo(3) } }),
      ).action,
    ).toBe('triage');
  });
});

describe('pickForTriage', () => {
  it('takes the oldest agent work up to the limit and all script-only work', () => {
    const items = [9, 3, 5, 4].map((n) => ({
      issue: issue({ number: n }),
      decision: { action: n === 4 ? 'remind' : 'triage', reason: '' },
    }));
    const { agent, script } = pickForTriage(items, 2);
    expect(agent.map((x) => x.issue.number)).toEqual([3, 5]);
    expect(script.map((x) => x.issue.number)).toEqual([4]);
  });
});
