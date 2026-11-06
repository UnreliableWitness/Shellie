import { useCallback, useEffect, useState } from 'react';

/**
 * A value read from main and read again when main reports a change. `load` runs when `deps` change (the value
 * resets to null first; a null `load` only resets) and whenever `subscribe`'s listeners call `refetch`;
 * `subscribe` returns its unsubscribe. With `throttleMs`, refetches within that window run once, at its end.
 * `error` is true when the last load failed (the value keeps its last reading); `reload` loads again.
 */
export function useLiveQuery<T>(
  load: (() => Promise<T>) | null,
  subscribe: (refetch: () => void) => () => void,
  deps: unknown[],
  opts: { throttleMs?: number } = {},
): { value: T | null; error: boolean; reload: () => void } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);
  const { throttleMs } = opts;
  useEffect(() => {
    setValue(null);
    setError(false);
    if (!load) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () =>
      load()
        .then((v) => {
          if (!live) return;
          setValue(v);
          setError(false);
        })
        .catch(() => {
          if (live) setError(true);
        });
    const refetch = throttleMs
      ? () => {
          timer ??= setTimeout(() => {
            timer = null;
            void run();
          }, throttleMs);
        }
      : () => void run();
    void run();
    const off = subscribe(refetch);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` names what `load` and `subscribe` read
  }, [...deps, nonce, throttleMs]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { value, error, reload };
}
