import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../fsRetry';
import type { GitClient } from '../services/GitClient';
import { withBrainGit } from './gitMutex';
import { absPath } from './paths';
import { brainReads, READS_RECORD, restampAfterScrub } from './reads';

/** Shorter than this would redact half the brain by accident. */
const SCRUB_MIN_LENGTH = 6;
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

/** Every file and folder under sources/, wiki/ and reads/ (dot entries left out), repo-relative, with whether it is a folder. */
async function entries(
  brainDir: string,
): Promise<{ rel: string; dir: boolean }[]> {
  const out: { rel: string; dir: boolean }[] = [];
  const walk = async (rel: string) => {
    let list;
    try {
      list = await fs.readdir(absPath(brainDir, rel), { withFileTypes: true });
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
  await walk('reads');
  return out;
}

/** A free name for the target: `-2`, `-3`… before the extension when it is taken. */
async function freeName(brainDir: string, rel: string): Promise<string> {
  if (!(await pathExists(absPath(brainDir, rel)))) return rel;
  const ext = path.posix.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!(await pathExists(absPath(brainDir, candidate)))) return candidate;
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
    await fs.rename(absPath(brainDir, from), absPath(brainDir, to));
    out.push({ from, to });
  }
  return out;
}

async function textFiles(brainDir: string): Promise<string[]> {
  const out = (await entries(brainDir))
    .filter((e) => !e.dir && TEXT.has(path.extname(e.rel).toLowerCase()))
    .map((e) => e.rel);
  for (const f of [
    'index.md',
    'log.md',
    'brain/state.json',
    'brain/book.json',
    'brain/conflicts.json',
    'brain/reads.json',
  ])
    if (await pathExists(absPath(brainDir, f))) out.push(f);
  return out;
}

/** The paths git knows (tracked), among the given ones; a folder stands for its tracked files. */
async function tracked(
  git: GitClient,
  brainDir: string,
  paths: string[],
): Promise<string[]> {
  if (!paths.length) return [];
  // -z: a non-ASCII or odd name comes back as it is, not quoted and escaped.
  return (
    await git.run(brainDir, [
      '--literal-pathspecs',
      'ls-files',
      '-z',
      '--',
      ...paths,
    ])
  )
    .split('\0')
    .filter(Boolean);
}

/** Files under wiki/ a person changed and did not commit (modified or new), repo-relative. */
async function dirtyWiki(
  git: GitClient,
  brainDir: string,
): Promise<Set<string>> {
  // -z: NUL-separated records, paths as they are; a rename record carries the new path, then the old one.
  const status = await git.run(brainDir, [
    '--literal-pathspecs',
    'status',
    '--porcelain',
    '-z',
    '-uall',
    '--',
    'wiki/',
  ]);
  const out = new Set<string>();
  const records = status.split('\0');
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.length < 4) continue;
    out.add(r.slice(3));
    if (r[0] === 'R' || r[0] === 'C') i++;
  }
  return out;
}

/**
 * Replaces every occurrence of the value (and its variants) in the brain's text files with `[REDACTED]`, renames
 * every file and folder whose name holds it, and commits only those paths as `Brain: scrub`. A wiki page a person
 * edited and did not commit is committed first as an outside edit, so Health and /sync still see the edit. Returns
 * how many files changed and how many were too large to scan. The value is never written anywhere, not even
 * the commit message. Git history keeps the old text. A long read does not go out of date over it: the record of
 * what it was written from moves to the scrub's commit.
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
    // The pages each long read was already behind on: those stay changed, the scrub's own rewrites must not count.
    const behind = (await brainReads(brainDir)).reads.map(
      (r) => [r.path, r.stale] as const,
    );
    const renames = await renameAll(brainDir, v);
    const planned: { rel: string; next: string }[] = [];
    let skipped = 0;
    for (const rel of await textFiles(brainDir)) {
      const file = absPath(brainDir, rel);
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
    // Every dirty wiki path this scrub will stage: rewritten, renamed, or inside a renamed folder.
    const touched = (p: string) =>
      planned.some((x) => x.rel === p) ||
      renames.some((r) => r.to === p || p.startsWith(`${r.to}/`));
    const outside = [...dirtyNow].filter(
      (p) => p.startsWith('wiki/') && touched(p),
    );
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
      await fs.writeFile(absPath(brainDir, p.rel), p.next, 'utf8');
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
    if (status.trim()) {
      const commit = (extra: string[]) =>
        git.run(brainDir, [
          '--literal-pathspecs',
          'commit',
          '-q',
          '-m',
          'Brain: scrub',
          '--',
          ...extra,
        ]);
      await commit(paths);
      // A name as the scrub left it: in a path the value became the token, as in the record's own text.
      const now = (p: string) => moved(p).split(v).join(REDACTED);
      const stale = new Map(
        behind.map(([read, pages]) => [now(read), new Set(pages.map(now))]),
      );
      if (await restampAfterScrub(git, brainDir, stale)) {
        await git.run(brainDir, [
          '--literal-pathspecs',
          'add',
          '--',
          READS_RECORD,
        ]);
        await commit([READS_RECORD]);
      }
    }
    return { files: changed.size, skipped };
  });
}
