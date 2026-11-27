import type { WeekRow } from '../shared/time';

/** A block in a day's column: one task, and the seconds worked on it before the next task took over. */
export type DayBlock = { taskId: string; seconds: number };

/** How many tasks get a colour of their own in a week (`--series-1` to `--series-8`); the rest share a neutral one. */
export const SERIES = 8;

/** The least height of an hour in a day's column; a week too long for the window at this height scrolls. */
export const MIN_HOUR_PX = 40;

/** The least height of a block's slot (its card and the gap under it): one line of text. */
export const MIN_SLOT_PX = 20;

/**
 * Per day, Monday to Sunday, the blocks of its column from the top: every task's stretches in the order they began,
 * a task's stretches that follow each other joined into one block. With `perTask`, all of a task's stretches of a
 * day are one block, where the task was first worked on that day: one block per task, its day's total.
 */
export function dayBlocks(rows: WeekRow[], perTask = false): DayBlock[][] {
  return Array.from({ length: 7 }, (_, day) => {
    const stretches = rows
      .flatMap((r) =>
        (r.stretches[day] ?? []).map((s) => ({ taskId: r.taskId, ...s })),
      )
      .sort((a, b) => a.start - b.start || (a.taskId < b.taskId ? -1 : 1));
    const blocks: DayBlock[] = [];
    for (const s of stretches) {
      const last = perTask
        ? blocks.find((b) => b.taskId === s.taskId)
        : blocks[blocks.length - 1];
      if (last?.taskId === s.taskId) last.seconds += s.seconds;
      else blocks.push({ taskId: s.taskId, seconds: s.seconds });
    }
    return blocks;
  });
}

/**
 * The colour slot of each task: 0 for the task first worked on in the week, and so on; null once the colours run
 * out. The order does not follow a task's total, so a task keeps its colour while the week's hours grow.
 */
export function taskSlots(rows: WeekRow[]): Map<string, number | null> {
  const first = (r: WeekRow) =>
    Math.min(...r.stretches.flat().map((s) => s.start), Infinity);
  return new Map(
    rows
      .map((r) => ({ id: r.taskId, at: first(r) }))
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
      .map(({ id }, i) => [id, i < SERIES ? i : null]),
  );
}

/** The hours a day's column runs to: as many whole hours as the week's longest day needs, one at least. */
export function scaleHours(dayTotals: number[]): number {
  return Math.max(1, Math.ceil(Math.max(0, ...dayTotals) / 3600));
}

/**
 * The height of an hour: the room there is shared over the scale's hours, never under the least, and enough for a
 * line for every block of the day with the most of them (`blocksPerDay`) to fit in the chart.
 */
export function hourHeight(
  blocksPerDay: number[],
  scale: number,
  room: number,
): number {
  const most = Math.max(0, ...blocksPerDay);
  return Math.max(
    MIN_HOUR_PX,
    Math.floor(room / scale),
    Math.ceil((most * MIN_SLOT_PX) / scale),
  );
}

/**
 * The height in whole px of each block's slot in a day's column, from the top. A block is as tall as its time,
 * but never lower than a line: what the short ones get more comes out of the longer ones, in proportion to their
 * time, so the column still ends at the day's total. Only a day whose lines do not fit in its total runs past it.
 */
export function slotHeights(seconds: number[], hourPx: number): number[] {
  const total = (seconds.reduce((n, s) => n + s, 0) / 3600) * hourPx;
  // The blocks held at a line; each round shares what is left over the others, which can push more under it.
  const held = new Set<number>();
  let share = (i: number) => (seconds[i] / 3600) * hourPx;
  for (let grew = true; grew;) {
    grew = false;
    for (let i = 0; i < seconds.length; i++) {
      if (!held.has(i) && share(i) < MIN_SLOT_PX) {
        held.add(i);
        grew = true;
      }
    }
    const left = total - held.size * MIN_SLOT_PX;
    const free = seconds.reduce((n, s, i) => (held.has(i) ? n : n + s), 0);
    share = (i) => (seconds[i] / free) * left;
  }
  // Whole px by rounding each block's lower edge, so the heights add up to the column's.
  let edge = 0;
  return seconds.map((_, i) => {
    const from = Math.round(edge);
    edge += held.has(i) ? MIN_SLOT_PX : share(i);
    return Math.round(edge) - from;
  });
}
