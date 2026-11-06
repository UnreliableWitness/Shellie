import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DELETED_HASH,
  type FileContent,
  type ReviewCommit,
  type ReviewFile,
  type ReviewFileStatus,
  type ReviewScope,
} from '../../shared/review';
import { resolveInWorktree } from '../docs/worktreeFiles';
import type { GitClient } from '../services/GitClient';

/** Git's empty tree (SHA-1 repos): the "before" of a root commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const MAX_CONTENT = 2 * 1024 * 1024;
const MAX_COMMITS = 200;
/** Paths per git call, so Windows' 32k command line is never reached. */
const CHUNK = 200;
const BINARY_SNIFF = 8000;

export class NoBaseError extends Error {
  constructor() {
    super('No base for this task: only uncommitted changes can be shown');
  }
}

/** `to: null` is the working tree (staged and unstaged together). */
export type DiffRange = { from: string; to: string | null };

/** Root-relative, inside the worktree: no absolute paths, no `..`, no NUL. */
export function assertRelPath(p: string): void {
  if (
    !p ||
    p.includes('\0') ||
    path.isAbsolute(p) ||
    path.win32.isAbsolute(p) ||
    p.split(/[\\/]/).includes('..')
  )
    throw new Error('Outside the worktree');
}

/** `-c` goes before the subcommand; quotepath off keeps non-ASCII names raw whatever the user's config. */
const DIFF = [
  '--no-optional-locks',
  '-c',
  'core.quotepath=off',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '-z',
  '-M',
];

export async function rangeFor(
  git: GitClient,
  worktree: string,
  scope: ReviewScope,
  base: string | null,
): Promise<DiffRange> {
  if (scope.kind === 'all') {
    if (!base) throw new NoBaseError();
    return { from: base, to: null };
  }
  if (scope.kind === 'uncommitted') return { from: 'HEAD', to: null };
  const parent = await git
    .run(worktree, ['rev-parse', '--verify', '--quiet', `${scope.from}^`])
    .then((s) => s.trim())
    .catch(() => '');
  return { from: parent || EMPTY_TREE, to: scope.to };
}

/** Paths `git status` lists (staged, unstaged, untracked), as Finish counts them. */
export async function countUncommitted(
  git: GitClient,
  worktree: string,
): Promise<number> {
  const out = await git.run(worktree, [
    '--no-optional-locks',
    'status',
    '--porcelain=v1',
    '-z',
  ]);
  // -z: one NUL-terminated entry per path; a rename adds its old path as an extra entry.
  let n = 0;
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    n++;
    if (e[0] === 'R' || e[0] === 'C') i++;
  }
  return n;
}

const STATUS: Record<string, ReviewFileStatus> = {
  A: 'A',
  C: 'A',
  M: 'M',
  T: 'M',
  U: 'M',
  D: 'D',
  R: 'R',
};

export function parseNameStatus(
  out: string,
): { status: ReviewFileStatus; path: string; oldPath?: string }[] {
  const t = out.split('\0');
  const rows: { status: ReviewFileStatus; path: string; oldPath?: string }[] =
    [];
  for (let i = 0; i < t.length;) {
    const code = t[i++];
    if (!code) continue;
    const status = STATUS[code[0]] ?? 'M';
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = t[i++];
      const p = t[i++];
      rows.push(
        code[0] === 'R' ? { status, path: p, oldPath } : { status, path: p },
      );
    } else rows.push({ status, path: t[i++] });
  }
  return rows;
}

export function parseNumstat(
  out: string,
): Map<string, { added: number; removed: number; binary: boolean }> {
  const t = out.split('\0');
  const m = new Map<
    string,
    { added: number; removed: number; binary: boolean }
  >();
  for (let i = 0; i < t.length; i++) {
    const r = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(t[i]);
    if (!r) continue;
    let p = r[3];
    // A rename leaves the path empty and puts old and new in the next two fields.
    if (p === '') {
      i += 2;
      p = t[i];
    }
    const binary = r[1] === '-';
    m.set(p, {
      added: binary ? 0 : Number(r[1]),
      removed: binary ? 0 : Number(r[2]),
      binary,
    });
  }
  return m;
}

const chunks = <T>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

/** Line count and binary sniff of a new file that git does not track yet. */
async function untrackedStats(
  worktree: string,
  rel: string,
): Promise<{ added: number; binary: boolean }> {
  const abs = path.join(worktree, rel);
  const st = await fs.stat(abs);
  if (st.size > MAX_CONTENT) return { added: 0, binary: false };
  const buf = await fs.readFile(abs);
  if (buf.subarray(0, BINARY_SNIFF).includes(0))
    return { added: 0, binary: true };
  const text = buf.toString('utf8');
  if (text === '') return { added: 0, binary: false };
  return {
    added: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
    binary: false,
  };
}

async function hashes(
  git: GitClient,
  worktree: string,
  range: DiffRange,
  paths: string[],
): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const part of chunks(paths)) {
    if (range.to === null) {
      try {
        const out = await git.run(worktree, ['hash-object', '--', ...part]);
        out
          .trim()
          .split('\n')
          .forEach((h, i) => m.set(part[i], h.trim()));
      } catch {
        // A file vanished or cannot be hashed: hash one by one, '' for the ones that fail.
        for (const p of part) {
          const h = await git
            .run(worktree, ['hash-object', '--', p])
            .then((o) => o.trim())
            .catch(() => '');
          m.set(p, h);
        }
      }
    } else {
      const out = await git.run(worktree, [
        '-c',
        'core.quotepath=off',
        'ls-tree',
        '-r',
        '-z',
        range.to,
        '--',
        ...part,
      ]);
      for (const entry of out.split('\0')) {
        const tab = entry.indexOf('\t');
        if (tab < 0) continue;
        m.set(entry.slice(tab + 1), entry.slice(0, tab).split(' ')[2]);
      }
    }
  }
  return m;
}

export async function listFiles(
  git: GitClient,
  worktree: string,
  range: DiffRange,
): Promise<ReviewFile[]> {
  const refs = range.to === null ? [range.from] : [range.from, range.to];
  const [ns, num, others] = await Promise.all([
    git.run(worktree, [...DIFF, '--name-status', ...refs, '--']),
    git.run(worktree, [...DIFF, '--numstat', ...refs, '--']),
    range.to === null
      ? git.run(worktree, [
          '--no-optional-locks',
          '-c',
          'core.quotepath=off',
          'ls-files',
          '-z',
          '--others',
          '--exclude-standard',
        ])
      : Promise.resolve(''),
  ]);
  const stats = parseNumstat(num);
  const files: Omit<ReviewFile, 'hash'>[] = parseNameStatus(ns).map((r) => ({
    ...r,
    ...(stats.get(r.path) ?? { added: 0, removed: 0, binary: false }),
  }));
  // A nested repo shows as a folder with a trailing slash; it has no diff.
  const untracked = others.split('\0').filter((p) => p && !p.endsWith('/'));
  const untrackedStatsList = await Promise.all(
    untracked.map((p) => untrackedStats(worktree, p).catch(() => null)),
  );
  untracked.forEach((p, i) => {
    const s = untrackedStatsList[i];
    if (s) files.push({ status: 'A', path: p, removed: 0, ...s });
  });
  // In the working tree a moved submodule is a folder: no blob to hash and no text to show.
  const gitlinks = new Map<string, string>();
  if (range.to === null) {
    const shas = await Promise.all(
      files.map(async (f) => {
        if (f.status === 'D') return null;
        const dir = path.join(worktree, f.path);
        const st = await fs.lstat(dir).catch(() => null);
        if (!st?.isDirectory()) return null;
        return git
          .run(dir, ['rev-parse', 'HEAD'])
          .then((o) => o.trim())
          .catch(() => '');
      }),
    );
    files.forEach((f, i) => {
      const sha = shas[i];
      if (sha !== null) gitlinks.set(f.path, sha);
    });
  }
  const live = files
    .filter((f) => f.status !== 'D' && !gitlinks.has(f.path))
    .map((f) => f.path);
  const h = await hashes(git, worktree, range, live);
  return files
    .map((f) => ({
      ...f,
      binary: f.binary || gitlinks.has(f.path),
      hash:
        f.status === 'D'
          ? DELETED_HASH
          : (gitlinks.get(f.path) ?? h.get(f.path) ?? ''),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * How many files `listFiles` lists for the range, without its stats, hashes or file reads:
 * the Changes badge only shows the number, and it refreshes on every worktree event.
 */
export async function countFiles(
  git: GitClient,
  worktree: string,
  range: DiffRange,
): Promise<number> {
  const refs = range.to === null ? [range.from] : [range.from, range.to];
  const [ns, others] = await Promise.all([
    git.run(worktree, [...DIFF, '--name-status', ...refs, '--']),
    range.to === null
      ? git.run(worktree, [
          '--no-optional-locks',
          '-c',
          'core.quotepath=off',
          'ls-files',
          '-z',
          '--others',
          '--exclude-standard',
        ])
      : Promise.resolve(''),
  ]);
  const untracked = others
    .split('\0')
    .filter((p) => p && !p.endsWith('/')).length;
  return parseNameStatus(ns).length + untracked;
}

export async function listCommits(
  git: GitClient,
  worktree: string,
  base: string | null,
): Promise<ReviewCommit[]> {
  if (!base) return [];
  const out = await git.run(worktree, [
    'log',
    '--no-color',
    '-z',
    `--max-count=${MAX_COMMITS}`,
    '--format=%H%x1f%s%x1f%an%x1f%aI',
    `${base}..HEAD`,
  ]);
  return out
    .split('\0')
    .filter((l) => l.trim())
    .map((l) => {
      const [sha, subject, author, date] = l.replace(/^\n/, '').split('\x1f');
      return {
        sha,
        subject: subject ?? '',
        author: author ?? '',
        date: date ?? '',
      };
    });
}

async function sizeAt(
  git: GitClient,
  worktree: string,
  ref: string | null,
  p: string,
): Promise<number | null> {
  if (ref === null) {
    try {
      return (await fs.stat(await resolveInWorktree(worktree, p))).size;
    } catch {
      return null;
    }
  }
  try {
    return Number(
      (await git.run(worktree, ['cat-file', '-s', `${ref}:${p}`])).trim(),
    );
  } catch {
    return null;
  }
}

/** One side of a file: a ref's blob, or the working tree when `ref` is null. Null when it does not exist there. */
export async function readSide(
  git: GitClient,
  worktree: string,
  ref: string | null,
  p: string,
): Promise<string | null> {
  assertRelPath(p);
  if (ref === null) {
    try {
      return await fs.readFile(await resolveInWorktree(worktree, p), 'utf8');
    } catch {
      return null;
    }
  }
  try {
    return await git.run(worktree, ['cat-file', 'blob', `${ref}:${p}`]);
  } catch {
    return null;
  }
}

export async function readContent(
  git: GitClient,
  worktree: string,
  range: DiffRange,
  file: Pick<ReviewFile, 'path' | 'oldPath' | 'status' | 'binary'>,
): Promise<FileContent> {
  assertRelPath(file.path);
  if (file.oldPath) assertRelPath(file.oldPath);
  const beforePath = file.oldPath ?? file.path;
  const [beforeSize, afterSize] = await Promise.all([
    file.status === 'A'
      ? 0
      : sizeAt(git, worktree, range.from, beforePath).then((n) => n ?? 0),
    file.status === 'D'
      ? 0
      : sizeAt(git, worktree, range.to, file.path).then((n) => n ?? 0),
  ]);
  const tooLarge =
    !file.binary && Math.max(beforeSize, afterSize) > MAX_CONTENT;
  if (file.binary || tooLarge)
    return {
      before: null,
      after: null,
      binary: file.binary,
      tooLarge,
      beforeSize,
      afterSize,
    };
  const [before, after] = await Promise.all([
    file.status === 'A'
      ? ''
      : readSide(git, worktree, range.from, beforePath).then((t) => t ?? ''),
    file.status === 'D'
      ? ''
      : readSide(git, worktree, range.to, file.path).then((t) => t ?? ''),
  ]);
  return {
    before,
    after,
    binary: false,
    tooLarge: false,
    beforeSize,
    afterSize,
  };
}
