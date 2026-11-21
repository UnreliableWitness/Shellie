/**
 * Pure helpers of a dream's OpenCode runs: waiting on a run that was stopped, telling why a run failed in a fixed
 * phrase, finding the run's session, and naming the task a report's evidence points at.
 */

import { withTimeout } from '../async';
import { opencodeResultWithSession } from '../brain/opencodeResult';
import { programMissing } from '../services/prSummary';
import type { TaskSessions } from './material';

/** A dream failed for this reason: a fixed phrase, never session text, a path or a program's output. */
export class DreamFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Rejects with `stopped` once `signal` aborts, without waiting for `p`. */
export const abortable = <T>(p: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('stopped'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });

/** Resolves once `p` settles, or after `ms` when it does not. */
export function settledWithin(p: Promise<unknown>, ms: number): Promise<void> {
  const done = (): void => undefined;
  return withTimeout(p.then(done, done), ms, done);
}

/** Why a run failed, as a fixed phrase: never the program's own output. */
export function runReason(e: unknown, timeoutMs: number): string {
  if (programMissing(e)) return 'OpenCode (opencode) was not found';
  if (/timed out/i.test((e as Error | null)?.message ?? ''))
    return `timed out after ${timeoutMs / 60_000} min`;
  return 'OpenCode stopped';
}

/** The run's session id, null when no event names one; throws `DreamFailed` for a run that printed an error. */
export function sessionOf(stdout: string): string | null {
  try {
    return opencodeResultWithSession(stdout).sessionId;
  } catch (e) {
    if ((e as Error).message.startsWith('OpenCode stopped'))
      throw new DreamFailed('OpenCode stopped');
  }
  // No answer text: the session is still named by its events.
  for (const line of stdout.split('\n')) {
    try {
      const id = (JSON.parse(line) as { sessionID?: unknown } | null)
        ?.sessionID;
      if (typeof id === 'string') return id;
    } catch {
      // not an event
    }
  }
  return null;
}

/** The task a report names: by id (or its digest file, `tasks/<id>.md`), else by label, else the name as given. */
export function taskRef(
  ref: string,
  tasks: Pick<TaskSessions, 'taskId' | 'label'>[],
): { taskId: string; label: string } {
  const file = ref.replace(/^tasks[\\/]/, '').replace(/\.md$/, '');
  const byId =
    tasks.find((t) => t.taskId === ref) ?? tasks.find((t) => t.taskId === file);
  if (byId) return { taskId: byId.taskId, label: byId.label };
  const want = ref.trim().toLowerCase();
  const byLabel =
    tasks.find((t) => t.label.toLowerCase() === want) ??
    (want
      ? tasks
          .filter((t) => {
            const l = t.label.toLowerCase();
            return l !== '' && (l.includes(want) || want.includes(l));
          })
          .sort((a, b) => b.label.length - a.label.length)[0]
      : undefined);
  return byLabel
    ? { taskId: byLabel.taskId, label: byLabel.label }
    : { taskId: ref, label: ref };
}
