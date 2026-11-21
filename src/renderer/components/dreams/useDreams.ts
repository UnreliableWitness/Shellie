import { useCallback, useSyncExternalStore } from 'react';
import type { DreamView } from '../../../shared/dreams';
import { api } from '../../api';

/** Bursts of `dream:changed` collapse into one refetch. */
const DEBOUNCE_MS = 100;

type State = { view: DreamView | null; failed: boolean };
const EMPTY: State = { view: null, failed: false };

/**
 * One view for every mounted consumer (navigation, Home, the Dreams screens): one `dream:changed` listener, one
 * debounce and one `dream:get` per change, however many components show it. Dropped when the last one unmounts.
 */
let state = EMPTY;
const subs = new Set<() => void>();
let off: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Bumped when the last consumer leaves: an answer from before is dropped. */
let gen = 0;
let asked = 0;
let shown = 0;
let loading = 0;

const set = (next: State) => {
  state = next;
  for (const f of subs) f();
};

const load = () => {
  const g = gen;
  const n = ++asked;
  loading++;
  api()
    .invoke('dream:get')
    .then(
      (view) => {
        // An answer older than one already shown is ignored.
        if (g !== gen || n < shown) return;
        shown = n;
        set({ view, failed: false });
      },
      () => {
        // A failed refetch keeps what was shown; a failed first load says so.
        if (g === gen && !state.view) set({ view: null, failed: true });
      },
    )
    .finally(() => {
      if (g === gen) loading--;
    });
};

const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn);
  if (subs.size === 1)
    off = api().on('dream:changed', () => {
      clearTimeout(timer);
      // Always a new fetch: one under way may answer with a view from before the change.
      timer = setTimeout(load, DEBOUNCE_MS);
    });
  // A screen that mounts shows fresh numbers; screens that mount together share one call.
  if (loading === 0) load();
  return () => {
    subs.delete(fn);
    if (subs.size > 0) return;
    off?.();
    off = null;
    clearTimeout(timer);
    gen++;
    state = EMPTY;
    asked = shown = loading = 0;
  };
};

const current = (): State => state;

/**
 * Everything the Dreams screens show: fetched on mount and again on `dream:changed`. `view` is null while loading
 * and when the first load failed (`failed`); `retry` loads again.
 */
export function useDreamsState(): {
  view: DreamView | null;
  failed: boolean;
  retry: () => void;
} {
  const s = useSyncExternalStore(subscribe, current);
  const retry = useCallback(() => {
    set(EMPTY);
    load();
  }, []);
  return { ...s, retry };
}

/** The view alone; null while loading or when it could not be loaded. */
export function useDreams(): DreamView | null {
  return useDreamsState().view;
}
