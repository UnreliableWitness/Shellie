import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocFile } from '../../shared/types';
import { isInside, toRel } from '../paths';
import type { GitClient } from '../services/GitClient';

export const MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_DOCS = 2000;
export const TASK_FILE = '.shellie/task.md';
const SPECS = [':(icase)*.md', ':(icase)*.markdown'];
export const MD = /\.(md|markdown)$/i;
export const HTML = /\.html?$/i;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** The real path of a regular file inside the worktree, after following symlinks. */
export async function resolveInWorktree(
  worktree: string,
  rel: string,
): Promise<string> {
  if (!rel || rel.includes('\0')) throw new Error('Outside the worktree');
  const lexical = path.resolve(worktree);
  const root = await fs.realpath(worktree);
  // An absolute path printed in a terminal uses the worktree path as Shellie knows it, which may differ from its realpath (macOS /var).
  const joined = path.isAbsolute(rel)
    ? isInside(lexical, rel)
      ? path.join(root, path.relative(lexical, rel))
      : path.resolve(rel)
    : path.resolve(root, rel);
  if (!isInside(root, joined)) throw new Error('Outside the worktree');
  let real: string;
  try {
    real = await fs.realpath(joined);
  } catch {
    throw new Error('Not found');
  }
  if (!isInside(root, real)) throw new Error('Outside the worktree');
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error('Not found');
  return real;
}

const splitZ = (out: string) => out.split('\0').filter(Boolean);

/** Markdown files changed against `base` (added, modified, untracked); empty without a base. */
export async function changedDocs(
  git: GitClient,
  worktree: string,
  base: string | null,
): Promise<Map<string, 'new' | 'modified'>> {
  const changed = new Map<string, 'new' | 'modified'>();
  if (!base) return changed;
  const diffRun = git
    .run(worktree, [
      'diff',
      '-z',
      '--name-status',
      '--no-renames',
      base,
      '--',
      ...SPECS,
    ])
    .catch(() => '');
  const untrackedRun = git.run(worktree, [
    'ls-files',
    '-z',
    '-o',
    '--exclude-standard',
    '--',
    ...SPECS,
  ]);
  untrackedRun.catch(() => {});
  const diff = splitZ(await diffRun);
  for (let i = 0; i + 1 < diff.length; i += 2) {
    const status = diff[i][0];
    if (status === 'A') changed.set(diff[i + 1], 'new');
    else if (status === 'M' || status === 'T')
      changed.set(diff[i + 1], 'modified');
  }
  for (const p of splitZ(await untrackedRun)) changed.set(p, 'new');
  return changed;
}

export async function listDocs(
  git: GitClient,
  worktree: string,
  baseSha: string | null,
): Promise<DocFile[]> {
  // Both run at once but are awaited in the old order, so the same failure surfaces first.
  const listedRun = git.run(worktree, [
    'ls-files',
    '-z',
    '-co',
    '--exclude-standard',
    '--',
    ...SPECS,
  ]);
  const changedRun = changedDocs(git, worktree, baseSha);
  changedRun.catch(() => {});
  const hasTaskRun = fs.stat(path.join(worktree, TASK_FILE)).then(
    (s) => s.isFile(),
    () => false,
  );
  const listed = splitZ(await listedRun).filter((p) => MD.test(p));
  const changed = await changedRun;
  // Cap before stat: a huge worktree must not cost a stat per file. The task file comes first, so it
  // takes one of the slots.
  const candidates = [...new Set(listed)]
    .filter((p) => p !== TASK_FILE)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_DOCS);
  // -c also lists files deleted from the working tree but still in the index.
  const present = await Promise.all(
    candidates.map(async (p) =>
      (await fs.stat(path.join(worktree, p)).then(
        (s) => s.isFile(),
        () => false,
      ))
        ? p
        : null,
    ),
  );
  const files = present
    .filter((p): p is string => p !== null)
    .map((p) => ({ path: p, changed: changed.get(p) ?? null }));
  const hasTask = await hasTaskRun;
  const all = hasTask ? [{ path: TASK_FILE, changed: null }, ...files] : files;
  return all.slice(0, MAX_DOCS);
}

export async function readDoc(
  worktree: string,
  rel: string,
): Promise<{ text: string; mtimeMs: number }> {
  return readText(await resolveInWorktree(worktree, rel));
}

/** A resolved Markdown file's text, refused over MAX_DOC_BYTES. */
export async function readText(
  abs: string,
): Promise<{ text: string; mtimeMs: number }> {
  const st = await fs.stat(abs);
  if (st.size > MAX_DOC_BYTES) throw new Error('Too large');
  return { text: await fs.readFile(abs, 'utf8'), mtimeMs: st.mtimeMs };
}

export async function readAsset(
  worktree: string,
  rel: string,
): Promise<string> {
  return readImage(await resolveInWorktree(worktree, rel));
}

/** An image file as a data URL; anything else, or a file over MAX_ASSET_BYTES, is refused. */
export async function readImage(abs: string): Promise<string> {
  const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
  if (!type) throw new Error('Not an image');
  const st = await fs.stat(abs);
  if (st.size > MAX_ASSET_BYTES) throw new Error('Too large');
  return `data:${type};base64,${(await fs.readFile(abs)).toString('base64')}`;
}

export async function resolveLink(
  worktree: string,
  rel: string,
): Promise<{ path: string; kind: 'md' | 'html' | 'file' } | null> {
  try {
    const abs = await resolveInWorktree(worktree, rel);
    const root = await fs.realpath(worktree);
    const kind = MD.test(abs) ? 'md' : HTML.test(abs) ? 'html' : 'file';
    return { path: toRel(root, abs), kind };
  } catch {
    return null;
  }
}
