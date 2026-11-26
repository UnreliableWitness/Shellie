import { useSyncExternalStore } from 'react';

/** Under this window width the nav is the rail whatever the setting: the page needs the room. */
export const NARROW_WINDOW_PX = 860;
const QUERY = `(max-width: ${NARROW_WINDOW_PX - 1}px)`;

const subscribe = (cb: () => void) => {
  const q = window.matchMedia?.(QUERY);
  q?.addEventListener('change', cb);
  return () => q?.removeEventListener('change', cb);
};
const narrow = () => window.matchMedia?.(QUERY).matches ?? false;

export function useNarrowWindow(): boolean {
  return useSyncExternalStore(subscribe, narrow);
}
