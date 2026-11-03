import { describe, expect, it } from 'vitest';
import type { BudgetRecord } from '../../shared/budget';
import type { CostRecord } from '../../shared/ledger';
import type { Connection, Repo, Task } from '../../shared/types';
import { attribute, attributionContext, merge, raises } from './attribute';

const conn = (id: string, org: string, project: string) =>
  ({ id, organizationUrl: org, project }) as Connection;
const repo = (
  id: string,
  name: string,
  p: string,
  connectionId: string | null,
) => ({ id, name, path: p, connectionId }) as Repo;

const task = (o: Partial<Task> & { id: string }): Task =>
  ({
    repoId: 'r1',
    workItem: { id: '42', type: 'Bug', title: 'Fix the thing', url: null },
    worktreePath: `/wt/${o.id}`,
    terminals: [],
    closedTerminals: [],
    extraWorkspaces: [],
    connectionId: null,
    openPeriods: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    finishedAt: null,
    ...o,
  }) as Task;

const rec = (o: Partial<BudgetRecord> = {}): BudgetRecord => ({
  id: 'cc:1',
  tool: 'claude-code',
  sessionId: 'S',
  model: 'claude-sonnet-5-5',
  provider: 'anthropic',
  at: '2026-10-12T10:00:00.000Z',
  cwd: null,
  fast: false,
  inputTokens: 10,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  ...o,
});

const repos = [
  repo('r1', 'web', '/src/web', 'c1'),
  repo('r2', 'api', '/src/api', 'c2'),
];
const connections = [
  conn('c1', 'https://dev.azure.com/acme', 'Shop'),
  conn('c2', 'https://dev.azure.com/other', 'Backend'),
];

describe('attribute', () => {
  it('attributes a Claude session the usage store knows for a task (no tab of its own)', () => {
    const t = task({ id: 't1' });
    const without = attributionContext([t], repos, connections);
    expect(
      attribute(rec({ sessionId: 'OT', cwd: '/elsewhere' }), without),
    ).toEqual({ level: 'none' });
    const ctx = attributionContext([t], repos, connections, (id) =>
      id === 't1' ? ['OT', 'OT'] : [],
    );
    expect(
      attribute(rec({ sessionId: 'OT', cwd: '/elsewhere' }), ctx),
    ).toMatchObject({ level: 'task', taskId: 't1', workItemId: 42 });
    // Stored records move up once the session is known: the key changes.
    expect(ctx.key).not.toBe(without.key);
  });

  it('attributes a Claude session of a task tab', () => {
    const t = task({
      id: 't1',
      terminals: [{ id: 'a', kind: 'claude', label: 'C', sessionId: 'S1' }],
      closedTerminals: [
        { id: 'b', kind: 'claude', label: 'C', sessionId: 'S2' },
      ],
    } as Partial<Task> & { id: string });
    const ctx = attributionContext([t], repos, connections);
    const want = {
      level: 'task',
      taskId: 't1',
      organization: 'https://dev.azure.com/acme',
      project: 'Shop',
      workItemId: 42,
      workItemTitle: 'Fix the thing',
      workItemType: 'Bug',
      repo: 'web',
    };
    expect(attribute(rec({ sessionId: 'S1' }), ctx)).toEqual(want);
    expect(attribute(rec({ sessionId: 'S2' }), ctx)).toEqual(want);
    // The task's own connection wins over the home repo's.
    const t2 = { ...t, connectionId: 'c2' };
    expect(
      attribute(
        rec({ sessionId: 'S1' }),
        attributionContext([t2], repos, connections),
      ),
    ).toMatchObject({
      organization: 'https://dev.azure.com/other',
      project: 'Backend',
    });
    // A record that carries its task id (Copilot CLI, PR summary).
    expect(
      attribute(rec({ id: 'cp:x', tool: 'copilot-cli', taskId: 't1' }), ctx),
    ).toEqual(want);
  });

  it('attributes OpenCode in a joined repo to the task, naming that repo', () => {
    const t = task({
      id: 't1',
      extraWorkspaces: [
        {
          id: 'x',
          repoId: 'r2',
          worktreePath: '/wt/t1-api',
          dropped: false,
        },
      ],
    } as Partial<Task> & { id: string });
    const ctx = attributionContext([t], repos, connections);
    const a = attribute(
      rec({ id: 'oc:1', tool: 'opencode', cwd: '/wt/t1-api/src' }),
      ctx,
    );
    expect(a).toMatchObject({
      level: 'task',
      taskId: 't1',
      repo: 'api',
      // The task's work item is what gets billed, also from a repo in another organization.
      organization: 'https://dev.azure.com/acme',
      workItemId: 42,
    });
  });

  it('ignores OpenCode in a reused worktree before the task opened', () => {
    const a = task({
      id: 'A',
      worktreePath: '/wt/shared',
      openPeriods: [
        { start: '2026-10-01T00:00:00.000Z', end: '2026-10-06T00:00:00.000Z' },
      ],
    });
    const b = task({
      id: 'B',
      worktreePath: '/wt/shared',
      openPeriods: [{ start: '2026-10-10T00:00:00.000Z', end: null }],
    });
    const msg = rec({
      id: 'oc:1',
      tool: 'opencode',
      cwd: '/wt/shared',
      at: '2026-10-05T12:00:00.000Z',
    });
    expect(
      attribute(msg, attributionContext([a, b], repos, connections)),
    ).toMatchObject({ level: 'task', taskId: 'A' });
    // Without A, B does not take a message from before it opened: the folder is still the repo's.
    expect(attribute(msg, attributionContext([b], repos, connections))).toEqual(
      {
        level: 'repo',
        organization: 'https://dev.azure.com/acme',
        project: 'Shop',
        repo: 'web',
      },
    );
    // Older tasks without periods fall back to createdAt until finishedAt (or now).
    const old = task({
      id: 'O',
      worktreePath: '/wt/shared',
      createdAt: '2026-10-04T00:00:00.000Z',
      finishedAt: '2026-10-07T00:00:00.000Z',
    });
    expect(
      attribute(msg, attributionContext([old], repos, connections)),
    ).toMatchObject({ level: 'task', taskId: 'O' });
  });

  it('falls back to the repo by folder, then none', () => {
    const ctx = attributionContext([], repos, connections);
    expect(attribute(rec({ cwd: '/src/api/lib' }), ctx)).toEqual({
      level: 'repo',
      organization: 'https://dev.azure.com/other',
      project: 'Backend',
      repo: 'api',
    });
    // A task worktree of the repo counts too, for a Claude session that is not a task tab.
    const t = task({ id: 't1', worktreePath: '/wt/t1' });
    expect(
      attribute(
        rec({ cwd: '/wt/t1/sub', sessionId: 'elsewhere' }),
        attributionContext([t], repos, connections),
      ),
    ).toMatchObject({ level: 'repo', repo: 'web' });
    expect(attribute(rec({ cwd: '/home/me/play' }), ctx)).toEqual({
      level: 'none',
    });
    expect(attribute(rec({ cwd: null }), ctx)).toEqual({ level: 'none' });
  });
});

const cost = (o: Partial<CostRecord> = {}): CostRecord => ({
  id: 'cc:1',
  tool: 'claude-code',
  provider: 'anthropic',
  vendor: 'claude',
  model: 'claude-sonnet-5-5',
  modelLabel: 'Claude Sonnet 5.5',
  at: '2026-10-12T10:00:00.000Z',
  fast: false,
  inputTokens: 10,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  costUsd: 1,
  costEur: 0.92,
  rateId: 'r',
  billable: true,
  attribution: { level: 'none' },
  developer: null,
  shellieVersion: '1.0.0',
  ...o,
});
const taskLevel = cost({
  attribution: {
    level: 'task',
    taskId: 't1',
    organization: 'o',
    project: 'p',
    workItemId: 1,
    workItemTitle: 't',
    workItemType: 'Bug',
    repo: 'web',
  },
});
const repoLevel = cost({
  attribution: { level: 'repo', organization: 'o', project: 'p', repo: 'web' },
});
const noneLevel = cost();

describe('merge', () => {
  it('never lowers attribution', () => {
    expect(merge(taskLevel, noneLevel).attribution.level).toBe('task');
    expect(merge(taskLevel, repoLevel).attribution.level).toBe('task');
    expect(merge(repoLevel, noneLevel).attribution.level).toBe('repo');
    expect(merge(noneLevel, repoLevel).attribution.level).toBe('repo');
    expect(merge(repoLevel, taskLevel).attribution.level).toBe('task');
    expect(merge(undefined, noneLevel)).toEqual(noneLevel);
    // At task level only billable still changes.
    const m = merge(taskLevel, { ...noneLevel, billable: false });
    expect(m.attribution).toEqual(taskLevel.attribution);
    expect(m.billable).toBe(false);
  });

  it('fills in the organization of a repo once it is linked', () => {
    const unlinked = cost({
      attribution: {
        level: 'repo',
        organization: null,
        project: null,
        repo: 'web',
      },
    });
    expect(merge(unlinked, repoLevel).attribution).toEqual(
      repoLevel.attribution,
    );
    // A linked repo is not overwritten by another same-level attribution.
    expect(merge(repoLevel, unlinked).attribution).toEqual(
      repoLevel.attribution,
    );
  });

  it('keeps the larger copy of a re-written message', () => {
    const big = cost({ outputTokens: 500, costUsd: 5, costEur: 4.6 });
    const small = cost({ outputTokens: 20, costUsd: 2, costEur: 1.84 });
    const m = merge(big, small);
    expect(m.outputTokens).toBe(500);
    expect(m.costEur).toBe(4.6);
    expect(merge(small, big).outputTokens).toBe(500);
  });

  it('takes a fresh price for an unpriced copy with the same tokens', () => {
    const unpriced = cost({
      costUsd: null,
      costEur: null,
      rateId: null,
      modelLabel: 'gpt-x',
    });
    const priced = cost({
      costUsd: 2,
      costEur: 1.84,
      rateId: 'r-new',
      modelLabel: 'GPT X',
    });
    const m = merge(unpriced, priced);
    expect(m).toMatchObject({
      costUsd: 2,
      costEur: 1.84,
      rateId: 'r-new',
      modelLabel: 'GPT X',
    });
    // A priced copy is never replaced by an unpriced one.
    expect(merge(priced, unpriced).costEur).toBe(1.84);
  });
});

describe('brain attribution', () => {
  const c = conn('c1', 'https://dev.azure.com/acme', 'Acme');
  const brains = [
    { id: 'b1', organization: c.organizationUrl, project: 'Acme' },
  ];
  it('attributes a brain record to the brain', () => {
    const ctx = attributionContext([], [], [c], () => [], brains);
    expect(attribute(rec({ taskId: 'brain:b1' }), ctx)).toEqual({
      level: 'brain',
      brainId: 'b1',
      organization: c.organizationUrl,
      project: 'Acme',
    });
  });
  it('an unknown brain id falls back to none', () => {
    const ctx = attributionContext([], [], [c], () => [], brains);
    expect(attribute(rec({ taskId: 'brain:zzz' }), ctx)).toEqual({
      level: 'none',
    });
  });
  it('brain level is frozen like task', () => {
    const b = {
      level: 'brain' as const,
      brainId: 'b1',
      organization: 'o',
      project: 'p',
    };
    expect(raises(b, { level: 'none' })).toBe(false);
    expect(
      raises(b, { level: 'repo', organization: 'o', project: 'p', repo: 'r' }),
    ).toBe(false);
    expect(raises({ level: 'none' }, b)).toBe(true);
    expect(
      raises(
        { level: 'repo', organization: null, project: null, repo: 'r' },
        b,
      ),
    ).toBe(true);
  });
});
