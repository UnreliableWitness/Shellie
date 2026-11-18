import { useEffect, useState } from 'react';
import type { PulseView } from '../../shared/pulse';
import { api } from '../api';

const TIME_THROTTLE_MS = 30_000;

/** PR, CI and review status per task plus last terminal activity: read on mount, on every `pulse:changed`, and on `time:changed` at most every 30 s. Null until the first read. */
export function usePulse(): PulseView | null {
  const [view, setView] = useState<PulseView | null>(null);
  useEffect(() => {
    let live = true;
    let lastRead = 0;
    const read = () => {
      lastRead = Date.now();
      void api()
        .invoke('pulse:get')
        .then((v) => {
          if (live && v) setView(v);
        })
        .catch(() => undefined);
    };
    read();
    const offs = [
      api().on('pulse:changed', read),
      api().on('time:changed', () => {
        if (Date.now() - lastRead >= TIME_THROTTLE_MS) read();
      }),
    ];
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  }, []);
  return view;
}
