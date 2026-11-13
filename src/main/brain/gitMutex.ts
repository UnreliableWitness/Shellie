import path from 'node:path';

/** The tail of each brain folder's queue of git writes. */
const tails = new Map<string, Promise<void>>();

const idleListeners = new Set<(dir: string) => void>();

/**
 * Calls `listener` with a brain folder (resolved) each time its `withBrainGit` queue empties: after a callback settles,
 * fulfilled or not, with no other one waiting. Returns the unsubscribe.
 */
export function onBrainGitIdle(listener: (dir: string) => void): () => void {
  idleListeners.add(listener);
  return () => idleListeners.delete(listener);
}

function idle(dir: string) {
  for (const l of idleListeners) {
    try {
      l(dir);
    } catch (e) {
      console.error('brain git idle listener failed', e);
    }
  }
}

/**
 * Runs `fn` after every earlier `withBrainGit` of the same brain folder has settled, so two commits in one brain repo
 * never race for `.git/index.lock` or sweep each other's staged files. In-process only; jobs of other processes use
 * brain/lock.
 */
export function withBrainGit<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir);
  const run = (tails.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) !== tail) return;
    tails.delete(key);
    idle(key);
  });
  return run;
}
