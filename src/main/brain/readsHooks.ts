import { writeReady, type Brain, type BrainJob } from '../../shared/brain';
import { dayKey } from '../../shared/budget';
import type { GitClient } from '../services/GitClient';
import { PENDING } from './bookPass';
import type { BrainJobRunner } from './jobs';
import { nextToWrite, stampReads, writePrompt, written } from './reads';

/** Automatic attempts at one long read that may fail before it is left to Write or Update by hand, for a while. */
export const MAX_READ_FAILURES = 2;
/** Days after its last failure that a long read is tried again: the pages under it have grown since. */
export const READ_RETRY_DAYS = 7;
/** Long reads a brain writes by itself on one day, whatever the token cap leaves. */
export const MAX_READS_A_DAY = 2;

type Failure = NonNullable<Brain['readsPass']>['failures'][string];
/** Whole days from one local `yyyy-mm-dd` to another; a day that does not parse is long ago. */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Number.isNaN(ms) ? Infinity : Math.round(ms / 86_400_000);
}
/** Whether the failures are old enough to start counting again. */
const expired = (f: Failure, today: string) =>
  daysBetween(f.day, today) >= READ_RETRY_DAYS;

/**
 * The write job's hooks. `promptFor` hands `/write` its target (an update with the commit and the pages that
 * changed); `stamp` records, before the job's commit, what the long read was written from; `afterJob` counts an
 * automatic write that left no long read; `readsPass` is the scheduler's: for a brain with "Write long reads" on it
 * queues one background write when nothing else is waiting, under half of the day's token cap, at most
 * `MAX_READS_A_DAY` a day, passing over a target that failed `MAX_READ_FAILURES` times until `READ_RETRY_DAYS`
 * have gone by. `runner` is read late: the runner is built with these hooks.
 */
export function createReadsHooks(d: {
  brains: {
    get: (id: string) => Brain | undefined;
    patch: (id: string, p: Partial<Brain>) => Promise<unknown>;
  };
  runner: () => Pick<BrainJobRunner, 'enqueue' | 'jobs'>;
  git: Pick<GitClient, 'run'>;
  tokensToday: (brainId: string) => number;
  now?: () => Date;
}) {
  const now = d.now ?? (() => new Date());
  // Brain ids with a check in flight, or a result not saved yet: one at a time per brain.
  const checking = new Set<string>();
  const settling = new Map<string, number>();
  let writes: Promise<unknown> = Promise.resolve();

  const dirOf = (id: string) => {
    const b = d.brains.get(id);
    if (!b) throw new Error('Unknown brain');
    return b.path;
  };
  /** Changes the brain's `readsPass` from the record as it is then: an earlier write may have changed it. */
  const save = (
    id: string,
    change: (p: NonNullable<Brain['readsPass']>) => Brain['readsPass'] | null,
  ) => {
    const write = writes.then(async () => {
      const b = d.brains.get(id);
      if (!b) return;
      const next = change(
        b.readsPass ?? { failures: {}, day: null, started: 0 },
      );
      if (next) await d.brains.patch(id, { readsPass: next });
    });
    writes = write.catch((err) =>
      console.error('[brain] could not save the reads pass', err),
    );
    return write;
  };
  const settle = (id: string, work: Promise<unknown>) => {
    settling.set(id, (settling.get(id) ?? 0) + 1);
    // Logged by save already.
    void work
      .catch(() => undefined)
      .finally(() => {
        const n = (settling.get(id) ?? 1) - 1;
        if (n > 0) settling.set(id, n);
        else settling.delete(id);
      });
  };
  const anyPending = (id: string) =>
    d
      .runner()
      .jobs(id)
      .some((j) => PENDING.has(j.status));

  const readsPass = async (id: string) => {
    if (checking.has(id) || settling.has(id)) return;
    checking.add(id);
    try {
      const b = d.brains.get(id);
      if (!b || b.archived || !b.options.writeLongReads || !writeReady(b))
        return;
      if (anyPending(id)) return;
      if (d.tokensToday(id) >= b.options.dailyTokenCap / 2) return;
      const day = dayKey(now());
      const started = b.readsPass?.day === day ? b.readsPass.started : 0;
      if (started >= MAX_READS_A_DAY) return;
      const failed = Object.entries(b.readsPass?.failures ?? {})
        .filter(([, f]) => f.count >= MAX_READ_FAILURES && !expired(f, day))
        .map(([t]) => t);
      const target = await nextToWrite(b.path, new Set(failed));
      // Judged after the reads and queued in the same turn, so nothing queues in between.
      if (!target || anyPending(id) || settling.has(id)) return;
      d.runner().enqueue(id, 'write', null, { background: true, target });
      settle(
        id,
        save(id, (p) => ({
          ...p,
          day,
          started: (p.day === day ? p.started : 0) + 1,
        })),
      );
    } finally {
      checking.delete(id);
    }
  };

  return {
    promptFor: async (job: BrainJob): Promise<string | undefined> => {
      if (job.kind !== 'write') return undefined;
      return writePrompt(d.git, dirOf(job.brainId), job.target ?? '');
    },

    /** Runs before a write job's commit, so the record is part of it. */
    stamp: async (job: BrainJob): Promise<void> => {
      if (job.kind !== 'write' || !job.target) return;
      await stampReads(d.git, dirOf(job.brainId), job.target, now());
    },

    afterJob: (job: BrainJob) => {
      if (job.kind !== 'write' || !job.target) return;
      if (job.status !== 'done' && job.status !== 'failed') return;
      const target = job.target;
      const b = d.brains.get(job.brainId);
      if (!b) return;
      const had = target in (b.readsPass?.failures ?? {});
      // A write by hand that failed says so in Activity; only the automatic ones are counted.
      if (!job.background && !(job.status === 'done' && had)) return;
      settle(
        job.brainId,
        (async () => {
          const ok =
            job.status === 'done' &&
            (await written(b.path, target).catch(() => false));
          if (!ok && !job.background) return;
          await save(job.brainId, (p) => {
            const failures = { ...p.failures };
            if (ok) {
              if (!(target in failures)) return null;
              delete failures[target];
            } else {
              const day = dayKey(now());
              const f = failures[target];
              failures[target] = {
                count: (f && !expired(f, day) ? f.count : 0) + 1,
                day,
              };
            }
            return { ...p, failures };
          });
        })(),
      );
    },

    /** Queues the brain's next long read when one is due; settles once queued or skipped. */
    readsPass,
    /** Whether an automatic write of the brain is queued, running or paused, or its result not saved yet. */
    passRunning: (id: string) =>
      settling.has(id) ||
      d
        .runner()
        .jobs(id)
        .some(
          (j) => j.kind === 'write' && j.background && PENDING.has(j.status),
        ),
  };
}
