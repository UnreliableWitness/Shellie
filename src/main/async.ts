/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Yields to the event loop once, so long synchronous work does not starve IPC and timers. */
export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * `promise`, or `onTimeout()` when it has not settled within `ms`. The timer is always cleared, so a
 * settled promise never keeps the process alive.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
