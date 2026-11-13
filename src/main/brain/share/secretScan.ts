/**
 * The secrets gate of a shared brain (the shared-brains spec, "Check" and "Secrets on every push"): the whole tree at
 * share time, and the text each unsent commit adds before a push. Every git output is kept under GitClient's 16 MB
 * buffer: diffs are read a chunk of files at a time, and a file larger than a chunk is read from the commit on its own.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitClient } from '../../services/GitClient';
import { absPath } from '../paths';
import { EMPTY_TREE } from '../../review/reviewGit';
import { findSecrets } from '../secrets';
/** One diff reads at most this much (git's output must fit GitClient's 16 MB buffer) and this many paths. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNK_PATHS = 100;
const NO_BLOB = /^0+$/;

/** A path as git prints it in a diff header: C-quoted (`"b/a\"b.md"`) when it holds a quote, a backslash or a control character. */
export function unquoteGitPath(name: string): string {
  if (!name.startsWith('"') || name.length < 2) return name;
  const chars = Array.from(name.slice(1, name.lastIndexOf('"')));
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    '\\': 92,
  };
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c !== '\\' || i + 1 >= chars.length) {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = chars[++i];
    const octal = chars.slice(i, i + 3).join('');
    if (Object.hasOwn(escapes, n)) bytes.push(escapes[n]);
    else if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else bytes.push(...Buffer.from(n, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The files a diff adds a possible secret to, in diff order. */
export function secretsInDiff(diff: string): string[] {
  const out: string[] = [];
  let file: string | null = null;
  let lines: string[] = [];
  let header = false;
  const check = () => {
    if (file && findSecrets(lines.join('\n')).length) out.push(file);
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      check();
      header = true;
      file = null;
      lines = [];
    } else if (header && line.startsWith('+++ ')) {
      const name = unquoteGitPath(line.slice(4).replace(/\t$/, ''));
      file =
        name === '/dev/null'
          ? null
          : name.startsWith('b/')
            ? name.slice(2)
            : name;
    } else if (line.startsWith('@@')) {
      header = false;
    } else if (!header && file && line.startsWith('+')) {
      lines.push(line.slice(1));
    }
  }
  check();
  return out;
}

/** Paths in groups whose summed size stays under `chunkBytes`; a path larger than that on its own goes to `large`. */
function chunked(
  files: { path: string; size: number }[],
  chunkBytes: number,
): { chunks: string[][]; large: string[] } {
  const chunks: string[][] = [];
  const large: string[] = [];
  let chunk: string[] = [];
  let bytes = 0;
  for (const f of files) {
    if (f.size > chunkBytes) {
      large.push(f.path);
      continue;
    }
    if (chunk.length >= CHUNK_PATHS || bytes + f.size > chunkBytes) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(f.path);
    bytes += f.size;
  }
  if (chunk.length) chunks.push(chunk);
  return { chunks, large };
}

/** The diff between two trees for some paths: only the lines each adds, never an external diff. */
const diff = (
  git: GitClient,
  dir: string,
  from: string,
  to: string,
  paths: string[],
) =>
  git.run(dir, [
    '--literal-pathspecs',
    '-c',
    'core.quotepath=off',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    '-U0',
    from,
    to,
    '--',
    ...paths,
  ]);

/** The repo-relative files of `commit`'s tree that hold a possible secret: diffs of chunks, then large files alone. */
export async function treeSecretFiles(
  git: GitClient,
  dir: string,
  commit: string,
  chunkBytes = CHUNK_BYTES,
): Promise<string[]> {
  const listing = await git.run(dir, [
    '-c',
    'core.quotepath=off',
    'ls-tree',
    '-r',
    '-z',
    '-l',
    commit,
  ]);
  const blobs: { path: string; size: number }[] = [];
  for (const rec of listing.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [, type, , size] = rec.slice(0, tab).split(/\s+/);
    if (type === 'blob') blobs.push({ path: rec.slice(tab + 1), size: +size });
  }
  const { chunks, large } = chunked(blobs, chunkBytes);
  const found: string[] = [];
  // Every line of every text file, as added since the empty tree; git leaves binary files out.
  for (const paths of chunks)
    found.push(
      ...secretsInDiff(await diff(git, dir, EMPTY_TREE, commit, paths)),
    );
  found.push(...(await largeSecretFiles(git, dir, commit, large)));
  return found;
}

/**
 * The blobs too large for one diff, as `commit` has them: written by git into a scratch folder of the git dir, read
 * from there whole, and removed. Whole, not only the added lines: stricter, never looser.
 */
async function largeSecretFiles(
  git: GitClient,
  dir: string,
  commit: string,
  paths: string[],
): Promise<string[]> {
  if (!paths.length) return [];
  const scratch = path.resolve(
    dir,
    (
      await git.run(dir, ['rev-parse', '--git-path', 'shellie-share-scan'])
    ).trim(),
  );
  const env = { GIT_INDEX_FILE: `${scratch}.index` };
  const found: string[] = [];
  try {
    await fs.rm(scratch, { recursive: true, force: true });
    await git.run(dir, ['read-tree', commit], { env });
    for (let n = 0; n < paths.length; n += CHUNK_PATHS)
      await git.run(
        dir,
        [
          '--literal-pathspecs',
          'checkout-index',
          '-f',
          `--prefix=${scratch}${path.sep}`,
          '--',
          ...paths.slice(n, n + CHUNK_PATHS),
        ],
        { env },
      );
    for (const p of paths) {
      const text = await fs.readFile(absPath(scratch, p), 'utf8');
      if (!text.includes('\0') && findSecrets(text).length) found.push(p);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
    await fs.rm(env.GIT_INDEX_FILE, { force: true });
  }
  return found;
}

/** The sizes of some blobs, by `git ls-tree -l` of `commit` for their paths (a path the commit lacks is left out). */
async function blobSizes(
  git: GitClient,
  dir: string,
  commit: string,
  paths: string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (let n = 0; n < paths.length; n += CHUNK_PATHS) {
    const listing = await git.run(dir, [
      '--literal-pathspecs',
      '-c',
      'core.quotepath=off',
      'ls-tree',
      '-z',
      '-l',
      commit,
      '--',
      ...paths.slice(n, n + CHUNK_PATHS),
    ]);
    for (const rec of listing.split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const size = Number(rec.slice(0, tab).split(/\s+/)[3]);
      sizes.set(rec.slice(tab + 1), Number.isFinite(size) ? size : 0);
    }
  }
  return sizes;
}

/** The first file `commit` adds a possible secret to (against its first parent, or the empty tree), or null. */
async function commitSecretFile(
  git: GitClient,
  dir: string,
  commit: string,
  chunkBytes: number,
): Promise<string | null> {
  const parent = await git
    .run(dir, ['rev-parse', '--verify', '-q', `${commit}^1`])
    .then(
      (o) => o.trim(),
      () => EMPTY_TREE,
    );
  // What the commit touches, and the blob it leaves (none: deleted); no file text yet.
  const raw = await git.run(dir, [
    '-c',
    'core.quotepath=off',
    'diff-tree',
    '-r',
    '-z',
    '--no-renames',
    '--no-commit-id',
    parent,
    commit,
  ]);
  const fields = raw.split('\0');
  const touched: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i].split(' ');
    if (meta.length < 5 || NO_BLOB.test(meta[3])) continue;
    touched.push(fields[i + 1]);
  }
  if (!touched.length) return null;
  // A diff holds both sides' lines (-U0 still lists the removed ones), so a file is as large as its larger side.
  const before =
    parent === EMPTY_TREE
      ? new Map<string, number>()
      : await blobSizes(git, dir, parent, touched);
  const after = await blobSizes(git, dir, commit, touched);
  const { chunks, large } = chunked(
    touched.map((p) => ({
      path: p,
      size: Math.max(before.get(p) ?? 0, after.get(p) ?? 0),
    })),
    chunkBytes,
  );
  for (const paths of chunks) {
    const hit = secretsInDiff(await diff(git, dir, parent, commit, paths))[0];
    if (hit) return hit;
  }
  return (await largeSecretFiles(git, dir, commit, large))[0] ?? null;
}

/**
 * The first file a commit in `range` (a rev-list range) adds a possible secret to, or null. Each commit on its own: a
 * line a later commit took out still goes to the server in the earlier one. A merge adds nothing of its own here (its
 * local side was scanned in the commits it merged). Throws when a scan cannot run: the caller holds the push then.
 * Commits in `clean` are skipped, and each commit found clean is added to it.
 */
export async function unsentSecretFile(
  git: GitClient,
  dir: string,
  range: string,
  chunkBytes = CHUNK_BYTES,
  clean?: Set<string>,
): Promise<string | null> {
  const commits = (
    await git.run(dir, ['rev-list', '--reverse', '--no-merges', range])
  )
    .split('\n')
    .map((c) => c.trim())
    .filter(Boolean);
  for (const c of commits) {
    if (clean?.has(c)) continue;
    const file = await commitSecretFile(git, dir, c, chunkBytes);
    if (file) return file;
    clean?.add(c);
  }
  return null;
}
