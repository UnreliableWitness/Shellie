import { describe, expect, it } from 'vitest';
import { secondsPerDay, stretchesPerDay, weekBounds } from './weekTime';

// Local times, so the day split holds in any time zone the tests run in.
const at = (d: number, h: number, m = 0) =>
  new Date(2026, 10, d, h, m).getTime();
const H = 3_600_000;
const NOW = new Date(2026, 10, 30).getTime();

describe('weekBounds', () => {
  it('gives the 8 local midnights of the week from its Monday', () => {
    const b = weekBounds('2026-11-16');
    expect(b).toHaveLength(8);
    expect(b[0]).toBe(new Date(2026, 10, 16).getTime());
    expect(b[7]).toBe(new Date(2026, 10, 23).getTime());
  });

  it('rejects a date that is not YYYY-MM-DD', () => {
    expect(() => weekBounds('16/11/2026')).toThrow();
  });
});

describe('secondsPerDay', () => {
  const bounds = weekBounds('2026-11-16');
  const task = {
    openPeriods: [],
    createdAt: new Date(at(10, 9)).toISOString(),
    finishedAt: null,
  };

  it('splits time over local midnight into its two days', () => {
    const r = secondsPerDay(task, [[at(17, 23), at(18, 1)]], [], bounds, NOW);
    expect(r).toEqual([0, 3600, 3600, 0, 0, 0, 0]);
  });

  it('leaves out time before Monday and after Sunday', () => {
    const r = secondsPerDay(
      task,
      [
        [at(15, 23), at(16, 1)],
        [at(22, 23), at(23, 2)],
      ],
      [],
      bounds,
      NOW,
    );
    expect(r).toEqual([3600, 0, 0, 0, 0, 0, 3600]);
  });

  it('counts agent time that overlaps active time once', () => {
    const r = secondsPerDay(
      task,
      [[at(19, 9), at(19, 11)]],
      [[[at(19, 10), at(19, 12)]], [[at(19, 10, 30), at(19, 11, 30)]]],
      bounds,
      NOW,
    );
    expect(r[3]).toBe(3 * 3600);
  });

  it('drops active time outside the task open periods', () => {
    const finished = {
      openPeriods: [
        {
          start: new Date(at(16, 8)).toISOString(),
          end: new Date(at(16, 10)).toISOString(),
        },
      ],
      createdAt: new Date(at(16, 8)).toISOString(),
      finishedAt: new Date(at(16, 10)).toISOString(),
    };
    const r = secondsPerDay(
      finished,
      [[at(16, 9), at(16, 12)]],
      [],
      bounds,
      NOW,
    );
    expect(r[0]).toBe(H / 1000);
  });
});

describe('stretchesPerDay', () => {
  const bounds = weekBounds('2026-11-16');
  const task = {
    openPeriods: [],
    createdAt: new Date(at(10, 9)).toISOString(),
    finishedAt: null,
  };
  const of = (active: [number, number][], agent: [number, number][][] = []) =>
    stretchesPerDay(task, active, agent, bounds, NOW);

  it('gives each day its stretches in order, with when they began and how long the work in them took', () => {
    const r = of([
      [at(16, 9), at(16, 12)],
      [at(16, 14), at(16, 15, 30)],
      [at(18, 10), at(18, 11)],
    ]);
    expect(r[0]).toEqual([
      { start: at(16, 9), seconds: 3 * 3600 },
      { start: at(16, 14), seconds: 5400 },
    ]);
    expect(r[1]).toEqual([]);
    expect(r[2]).toEqual([{ start: at(18, 10), seconds: 3600 }]);
  });

  it('joins work that resumes within half an hour into one stretch, counting only the time worked', () => {
    const r = of([
      [at(16, 9), at(16, 10)],
      [at(16, 10, 20), at(16, 11)],
      [at(16, 11, 31), at(16, 12)],
    ]);
    expect(r[0]).toEqual([
      { start: at(16, 9), seconds: 3600 + 40 * 60 },
      { start: at(16, 11, 31), seconds: 29 * 60 },
    ]);
  });

  it('adds up to the seconds per day, agent time and the split over midnight included', () => {
    const active: [number, number][] = [[at(17, 23), at(18, 1)]];
    const agent: [number, number][][] = [[[at(17, 23, 30), at(18, 2)]]];
    const r = of(active, agent);
    const perDay = secondsPerDay(task, active, agent, bounds, NOW);
    expect(r.map((day) => day.reduce((n, s) => n + s.seconds, 0))).toEqual(
      perDay,
    );
    expect(r[2][0].start).toBe(bounds[2]);
  });
});
