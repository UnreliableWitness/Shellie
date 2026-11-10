import {
  SOURCE_JOB_KINDS,
  type BrainJob,
  type BrainSourceRow,
} from '../../../../shared/brain';
import { captureInFlight, waitingSources, type WaitReason } from '../waiting';

/** One line of Activity: a source with its newest job (or none), or a job without a source. */
export type ActivityRow = {
  key: string;
  group: 'running' | 'needs' | 'earlier';
  source: string | null;
  sourceRow: BrainSourceRow | null;
  job: BrainJob | null;
  reason: WaitReason | null;
};

const CAP: WaitReason = { kind: 'paused', text: 'paused: daily token cap' };
const IN_FLIGHT = new Set<BrainJob['status']>(['queued', 'running', 'paused']);

/** Queued jobs (no start yet) count as newest, as Recent work showed them. */
const when = (j: BrainJob) =>
  j.startedAt ?? (j.status === 'queued' ? '9' : (j.endedAt ?? ''));
const newestFirst = (a: BrainJob, b: BrainJob) =>
  when(b).localeCompare(when(a));

/** What a job's status says on its row. */
export function jobReason(
  job: BrainJob,
  queuePaused: 'cap' | null,
): WaitReason {
  switch (job.status) {
    case 'queued':
      return queuePaused === 'cap' ? CAP : { kind: 'queued', text: 'queued' };
    case 'running':
      return {
        kind: 'running',
        text: job.kind === 'capture' ? 'capturing…' : 'running…',
      };
    case 'paused':
      return CAP;
    case 'failed':
      return { kind: 'failed', text: job.error ?? 'failed' };
    default:
      return { kind: 'none', text: 'done' };
  }
}

/**
 * Activity's rows: one per source over its source jobs (its newest stands for it), one per job without a source.
 * Background jobs show only while running or once failed. A source the Add badge counts (waiting, no capture in
 * flight) needs you and is never listed again under Earlier. Running first, then needs you, then earlier.
 */
export function activityRows(
  jobs: BrainJob[],
  sources: BrainSourceRow[],
  queuePaused: 'cap' | null,
  /** Answer sources a settle will read: not waiting for a capture. */
  exclude: string[] = [],
): ActivityRow[] {
  if (exclude.length) {
    const skip = new Set(exclude);
    sources = sources.filter((s) => !skip.has(s.path));
  }
  const shown = jobs
    .filter(
      (j) => !j.background || j.status === 'running' || j.status === 'failed',
    )
    .sort(newestFirst);
  const bySource = new Map(sources.map((s) => [s.path, s]));
  const needs = new Set(
    waitingSources(sources)
      .filter((s) => !captureInFlight(s.path, jobs))
      .map((s) => s.path),
  );
  const rows: ActivityRow[] = [];
  const seen = new Set<string>();
  for (const j of shown) {
    const path = SOURCE_JOB_KINDS.has(j.kind) ? j.source : null;
    if (path) {
      if (seen.has(path)) continue;
      seen.add(path);
    }
    const waiting = path !== null && needs.has(path);
    // A waiting source shows its newest failed capture (Retry keeps that capture's model).
    const job = waiting
      ? (jobs.find(
          (x) =>
            x.kind === 'capture' && x.source === path && x.status === 'failed',
        ) ?? null)
      : j;
    rows.push({
      key: job?.id ?? `source:${path}`,
      group: waiting
        ? 'needs'
        : IN_FLIGHT.has(j.status)
          ? 'running'
          : 'earlier',
      source: path,
      sourceRow: path ? (bySource.get(path) ?? null) : null,
      job,
      reason: job
        ? jobReason(job, queuePaused)
        : { kind: 'none', text: 'not captured yet' },
    });
  }
  for (const path of needs) {
    if (seen.has(path)) continue;
    rows.push({
      key: `source:${path}`,
      group: 'needs',
      source: path,
      sourceRow: bySource.get(path) ?? null,
      job: null,
      reason: { kind: 'none', text: 'not captured yet' },
    });
  }
  const rank = { running: 0, needs: 1, earlier: 2 };
  // A stable sort keeps newest first within each group.
  return rows.sort((a, b) => rank[a.group] - rank[b.group]);
}
