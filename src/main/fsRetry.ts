import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sleep } from './async';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const WAITS = [50, 100, 200, 400, 800];

export type Wait = (ms: number) => Promise<void>;
export const realWait: Wait = sleep;

/** Runs `fn`, retrying with a backoff (default 50/100/200/400/800 ms) while `retryable(error)` holds. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retryable: (e: unknown) => boolean,
  wait: Wait = realWait,
  waits: readonly number[] = WAITS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!retryable(e) || attempt >= waits.length) throw e;
      await wait(waits[attempt]);
    }
  }
}

/** True when `p` exists (any kind of entry). */
export const pathExists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/** True when `p` is a regular file (a missing path or a folder is false, never an error). */
export const isFile = (p: string): Promise<boolean> =>
  fs.stat(p).then(
    (st) => st.isFile(),
    () => false,
  );

/** A file's text; null when it is missing (any other read error throws). */
export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Reads a JSON file; null when it is missing or not JSON. */
export async function readJson<T = unknown>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** The `records-YYYY-MM.jsonl` files of a store folder, oldest month first; none when the folder does not exist yet. */
export async function monthFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir))
      .filter((f) => /^records-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return [];
  }
}

/** fs.rename that rides out short locks held by antivirus or indexers (common on Windows). */
export async function renameWithRetry(
  from: string,
  to: string,
  rename: (a: string, b: string) => Promise<void> = fs.rename,
  wait: Wait = realWait,
): Promise<void> {
  await withRetry(
    () => rename(from, to),
    (e) => RETRYABLE.has((e as NodeJS.ErrnoException).code ?? ''),
    wait,
  );
}

/**
 * Writes `text` to a sibling temp file and renames it over `file`, so a reader never sees a half-written
 * file. `tmpSuffix` names the temp file (default `.tmp`); pass a unique one when several writers may race.
 */
export async function writeAtomic(
  file: string,
  text: string,
  tmpSuffix = '.tmp',
): Promise<void> {
  const tmp = `${file}${tmpSuffix}`;
  await fs.writeFile(tmp, text, 'utf8');
  await renameWithRetry(tmp, file);
}

/**
 * Deletes a folder and everything in it without following links. On Windows every path goes through the
 * `\\?\` namespace, so names the Win32 layer rejects (`nul`, `con`, a trailing dot or space) and long
 * paths can be deleted too; read-only files are made writable first. Locks are retried like a rename.
 *
 * An entry that stays locked does not stop the rest: everything else goes, then the first error is thrown
 * with its own code (EPERM, EBUSY), so a caller can tell "a process holds a file" from anything else.
 */
export async function removeTree(
  dir: string,
  wait: Wait = realWait,
  ops: TreeOps = fs,
): Promise<void> {
  const ns = (p: string) => path.toNamespacedPath(path.resolve(p));
  const retry = <T>(fn: () => Promise<T>, extra?: string) =>
    withRetry(
      fn,
      (e) => {
        const code = (e as NodeJS.ErrnoException).code ?? '';
        return RETRYABLE.has(code) || code === extra;
      },
      wait,
    );
  const unlink = async (p: string) => {
    try {
      await ops.unlink(ns(p));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
      // A read-only file on Windows; a link to a folder is removed with rmdir.
      await ops.chmod(ns(p), 0o666).catch(() => undefined);
      try {
        await ops.unlink(ns(p));
      } catch (again) {
        // rmdir on a file says ENOENT or ENOTDIR on Windows (#115), which would hide that a process holds it.
        await ops.rmdir(ns(p)).catch(() => {
          throw again;
        });
      }
    }
  };
  let first: unknown = null;
  /** False when something under `p` is left. */
  const walk = async (p: string): Promise<boolean> => {
    try {
      const st = await ops.lstat(ns(p)).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if (!st) return true;
      if (!st.isDirectory() || st.isSymbolicLink()) {
        await retry(() => unlink(p));
        return true;
      }
      let all = true;
      for (const name of await ops.readdir(ns(p)))
        if (!(await walk(path.join(p, name)))) all = false;
      if (!all) return false;
      // ENOTEMPTY: a child Windows has marked for deletion but not yet let go of.
      await retry(() => ops.rmdir(ns(p)), 'ENOTEMPTY');
      return true;
    } catch (e) {
      first ??= e;
      return false;
    }
  };
  if (!(await walk(dir))) throw first;
}

/** The fs calls removeTree makes (tests pass fakes). */
export type TreeOps = {
  lstat(
    p: string,
  ): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readdir(p: string): Promise<string[]>;
  unlink(p: string): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
  rmdir(p: string): Promise<void>;
};
