/**
 * Calls `fn(key)` at once for a key's first call, then at most once per `ms` for that key: calls inside a
 * window collapse into one call when it closes. Keys throttle independently.
 */
export function throttleByKey(
  fn: (key: string) => void,
  ms: number,
): (key: string) => void {
  const windows = new Map<string, { again: boolean }>();
  const open = (key: string) => {
    const w = { again: false };
    windows.set(key, w);
    const t = setTimeout(() => {
      if (!w.again) {
        windows.delete(key);
        return;
      }
      fn(key);
      open(key);
    }, ms);
    t.unref?.();
  };
  return (key) => {
    const w = windows.get(key);
    if (w) {
      w.again = true;
      return;
    }
    fn(key);
    open(key);
  };
}
