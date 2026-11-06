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

/** The newest capture job for a path; `jobs` is newest first. */
function newestCapture(path: string, jobs: BrainJob[]): BrainJob | undefined {
  return jobs.find((j) => j.kind === 'capture' && j.source === path);
}

/** Why a source waits, from the newest capture job for its path. */
export function waitReason(
  path: string,
  jobs: BrainJob[],
  queuePaused: 'cap' | null,
): WaitReason {
  const job = newestCapture(path, jobs);
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

/** The Add tab's badge: waiting sources whose newest capture job is not queued or running (also while the cap holds the queue). */
export function badgeCount(
  sources: BrainSourceRow[],
  jobs: BrainJob[],
  _queuePaused: 'cap' | null,
): number {
  return waitingSources(sources).filter((s) => {
    const status = newestCapture(s.path, jobs)?.status;
    return status !== 'queued' && status !== 'running';
  }).length;
}
