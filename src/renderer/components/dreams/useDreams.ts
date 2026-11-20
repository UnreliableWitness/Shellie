import { useCallback, useEffect, useRef, useState } from 'react';
import type { DreamView } from '../../../shared/dreams';
import { api } from '../../api';

/** Bursts of `dream:changed` collapse into one refetch. */
const DEBOUNCE_MS = 100;

/**
 * The fetch that is under way: screens that mount together (navigation, Home, Dreams) share one call. Only mount
 * loads share it; a reload after a change always starts a new fetch (and replaces this one), since a fetch under way
 * may answer with a view from before the change.
 */
let inflight: Promise<DreamView> | null = null;
const fetchView = (fresh: boolean): Promise<DreamView> => {
  if (fresh || !inflight) {
    const p = api().invoke('dream:get');
    const done = () => {
      if (inflight === p) inflight = null;
    };
    inflight = p;
    p.then(done, done);
  }
  return inflight;
};

/**
 * Everything the Dreams screens show: fetched on mount and again on `dream:changed`. `view` is null while loading
 * and when the first load failed (`failed`); `retry` loads again. An answer older than one already shown is ignored.
 */
export function useDreamsState(): {
  view: DreamView | null;
  failed: boolean;
  retry: () => void;
} {
  const [state, setState] = useState<{
    view: DreamView | null;
    failed: boolean;
  }>({ view: null, failed: false });
  const live = useRef(true);
  const asked = useRef(0);
  const shown = useRef(0);
  const load = useCallback((fresh: boolean) => {
    const n = ++asked.current;
    fetchView(fresh).then(
      (view) => {
        if (!live.current || n < shown.current) return;
        shown.current = n;
        setState({ view, failed: false });
      },
      () => {
        // A failed refetch keeps what was shown; a failed first load says so.
        if (live.current)
          setState((s) => (s.view ? s : { view: null, failed: true }));
      },
    );
  }, []);
  useEffect(() => {
    live.current = true;
    load(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api().on('dream:changed', () => {
      clearTimeout(timer);
      timer = setTimeout(() => load(true), DEBOUNCE_MS);
    });
    return () => {
      live.current = false;
      off();
      clearTimeout(timer);
    };
  }, [load]);
  const retry = useCallback(() => {
    setState({ view: null, failed: false });
    load(true);
  }, [load]);
  return { ...state, retry };
}

/** The view alone; null while loading or when it could not be loaded. */
export function useDreams(): DreamView | null {
  return useDreamsState().view;
}
