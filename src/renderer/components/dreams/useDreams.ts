import { useCallback, useEffect, useRef, useState } from 'react';
import type { DreamView } from '../../../shared/dreams';
import { api } from '../../api';

/** Bursts of `dream:changed` collapse into one refetch. */
const DEBOUNCE_MS = 100;

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
  const load = useCallback(() => {
    const n = ++asked.current;
    api()
      .invoke('dream:get')
      .then(
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
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api().on('dream:changed', () => {
      clearTimeout(timer);
      timer = setTimeout(load, DEBOUNCE_MS);
    });
    return () => {
      live.current = false;
      off();
      clearTimeout(timer);
    };
  }, [load]);
  const retry = useCallback(() => {
    setState({ view: null, failed: false });
    load();
  }, [load]);
  return { ...state, retry };
}

/** The view alone; null while loading or when it could not be loaded. */
export function useDreams(): DreamView | null {
  return useDreamsState().view;
}
