/**
 * OpenCode's model list for dreams: one cache that the scheduler and `dream:get` share (and that
 * `agents:opencodeModels` feeds). Asking runs `opencode models` through a login shell or PowerShell, so it happens
 * at most every 10 minutes, a failed ask is kept as long, and `known()` never starts a process.
 */

import { withTimeout } from '../async';

/** `opencode models` is asked again at most this often, also after a failed ask. */
export const MODELS_MS = 10 * 60_000;
/** A hung `opencode models` is given up on after this. */
export const MODELS_TIMEOUT_MS = 30_000;

type Entry = { at: number; list: string[] | null; failed: boolean };

export type OpencodeModelList = ReturnType<typeof opencodeModelList>;

export function opencodeModelList(o: {
  /** Runs `opencode models`; null when OpenCode is missing or failing. */
  ask: () => Promise<string[] | null>;
  now: () => number;
}) {
  let entry: Entry | null = null;
  let asking: Promise<string[] | null> | null = null;

  /** A failed ask keeps the last good list for one more interval; a second in a row gives none. */
  const store = (asked: string[] | null) => {
    const keep = asked === null && entry?.list && !entry.failed;
    entry = keep
      ? { at: o.now(), list: entry!.list, failed: true }
      : { at: o.now(), list: asked, failed: asked === null };
    return entry.list;
  };

  const askNow = (): Promise<string[] | null> =>
    (asking ??= (async () => {
      try {
        return store(
          await withTimeout(
            o.ask().catch(() => null),
            MODELS_TIMEOUT_MS,
            () => null,
          ),
        );
      } finally {
        asking = null;
      }
    })());

  return {
    /** The list as last known; null when never known or the last two asks failed. Never starts a process. */
    known(): string[] | null {
      return entry?.list ?? null;
    },
    /** The list, asked again when the last answer (good or failed) is 10 minutes old, or with `fresh`. */
    get(fresh = false): Promise<string[] | null> {
      if (!fresh && entry && o.now() - entry.at < MODELS_MS)
        return Promise.resolve(entry.list);
      return askNow();
    },
    /** A list `agents:opencodeModels` read for another screen; a failed read there forgets nothing. */
    seen(list: string[] | null): void {
      if (list) entry = { at: o.now(), list, failed: false };
    },
  };
}
