import { describe, expect, it } from 'vitest';
import type { WeekRow } from '../shared/time';
import {
  dayBlocks,
  hourHeight,
  MIN_HOUR_PX,
  MIN_SLOT_PX,
  scaleHours,
  SERIES,
  slotHeights,
  taskSlots,
} from './weekColumns';

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

  it("makes one block per task of all its day's stretches, where it was first worked on", () => {
    const rows = [
      row('a', [
        [0, 900, 3600],
        [0, 1500, 1800],
      ]),
      row('b', [[0, 1200, 600]]),
    ];
    expect(dayBlocks(rows, true)[0]).toEqual([
      { taskId: 'a', seconds: 5400 },
      { taskId: 'b', seconds: 600 },
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
  it("ends at the week's longest day, in whole hours", () => {
    expect(scaleHours([4.5 * 3600, 3600, 0, 0, 0, 0, 0])).toBe(5);
    expect(scaleHours([14 * 3600, 3600, 0, 0, 0, 0, 0])).toBe(14);
    expect(scaleHours([10 * 3600 + 60, 0, 0, 0, 0, 0, 0])).toBe(11);
  });

  it('is an hour at least', () => {
    expect(scaleHours([0, 0, 0, 0, 0, 0, 0])).toBe(1);
    expect(scaleHours([300, 0, 0, 0, 0, 0, 0])).toBe(1);
  });
});

describe('slotHeights', () => {
  it('makes a block as tall as its time', () => {
    expect(slotHeights([3600, 3600], 40)).toEqual([40, 40]);
    expect(slotHeights([5400], 100)).toEqual([150]);
  });

  it("gives a short block a line, out of the day's longer ones, so the day still ends at its total", () => {
    // 2.75 h, 0.25 h and 1.5 h at 40 px an hour: 110, 10 and 60 px by their time.
    const heights = slotHeights([9900, 900, 5400], 40);
    expect(heights).toEqual([104, MIN_SLOT_PX, 56]);
    expect(heights.reduce((n, h) => n + h, 0)).toBe(180);
  });

  it('takes nothing from a block that would fall under a line itself', () => {
    // An hour of 40 px: 5 min, 30 min (20 px, a line already) and 25 min.
    expect(slotHeights([300, 1800, 1500], 40)).toEqual([20, 20, 20]);
  });

  it("runs past the day's total when its lines do not fit in it", () => {
    expect(slotHeights([300], 40)).toEqual([MIN_SLOT_PX]);
    expect(slotHeights([300, 300, 600], 40)).toEqual([20, 20, 20]);
  });

  it('is nothing for a day without work', () => {
    expect(slotHeights([], 40)).toEqual([]);
  });
});

describe('hourHeight', () => {
  it('shares the room over the hours of the scale', () => {
    expect(hourHeight([3, 1], 5, 600)).toBe(120);
    expect(hourHeight([1], 1, 613)).toBe(613);
  });

  it('is never under the least, whatever the room', () => {
    expect(hourHeight([3], 15, 300)).toBe(MIN_HOUR_PX);
    expect(hourHeight([], 10, 0)).toBe(MIN_HOUR_PX);
  });

  it('grows until the lines of the day with the most blocks fit in the chart', () => {
    expect(hourHeight([2, 12], 2, 0)).toBe(120);
  });
});
