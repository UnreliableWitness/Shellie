import type { Brain } from '../../shared/brain';

const DAY_MS = 24 * 3600 * 1000;
const TICK_MS = 15 * 60 * 1000;
/** A refresh that failed (offline, no access) is tried again after this, not on every tick. */
const RETRY_MS = 60 * 60 * 1000;

/** Monday 00:00 local of `now`'s week, or null when `now` is not a Monday. */
function thisMonday(now: Date): Date | null {
  if (now.getDay() !== 1) return null;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * The brains' background work while the app is open: a wiki mirror older than 24 h is refreshed (a failed one again after an hour), and a brain with
 * `weeklyDigest` gets its digest on Monday (once, and only when nothing runs for it). Checks at once and then every
 * tick (default 15 min); returns the stop function.
 */
export function startBrainScheduler(d: {
  brains: () => Brain[];
  refresh: (id: string) => Promise<unknown>;
  digest: (id: string) => void;
  running: (id: string) => boolean;
  now?: () => Date;
  tick?: number;
}): () => void {
  const now = d.now ?? (() => new Date());
  const refreshing = new Set<string>();
  // brain id -> when its last refresh failed (it rejected or answered ok: false).
  const failedAt = new Map<string, number>();
  // brain id -> the Monday its digest was enqueued, so a slow lastDigestAt write never enqueues it twice.
  const digested = new Map<string, number>();

  const check = () => {
    const at = now();
    for (const b of d.brains()) {
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
      const monday = thisMonday(at)?.getTime();
      if (
        monday !== undefined &&
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
    }
  };

  const first = setTimeout(check, 0);
  const timer = setInterval(check, d.tick ?? TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
