import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AddSourceResult,
  BrainSourceRow,
  BrainState,
  SourceType,
} from '../../shared/brain';
import type { GitClient } from '../services/GitClient';
import {
  ASSETS_PLACEHOLDER,
  convertFile,
  describeContents,
  type ConvertOptions,
  type ConvertedImage,
} from './convert';
import { withBrainGit } from './gitMutex';
import { findSecrets, secretMessage } from './secrets';
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
  convert: ConvertOptions = {},
): Promise<AddSourceResult> {
  let title: string;
  let sourceUrl: string;
  let body: string;
  let hash: string;
  let slugBase: string;
  let original: { buf: Buffer; ext: string } | null = null;
  let images: ConvertedImage[] = [];
  let warnings: string[] = [];
  let contents: string;

  if ('file' in input) {
    const base = path.basename(input.file);
    const ext = path.extname(base);
    let converted;
    try {
      converted = await convertFile(input.file, convert);
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
    if (converted.empty) {
      return {
        ok: false,
        reason: 'needs-ocr',
        message: 'No text layer and no images; needs OCR',
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
    images = converted.images;
    warnings = converted.warnings;
    contents = describeContents(
      converted.markdown,
      images.length,
      ext.replace(/^\./, ''),
    );
  } else {
    title = input.title;
    sourceUrl = input.url ?? input.title;
    slugBase = input.title;
    hash = sha256(input.text);
    body = input.text.trimEnd() + '\n';
    contents = describeContents(body, 0, 'txt');
  }

  // A credential never lands in the brain: git would keep it for good.
  const secrets = findSecrets(body);
  if (secrets.length)
    return {
      ok: false,
      reason: 'secret',
      message: secretMessage(
        secrets,
        'file' in input
          ? {
              name: path.basename(input.file),
              converted: !/\.(md|txt)$/i.test(input.file),
            }
          : undefined,
      ),
    };

  // Duplicate check, name choice and commit in one go per brain: concurrent adds never take the same name.
  return withBrainGit(brainDir, () =>
    writeSource(git, brainDir, type, now, {
      title,
      sourceUrl,
      body,
      hash,
      slugBase,
      original,
      images,
      warnings,
      contents,
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
    images: ConvertedImage[];
    warnings: string[];
    contents: string;
  },
): Promise<AddSourceResult> {
  const { title, sourceUrl, hash, slugBase, original, images, warnings } = src;
  const existing = await readSources(brainDir);
  const dup = existing.find((s) => s.fm.sha256 === hash);
  if (dup) {
    return {
      ok: false,
      reason: 'duplicate',
      message: `Already in the brain as ${dup.path}`,
    };
  }

  // Files and folders written: removed again if anything below fails.
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
    const stem = name.replace(/\.md$/, '');
    const assetsDir = `${stem}-assets`;
    // Only converter output with pictures carries the placeholder; other sources keep their text as is.
    const body = images.length
      ? src.body.split(`${ASSETS_PLACEHOLDER}/`).join(`${assetsDir}/`)
      : src.body;
    if (images.length) {
      written.push(path.join(sourcesDir, assetsDir));
      await fs.mkdir(written[0], { recursive: true });
      for (const img of images) {
        const rel = `sources/${assetsDir}/${img.name}`;
        rels.push(rel);
        await fs.writeFile(path.join(brainDir, rel), img.data);
      }
    }
    written.push(path.join(sourcesDir, name));
    rels.push(`sources/${name}`);
    await fs.writeFile(
      path.join(sourcesDir, name),
      renderSource(
        {
          title,
          source_url: sourceUrl,
          ingested_at: date.toISOString(),
          content_type: type,
          sha256: hash,
          contents: src.contents,
        },
        body,
      ),
    );
    if (original) {
      const copyName = name.replace(/\.md$/, original.ext.toLowerCase());
      written.push(path.join(sourcesDir, copyName));
      rels.push(`sources/${copyName}`);
      await fs.writeFile(path.join(sourcesDir, copyName), original.buf);
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
    return {
      ok: true,
      path: `sources/${name}`,
      images: images.length,
      warnings,
      contents: src.contents,
    };
  } catch (e) {
    for (const f of written) await fs.rm(f, { recursive: true, force: true });
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
      contents: s.fm.contents ?? null,
    });
  }
  return rows.sort(
    (a, b) =>
      b.ingestedAt.localeCompare(a.ingestedAt) || a.path.localeCompare(b.path),
  );
}
