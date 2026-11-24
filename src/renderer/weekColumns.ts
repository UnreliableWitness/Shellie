import type { WeekRow } from '../shared/time';

/** A block in a day's column: one task, and the seconds worked on it before the next task took over. */
export type DayBlock = { taskId: string; seconds: number };

/** How many tasks get a colour of their own in a week (`--series-1` to `--series-8`); the rest share a neutral one. */
export const SERIES = 8;

/** The scale of a day's column when no day is longer: a working day and some. */
const BASE_HOURS = 10;

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

/** The hours a day's column runs to: ten, or as many whole hours as the week's longest day needs. */
export function scaleHours(dayTotals: number[]): number {
  return Math.max(BASE_HOURS, Math.ceil(Math.max(0, ...dayTotals) / 3600));
}
