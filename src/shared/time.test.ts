import { describe, expect, it } from 'vitest';
import { AppSettingsSchema } from './usage';
import { TaskSchema } from './types';
import {
  clip,
  formatDuration,
  mergeIntervals,
  parseDuration,
  periodsOf,
  totalMs,
  unionMs,
  workingMs,
  type WorkHours,
} from './time';

const hours: WorkHours = {
  start: '09:00',
  end: '17:00',
  days: [1, 2, 3, 4, 5],
};
const H = 3600_000;

describe('intervals', () => {
  it('merges, sorts and drops empty ones', () => {
    expect(
      mergeIntervals([
        [5, 10],
        [0, 3],
        [3, 4],
        [9, 12],
        [7, 7],
      ]),
    ).toEqual([
      [0, 4],
      [5, 12],
    ]);
  });
  it('totals and unions', () => {
    expect(
      totalMs([
        [0, 10],
        [20, 25],
      ]),
    ).toBe(15);
    expect(unionMs([[0, 10]], [[5, 15]], [[20, 25]])).toBe(20);
  });
  it('clips', () => {
    expect(clip([[0, 100]], 10, 50)).toEqual([[10, 50]]);
    expect(clip([[0, 5]], 10, 50)).toEqual([]);
  });
});

describe('workingMs', () => {
  it('counts a Monday inside working hours', () => {
    const p: [number, number][] = [
      [new Date(2026, 9, 12, 8).getTime(), new Date(2026, 9, 12, 18).getTime()],
    ];
    expect(workingMs(p, hours)).toBe(8 * H);
  });
  it('skips the weekend', () => {
    const p: [number, number][] = [
      [
        new Date(2026, 9, 16, 16).getTime(),
        new Date(2026, 9, 19, 10).getTime(),
      ],
    ];
    expect(workingMs(p, hours)).toBe(2 * H);
  });
  it('is zero on a Saturday', () => {
    const p: [number, number][] = [
      [new Date(2026, 9, 17, 8).getTime(), new Date(2026, 9, 17, 20).getTime()],
    ];
    expect(workingMs(p, hours)).toBe(0);
  });
});

describe('periodsOf', () => {
  const createdAt = '2026-10-12T08:00:00.000Z';
  const finishedAt = '2026-10-12T10:00:00.000Z';
  it('falls back to createdAt/finishedAt', () => {
    expect(periodsOf({ openPeriods: [], createdAt, finishedAt }, 5)).toEqual([
      [Date.parse(createdAt), Date.parse(finishedAt)],
    ]);
    expect(
      periodsOf({ openPeriods: [], createdAt, finishedAt: null }, 99),
    ).toEqual([[Date.parse(createdAt), 99]]);
  });
  it('ends an open period at now', () => {
    expect(
      periodsOf(
        {
          openPeriods: [{ start: createdAt, end: null }],
          createdAt,
          finishedAt: null,
        },
        123,
      ),
    ).toEqual([[Date.parse(createdAt), 123]]);
  });
});

describe('parseDuration', () => {
  it.each([
    ['3.5', 12600],
    ['3,5', 12600],
    ['3h', 10800],
    ['3h 30m', 12600],
    ['3h30', 12600],
    ['210m', 12600],
    ['45m', 2700],
    ['', null],
    ['abc', null],
    ['-1', null],
  ])('%s', (text, seconds) => {
    expect(parseDuration(text)).toBe(seconds);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0m'],
    [2700, '45m'],
    [10800, '3h'],
    [11400, '3h 10m'],
    [89, '1m'],
  ])('%s', (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });
});

describe('schemas', () => {
  it('defaults the task time fields', () => {
    const t = TaskSchema.parse({
      id: 'a',
      repoId: 'r',
      name: 'n',
      workItem: null,
      slug: 's',
      branch: 'b',
      worktreePath: '/w',
      baseRef: 'main',
      status: 'ready',
      setup: {
        copy: false,
        commands: [],
        startClaude: false,
        openShell: false,
      },
      terminals: [],
      createdAt: '2026-10-12T08:00:00.000Z',
      finishedAt: null,
    });
    expect(t.openPeriods).toEqual([]);
    expect(t.time).toBeNull();
  });
  it('defaults the time settings', () => {
    const s = AppSettingsSchema.parse({
      version: 1,
      receiverPort: 4319,
    });
    expect(s.writeTimeToAdo).toBeUndefined();
    expect(s.idleMinutes).toBe(5);
    expect(s.workHours).toEqual(hours);
  });
  it('rejects work hours that end before they start', () => {
    expect(
      AppSettingsSchema.safeParse({
        version: 1,
        receiverPort: 4319,
        workHours: { start: '17:00', end: '09:00', days: [1] },
      }).success,
    ).toBe(false);
  });
});
