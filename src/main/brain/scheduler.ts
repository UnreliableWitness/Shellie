import type { Brain } from '../../shared/brain';

const DAY_MS = 24 * 3600 * 1000;
const TICK_MS = 15 * 60 * 1000;
/** A refresh that failed (offline, no access) is tried again after this, not on every tick. */
const RETRY_MS = 60 * 60 * 1000;
/** The skills that cite and mark pictures: the one-time picture pass waits for them. */
const PASS_TEMPLATES = 6;

/** Monday 00:00 local of `now`'s week (the most recent Monday, today when it is one). */
function lastMonday(now: Date): Date {
  const back = (now.getDay() + 6) % 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
}

/**
 * The brains' background work while the app is open: a wiki mirror older than 24 h is refreshed (a failed one again after an hour), and a brain with
 * `weeklyDigest` gets its digest on Monday, or the next time the app is open after a Monday it missed (once per week,
 * and only when nothing runs for it). A brain on templates v6 whose one-time picture pass has not finished gets it started
 * or resumed when none of its pass jobs is pending (after a restart the queue is empty, so it picks up again).
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

  const check = () => {
    const at = now();
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
        b.templatesVersion >= PASS_TEMPLATES &&
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
    }
  };

  const first = setTimeout(check, 0);
  const timer = setInterval(check, d.tick ?? TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
