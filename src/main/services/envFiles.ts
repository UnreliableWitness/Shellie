import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CopyEntry } from '../../shared/types';
import type { GitClient } from './GitClient';
import { findEnvCandidates } from './repoInspect';
import { insideDir } from './SetupRunner';

export type CopyEntryDeps = {
  git: GitClient;
  /** Repo-relative (`/`) copied files that hold a stored secret; from the Secrets feature, not detected here. */
  secretFiles: (repoPath: string) => Promise<string[]>;
};

const norm = (p: string) =>
  path
    .normalize(p.replace(/\\/g, '/'))
    .split(path.sep)
    .join('/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');

async function countFiles(
  dir: string,
): Promise<{ files: number; size: number }> {
  let files = 0;
  let size = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        files++;
        size += (await fs.stat(full)).size;
      }
    }
  };
  await walk(dir).catch(() => undefined);
  return { files, size };
}

async function ignored(
  git: GitClient,
  repoPath: string,
  rel: string,
): Promise<boolean> {
  try {
    await git.run(repoPath, ['check-ignore', '-q', '--', rel]);
    return true;
  } catch {
    // Exit 1: not ignored (also when git cannot say, which is the safer reading for a warning).
    return false;
  }
}

/**
 * The state of each `copy:` entry of a repo. Precedence: outside, missing, notIgnored, holdsSecrets, present.
 * `suggestions` are the ignored env files in the repo's top folder that are not listed.
 */
export async function inspectCopyEntries(
  repoPath: string,
  copy: string[],
  deps: CopyEntryDeps,
): Promise<{ entries: CopyEntry[]; suggestions: string[] }> {
  const secrets = (await deps.secretFiles(repoPath).catch(() => [])).map(norm);
  const entries: CopyEntry[] = [];
  for (const raw of copy) {
    const rel = norm(raw);
    const abs = insideDir(repoPath, raw);
    if (abs === null || abs === path.resolve(repoPath)) {
      entries.push({ path: raw, state: 'outside', folder: false });
      continue;
    }
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      entries.push({ path: raw, state: 'missing', folder: false });
      continue;
    }
    const folder = st.isDirectory();
    const counts = folder ? await countFiles(abs) : null;
    const base = {
      path: raw,
      folder,
      ...(counts ? { files: counts.files } : {}),
      size: counts ? counts.size : st.size,
      modified: st.mtime.toISOString(),
    };
    if (!(await ignored(deps.git, repoPath, rel))) {
      entries.push({ ...base, state: 'notIgnored' });
    } else if (secrets.some((f) => f === rel || f.startsWith(`${rel}/`))) {
      entries.push({ ...base, state: 'holdsSecrets' });
    } else entries.push({ ...base, state: 'present' });
  }
  const listed = new Set(copy.map(norm));
  const suggestions = (
    await findEnvCandidates(repoPath, deps.git).catch(() => [])
  ).filter((f) => !listed.has(f));
  return { entries, suggestions };
}
