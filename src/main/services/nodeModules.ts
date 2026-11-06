import path from 'node:path';
import { readJson } from '../fsRetry';

type LockEntry = {
  version?: string;
  resolved?: string;
  integrity?: string;
  optional?: boolean;
  devOptional?: boolean;
  link?: boolean;
};

function packagesOf(doc: unknown): Record<string, LockEntry> | null {
  if (typeof doc !== 'object' || doc === null) return null;
  const packages = (doc as { packages?: unknown }).packages;
  if (typeof packages !== 'object' || packages === null) return null;
  const out: Record<string, LockEntry> = {};
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue;
    out[key] = (entry ?? {}) as LockEntry;
  }
  return out;
}

/**
 * Whether an installed tree (npm's hidden lockfile, `node_modules/.package-lock.json`) is what `npm ci` would install
 * from `lock` (a `package-lock.json`). Lockfile packages that were not installed are fine when optional (other
 * platforms' binaries). Workspaces and links never match: their contents live outside node_modules.
 */
export function lockMatches(hidden: unknown, lock: unknown): boolean {
  const installed = packagesOf(hidden);
  const wanted = packagesOf(lock);
  if (!installed || !wanted) return false;
  const plain = (entries: Record<string, LockEntry>) =>
    Object.entries(entries).every(
      ([key, e]) => key.startsWith('node_modules/') && !e.link,
    );
  if (!plain(installed) || !plain(wanted)) return false;
  for (const [key, want] of Object.entries(wanted)) {
    const have = installed[key];
    if (!have) {
      if (want.optional || want.devOptional) continue;
      return false;
    }
    if (
      have.version !== want.version ||
      have.resolved !== want.resolved ||
      have.integrity !== want.integrity
    )
      return false;
  }
  return Object.keys(installed).every((key) => key in wanted);
}

/** Whether the `node_modules` folder is up to date for the `package-lock.json` file. False when either is missing. */
export async function nodeModulesMatch(
  nodeModules: string,
  lockFile: string,
): Promise<boolean> {
  const [hidden, lock] = await Promise.all([
    readJson(path.join(nodeModules, '.package-lock.json')),
    readJson(lockFile),
  ]);
  return lockMatches(hidden, lock);
}
