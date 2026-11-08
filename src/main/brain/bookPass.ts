import {
  isBookJob,
  bookReady,
  type Brain,
  type BrainJob,
} from '../../shared/brain';
import { readBook } from './book';
import type { BrainJobRunner } from './jobs';
import { readPages } from './pages';

/** Failed attempts after which a brain's first arrangement is given up (a Sync from Run now still makes it). */
export const MAX_BOOK_ATTEMPTS = 2;

export const PENDING: ReadonlySet<BrainJob['status']> = new Set([
  'queued',
  'running',
  'paused',
]);

/**
 * The first arrangement of a brain's book: one background `sync` with the `book` argument, for a brain on skills
 * v8 with pages and no valid book. `bookPass` is the scheduler's; `afterJob` counts an attempt that ended without a
 * valid book (persisted, so a restart never starts over); `passRunning` is true while the job is queued, running
 * or paused, and until its attempt is saved, so nothing queues a second job in between. `runner` is read late:
 * the runner is built with these hooks.
 */
export function createBookHooks(d: {
  brains: {
    get: (id: string) => Brain | undefined;
    patch: (id: string, p: Partial<Brain>) => Promise<unknown>;
  };
  runner: () => Pick<BrainJobRunner, 'enqueue' | 'jobs'>;
}) {
  // Brain ids with a check in flight, or an attempt not saved yet: one at a time per brain.
  const checking = new Set<string>();
  const settling = new Map<string, number>();
  let writes: Promise<unknown> = Promise.resolve();
  const pending = (id: string) =>
    d
      .runner()
      .jobs(id)
      .some((j) => j.kind === 'sync' && PENDING.has(j.status));
  const countAttempt = (id: string) => {
    const write = writes.then(async () => {
      const b = d.brains.get(id);
      if (!b || !bookReady(b)) return;
      if (await readBook(b.path)) return;
      // From the record as it is now: an earlier write may have changed it.
      const now = d.brains.get(id);
      if (!now) return;
      await d.brains.patch(id, {
        bookPass: { attempts: (now.bookPass?.attempts ?? 0) + 1 },
      });
    });
    writes = write.catch((err) =>
      console.error('[brain] could not save the book pass', err),
    );
    return write;
  };
  const bookPass = async (id: string) => {
    if (checking.has(id) || settling.has(id)) return;
    checking.add(id);
    try {
      const b = d.brains.get(id);
      if (
        !b ||
        !bookReady(b) ||
        (b.bookPass?.attempts ?? 0) >= MAX_BOOK_ATTEMPTS
      )
        return;
      // Pages are judged from the pages themselves: readBook has none to tell it a book from nothing.
      const pages = await readPages(b.path).catch(() => []);
      if (!pages.length || (await readBook(b.path))) return;
      // Judged after the reads and queued in the same turn, so nothing queues in between.
      if (pending(id) || settling.has(id)) return;
      d.runner().enqueue(id, 'sync', null, { background: true });
    } finally {
      checking.delete(id);
    }
  };
  return {
    afterJob: (j: BrainJob) => {
      if (!isBookJob(j) || (j.status !== 'done' && j.status !== 'failed'))
        return;
      settling.set(j.brainId, (settling.get(j.brainId) ?? 0) + 1);
      // Logged by countAttempt already.
      void countAttempt(j.brainId)
        .catch(() => undefined)
        .finally(() => {
          const n = (settling.get(j.brainId) ?? 1) - 1;
          if (n > 0) settling.set(j.brainId, n);
          else settling.delete(j.brainId);
        });
    },
    /** Queues the brain's first arrangement when it is due; settles once queued or skipped. */
    bookPass,
    /** Whether the brain's first arrangement is queued, running or paused, or its attempt not saved yet. */
    passRunning: (id: string) =>
      settling.has(id) ||
      d
        .runner()
        .jobs(id)
        .some((j) => isBookJob(j) && PENDING.has(j.status)),
  };
}
