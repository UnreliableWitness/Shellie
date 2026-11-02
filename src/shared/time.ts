import { z } from 'zod';
import type { Task } from './types';

/** [startMs, endMs] as epoch milliseconds. */
export type Interval = [startMs: number, endMs: number];

export type AgentTool = 'claude-code' | 'copilot-cli' | 'opencode';
export const AGENT_TOOLS: AgentTool[] = [
  'claude-code',
  'copilot-cli',
  'opencode',
];

export const TOOL_LABEL: Record<AgentTool, string> = {
  'claude-code': 'Claude Code',
  'copilot-cli': 'Copilot CLI',
  opencode: 'OpenCode est.',
};

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** Minutes since midnight of an `HH:MM` time. */
export const minutesOf = (t: string): number =>
  Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** Local working hours; days: 0 = Sunday … 6 = Saturday. */
export const WorkHoursSchema = z
  .object({
    start: hhmm,
    end: hhmm,
    days: z.array(z.number().int().min(0).max(6)),
  })
  .refine((w) => minutesOf(w.end) > minutesOf(w.start), {
    message: 'end must be after start',
    path: ['end'],
  });
export type WorkHours = z.infer<typeof WorkHoursSchema>;

const AgentSecondsSchema = z.object({
  'claude-code': z.number(),
  'copilot-cli': z.number(),
  opencode: z.number(),
});

/** What was booked when the task was finished, kept so a re-finish only writes the difference. */
export const TimeBookingSchema = z.object({
  bookedSeconds: z.number(),
  measuredSeconds: z.number(),
  realisticSeconds: z.number(),
  wallClockSeconds: z.number(),
  agentSeconds: AgentSecondsSchema,
  bookedAt: z.string(),
  writtenHours: z.number(),
  syncError: z.string().nullable(),
});
export type TimeBooking = z.infer<typeof TimeBookingSchema>;

export type TaskTime = {
  taskId: string;
  activeSeconds: number;
  agentSeconds: Record<AgentTool, number>;
  realisticSeconds: number;
  wallClockSeconds: number;
  measuredSinceReopenSeconds: number;
  booking: TimeBooking | null;
  estimate: { hours: number; source: 'original' | 'baseline' | 'live' } | null;
};

/** Local time of one work item, summed over its tasks on one connection (Sprint page). */
export type LocalItemTime = {
  /** Booked seconds of finished tasks, measured active seconds of open ones (a reopened task adds what was measured since). */
  spentSeconds: number;
  measuredSeconds: number;
  agentSeconds: number;
  /** True when any of the tasks has a booking. */
  booked: boolean;
  baselineHours: number | null;
};

/** Sorted, overlapping or touching intervals joined, empty or negative ones dropped. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function totalMs(list: Interval[]): number {
  return list.reduce((sum, [s, e]) => sum + Math.max(0, e - s), 0);
}

export function unionMs(...lists: Interval[][]): number {
  return totalMs(mergeIntervals(lists.flat()));
}

export function clip(list: Interval[], from: number, to: number): Interval[] {
  const out: Interval[] = [];
  for (const [s, e] of list) {
    const cs = Math.max(s, from);
    const ce = Math.min(e, to);
    if (ce > cs) out.push([cs, ce]);
  }
  return out;
}

/** The length of `periods` that falls inside working hours, in local time (walks day by day, so DST days hold). */
export function workingMs(periods: Interval[], hours: WorkHours): number {
  const [sh, sm] = [
    Number(hours.start.slice(0, 2)),
    Number(hours.start.slice(3)),
  ];
  const [eh, em] = [Number(hours.end.slice(0, 2)), Number(hours.end.slice(3))];
  let sum = 0;
  for (const [s, e] of mergeIntervals(periods)) {
    const first = new Date(s);
    const day = new Date(
      first.getFullYear(),
      first.getMonth(),
      first.getDate(),
    );
    for (let i = 0; day.getTime() < e; i++) {
      if (hours.days.includes(day.getDay())) {
        const from = new Date(
          day.getFullYear(),
          day.getMonth(),
          day.getDate(),
          sh,
          sm,
        ).getTime();
        const to = new Date(
          day.getFullYear(),
          day.getMonth(),
          day.getDate(),
          eh,
          em,
        ).getTime();
        sum += totalMs(clip([[s, e]], from, to));
      }
      day.setTime(
        new Date(
          first.getFullYear(),
          first.getMonth(),
          first.getDate() + i + 1,
        ).getTime(),
      );
    }
  }
  return sum;
}

/** The task's open periods, an open one ending at `now`; without any, creation to finish (or now). */
export function periodsOf(
  task: Pick<Task, 'openPeriods' | 'createdAt' | 'finishedAt'>,
  now: number,
): Interval[] {
  if (task.openPeriods.length === 0)
    return [
      [
        Date.parse(task.createdAt),
        task.finishedAt ? Date.parse(task.finishedAt) : now,
      ],
    ];
  return task.openPeriods.map((p): Interval => [
    Date.parse(p.start),
    p.end === null ? now : Date.parse(p.end),
  ]);
}

/** Seconds from `3.5`, `3,5`, `3h`, `3h 30m`, `3h30`, `210m`, `45m` (a bare number is hours); null for anything else. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase().replace(',', '.');
  if (t === '') return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 3600);
  const m = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m?)?$/.exec(t);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return Math.round(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60);
}

/** `0m`, `45m`, `3h`, `3h 10m`; minutes rounded. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
