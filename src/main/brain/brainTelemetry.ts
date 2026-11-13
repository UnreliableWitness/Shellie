import type { BrainJob } from '../../shared/brain';
import type { TelemetryProps } from '../../shared/telemetry';
import { AdoError } from '../services/AdoClient';
import { NoConnectionError } from './share/join';

/** A size in kB as a coarse bucket, never the exact number. */
export function sizeBucket(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 10) return '<10';
  if (kb < 100) return '10-100';
  if (kb < 1000) return '100-1000';
  return '>1000';
}

export function imagesBucket(n: number): string {
  if (n === 0) return '0';
  if (n <= 10) return '1-10';
  return '>10';
}

export function pagesBucket(n: number): string {
  if (n === 0) return '0';
  if (n <= 10) return '1-10';
  if (n <= 100) return '11-100';
  return '>100';
}

/** The runner's onChange: one `brain.job` event per job that finished (done or failed), kind and duration only. */
export function jobTelemetry(
  event: (name: string, props?: TelemetryProps) => void,
): (jobs: BrainJob[]) => void {
  const seen = new Set<string>();
  return (jobs) => {
    for (const j of jobs) {
      if ((j.status !== 'done' && j.status !== 'failed') || seen.has(j.id))
        continue;
      seen.add(j.id);
      const ms =
        j.startedAt && j.endedAt
          ? Date.parse(j.endedAt) - Date.parse(j.startedAt)
          : 0;
      event('brain.job', {
        kind: j.kind,
        outcome: j.status === 'done' ? 'ok' : 'failed',
        ms,
      });
    }
  };
}

/** A failed join for `brain.join`: no connection for the project, access refused, or anything else. */
export function joinOutcome(e: unknown): 'noConnection' | 'denied' | 'failed' {
  if (e instanceof NoConnectionError) return 'noConnection';
  if (e instanceof AdoError && e.kind === 'unauthorized') return 'denied';
  return 'failed';
}
