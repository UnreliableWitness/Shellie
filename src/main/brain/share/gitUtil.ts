/** Small git and JSON helpers the shared-brains code uses throughout. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitClient } from '../../services/GitClient';
import { EMPTY_TREE } from '../../review/reviewGit';

/** The server's branch, as fetched into a shared brain's folder. */
export const SERVER = 'origin/main';

/** Whether a git command exits cleanly (a check such as `merge-base --is-ancestor`). */
export const succeeds = (
  git: GitClient,
  dir: string,
  args: string[],
): Promise<boolean> =>
  git.run(dir, args).then(
    () => true,
    () => false,
  );

export const headOf = async (git: GitClient, dir: string): Promise<string> =>
  (await git.run(dir, ['rev-parse', 'HEAD'])).trim();

export const isAncestor = (
  git: GitClient,
  dir: string,
  a: string,
  b: string,
): Promise<boolean> =>
  succeeds(git, dir, ['merge-base', '--is-ancestor', a, b]);

/** What the brain is compared with: the server's main, or the empty tree before it has one. */
export const serverBase = async (
  git: GitClient,
  dir: string,
): Promise<string> =>
  (await git.commitExists(dir, SERVER)) ? SERVER : EMPTY_TREE;

/** The commits from `base` to `tip` the server lacks: a range for rev-list and log. */
export const unsentRange = (base: string, tip: string): string =>
  base === EMPTY_TREE ? tip : `${base}..${tip}`;

/** How many commits up to `tip` the server lacks (every commit before the first push). */
export async function unsentCount(
  git: GitClient,
  dir: string,
  tip = 'HEAD',
  base?: string,
): Promise<number> {
  const range = unsentRange(base ?? (await serverBase(git, dir)), tip);
  return Number((await git.run(dir, ['rev-list', '--count', range])).trim());
}

/**
 * Builds a tree in an index file of its own (named `name` in the git dir), starting from `base`'s tree, so the
 * person's staged work stays out; `fn` changes that index through `env`. Returns the tree's id; the index is removed.
 */
export async function withPrivateIndex(
  git: GitClient,
  dir: string,
  name: string,
  base: string,
  fn: (env: { GIT_INDEX_FILE: string }, index: string) => Promise<void>,
): Promise<string> {
  const index = path.resolve(
    dir,
    (await git.run(dir, ['rev-parse', '--git-path', name])).trim(),
  );
  const env = { GIT_INDEX_FILE: index };
  try {
    await git.run(dir, ['read-tree', base], { env });
    await fn(env, index);
    return (await git.run(dir, ['write-tree'], { env })).trim();
  } finally {
    await fs.rm(index, { force: true });
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** The JSON value of `text`; null when it is not JSON. */
export function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Sets each long read's `commit` in a `brain/reads.json` value to `fn(commit)` (unknown keys kept): whether one
 * changed, or null when the value has no `reads` map.
 */
export function mapReadCommits(
  value: unknown,
  fn: (commit: unknown) => unknown,
): boolean | null {
  const reads = isRecord(value) ? value.reads : null;
  if (!reads || typeof reads !== 'object') return null;
  let changed = false;
  for (const r of Object.values(reads as Record<string, unknown>)) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as { commit?: unknown };
    const next = fn(rec.commit);
    if (next !== rec.commit) changed = true;
    rec.commit = next;
  }
  return changed;
}
