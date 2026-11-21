import { useEffect, useState } from 'react';
import type { PulseSnapshot } from '../../shared/pulse';
import { api } from '../api';

/** PR, CI and review status per task: read on mount and on every `pulse:changed`. Null until the first read. */
export function usePulse(): PulseSnapshot | null {
  const [view, setView] = useState<PulseSnapshot | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => {
      void api()
        .invoke('pulse:get')
        .then((v) => {
          if (live && v) setView(v);
        })
        .catch(() => undefined);
    };
    read();
    const off = api().on('pulse:changed', read);
    return () => {
      live = false;
      off();
    };
  }, []);
  return view;
}
