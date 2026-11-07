import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BrainFinding,
  BrainSourceRow,
  PictureCounts,
  PictureRow,
  SourcePictures,
} from '../../shared/brain';
import { readJson, writeAtomic } from '../fsRetry';
import { localTarget } from './check';
import type { WikiPage } from './pages';
import { absPath } from './paths';
import { pictureLabel } from './pictureLabel';

export { pictureLabel };

/** Pictures Claude marked as carrying nothing to record. Skills write it, Shellie only reads it. */
export const SKIPPED_FILE = 'brain/pictures-skipped.json';
/** Pictures the converter could not deliver, per source. Shellie writes it, skills never do. */
export const DROPPED_FILE = 'brain/pictures-dropped.json';
/** The wiki mirror counts as one source; its pictures are the attachments of all its pages. */
export const MIRROR_SOURCE = 'sources/wiki';
const MIRROR_ATTACHMENTS = `${MIRROR_SOURCE}/.attachments`;

export type PictureDrop = {
  /** Where the picture was ('slide 9, picture 2'); the key a drop is accepted by. */
  where: string;
  reason: string;
  fix: string;
  /** When the owner said "fine, I know", or null. */
  accepted: string | null;
};
export type DroppedFile = Record<
  string,
  { dropped: PictureDrop[]; tiny: number }
>;
export type SkippedFile = Record<string, { reason: string; at: string }>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '';

/** brain/pictures-skipped.json; a missing, unparsable or wrongly shaped file is empty, and entries without a reason are left out. */
export async function readSkipped(brainDir: string): Promise<SkippedFile> {
  const raw = await readJson(absPath(brainDir, SKIPPED_FILE));
  const out: SkippedFile = {};
  if (!isRecord(raw)) return out;
  for (const [file, v] of Object.entries(raw)) {
    if (!isRecord(v) || !text(v.reason)) continue;
    out[file] = { reason: v.reason, at: typeof v.at === 'string' ? v.at : '' };
  }
  return out;
}

/** brain/pictures-dropped.json, tolerant the same way: malformed sources and drops are left out. */
export async function readDropped(brainDir: string): Promise<DroppedFile> {
  const raw = await readJson(absPath(brainDir, DROPPED_FILE));
  const out: DroppedFile = {};
  if (!isRecord(raw)) return out;
  for (const [source, v] of Object.entries(raw)) {
    if (!isRecord(v)) continue;
    const dropped: PictureDrop[] = [];
    for (const d of Array.isArray(v.dropped) ? v.dropped : []) {
      if (
        !isRecord(d) ||
        !text(d.where) ||
        !text(d.reason) ||
        typeof d.fix !== 'string'
      )
        continue;
      dropped.push({
        where: d.where,
        reason: d.reason,
        fix: d.fix,
        accepted: typeof d.accepted === 'string' ? d.accepted : null,
      });
    }
    const tiny =
      typeof v.tiny === 'number' && Number.isInteger(v.tiny) && v.tiny > 0
        ? v.tiny
        : 0;
    out[source] = { dropped, tiny };
  }
  return out;
}

/** Changes brain/pictures-dropped.json atomically, starting from what `readDropped` makes of it. */
export async function writeDropped(
  brainDir: string,
  update: (f: DroppedFile) => DroppedFile,
): Promise<void> {
  const next = update(await readDropped(brainDir));
  const file = absPath(brainDir, DROPPED_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(
    file,
    `${JSON.stringify(next, null, 2)}\n`,
    `.${process.pid}.tmp`,
  );
}

/** The picture files of a source (`sources/<stem>-assets/`, or the mirror's attachments), repo-relative and sorted. */
export async function assetsOf(
  brainDir: string,
  source: string,
): Promise<string[]> {
  const dir =
    source === MIRROR_SOURCE
      ? MIRROR_ATTACHMENTS
      : `${source.replace(/\.md$/, '')}-assets`;
  try {
    const entries = await fs.readdir(absPath(brainDir, dir), {
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => `${dir}/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

/** Every local link target of the pages, repo-relative, with the pages linking it. Built once per page list. */
const citedCache = new WeakMap<WikiPage[], Map<string, string[]>>();
function citedBy(pages: WikiPage[]): Map<string, string[]> {
  let cited = citedCache.get(pages);
  if (cited) return cited;
  cited = new Map();
  for (const p of pages)
    for (const l of p.links) {
      const rel = localTarget(p.path, l);
      if (!rel) continue;
      const list = cited.get(rel) ?? [];
      if (!list.includes(p.path)) list.push(p.path);
      cited.set(rel, list);
    }
  citedCache.set(pages, cited);
  return cited;
}

const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)/g;

/** The alt text of each picture the source embeds, by repo-relative path; the first non-empty one wins. */
function altTexts(source: string, sourceText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sourceText.matchAll(IMAGE)) {
    const rel = localTarget(source, m[2]);
    const alt = m[1].trim();
    if (rel && alt && !out.has(rel)) out.set(rel, alt);
  }
  return out;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Each picture of a source with its status: described when a wiki page links the file (a `#slide-N` anchor on the
 * source does not count), skipped when Claude marked it, missing otherwise; then the drops, accepted or not.
 */
export function coverage(input: {
  source: string;
  assets: string[];
  sourceText: string;
  pages: WikiPage[];
  skipped: SkippedFile;
  dropped: DroppedFile;
}): SourcePictures {
  const { source, assets, sourceText, pages, skipped, dropped } = input;
  const cited = citedBy(pages);
  const alts = altTexts(source, sourceText);
  const rows: PictureRow[] = [];
  for (const file of assets) {
    const citing = cited.get(file) ?? [];
    const skip = citing.length ? undefined : skipped[file];
    rows.push({
      path: file,
      label: pictureLabel(file),
      alt: alts.get(file) ?? null,
      status: citing.length ? 'described' : skip ? 'skipped' : 'missing',
      pages: [...citing].sort(),
      reason: skip?.reason ?? null,
      fix: null,
      where: null,
    });
  }
  const entry = dropped[source];
  for (const d of entry?.dropped ?? [])
    rows.push({
      path: null,
      label: capitalise(d.where),
      alt: null,
      status: d.accepted ? 'accepted' : 'dropped',
      pages: [],
      reason: d.reason,
      fix: d.fix,
      where: d.where,
    });
  const counts: PictureCounts = {
    total: rows.length,
    described: 0,
    skipped: 0,
    missing: 0,
    dropped: 0,
    accepted: 0,
    tiny: entry?.tiny ?? 0,
  };
  for (const r of rows) counts[r.status]++;
  return { source, counts, rows };
}

/**
 * The pictures of every source that has any (stored files or drop records), newest source first as `sources`
 * lists them, then the wiki mirror when it has attachments or drop records.
 */
export async function brainCoverage(
  brainDir: string,
  pages: WikiPage[],
  sources: BrainSourceRow[],
): Promise<SourcePictures[]> {
  const [skipped, dropped] = await Promise.all([
    readSkipped(brainDir),
    readDropped(brainDir),
  ]);
  const out: SourcePictures[] = [];
  for (const s of sources) {
    if (s.path.startsWith(`${MIRROR_SOURCE}/`)) continue;
    const assets = await assetsOf(brainDir, s.path);
    if (!assets.length && !dropped[s.path]) continue;
    const sourceText = await fs
      .readFile(absPath(brainDir, s.path), 'utf8')
      .catch(() => '');
    out.push(
      coverage({ source: s.path, assets, sourceText, pages, skipped, dropped }),
    );
  }
  // The mirror's pages link their attachments relative to themselves: no alt text for these.
  const mirror = await assetsOf(brainDir, MIRROR_SOURCE);
  if (mirror.length || dropped[MIRROR_SOURCE])
    out.push(
      coverage({
        source: MIRROR_SOURCE,
        assets: mirror,
        sourceText: '',
        pages,
        skipped,
        dropped,
      }),
    );
  return out;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** One `picture` finding per source with pictures not interpreted or drops not accepted. */
export function pictureFindings(
  all: SourcePictures[],
  at: string,
): BrainFinding[] {
  const out: BrainFinding[] = [];
  for (const { source, counts } of all) {
    const parts: string[] = [];
    if (counts.missing)
      parts.push(
        `${plural(counts.missing, 'picture', 'pictures')} not interpreted`,
      );
    if (counts.dropped) parts.push(`${counts.dropped} never reached Claude`);
    if (parts.length)
      out.push({
        kind: 'picture',
        page: source,
        detail: parts.join(' · '),
        at,
      });
  }
  return out;
}
