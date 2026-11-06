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

/** Whether a capture for the path is in flight (queued, running, or paused by the cap): main counts all three, so it is not queued again. */
export function captureInFlight(path: string, jobs: BrainJob[]): boolean {
  const status = newestCapture(path, jobs)?.status;
  return status === 'queued' || status === 'running' || status === 'paused';
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

/** The Add tab's badge: waiting sources with no capture in flight (queued, running, or paused by the cap). */
export function badgeCount(
  sources: BrainSourceRow[],
  jobs: BrainJob[],
): number {
  return waitingSources(sources).filter((s) => !captureInFlight(s.path, jobs))
    .length;
}
