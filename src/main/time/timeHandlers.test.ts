import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TimeBooking } from '../../shared/time';
import type { Task } from '../../shared/types';
import { defaultSettings } from '../../shared/usage';
import { TimeStore } from './TimeStore';
import { createTimeHandlers } from './timeHandlers';

const NOW = Date.parse('2026-10-16T12:00:00Z');

const task = (over: Partial<Task> & Pick<Task, 'id'>): Task => ({
  repoId: 'r1',
  name: '',
  workItem: {
    id: '12',
    type: 'Task',
    title: 'Twelve',
    url: null,
    project: null,
  },
  slug: over.id,
  branch: `b-${over.id}`,
  worktreePath: `/wt/${over.id}`,
  baseRef: 'main',
  baseSha: null,
  status: 'ready',
  setup: {
    copy: false,
    commands: [],
    startClaude: false,
    openShell: false,
    openCopilot: false,
    summary: null,
  },
  terminals: [],
  createdAt: new Date(NOW - 3_600_000).toISOString(),
  finishedAt: null,
  usageSyncedAt: null,
  usageSyncError: null,
  usageCommentId: null,
  summary: null,
  pullRequest: null,
  closedTerminals: [],
  reopen: null,
  extraWorkspaces: [],
  detachedPaths: [],
  homeDropped: false,
  connectionId: null,
  mainCheckoutEdits: [],
  environment: 'development',
  environmentUntil: null,
  pendingCleanup: [],
  openPeriods: [],
  time: null,
  ...over,
});

const booking = (bookedSeconds: number): TimeBooking => ({
  bookedSeconds,
  measuredSeconds: bookedSeconds,
  realisticSeconds: bookedSeconds,
  wallClockSeconds: bookedSeconds,
  agentSeconds: { 'claude-code': 0, 'copilot-cli': 0, opencode: 0 },
  bookedAt: new Date(NOW).toISOString(),
  writtenHours: 0,
  syncError: null,
});

async function setup(tasks: Task[]) {
  const time = new TimeStore(
    path.join(mkdtempSync(path.join(tmpdir(), 'time-h-')), 'time.json'),
  );
  await time.load();
  const focused: (string | null)[] = [];
  const repoConnection: Record<string, string | null> = {
    r1: 'c1',
    r2: 'c2',
  };
  const h = createTimeHandlers({
    time,
    tasks: () => tasks,
    task: (id) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) throw new Error(`Task ${id} not found`);
      return t;
    },
    settings: defaultSettings,
    connectionOf: (t) => repoConnection[t.repoId] ?? null,
    tracker: { setTask: (id) => focused.push(id) },
    now: () => NOW,
  });
  return { h, time, focused };
}

describe('time handlers', () => {
  it('time:focus passes the task on screen to the tracker', async () => {
    const { h, focused } = await setup([task({ id: 't1' })]);
    await h['time:focus']('t1');
    await h['time:focus'](null);
    expect(focused).toEqual(['t1', null]);
  });

  it('time:focus never counts a finished or unknown task', async () => {
    const done = task({ id: 'd1', status: 'done' });
    const open = task({ id: 'o1', status: 'ready' });
    const { h, focused } = await setup([done, open]);
    await h['time:focus']('d1');
    await h['time:focus']('o1');
    await h['time:focus']('gone');
    expect(focused).toEqual([null, 'o1', null]);
  });

  it('time:task sums active, agent and realistic time from the store', async () => {
    const t = task({ id: 't1' });
    const { h, time } = await setup([t]);
    await time.addActive('t1', [NOW - 600_000, NOW - 300_000]);
    await time.addAgent('t1', 'copilot-cli', [NOW - 400_000, NOW - 100_000]);
    const r = await h['time:task']('t1');
    expect(r.taskId).toBe('t1');
    expect(r.activeSeconds).toBe(300);
    expect(r.agentSeconds).toEqual({
      'claude-code': 0,
      'copilot-cli': 300,
      opencode: 0,
    });
    expect(r.realisticSeconds).toBe(500);
    expect(r.booking).toBeNull();
    expect(r.estimate).toBeNull();
  });

  it('time:task gives the recorded baseline as the estimate, also for a done task', async () => {
    const t = task({
      id: 't1',
      status: 'done',
      finishedAt: new Date(NOW).toISOString(),
      time: booking(1800),
    });
    const { h, time } = await setup([t]);
    await time.recordBaseline('c1:12', 6);
    const r = await h['time:task']('t1');
    expect(r.estimate).toEqual({ hours: 6, source: 'baseline' });
    expect(r.booking?.bookedSeconds).toBe(1800);
  });

  it('time:exportCsv gives one row for the task', async () => {
    const t = task({ id: 't1' });
    const { h, time } = await setup([t]);
    await time.addActive('t1', [NOW - 600_000, NOW - 300_000]);
    const csv = await h['time:exportCsv']('t1');
    expect(csv.split('\r\n')[1]).toMatch(/^b-t1,12,,300,300,\d+,0,0,0$/);
  });

  it('time:sprint sums the tasks of a work item on the connection', async () => {
    const done = task({
      id: 'done',
      status: 'done',
      finishedAt: new Date(NOW - 1_800_000).toISOString(),
      time: booking(3600),
    });
    const open = task({ id: 'open' });
    const other = task({ id: 'other', repoId: 'r2' });
    const unlinked = task({ id: 'nowi', workItem: null });
    const { h, time } = await setup([done, open, other, unlinked]);
    await time.addActive('done', [NOW - 3_600_000, NOW - 1_800_000]);
    await time.addActive('open', [NOW - 600_000, NOW]);
    await time.addAgent('open', 'claude-code', [NOW - 120_000, NOW]);
    await time.addActive('other', [NOW - 900_000, NOW]);
    await time.recordBaseline('c1:12', 4);
    const r = await h['time:sprint']('c1');
    expect(Object.keys(r)).toEqual(['12']);
    expect(r['12']).toEqual({
      spentSeconds: 4200,
      measuredSeconds: 2400,
      agentSeconds: 120,
      booked: true,
      baselineHours: 4,
    });
    expect((await h['time:sprint']('c2'))['12'].spentSeconds).toBe(900);
  });

  it('time:sprint counts a reopened task as its booking plus the time since the reopen', async () => {
    const reopened = task({
      id: 'r',
      time: booking(3600),
      openPeriods: [
        {
          start: new Date(NOW - 7_200_000).toISOString(),
          end: new Date(NOW - 3_600_000).toISOString(),
        },
        { start: new Date(NOW - 600_000).toISOString(), end: null },
      ],
    });
    const { h, time } = await setup([reopened]);
    await time.addActive('r', [NOW - 7_000_000, NOW - 4_000_000]);
    await time.addActive('r', [NOW - 300_000, NOW]);
    const r = await h['time:sprint']('c1');
    expect(r['12'].spentSeconds).toBe(3900);
    expect(r['12'].booked).toBe(true);
  });
});
