import {
  clip,
  mergeIntervals,
  periodsOf,
  totalMs,
  type Interval,
  type WeekStretch,
} from '../../shared/time';
import type { Task } from '../../shared/types';

/** The 8 local midnights that bound the week starting on `weekStart` (YYYY-MM-DD, a Monday); walks by date, so DST weeks hold. */
export function weekBounds(weekStart: string): number[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStart);
  if (!m) throw new Error(`Not a date: ${weekStart}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  return Array.from({ length: 8 }, (_, i) => new Date(y, mo, d + i).getTime());
}

/** The task's realistic time (Shellie and agent time, overlap counted once; active time outside its open periods dropped). */
function realistic(
  task: Pick<Task, 'openPeriods' | 'createdAt' | 'finishedAt'>,
  active: Interval[],
  agent: Interval[][],
  now: number,
): Interval[] {
  const open = periodsOf(task, now).flatMap(([from, to]) =>
    clip(active, from, to),
  );
  return mergeIntervals([...open, ...agent.flat()]);
}

/** Realistic seconds per day between `bounds`, like `summarize`. */
export function secondsPerDay(
  task: Pick<Task, 'openPeriods' | 'createdAt' | 'finishedAt'>,
  active: Interval[],
  agent: Interval[][],
  bounds: number[],
  now: number,
): number[] {
  const all = realistic(task, active, agent, now);
  return bounds
    .slice(0, -1)
    .map((from, i) =>
      Math.round(totalMs(clip(all, from, bounds[i + 1])) / 1000),
    );
}

/** Work on a task that resumes within this long is the same stretch: a coffee, a question, a look at another task. */
export const STRETCH_GAP_MS = 30 * 60_000;

/**
 * Per day between `bounds`, the task's stretches of work in order: when each began and the seconds worked in it
 * (the pauses inside a stretch are not counted). The Week page stacks a day's stretches of every task by `start`.
 */
export function stretchesPerDay(
  task: Pick<Task, 'openPeriods' | 'createdAt' | 'finishedAt'>,
  active: Interval[],
  agent: Interval[][],
  bounds: number[],
  now: number,
): WeekStretch[][] {
  const all = realistic(task, active, agent, now);
  return bounds.slice(0, -1).map((from, i) => {
    const out: { start: number; end: number; ms: number }[] = [];
    for (const [s, e] of clip(all, from, bounds[i + 1])) {
      const last = out[out.length - 1];
      if (last && s - last.end <= STRETCH_GAP_MS) {
        last.end = e;
        last.ms += e - s;
      } else out.push({ start: s, end: e, ms: e - s });
    }
    return out.map((x) => ({
      start: x.start,
      seconds: Math.round(x.ms / 1000),
    }));
  });
}
