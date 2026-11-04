import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitClient } from '../services/GitClient';
import { withBrainGit } from './gitMutex';

/** Shorter than this would redact half the brain by accident. */
export const SCRUB_MIN_LENGTH = 6;
const REDACTED = '[REDACTED]';
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

async function textFiles(brainDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = await fs.readdir(path.join(brainDir, ...rel.split('/')), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const next = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(next);
      else if (e.isFile() && TEXT.has(path.extname(e.name).toLowerCase()))
        out.push(next);
    }
  };
  await walk('sources');
  await walk('wiki');
  for (const f of ['index.md', 'log.md', 'brain/state.json'])
    if (
      await fs.stat(path.join(brainDir, ...f.split('/'))).then(
        (s) => s.isFile(),
        () => false,
      )
    )
      out.push(f);
  return out;
}

/**
 * Replaces every occurrence of the value (and its variants) in the brain's text files with `[REDACTED]`, renames
 * files whose name holds it, and commits only those paths as `Brain: scrub`. Returns how many files changed. The
 * value is never written anywhere, not even the commit message. Git history keeps the old text.
 */
export async function scrubBrain(
  git: GitClient,
  brainDir: string,
  value: string,
): Promise<{ files: number }> {
  const v = value.trim();
  if (v.length < SCRUB_MIN_LENGTH)
    throw new Error(`Give at least ${SCRUB_MIN_LENGTH} characters to scrub`);
  const variants = scrubVariants(v);
  return withBrainGit(brainDir, async () => {
    const touched: string[] = [];
    const changed = new Set<string>();
    for (const rel of await textFiles(brainDir)) {
      const abs = path.join(brainDir, ...rel.split('/'));
      const size = (await fs.stat(abs)).size;
      if (size > MAX_FILE) continue;
      const text = await fs.readFile(abs, 'utf8');
      let next = text;
      for (const s of variants) next = next.split(s).join(REDACTED);
      if (next !== text) {
        await fs.writeFile(abs, next, 'utf8');
        touched.push(rel);
        changed.add(rel);
      }
      const base = path.posix.basename(rel);
      if (base.includes(v)) {
        const renamed = `${path.posix.dirname(rel)}/${base.split(v).join('redacted')}`;
        await fs.rename(abs, path.join(brainDir, ...renamed.split('/')));
        touched.push(rel, renamed);
        changed.add(rel);
      }
    }
    const paths = [...new Set(touched)];
    if (!paths.length) return { files: 0 };
    await git.run(brainDir, ['add', '-A', '--', ...paths]);
    const status = await git.run(brainDir, [
      'status',
      '--porcelain',
      '--',
      ...paths,
    ]);
    if (status.trim())
      await git.run(brainDir, [
        'commit',
        '-q',
        '-m',
        'Brain: scrub',
        '--',
        ...paths,
      ]);
    return { files: changed.size };
  });
}
