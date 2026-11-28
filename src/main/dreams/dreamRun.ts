/**
 * A dream's OpenCode runs: the one call every run is (`dreamCall`), waiting on a run that was stopped, telling why a
 * run failed in a fixed phrase, finding the run's session, and naming the task a report's evidence points at.
 */

import { withTimeout } from '../async';
import { opencodeResultWithSession } from '../brain/opencodeResult';
import type { Platform } from '../platform/Platform';
import { programMissing, type runWithInput } from '../services/prSummary';
import type { TaskSessions } from './material';
import { dreamArgs, dreamEnv, otherModels } from './opencodeDream';

/** How long a stopped run may take to end before its folders are removed or rebuilt anyway. */
export const RUN_GRACE_MS = 10_000;

/** A dream failed for this reason: a fixed phrase, never session text, a path or a program's output. */
export class DreamFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** The run was stopped through its signal. */
export class DreamStopped extends Error {
  constructor() {
    super('stopped');
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

/**
 * One OpenCode run of a dream in its worktree, as every dream run is made: the dream's arguments and title, the
 * dream's environment (applied last: spawning spreads process.env, then the env given, then the command's own), the
 * prompt on stdin. Returns the models other than `model` that answered (empty: the model rule held). Throws
 * `DreamStopped` when `signal` aborted (after giving the process `RUN_GRACE_MS` to end), `DreamFailed` with a fixed
 * phrase for any other failure of the run.
 */
export async function dreamCall(
  d: {
    platform: Pick<Platform, 'opencodeCommand'>;
    /** It MUST kill the process when `signal` aborts (`runWithInput` does). */
    run: typeof runWithInput;
    sessionModels: (sessionId: string) => string[];
  },
  o: {
    model: string;
    what: 'propose' | 'check' | 'adjust';
    project: string;
    worktree: string;
    dataDir: string;
    /** The check run: edits only in the data folder. */
    readOnlyWorktree?: boolean;
    prompt: string;
    timeoutMs: number;
    signal: AbortSignal;
    /** Given each line the agent prints as it arrives (its events), to show what it is doing. */
    onLine?: (line: string) => void;
  },
): Promise<string[]> {
  const cmd = d.platform.opencodeCommand(
    undefined,
    dreamArgs(o.model, o.what, o.project),
  );
  const env = dreamEnv(cmd.env ?? {}, {
    model: o.model,
    worktree: o.worktree,
    dataDir: o.dataDir,
    readOnlyWorktree: o.readOnlyWorktree === true,
  });
  const running = d.run(
    { ...cmd, env },
    {
      cwd: o.worktree,
      input: o.prompt,
      timeoutMs: o.timeoutMs,
      env,
      signal: o.signal,
      ...(o.onLine ? { onLine: o.onLine } : {}),
    },
  );
  let stdout: string;
  try {
    stdout = await abortable(running, o.signal);
  } catch (e) {
    if (o.signal.aborted) {
      // Stopped: give the process time to end before its folders go or are rebuilt.
      await settledWithin(running, RUN_GRACE_MS);
      throw new DreamStopped();
    }
    throw new DreamFailed(runReason(e, o.timeoutMs));
  }
  if (o.signal.aborted) throw new DreamStopped();
  const session = sessionOf(stdout);
  return otherModels(session ? d.sessionModels(session) : [], o.model);
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
