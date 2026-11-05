import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { SourceTypeSchema, type SourceType } from '../../shared/brain';

export type SourceFrontmatter = {
  source_url: string;
  ingested_at: string;
  content_type: SourceType;
  sha256: string;
  title: string;
  /** One line on what the source holds (describeContents); absent on wiki pages and older sources. */
  contents?: string;
  /** What the person who added the source said about it, written once at ingest; the skills read it as their instruction. */
  note?: string;
};

export function slugify(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const slug = base
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-');
  return slug.slice(0, 60).replace(/-+$/, '');
}

export function sourceFileName(
  date: Date,
  slug: string,
  existing: Set<string>,
): string {
  const day = date.toISOString().slice(0, 10);
  let name = `${day}-${slug}.md`;
  for (let n = 2; existing.has(name); n++) name = `${day}-${slug}-${n}.md`;
  return name;
}

export function renderSource(fm: SourceFrontmatter, body: string): string {
  const ordered = {
    title: fm.title,
    source_url: fm.source_url,
    ingested_at: fm.ingested_at,
    content_type: fm.content_type,
    sha256: fm.sha256,
    ...(fm.contents ? { contents: fm.contents } : {}),
    ...(fm.note ? { note: fm.note } : {}),
  };
  return `---\n${stringify(ordered)}---\n\n${body}`;
}

export function parseSourceFrontmatter(text: string): SourceFrontmatter | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  let data: unknown;
  try {
    data = parse(m[1]);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const type = SourceTypeSchema.safeParse(d.content_type);
  if (
    !type.success ||
    typeof d.title !== 'string' ||
    typeof d.source_url !== 'string' ||
    typeof d.ingested_at !== 'string' ||
    typeof d.sha256 !== 'string'
  ) {
    return null;
  }
  return {
    title: d.title,
    source_url: d.source_url,
    ingested_at: d.ingested_at,
    content_type: type.data,
    sha256: d.sha256,
    ...(typeof d.contents === 'string' ? { contents: d.contents } : {}),
    ...(typeof d.note === 'string' && d.note ? { note: d.note } : {}),
  };
}

export function guessSourceType(fileName: string): SourceType {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.vtt')) return 'transcript';
  if (lower.endsWith('.pptx')) return 'deck';
  return 'doc';
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}
