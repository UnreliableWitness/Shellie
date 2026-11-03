import path from 'node:path';

/** The tail of each brain folder's queue of git writes. */
const tails = new Map<string, Promise<void>>();

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
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
