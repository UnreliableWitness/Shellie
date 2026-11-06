import type { BrainJob, BrainSourceRow } from '../../../shared/brain';

export type WaitReason = {
  kind: 'queued' | 'running' | 'failed' | 'paused' | 'none';
  text: string;
};

const CAP_TEXT = 'paused: daily token cap';

/** The sources the Add view lists as waiting: not captured yet, not a DevOps wiki mirror page. */
export function waitingSources(sources: BrainSourceRow[]): BrainSourceRow[] {
  return sources.filter(
    (s) => !s.captured && !s.path.startsWith('sources/wiki/'),
  );
}

/** Why a source waits, from the newest capture job for its path. */
export function waitReason(
  path: string,
  jobs: BrainJob[],
  queuePaused: 'cap' | null,
): WaitReason {
  const job = jobs.findLast((j) => j.kind === 'capture' && j.source === path);
  switch (job?.status) {
    case 'queued':
      return queuePaused === 'cap'
        ? { kind: 'paused', text: CAP_TEXT }
        : { kind: 'queued', text: 'queued' };
    case 'running':
      return { kind: 'running', text: 'capturing…' };
    case 'paused':
      return { kind: 'paused', text: CAP_TEXT };
    case 'failed':
      return { kind: 'failed', text: job.error ?? 'failed' };
    default:
      return { kind: 'none', text: 'not captured yet' };
  }
}

/** The Add tab's badge: waiting sources with no queued or running capture. */
export function badgeCount(
  sources: BrainSourceRow[],
  jobs: BrainJob[],
  queuePaused: 'cap' | null,
): number {
  return waitingSources(sources).filter((s) => {
    const kind = waitReason(s.path, jobs, queuePaused).kind;
    return kind !== 'queued' && kind !== 'running';
  }).length;
}
