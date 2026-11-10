import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainJob, SettleDecision } from '../../shared/brain';
import { brainJob } from '../../renderer/test-helpers/brainFixture';
import { readConflicts, updateConflicts } from './conflicts';
import { createSettleHooks } from './settleHooks';
import { readState } from './state';

let dir: string;
let jobs: BrainJob[];
let enqueued: unknown[][];
let changed: string[];
let brains: { id: string; archived: boolean }[];
const decision = (over: Partial<SettleDecision> = {}): SettleDecision => ({
  id: 'c1',
  kind: 'contradiction',
  page: 'wiki/a.md',
  question: 'When?',
  detail: 'd',
  claims: null,
  choice: 'b',
  text: null,
  why: 'steerco',
  answer: null,
  ...over,
});
const pendingRecord = (d: SettleDecision) =>
  updateConflicts(dir, (f) => ({
    ...f,
    conflicts: {
      ...f.conflicts,
      [d.id]: {
        settled: {
          at: '2026-11-10T09:00:00.000Z',
          status: 'pending',
          decision: d,
          page: null,
          error: null,
        },
      },
    },
  }));
const hooks = () =>
  createSettleHooks({
    brainDir: () => dir,
    brains: () => brains,
    runner: () => ({
      jobs: () => jobs,
      enqueue: (...a: unknown[]) => {
        enqueued.push(a);
        return brainJob();
      },
    }),
    changed: (id) => changed.push(id),
    now: () => new Date('2026-11-10T10:00:00.000Z'),
  });
const settle = (over: Partial<BrainJob> = {}): BrainJob =>
  brainJob({
    brainId: 'b1',
    kind: 'settle',
    source: null,
    conflict: 'c1',
    status: 'done',
    error: null,
    sessionId: 's-9',
    ...over,
  });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'brain-settle-'));
  await mkdir(path.join(dir, 'brain'));
  await writeFile(path.join(dir, 'brain', 'state.json'), '{"schemaVersion":1}');
  jobs = [];
  enqueued = [];
  changed = [];
  brains = [{ id: 'b1', archived: false }];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('settle hooks', () => {
  it('gives a settle job the pending decision as its argument, and nothing to do without one', async () => {
    await pendingRecord(decision());
    expect(await hooks().promptFor(settle({ status: 'running' }))).toBe(
      `/settle ${JSON.stringify(decision())}`,
    );
    expect(
      await hooks().promptFor(settle({ status: 'running', conflict: 'gone' })),
    ).toBeNull();
    expect(
      await hooks().promptFor(brainJob({ kind: 'capture' })),
    ).toBeUndefined();
  });

  it('marks a done settle with its decision page and records the answer as captured', async () => {
    await pendingRecord(decision({ answer: 'sources/answer.md' }));
    await hooks().afterJob(
      settle({
        result:
          'Changed wiki/a.md\ndecision: wiki/decision-2026-11-10-go-live.md',
      }),
    );
    const rec = (await readConflicts(dir)).conflicts.c1.settled;
    expect(rec).toMatchObject({
      status: 'done',
      page: 'wiki/decision-2026-11-10-go-live.md',
      error: null,
    });
    expect((await readState(dir)).state?.captured['sources/answer.md']).toEqual(
      { at: '2026-11-10T10:00:00.000Z', sessionId: 's-9' },
    );
    expect(changed).toEqual(['b1']);
  });

  it('counts a settle that names no decision page as failed, so the conflict is not hidden for nothing', async () => {
    await pendingRecord(decision());
    await hooks().afterJob(settle({ result: 'I could not find the pages.' }));
    expect((await readConflicts(dir)).conflicts.c1.settled).toMatchObject({
      status: 'failed',
      error: 'The settle wrote no decision page',
    });
  });

  it('marks a failed settle with its error and keeps the decision', async () => {
    await pendingRecord(decision({ answer: 'sources/answer.md' }));
    await hooks().afterJob(
      settle({ status: 'failed', error: 'agent exited 1' }),
    );
    const rec = (await readConflicts(dir)).conflicts.c1.settled;
    expect(rec).toMatchObject({
      status: 'failed',
      error: 'agent exited 1',
      decision: decision({ answer: 'sources/answer.md' }),
    });
    expect((await readState(dir)).state?.captured).toEqual({});
  });

  it('queues each pending settle that has no job at launch, once', async () => {
    await pendingRecord(decision());
    await pendingRecord(decision({ id: 'c2' }));
    jobs = [settle({ conflict: 'c2', status: 'queued' })];
    await hooks().resume();
    expect(enqueued).toEqual([['b1', 'settle', null, { conflict: 'c1' }]]);
  });

  it('runs nothing at launch for an archived brain', async () => {
    await pendingRecord(decision());
    brains = [{ id: 'b1', archived: true }];
    await hooks().resume();
    expect(enqueued).toEqual([]);
  });

  it('ignores other jobs', async () => {
    const spy = vi.fn();
    await hooks().afterJob(brainJob({ kind: 'capture', status: 'done' }));
    expect(spy).not.toHaveBeenCalled();
    expect(changed).toEqual([]);
  });
});
