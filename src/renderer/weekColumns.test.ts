import { describe, expect, it } from 'vitest';
import type { WeekRow } from '../shared/time';
import { dayBlocks, scaleHours, SERIES, taskSlots } from './weekColumns';

const row = (
  taskId: string,
  stretches: [day: number, start: number, seconds: number][],
): WeekRow => {
  const perDay = Array.from({ length: 7 }, () => 0);
  const days = Array.from({ length: 7 }, () => [] as WeekRow['stretches'][0]);
  for (const [day, start, seconds] of stretches) {
    perDay[day] += seconds;
    days[day].push({ start, seconds });
  }
  return {
    taskId,
    title: taskId,
    project: null,
    workItem: null,
    perDay,
    stretches: days,
    totalSeconds: perDay.reduce((n, s) => n + s, 0),
  };
};

describe('dayBlocks', () => {
  it("stacks a day's stretches of every task in the order they began", () => {
    const rows = [
      row('a', [
        [0, 900, 3600],
        [0, 1500, 1800],
      ]),
      row('b', [[0, 1200, 600]]),
    ];
    expect(dayBlocks(rows)[0]).toEqual([
      { taskId: 'a', seconds: 3600 },
      { taskId: 'b', seconds: 600 },
      { taskId: 'a', seconds: 1800 },
    ]);
  });

  it('joins stretches of one task that follow each other into one block', () => {
    const rows = [
      row('a', [
        [2, 900, 3600],
        [2, 1300, 1800],
      ]),
      row('b', [[2, 1500, 600]]),
    ];
    expect(dayBlocks(rows)[2]).toEqual([
      { taskId: 'a', seconds: 5400 },
      { taskId: 'b', seconds: 600 },
    ]);
  });

  it('gives seven days, empty ones included', () => {
    const blocks = dayBlocks([row('a', [[6, 1, 60]])]);
    expect(blocks).toHaveLength(7);
    expect(blocks[0]).toEqual([]);
    expect(blocks[6]).toEqual([{ taskId: 'a', seconds: 60 }]);
  });
});

describe('taskSlots', () => {
  it('numbers the tasks by when they were first worked on in the week, whatever their order or total', () => {
    const rows = [
      row('big', [[3, 5000, 90_000]]),
      row('early', [[0, 100, 60]]),
      row('mid', [
        [1, 3000, 60],
        [4, 9000, 60],
      ]),
    ];
    expect([...taskSlots(rows)]).toEqual([
      ['early', 0],
      ['mid', 1],
      ['big', 2],
    ]);
  });

  it('keeps the colours for the first tasks and leaves the rest without one', () => {
    const rows = Array.from({ length: SERIES + 2 }, (_, i) =>
      row(`t${i}`, [[0, i, 60]]),
    );
    const slots = taskSlots(rows);
    expect(slots.get(`t${SERIES - 1}`)).toBe(SERIES - 1);
    expect(slots.get(`t${SERIES}`)).toBeNull();
    expect(slots.get(`t${SERIES + 1}`)).toBeNull();
  });
});

describe('scaleHours', () => {
  it('is ten hours for an ordinary week', () => {
    expect(scaleHours([0, 0, 0, 0, 0, 0, 0])).toBe(10);
    expect(scaleHours([7.5 * 3600, 10 * 3600, 0, 0, 0, 0, 0])).toBe(10);
  });

  it('grows by whole hours to fit the longest day', () => {
    expect(scaleHours([14 * 3600, 3600, 0, 0, 0, 0, 0])).toBe(14);
    expect(scaleHours([10 * 3600 + 60, 0, 0, 0, 0, 0, 0])).toBe(11);
  });
});
