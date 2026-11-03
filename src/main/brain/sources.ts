import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AddSourceResult,
  BrainSourceRow,
  BrainState,
  SourceType,
} from '../../shared/brain';
import type { GitClient } from '../services/GitClient';
import { convertFile } from './convert';
import { withBrainGit } from './gitMutex';
import {
  parseSourceFrontmatter,
  renderSource,
  sha256,
  slugify,
  sourceFileName,
} from './sourceFile';

export type AddSourceInput =
  | { file: string }
  | { text: string; title: string; url?: string };
export type { AddSourceResult };

type SourceEntry = {
  path: string;
  fm: NonNullable<ReturnType<typeof parseSourceFrontmatter>>;
};

async function readSources(brainDir: string): Promise<SourceEntry[]> {
  const root = path.join(brainDir, 'sources');
  const out: SourceEntry[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(next);
      else if (e.isFile() && e.name.endsWith('.md')) {
        const fm = parseSourceFrontmatter(
          await fs.readFile(path.join(root, next), 'utf8'),
        );
        if (fm) out.push({ path: `sources/${next}`, fm });
      }
    }
  };
  await walk('');
  return out;
}

export async function addSource(
  git: GitClient,
  brainDir: string,
  input: AddSourceInput,
  type: SourceType,
  now: () => Date = () => new Date(),
): Promise<AddSourceResult> {
  let title: string;
  let sourceUrl: string;
  let body: string;
  let hash: string;
  let slugBase: string;
  let original: { buf: Buffer; ext: string } | null = null;

  if ('file' in input) {
    const base = path.basename(input.file);
    const ext = path.extname(base);
    let converted;
    try {
      converted = await convertFile(input.file);
    } catch (e) {
      return {
        ok: false,
        reason: 'error',
        message: e instanceof Error ? e.message : String(e),
      };
    }
    if (converted === 'unsupported') {
      return {
        ok: false,
        reason: 'unsupported',
        message: `Unsupported file type: ${ext || base}`,
      };
    }
    if (converted.needsOcr) {
      return {
        ok: false,
        reason: 'needs-ocr',
        message: 'No text layer; needs OCR',
      };
    }
    const buf = await fs.readFile(input.file);
    hash = sha256(buf);
    title = converted.title ?? path.basename(base, ext);
    sourceUrl = base;
    slugBase = base;
    body = converted.markdown.trimEnd() + '\n';
    for (const w of converted.warnings) body += `\n> Note: ${w}\n`;
    if (!['.md', '.txt'].includes(ext.toLowerCase())) original = { buf, ext };
  } else {
    title = input.title;
    sourceUrl = input.url ?? input.title;
    slugBase = input.title;
    hash = sha256(input.text);
    body = input.text.trimEnd() + '\n';
  }

  // Duplicate check, name choice and commit in one go per brain: concurrent adds never take the same name.
  return withBrainGit(brainDir, () =>
    writeSource(git, brainDir, type, now, {
      title,
      sourceUrl,
      body,
      hash,
      slugBase,
      original,
    }),
  );
}

async function writeSource(
  git: GitClient,
  brainDir: string,
  type: SourceType,
  now: () => Date,
  src: {
    title: string;
    sourceUrl: string;
    body: string;
    hash: string;
    slugBase: string;
    original: { buf: Buffer; ext: string } | null;
  },
): Promise<AddSourceResult> {
  const { title, sourceUrl, body, hash, slugBase, original } = src;
  const existing = await readSources(brainDir);
  const dup = existing.find((s) => s.fm.sha256 === hash);
  if (dup) {
    return {
      ok: false,
      reason: 'duplicate',
      message: `Already in the brain as ${dup.path}`,
    };
  }

  const written: string[] = [];
  // Repo-relative paths of what is written: the only paths staged and committed.
  const rels: string[] = [];
  let staged = false;
  try {
    const sourcesDir = path.join(brainDir, 'sources');
    await fs.mkdir(sourcesDir, { recursive: true });
    const taken = new Set(await fs.readdir(sourcesDir));
    const date = now();
    const slug = slugify(slugBase) || 'source';
    const name = sourceFileName(date, slug, taken);
    written.push(path.join(sourcesDir, name));
    rels.push(`sources/${name}`);
    await fs.writeFile(
      written[0],
      renderSource(
        {
          title,
          source_url: sourceUrl,
          ingested_at: date.toISOString(),
          content_type: type,
          sha256: hash,
        },
        body,
      ),
    );
    if (original) {
      const copyName = name.replace(/\.md$/, original.ext.toLowerCase());
      written.push(path.join(sourcesDir, copyName));
      rels.push(`sources/${copyName}`);
      await fs.writeFile(written[1], original.buf);
    }
    staged = true;
    await git.run(brainDir, ['add', '--', ...rels]);
    await git.run(brainDir, [
      'commit',
      '-q',
      '-m',
      `Brain: add source ${name}`,
      '--',
      ...rels,
    ]);
    return { ok: true, path: `sources/${name}` };
  } catch (e) {
    for (const f of written) await fs.rm(f, { force: true });
    if (staged && rels.length) {
      await git.run(brainDir, ['reset', '-q', '--', ...rels]).catch(() => '');
    }
    return {
      ok: false,
      reason: 'error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function listSources(
  brainDir: string,
  state: BrainState | null,
): Promise<BrainSourceRow[]> {
  const rows: BrainSourceRow[] = [];
  for (const s of await readSources(brainDir)) {
    const stem = s.path.replace(/\.md$/, '');
    const dir = path.dirname(path.join(brainDir, s.path));
    const sibling = (await fs.readdir(dir)).find(
      (n) =>
        path.extname(n).toLowerCase() !== '.md' &&
        n.startsWith(`${path.basename(stem)}.`) &&
        path.extname(n) === n.slice(path.basename(stem).length),
    );
    rows.push({
      path: s.path,
      type: s.fm.content_type,
      ingestedAt: s.fm.ingested_at,
      captured: state?.captured[s.path] != null,
      original: sibling ? `${path.posix.dirname(s.path)}/${sibling}` : null,
    });
  }
  return rows.sort(
    (a, b) =>
      b.ingestedAt.localeCompare(a.ingestedAt) || a.path.localeCompare(b.path),
  );
}
