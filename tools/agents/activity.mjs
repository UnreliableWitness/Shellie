// The agents' own bookkeeping, kept in the body of the "Agent activity" issue (spec 6.1a, 8):
// the pause after a usage limit, runs per day for the daily cap, and what shadow mode has already looked at.
import { renderStatus } from './state.mjs';

const day = (d) => d.toISOString().slice(0, 10);

export function emptyActivity() {
  return { v: 1, runsByDay: {}, shadowSeen: {} };
}

/**
 * @param {{ pausedUntil?: string, runsByDay: Record<string, number> }} a
 * @param {Date} now
 * @param {number} maxPerDay
 * @returns {{ ok: boolean, reason?: 'paused' | 'daily-cap' }}
 */
export function canRunAgent(a, now, maxPerDay) {
  if (a.pausedUntil && now.getTime() < Date.parse(a.pausedUntil))
    return { ok: false, reason: 'paused' };
  if ((a.runsByDay[day(now)] ?? 0) >= maxPerDay)
    return { ok: false, reason: 'daily-cap' };
  return { ok: true };
}

/** Counts one agent run today and forgets days older than a week. */
export function recordRun(a, now) {
  const runsByDay = {
    ...a.runsByDay,
    [day(now)]: (a.runsByDay[day(now)] ?? 0) + 1,
  };
  const oldest = day(new Date(now.getTime() - 6 * 86400000));
  for (const d of Object.keys(runsByDay)) if (d < oldest) delete runsByDay[d];
  return { ...a, runsByDay };
}

export function recordPause(a, now, minutes) {
  return {
    ...a,
    pausedUntil: new Date(now.getTime() + minutes * 60000).toISOString(),
  };
}

/**
 * @param {any} a
 * @param {Record<string, number>} counts open issues per agent label
 * @param {Date} now
 * @param {number} maxPerDay
 */
export function renderActivity(a, counts, now, maxPerDay) {
  const paused = a.pausedUntil && now.getTime() < Date.parse(a.pausedUntil);
  const lines = [
    "This issue is the Shellie agents' own bookkeeping; they edit it. See `docs/agents.md`.",
    '',
    `- Agent runs today: ${a.runsByDay[day(now)] ?? 0} of ${maxPerDay}`,
    `- ${paused ? `**Paused for a usage limit until ${a.pausedUntil}**` : 'Not paused'}`,
    '',
    '| Label | Open issues |',
    '|---|---|',
    ...Object.entries(counts).map(([label, n]) => `| \`${label}\` | ${n} |`),
    '',
    `<sub>Updated ${now.toISOString()}</sub>`,
  ];
  return renderStatus(a, lines.join('\n'));
}
