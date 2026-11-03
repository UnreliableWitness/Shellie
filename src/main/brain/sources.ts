import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BrainSourceRow,
  BrainState,
  SourceType,
} from '../../shared/brain';
import type { GitClient } from '../services/GitClient';
import { convertFile } from './convert';
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
export type AddSourceResult =
  | { ok: true; path: string }
  | {
      ok: false;
      reason: 'unsupported' | 'duplicate' | 'needs-ocr' | 'error';
      message: string;
    };

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

  const existing = await readSources(brainDir);
  const dup = existing.find((s) => s.fm.sha256 === hash);
  if (dup) {
    return {
      ok: false,
      reason: 'duplicate',
      message: `Already in the brain as ${dup.path}`,
    };
  }

  try {
    const sourcesDir = path.join(brainDir, 'sources');
    await fs.mkdir(sourcesDir, { recursive: true });
    const taken = new Set(await fs.readdir(sourcesDir));
    const date = now();
    const slug = slugify(slugBase) || 'source';
    const name = sourceFileName(date, slug, taken);
    await fs.writeFile(
      path.join(sourcesDir, name),
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
      await fs.writeFile(
        path.join(
          sourcesDir,
          name.replace(/\.md$/, original.ext.toLowerCase()),
        ),
        original.buf,
      );
    }
    await git.run(brainDir, ['add', '-A', 'sources']);
    await git.run(brainDir, ['commit', '-m', `Brain: add source ${name}`]);
    return { ok: true, path: `sources/${name}` };
  } catch (e) {
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
        n !== path.basename(s.path) &&
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
