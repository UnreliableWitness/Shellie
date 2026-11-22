import {
  clip,
  mergeIntervals,
  periodsOf,
  totalMs,
  type Interval,
} from '../../shared/time';
import type { Task } from '../../shared/types';

/** The 8 local midnights that bound the week starting on `weekStart` (YYYY-MM-DD, a Monday); walks by date, so DST weeks hold. */
export function weekBounds(weekStart: string): number[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStart);
  if (!m) throw new Error(`Not a date: ${weekStart}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  return Array.from({ length: 8 }, (_, i) => new Date(y, mo, d + i).getTime());
}

/**
 * Realistic seconds per day between `bounds` (Shellie and agent time, overlap counted once), like `summarize`:
 * active time outside the task's open periods is dropped.
 */
export function secondsPerDay(
  task: Pick<Task, 'openPeriods' | 'createdAt' | 'finishedAt'>,
  active: Interval[],
  agent: Interval[][],
  bounds: number[],
  now: number,
): number[] {
  const open = periodsOf(task, now).flatMap(([from, to]) =>
    clip(active, from, to),
  );
  const all = mergeIntervals([...open, ...agent.flat()]);
  return bounds
    .slice(0, -1)
    .map((from, i) =>
      Math.round(totalMs(clip(all, from, bounds[i + 1])) / 1000),
    );
}
