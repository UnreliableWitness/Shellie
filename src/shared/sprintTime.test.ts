import { describe, expect, it } from 'vitest';
import { progress, sprintTime } from './sprintTime';
import type { LocalItemTime } from './time';
import type { SprintItem, SprintRow } from './types';

const item = (id: string, over: Partial<SprintItem> = {}): SprintItem => ({
  id,
  type: 'Task',
  title: id,
  state: 'To Do',
  areaPath: 'Shellie',
  iterationPath: 'Shellie\\Sprint 1',
  assignedTo: null,
  url: '',
  project: null,
  remainingWork: null,
  originalEstimate: null,
  completedWork: null,
  ...over,
});
const row = (
  i: SprintItem,
  depth = 0,
  parentId: string | null = null,
  hasChildren = false,
): SprintRow => ({ item: i, depth, parentId, hasChildren });
const local = (over: Partial<LocalItemTime> = {}): LocalItemTime => ({
  spentSeconds: 0,
  measuredSeconds: 0,
  agentSeconds: 0,
  booked: false,
  baselineHours: null,
  ...over,
});

describe('sprintTime', () => {
  it('uses local time against the original estimate', () => {
    const m = sprintTime([row(item('1', { originalEstimate: 5 }))], {
      '1': local({ spentSeconds: 11400 }),
    });
    expect(m.get('1')).toMatchObject({
      spentSeconds: 11400,
      estimateHours: 5,
      source: 'local',
    });
  });

  it('falls back to ADO completed work and remaining + completed', () => {
    const m = sprintTime(
      [row(item('1', { completedWork: 2, remainingWork: 3 }))],
      {},
    );
    expect(m.get('1')).toMatchObject({
      spentSeconds: 7200,
      estimateHours: 5,
      source: 'ado',
    });
  });

  it('uses the recorded baseline before remaining + completed', () => {
    const m = sprintTime([row(item('1', { remainingWork: 9 }))], {
      '1': local({ spentSeconds: 60, baselineHours: 4 }),
    });
    expect(m.get('1')?.estimateHours).toBe(4);
  });

  it('gives nothing for an item without any figures', () => {
    expect(sprintTime([row(item('1'))], {}).get('1')).toMatchObject({
      spentSeconds: null,
      estimateHours: null,
      source: null,
      rolledUp: false,
    });
  });

  it('treats a local task with no time yet as missing: ADO Completed Work, else nothing', () => {
    const m = sprintTime(
      [
        row(item('1', { completedWork: 2, remainingWork: 3 })),
        row(item('2', { remainingWork: 3 })),
      ],
      {
        '1': local({ baselineHours: 4 }),
        '2': local({ baselineHours: 6 }),
      },
    );
    expect(m.get('1')).toMatchObject({
      spentSeconds: 7200,
      estimateHours: 4,
      source: 'ado',
    });
    expect(m.get('2')).toMatchObject({
      spentSeconds: null,
      estimateHours: 6,
      source: null,
    });
  });

  it('keeps a booked zero as local time', () => {
    const m = sprintTime([row(item('1', { completedWork: 2 }))], {
      '1': local({ booked: true }),
    });
    expect(m.get('1')).toMatchObject({ spentSeconds: 0, source: 'local' });
  });

  it('never adds local and ADO for one item', () => {
    const m = sprintTime([row(item('1', { completedWork: 9 }))], {
      '1': local({ spentSeconds: 3600 }),
    });
    expect(m.get('1')?.spentSeconds).toBe(3600);
  });

  it('rolls descendants up into a parent', () => {
    const rows = [
      row(item('p'), 0, null, true),
      row(item('a', { remainingWork: 1 }), 1, 'p'),
      row(item('b', { completedWork: 2 }), 1, 'p'),
    ];
    const m = sprintTime(rows, { a: local({ spentSeconds: 3600 }) });
    expect(m.get('p')).toMatchObject({
      spentSeconds: 10800,
      estimateHours: 3,
      rolledUp: true,
    });
    expect(m.get('a')?.rolledUp).toBe(false);
  });

  it('rolls up through several levels', () => {
    const rows = [
      row(item('g'), 0, null, true),
      row(item('p'), 1, 'g', true),
      row(item('c', { completedWork: 1 }), 2, 'p'),
    ];
    const m = sprintTime(rows, {});
    expect(m.get('g')?.spentSeconds).toBe(3600);
    expect(m.get('p')?.spentSeconds).toBe(3600);
  });
});

describe('progress', () => {
  it('is the spent share of the estimate, over once past it', () => {
    expect(progress(1800, 1)).toEqual({ pct: 50, over: false });
    expect(progress(3600, 1)).toEqual({ pct: 100, over: false });
    expect(progress(5400, 1)).toEqual({ pct: 150, over: true });
  });

  it('has no share without a spent figure or a positive estimate', () => {
    expect(progress(null, 1)).toEqual({ pct: null, over: false });
    expect(progress(1800, null)).toEqual({ pct: null, over: false });
    expect(progress(1800, 0)).toEqual({ pct: null, over: false });
  });
});
