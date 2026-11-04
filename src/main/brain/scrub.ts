import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitClient } from '../services/GitClient';
import { withBrainGit } from './gitMutex';

/** Shorter than this would redact half the brain by accident. */
export const SCRUB_MIN_LENGTH = 6;
/**
 * One token for text and for names, so a renamed file still matches the links and state keys that name it. No
 * brackets: git reads `[…]` in a pathspec as a glob.
 */
export const REDACTED = 'REDACTED';
/** The message of the commit that saves a person's edit before the scrub touches the file (Health keeps listing it). */
export const OUTSIDE_EDIT_MESSAGE = 'Edited outside a capture';
/** Text files of a brain; pictures and originals in binary formats are left alone. */
const TEXT = new Set([
  '.md',
  '.txt',
  '.json',
  '.vtt',
  '.csv',
  '.xml',
  '.drawio',
  '.html',
  '.yml',
  '.yaml',
]);
const MAX_FILE = 20 * 1024 * 1024;

/** The value as written, URL-encoded and base64 (the last only when long enough not to match by chance). */
export function scrubVariants(value: string): string[] {
  const out = [value];
  const url = encodeURIComponent(value);
  if (url !== value) out.push(url);
  if (value.length >= 8)
    out.push(Buffer.from(value, 'utf8').toString('base64'));
  return out;
}

const abs = (brainDir: string, rel: string) =>
  path.join(brainDir, ...rel.split('/'));
const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

/** Every file and folder under sources/ and wiki/ (dot entries left out), repo-relative, with whether it is a folder. */
async function entries(
  brainDir: string,
): Promise<{ rel: string; dir: boolean }[]> {
  const out: { rel: string; dir: boolean }[] = [];
  const walk = async (rel: string) => {
    let list;
    try {
      list = await fs.readdir(abs(brainDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (e.name.startsWith('.')) continue;
      const next = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        out.push({ rel: next, dir: true });
        await walk(next);
      } else if (e.isFile()) out.push({ rel: next, dir: false });
    }
  };
  await walk('sources');
  await walk('wiki');
  return out;
}

/** A free name for the target: `-2`, `-3`… before the extension when it is taken. */
async function freeName(brainDir: string, rel: string): Promise<string> {
  if (!(await exists(abs(brainDir, rel)))) return rel;
  const ext = path.posix.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!(await exists(abs(brainDir, candidate)))) return candidate;
  }
}

/** Renames every file and folder whose name holds the value, deepest first; returns the pairs, final names. */
async function renameAll(
  brainDir: string,
  value: string,
): Promise<{ from: string; to: string }[]> {
  const all = (await entries(brainDir)).filter((e) =>
    path.posix.basename(e.rel).includes(value),
  );
  all.sort((a, b) => b.rel.split('/').length - a.rel.split('/').length);
  const out: { from: string; to: string }[] = [];
  for (const e of all) {
    // A parent renamed earlier moved this entry: map its path through the renames done so far.
    let from = e.rel;
    for (const r of out)
      if (from.startsWith(`${r.from}/`))
        from = `${r.to}${from.slice(r.from.length)}`;
    const dir = path.posix.dirname(from);
    const base = path.posix.basename(from).split(value).join(REDACTED);
    if (base === path.posix.basename(from)) continue;
    const to = await freeName(brainDir, `${dir}/${base}`);
    await fs.rename(abs(brainDir, from), abs(brainDir, to));
    out.push({ from, to });
  }
  return out;
}

async function textFiles(brainDir: string): Promise<string[]> {
  const out = (await entries(brainDir))
    .filter((e) => !e.dir && TEXT.has(path.extname(e.rel).toLowerCase()))
    .map((e) => e.rel);
  for (const f of ['index.md', 'log.md', 'brain/state.json'])
    if (await exists(abs(brainDir, f))) out.push(f);
  return out;
}

/** The paths git knows (tracked), among the given ones; a folder stands for its tracked files. */
async function tracked(
  git: GitClient,
  brainDir: string,
  paths: string[],
): Promise<string[]> {
  if (!paths.length) return [];
  return (
    await git.run(brainDir, ['--literal-pathspecs', 'ls-files', '--', ...paths])
  )
    .split('\n')
    .filter(Boolean);
}

/** Files under wiki/ a person changed and did not commit (modified or new), repo-relative. */
async function dirtyWiki(
  git: GitClient,
  brainDir: string,
): Promise<Set<string>> {
  const status = await git.run(brainDir, [
    '--literal-pathspecs',
    'status',
    '--porcelain',
    '-uall',
    '--',
    'wiki/',
  ]);
  const out = new Set<string>();
  for (const line of status.split('\n')) {
    if (line.length < 4) continue;
    const p = line.slice(3);
    out.add(p.includes(' -> ') ? p.split(' -> ')[1] : p);
  }
  return out;
}

/**
 * Replaces every occurrence of the value (and its variants) in the brain's text files with `[REDACTED]`, renames
 * every file and folder whose name holds it, and commits only those paths as `Brain: scrub`. A wiki page a person
 * edited and did not commit is committed first as an outside edit, so Health and /sync still see the edit. Returns
 * how many files changed and how many were too large to scan. The value is never written anywhere, not even
 * the commit message. Git history keeps the old text.
 */
export async function scrubBrain(
  git: GitClient,
  brainDir: string,
  value: string,
): Promise<{ files: number; skipped: number }> {
  const v = value.trim();
  if (v.length < SCRUB_MIN_LENGTH)
    throw new Error(`Give at least ${SCRUB_MIN_LENGTH} characters to scrub`);
  const variants = scrubVariants(v);
  return withBrainGit(brainDir, async () => {
    // What a person changed under wiki/ and did not commit, before anything here moves.
    const dirty = await dirtyWiki(git, brainDir);
    const renames = await renameAll(brainDir, v);
    const planned: { rel: string; next: string }[] = [];
    let skipped = 0;
    for (const rel of await textFiles(brainDir)) {
      const file = abs(brainDir, rel);
      if ((await fs.stat(file)).size > MAX_FILE) {
        skipped++;
        continue;
      }
      const text = await fs.readFile(file, 'utf8');
      let next = text;
      for (const s of variants) next = next.split(s).join(REDACTED);
      if (next !== text) planned.push({ rel, next });
    }
    // A person's uncommitted wiki edit among the files about to change is saved as their own commit first.
    // A dirty path as it is called now: a file inside a renamed folder moved with the folder.
    const moved = (p: string) => {
      for (const r of renames)
        if (p === r.from || p.startsWith(`${r.from}/`))
          return `${r.to}${p.slice(r.from.length)}`;
      return p;
    };
    const dirtyNow = new Set([...dirty].map(moved));
    const wasDirty = (p: string) => dirtyNow.has(p);
    const outside = [
      ...new Set([...planned.map((p) => p.rel), ...renames.map((r) => r.to)]),
    ].filter((p) => p.startsWith('wiki/') && wasDirty(p));
    if (outside.length) {
      const old = await tracked(
        git,
        brainDir,
        renames.filter((r) => outside.includes(r.to)).map((r) => r.from),
      );
      await git.run(brainDir, [
        '--literal-pathspecs',
        'add',
        '-A',
        '--',
        ...outside,
        ...old,
      ]);
      await git.run(brainDir, [
        '--literal-pathspecs',
        'commit',
        '-q',
        '-m',
        OUTSIDE_EDIT_MESSAGE,
        '--',
        ...outside,
        ...old,
      ]);
    }
    for (const p of planned)
      await fs.writeFile(abs(brainDir, p.rel), p.next, 'utf8');
    // A file both renamed and rewritten counts once, under its old name.
    const original = (rel: string) =>
      renames.find((r) => r.to === rel)?.from ?? rel;
    const changed = new Set<string>([
      ...planned.map((p) => original(p.rel)),
      ...renames.map((r) => r.from),
    ]);
    // Staged: the files written, the new names, and the old names git still tracks (a never-committed one just goes).
    const paths = [
      ...new Set([
        ...planned.map((p) => p.rel),
        ...renames.map((r) => r.to),
        ...(await tracked(
          git,
          brainDir,
          renames.map((r) => r.from),
        )),
      ]),
    ];
    if (!paths.length) return { files: 0, skipped };
    await git.run(brainDir, [
      '--literal-pathspecs',
      'add',
      '-A',
      '--',
      ...paths,
    ]);
    const status = await git.run(brainDir, [
      '--literal-pathspecs',
      'status',
      '--porcelain',
      '--',
      ...paths,
    ]);
    if (status.trim())
      await git.run(brainDir, [
        '--literal-pathspecs',
        'commit',
        '-q',
        '-m',
        'Brain: scrub',
        '--',
        ...paths,
      ]);
    return { files: changed.size, skipped };
  });
}
