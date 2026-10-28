import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BudgetRecord } from '../../shared/budget';
import type { Connection, Repo, Task } from '../../shared/types';
import type { UsageRecord } from '../../shared/usage';
import { attributionContext } from './attribute';
import { LedgerService } from './LedgerService';
import { LedgerStore } from './LedgerStore';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-svc-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const rec = (o: Partial<BudgetRecord> = {}): BudgetRecord => ({
  id: 'cc:m1',
  tool: 'claude-code',
  sessionId: 'S1',
  model: 'claude-sonnet-5-5',
  provider: 'anthropic',
  at: '2026-10-12T10:00:00.000Z',
  cwd: '/home/me/play',
  fast: false,
  inputTokens: 1000,
  outputTokens: 2000,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  ...o,
});
const usageRec = (o: Partial<UsageRecord>): UsageRecord => ({
  id: 'u',
  taskId: 't1',
  tool: 'copilot-cli',
  sessionId: 'CP',
  model: 'gpt-5-mini',
  at: '2026-10-12T11:00:00.000Z',
  inputTokens: 100,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  fast: false,
  costUsd: null,
  rateId: null,
  rate: null,
  ...o,
});

const repos = [
  { id: 'r1', name: 'web', path: '/src/web', connectionId: 'c1' },
] as Repo[];
const connections = [
  { id: 'c1', organizationUrl: 'https://dev.azure.com/acme', project: 'Shop' },
] as Connection[];
const task1 = {
  id: 't1',
  repoId: 'r1',
  workItem: { id: '42', type: 'Bug', title: 'Fix', url: null },
  worktreePath: '/wt/t1',
  terminals: [{ id: 'a', kind: 'claude', label: 'C', sessionId: 'S1' }],
  closedTerminals: [],
  extraWorkspaces: [],
  connectionId: null,
  openPeriods: [{ start: '2026-10-01T00:00:00.000Z', end: null }],
  createdAt: '2026-10-01T00:00:00.000Z',
  finishedAt: null,
} as unknown as Task;

function setup(
  o: {
    claude?: BudgetRecord[][];
    openCode?: BudgetRecord[][];
    usage?: UsageRecord[];
    now?: () => Date;
  } = {},
) {
  const state = {
    tasks: [] as Task[],
    repos: [...repos],
    notBillable: new Set<string>(),
    /** Claude sessions per task from the usage store (OTLP). */
    usageSessions: {} as Record<string, string[]>,
    developer: null as string | null,
  };
  const claudeQueue = [...(o.claude ?? [])];
  const ocQueue = [...(o.openCode ?? [])];
  const claudeRead = vi.fn(async (cursors: Record<string, unknown>) => ({
    records: claudeQueue.shift() ?? [],
    cursors: {
      ...cursors,
      '/t.jsonl': { offset: 1, size: 1, mtimeMs: 1, ino: 1 },
    },
    found: true,
  }));
  const openCodeRead = vi.fn((cursor: number) => ({
    records: ocQueue.shift() ?? [],
    cursor: cursor + 1,
    found: true,
  }));
  const toUsage = vi.fn();
  const changed = vi.fn();
  const telemetry = vi.fn();
  const store = new LedgerStore(dir);
  const svc = new LedgerService({
    store,
    claude: { read: claudeRead },
    openCode: { read: openCodeRead },
    usageRecords: () => o.usage ?? [],
    context: () =>
      attributionContext(
        state.tasks,
        state.repos,
        connections,
        (id) => state.usageSessions[id] ?? [],
      ),
    isBillable: (taskId, sessionId) =>
      !state.notBillable.has(`${taskId}/${sessionId}`),
    developer: () => state.developer,
    version: '9.9.0',
    toUsage,
    changed,
    telemetry,
    now: o.now,
  });
  const upsert = vi.spyOn(store, 'upsert');
  return {
    svc,
    store,
    state,
    claudeRead,
    openCodeRead,
    toUsage,
    changed,
    telemetry,
    upsert,
  };
}

describe('LedgerService', () => {
  it('backfills everything the readers have on the first pass', async () => {
    const s = setup({
      claude: [[rec()]],
      openCode: [
        [
          rec({
            id: 'oc:o1',
            tool: 'opencode',
            provider: 'github-copilot',
            model: 'gpt-5-mini',
            sessionId: 'O1',
          }),
        ],
      ],
    });
    await s.svc.pass();
    expect(s.claudeRead).toHaveBeenCalledWith({});
    expect(s.openCodeRead).toHaveBeenCalledWith(0, { limit: 1000 });
    const cc = s.store.get('cc:m1')!;
    expect(cc).toMatchObject({
      vendor: 'claude',
      modelLabel: 'Claude Sonnet 5.5',
      billable: true,
      shellieVersion: '9.9.0',
      attribution: { level: 'none' },
    });
    expect(cc.costEur).toBeGreaterThan(0);
    expect(cc).not.toHaveProperty('cwd');
    expect(cc).not.toHaveProperty('sessionId');
    expect(s.store.get('oc:o1')).toMatchObject({
      vendor: 'copilot',
      modelLabel: 'GPT-5 mini',
    });
    expect(s.changed).toHaveBeenCalledTimes(1);
    // Cursors are kept next to the ledger: a new service carries on from them.
    const again = setup();
    await again.svc.pass();
    expect(again.claudeRead).toHaveBeenCalledWith({
      '/t.jsonl': { offset: 1, size: 1, mtimeMs: 1, ino: 1 },
    });
    expect(again.openCodeRead).toHaveBeenCalledWith(1, { limit: 1000 });
    expect(again.store.get('cc:m1')).toEqual(cc);
  });

  it('re-attributes when a task starts later', async () => {
    const s = setup({ claude: [[rec()]] });
    await s.svc.pass();
    expect(s.store.get('cc:m1')!.attribution.level).toBe('none');
    await s.store.markSent(s.store.all());
    expect(s.store.dirty(10)).toEqual([]);
    s.state.tasks = [task1];
    await s.svc.pass();
    expect(s.store.get('cc:m1')!.attribution).toMatchObject({
      level: 'task',
      taskId: 't1',
      workItemId: 42,
    });
    expect(s.store.dirty(10).map((r) => r.id)).toEqual(['cc:m1']);
  });

  it('moves a stored record up once the usage store ties its session to a task', async () => {
    const s = setup({
      claude: [[rec({ sessionId: 'TYPED', cwd: '/wt/t1' })]],
    });
    s.state.tasks = [{ ...task1, terminals: [] }];
    await s.svc.pass();
    expect(s.store.get('cc:m1')!.attribution.level).toBe('repo');
    s.state.usageSessions = { t1: ['TYPED'] };
    await s.svc.pass();
    expect(s.store.get('cc:m1')!.attribution).toMatchObject({
      level: 'task',
      taskId: 't1',
      workItemId: 42,
    });
  });

  it('re-attributes after a restart from the inputs it kept', async () => {
    const s = setup({ claude: [[rec()]] });
    await s.svc.pass();
    expect(s.store.get('cc:m1')!.attribution.level).toBe('none');
    const later = setup();
    later.state.tasks = [task1];
    await later.svc.pass();
    expect(later.store.get('cc:m1')!.attribution.level).toBe('task');
  });

  it('does not change records when a repo or task is removed', async () => {
    const s = setup({
      claude: [
        [rec(), rec({ id: 'cc:m2', sessionId: 'X', cwd: '/src/web/a' })],
      ],
    });
    s.state.tasks = [task1];
    await s.svc.pass();
    expect(s.store.get('cc:m1')!.attribution.level).toBe('task');
    expect(s.store.get('cc:m2')!.attribution.level).toBe('repo');
    s.state.tasks = [];
    s.state.repos = [];
    await s.svc.pass();
    const last = await s.upsert.mock.results.at(-1)?.value;
    expect(last ?? []).toEqual([]);
    expect(s.store.get('cc:m1')!.attribution.level).toBe('task');
    expect(s.store.get('cc:m2')!.attribution.level).toBe('repo');
  });

  it('applies billable without touching attribution', async () => {
    const s = setup({ claude: [[rec()]] });
    s.state.tasks = [task1];
    await s.svc.pass();
    const before = s.store.get('cc:m1')!;
    expect(before.billable).toBe(true);
    s.state.notBillable.add('t1/S1');
    await s.svc.pass();
    const after = s.store.get('cc:m1')!;
    expect(after.billable).toBe(false);
    expect(after.attribution).toEqual(before.attribution);
    // Removing the task does not move it, and billable stays as last known.
    s.state.tasks = [];
    await s.svc.pass();
    expect(s.store.get('cc:m1')).toEqual(after);
  });

  it('sends OpenCode task usage to the Usage tab once', async () => {
    const oc = rec({
      id: 'oc:o1',
      tool: 'opencode',
      sessionId: 'O1',
      cwd: '/wt/t1',
      cacheWrite5mTokens: 5,
    });
    const s = setup({ openCode: [[oc], [oc]] });
    s.state.tasks = [task1];
    await s.svc.pass();
    await s.svc.pass();
    expect(s.toUsage).toHaveBeenCalledTimes(1);
    expect(s.toUsage).toHaveBeenCalledWith({
      id: 'oc:o1',
      taskId: 't1',
      tool: 'opencode',
      sessionId: 'O1',
      model: 'claude-sonnet-5-5',
      at: '2026-10-12T10:00:00.000Z',
      inputTokens: 1000,
      outputTokens: 2000,
      cacheReadTokens: 0,
      cacheWriteTokens: 5,
      fast: false,
    });
  });

  it("sends an OpenCode child session's parent and agent to the Usage tab", async () => {
    const oc = rec({
      id: 'oc:o2',
      tool: 'opencode',
      sessionId: 'O2',
      cwd: '/wt/t1',
      parentSessionId: 'O1',
      agentLabel: 'explore',
    });
    const s = setup({ openCode: [[oc]] });
    s.state.tasks = [task1];
    await s.svc.pass();
    expect(s.toUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'O2',
        parentSessionId: 'O1',
        agent: 'explore',
      }),
    );
  });

  it('includes Copilot CLI and PR summary records', async () => {
    const s = setup({
      usage: [
        usageRec({ id: 'trace:span' }),
        usageRec({
          id: 'req1',
          tool: 'claude-code',
          source: 'pr-summary',
          model: 'claude-sonnet-5-5',
          sessionId: 'PR',
        }),
        // Claude tab usage from OTLP is not a ledger source (the transcripts are).
        usageRec({ id: 'otlp', tool: 'claude-code', sessionId: 'S1' }),
      ],
    });
    s.state.tasks = [task1];
    await s.svc.pass();
    expect(s.store.get('cp:trace:span')).toMatchObject({
      vendor: 'copilot',
      attribution: { level: 'task', taskId: 't1' },
    });
    expect(s.store.get('sh:req1')).toMatchObject({
      vendor: 'claude',
      attribution: { level: 'task', taskId: 't1' },
    });
    expect(
      s.store
        .all()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['cp:trace:span', 'sh:req1']);
  });

  it('prices a stored unpriced Copilot record once its model has a rate', async () => {
    const s = setup({ usage: [usageRec({ id: 'trace:span' })] });
    s.state.tasks = [task1];
    await s.svc.pass();
    const priced = s.store.get('cp:trace:span')!;
    expect(priced.costEur).not.toBeNull();
    // As stored by a Shellie that had no rate for the model yet.
    await s.store.upsert([
      { ...priced, costUsd: null, costEur: null, rateId: null },
    ]);
    await s.svc.pass();
    expect(s.store.get('cp:trace:span')).toMatchObject({
      costEur: priced.costEur,
      rateId: priced.rateId,
    });
  });

  it('keeps a task not billable when it has no connection (stored at repo level)', async () => {
    const s = setup({
      claude: [
        [
          rec({ sessionId: 'S1', cwd: '/wt/t1' }),
          rec({ id: 'cc:m2', sessionId: 'OTHER', cwd: '/src/web' }),
        ],
      ],
    });
    s.state.repos = [{ ...repos[0], connectionId: null }];
    s.state.tasks = [task1];
    s.state.notBillable.add('t1/S1');
    await s.svc.pass();
    expect(s.store.get('cc:m1')).toMatchObject({
      attribution: { level: 'repo', repo: 'web' },
      billable: false,
    });
    // No task involved: billable.
    expect(s.store.get('cc:m2')!.billable).toBe(true);
    // The stored record follows the task's switch on later passes.
    s.state.notBillable.clear();
    await s.svc.pass();
    expect(s.store.get('cc:m1')!.billable).toBe(true);
  });

  it('stamps the saved email on every record, also a changed one, and keeps it after a disconnect', async () => {
    const s = setup({ claude: [[rec()]] });
    await s.svc.pass();
    expect(s.store.get('cc:m1')!.developer).toBeNull();
    s.state.developer = 'dev@example.com';
    await s.svc.pass();
    expect(s.store.get('cc:m1')!.developer).toBe('dev@example.com');
    s.state.developer = 'new@example.com';
    await s.svc.pass();
    expect(s.store.get('cc:m1')!.developer).toBe('new@example.com');
    s.state.developer = null;
    await s.svc.pass();
    expect(s.store.get('cc:m1')!.developer).toBe('new@example.com');
  });

  it('freshPass runs a pass that starts after the call', async () => {
    const s = setup({ claude: [[rec()]] });
    const running = s.svc.pass();
    s.state.developer = 'dev@example.com';
    await s.svc.freshPass();
    await running;
    expect(s.store.get('cc:m1')!.developer).toBe('dev@example.com');
  });

  it('keeps a record not billable when its task is gone and it is read again', async () => {
    const s = setup({ usage: [usageRec({ id: 'trace:span' })] });
    s.state.tasks = [task1];
    s.state.notBillable.add('t1/CP');
    await s.svc.pass();
    expect(s.store.get('cp:trace:span')!.billable).toBe(false);
    s.state.tasks = [];
    await s.svc.pass();
    await s.svc.pass();
    expect(s.store.get('cp:trace:span')).toMatchObject({
      billable: false,
      attribution: { level: 'task', taskId: 't1' },
    });
  });

  it('fills in the organization once the repo gets a connection', async () => {
    const s = setup({ claude: [[rec({ cwd: '/src/web/x', sessionId: 'X' })]] });
    s.state.repos = [{ ...repos[0], connectionId: null }];
    await s.svc.pass();
    expect(s.store.get('cc:m1')!.attribution).toEqual({
      level: 'repo',
      organization: null,
      project: null,
      repo: 'web',
    });
    s.state.repos = [...repos];
    await s.svc.pass();
    expect(s.store.get('cc:m1')!.attribution).toEqual({
      level: 'repo',
      organization: 'https://dev.azure.com/acme',
      project: 'Shop',
      repo: 'web',
    });
  });

  it('reads a large OpenCode backfill in chunks, yielding between them', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) =>
      rec({
        id: `oc:${String(i).padStart(5, '0')}`,
        tool: 'opencode',
        sessionId: 'O',
        at: new Date(
          Date.parse('2026-10-12T00:00:00Z') + i * 1000,
        ).toISOString(),
      }),
    );
    const log: string[] = [];
    const sizes: number[] = [];
    const s = setup();
    const read = vi.fn(
      (
        cursor: number,
        page?: { limit: number; after?: { t: number; id: string } },
      ) => {
        log.push('read');
        setImmediate(() => log.push('yield'));
        const limit = page?.limit ?? Infinity;
        const from = page?.after
          ? rows.findIndex((r) => r.id === page.after!.id) + 1
          : 0;
        const chunk = rows.slice(from, from + limit);
        sizes.push(chunk.length);
        const last = chunk.at(-1);
        return {
          records: chunk,
          cursor: last ? Date.parse(last.at) : cursor,
          found: true,
          more: from + chunk.length < rows.length,
          last: last ? { t: Date.parse(last.at), id: last.id } : undefined,
        };
      },
    );
    (
      s.svc as unknown as { d: { openCode: { read: typeof read } } }
    ).d.openCode = { read };
    await s.svc.pass();
    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
    expect(read.mock.calls.every(([, p]) => p?.limit === 1000)).toBe(true);
    // Each chunk after the first starts only after the event loop got a turn.
    const reads = log.flatMap((x, i) => (x === 'read' ? [i] : []));
    for (let k = 1; k < reads.length; k++)
      expect(log.slice(reads[k - 1], reads[k])).toContain('yield');
    expect(s.store.all()).toHaveLength(2500);
  });

  it('reports record counts once a day, no amounts', async () => {
    let day = new Date(2026, 9, 12, 10);
    const s = setup({
      claude: [
        [rec(), rec({ id: 'cc:m2' })],
        [rec({ id: 'cc:m3' })],
        [rec({ id: 'cc:m4' })],
      ],
      openCode: [
        [rec({ id: 'oc:o1', tool: 'opencode', provider: 'github-copilot' })],
      ],
      now: () => day,
    });
    await s.svc.pass();
    await s.svc.pass();
    expect(s.telemetry).toHaveBeenCalledTimes(1);
    const [name, props] = s.telemetry.mock.calls[0]!;
    expect(name).toBe('ledger.records');
    expect(Object.keys(props).sort()).toEqual(
      ['claudeCode', 'copilotCli', 'none', 'opencode', 'repo', 'task'].sort(),
    );
    expect(props).toMatchObject({ claudeCode: 2, opencode: 1, copilotCli: 0 });
    expect(Object.values(props).every((v) => typeof v === 'number')).toBe(true);
    day = new Date(2026, 9, 13, 9);
    await s.svc.pass();
    expect(s.telemetry).toHaveBeenCalledTimes(2);
  });
});
