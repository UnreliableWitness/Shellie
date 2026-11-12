import type { BrainJob } from '../../shared/brain';
import type { Events } from '../../shared/ipc';

export interface BrainEventDeps {
  /** Forwards an event to the window, nothing more. */
  send: <K extends keyof Events>(event: K, payload: Events[K]) => void;
  /** A brain's files, options or existence may have changed: the reading list and the phone push read it again. */
  filesChanged: (brainId: string) => void;
}

/** An event for the window; a `brain:changed` from an edit, options, archive or removal counts as changed files. */
export function broadcastEvent<K extends keyof Events>(
  d: BrainEventDeps,
  event: K,
  payload: Events[K],
): void {
  if (event === 'brain:changed')
    d.filesChanged((payload as Events['brain:changed']).brainId);
  d.send(event, payload);
}

/**
 * The job runner's events. A status change (queued, held, running, paused) only updates Activity; it touches no
 * file, so the reading list keeps what it read. A job that ended may have written files.
 */
export function jobEvents(d: BrainEventDeps) {
  return {
    changed: (brainId: string) => d.send('brain:changed', { brainId }),
    ended: (job: Pick<BrainJob, 'brainId'>) => d.filesChanged(job.brainId),
  };
}
