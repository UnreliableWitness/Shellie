import {
  bookReady,
  picturesReady,
  writeReady,
  type Brain,
} from '../../shared/brain';
import { MAX_BOOK_ATTEMPTS } from './bookPass';

const DAY_MS = 24 * 3600 * 1000;
export const TICK_MS = 15 * 60 * 1000;
/** A refresh that failed (offline, no access) is tried again after this, not on every tick. */
const RETRY_MS = 60 * 60 * 1000;

/** Monday 00:00 local of `now`'s week (the most recent Monday, today when it is one). */
function lastMonday(now: Date): Date {
  const back = (now.getDay() + 6) % 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
}

/**
 * The brains' background work while the app is open: a wiki mirror older than 24 h is refreshed (a failed one again after an hour), and a brain with
 * `weeklyDigest` gets its digest on Monday, or the next time the app is open after a Monday it missed (once per week,
 * and only when nothing runs for it). A brain on templates v6 whose one-time picture pass has not finished gets it started
 * or resumed when none of its pass jobs is pending (after a restart the queue is empty, so it picks up again), from the
 * second check on.
 * A brain on templates v8 with pages and no book gets its first arrangement queued the same way, until two attempts
 * have failed.
 * A brain on templates v10 with `writeLongReads` on gets its next long read looked for the same way (the pass itself
 * decides whether one is due).
 * Checks at once and then every tick (default 15 min); returns the stop function.
 */
export function startBrainScheduler(d: {
  brains: () => Brain[];
  refresh: (id: string) => Promise<unknown>;
  digest: (id: string) => void;
  running: (id: string) => boolean;
  /** Starts or resumes the brain's picture pass; settles once it is saved. */
  picturePass: (id: string) => Promise<unknown>;
  /** Whether a background pictures job of the brain is queued, running or paused. */
  passRunning: (id: string) => boolean;
  /** Queues the brain's first book arrangement when it is due; settles once queued or skipped. */
  bookPass: (id: string) => Promise<unknown>;
  /** Whether the brain's first arrangement is queued, running or paused, or its attempt not saved yet. */
  bookPassRunning: (id: string) => boolean;
  /** Queues the brain's next long read when one is due; settles once queued or skipped. */
  readsPass: (id: string) => Promise<unknown>;
  /** Whether an automatic write of the brain is queued, running or paused, or its result not saved yet. */
  readsPassRunning: (id: string) => boolean;
  now?: () => Date;
  tick?: number;
}): () => void {
  const now = d.now ?? (() => new Date());
  const refreshing = new Set<string>();
  // brain id -> when its last refresh failed (it rejected or answered ok: false).
  const failedAt = new Map<string, number>();
  // brain id -> the Monday its digest was enqueued, so a slow lastDigestAt write never enqueues it twice.
  const digested = new Map<string, number>();
  const passing = new Set<string>();
  const bookPassing = new Set<string>();
  const readsPassing = new Set<string>();
  // The picture pass converts originals again, and both passes read every page: they wait one tick, so they never weigh on the launch.
  let firstCheck = true;

  const check = () => {
    const at = now();
    const launch = firstCheck;
    firstCheck = false;
    for (const b of d.brains()) {
      if (b.archived) continue;
      const last = b.lastRefreshAt ? Date.parse(b.lastRefreshAt) : 0;
      const failed = failedAt.get(b.id);
      if (
        b.wiki &&
        !refreshing.has(b.id) &&
        at.getTime() - last > DAY_MS &&
        (failed === undefined || at.getTime() - failed >= RETRY_MS)
      ) {
        refreshing.add(b.id);
        void d
          .refresh(b.id)
          .then(
            (r) => {
              if ((r as { ok?: boolean } | null)?.ok === false)
                failedAt.set(b.id, now().getTime());
              else failedAt.delete(b.id);
            },
            (e) => {
              failedAt.set(b.id, now().getTime());
              console.error('[brain] scheduled refresh failed', e);
            },
          )
          .finally(() => refreshing.delete(b.id));
      }
      const monday = lastMonday(at).getTime();
      if (
        b.options.weeklyDigest &&
        digested.get(b.id) !== monday &&
        (!b.lastDigestAt || Date.parse(b.lastDigestAt) < monday) &&
        !d.running(b.id)
      ) {
        digested.set(b.id, monday);
        try {
          d.digest(b.id);
        } catch (e) {
          console.error('[brain] scheduled digest failed', e);
        }
      }
      if (
        !launch &&
        picturesReady(b) &&
        !b.picturePass?.finishedAt &&
        !passing.has(b.id) &&
        !d.passRunning(b.id)
      ) {
        passing.add(b.id);
        void d
          .picturePass(b.id)
          .catch((e) => console.error('[brain] picture pass failed', e))
          .finally(() => passing.delete(b.id));
      }
      if (
        !launch &&
        bookReady(b) &&
        (b.bookPass?.attempts ?? 0) < MAX_BOOK_ATTEMPTS &&
        !bookPassing.has(b.id) &&
        !d.bookPassRunning(b.id)
      ) {
        bookPassing.add(b.id);
        void d
          .bookPass(b.id)
          .catch((e) => console.error('[brain] book pass failed', e))
          .finally(() => bookPassing.delete(b.id));
      }
      if (
        !launch &&
        b.options.writeLongReads &&
        writeReady(b) &&
        !readsPassing.has(b.id) &&
        !d.readsPassRunning(b.id)
      ) {
        readsPassing.add(b.id);
        void d
          .readsPass(b.id)
          .catch((e) => console.error('[brain] reads pass failed', e))
          .finally(() => readsPassing.delete(b.id));
      }
    }
  };

  const first = setTimeout(check, 0);
  const timer = setInterval(check, d.tick ?? TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
