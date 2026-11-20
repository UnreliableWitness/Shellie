import { useCallback, useEffect, useRef, useState } from 'react';
import type { DreamView } from '../../../shared/dreams';
import { api } from '../../api';

/** Bursts of `dream:changed` collapse into one refetch. */
const DEBOUNCE_MS = 100;

/** Everything the Dreams screens show: fetched on mount and again on `dream:changed`; null while loading. */
export function useDreams(): DreamView | null {
  const [view, setView] = useState<DreamView | null>(null);
  const live = useRef(true);
  const load = useCallback(() => {
    api()
      .invoke('dream:get')
      // A failed refetch keeps what was shown.
      .then(
        (v) => live.current && setView(v),
        () => undefined,
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
  return view;
}
