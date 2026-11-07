import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  Brain,
  BrainFinding,
  BrainJob,
  BrainSourceRow,
  PictureCounts,
  PictureRow,
  SourcePictures,
} from '../../shared/brain';
import { readJson, writeAtomic } from '../fsRetry';
import type { GitClient } from '../services/GitClient';
import { localTarget } from './check';
import { convertFile, type ConvertOptions, type Rasterize } from './convert';
import { withBrainGit } from './gitMutex';
import type { BrainJobRunner } from './jobs';
import { readPages, type WikiPage } from './pages';
import { absPath } from './paths';
import { pictureLabel } from './pictureLabel';
import { listSources } from './sources';

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

/** A skipped key as the plain path from the brain folder: a skill may write `./`, URL encoding or backslashes. */
function skippedKey(key: string): string {
  let p = key.replace(/\\/g, '/');
  try {
    p = decodeURIComponent(p);
  } catch {
    // Not valid URL encoding: keep it as written.
  }
  return path.posix.normalize(p);
}

/** brain/pictures-skipped.json; a missing, unparsable or wrongly shaped file is empty, and entries without a reason are left out. */
export async function readSkipped(brainDir: string): Promise<SkippedFile> {
  const raw = await readJson(absPath(brainDir, SKIPPED_FILE));
  const out: SkippedFile = {};
  if (!isRecord(raw)) return out;
  for (const [file, v] of Object.entries(raw)) {
    if (!isRecord(v) || !text(v.reason)) continue;
    out[skippedKey(file)] = {
      reason: v.reason,
      at: typeof v.at === 'string' ? v.at : '',
    };
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

/** One source's pictures from what is on disk; the mirror's pages link their attachments relative to themselves, so it has no alt text. */
async function coverageOn(
  brainDir: string,
  pages: WikiPage[],
  source: string,
  skipped: SkippedFile,
  dropped: DroppedFile,
): Promise<SourcePictures> {
  const assets = await assetsOf(brainDir, source);
  // The text only gives alt texts: not read for a source without pictures.
  const sourceText =
    source === MIRROR_SOURCE || !assets.length
      ? ''
      : await fs.readFile(absPath(brainDir, source), 'utf8').catch(() => '');
  return coverage({ source, assets, sourceText, pages, skipped, dropped });
}

/** The pictures of one source (a source file or the wiki mirror), as Health computes them. No picture is read. */
export async function sourceCoverage(
  brainDir: string,
  pages: WikiPage[],
  source: string,
): Promise<SourcePictures> {
  const [skipped, dropped] = await Promise.all([
    readSkipped(brainDir),
    readDropped(brainDir),
  ]);
  return coverageOn(brainDir, pages, source, skipped, dropped);
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
  const paths = sources
    .map((s) => s.path)
    .filter((p) => !p.startsWith(`${MIRROR_SOURCE}/`));
  for (const source of [...paths, MIRROR_SOURCE]) {
    const c = await coverageOn(brainDir, pages, source, skipped, dropped);
    // An empty drop record only says the source was checked: no pictures, nothing to list.
    if (c.rows.length || c.counts.tiny) out.push(c);
  }
  return out;
}

/** The prompt for a pictures job: null when the source has no picture left to interpret. */
export async function picturesPrompt(
  brainDir: string,
  source: string,
): Promise<string | null> {
  const pages = await readPages(brainDir).catch(() => []);
  const { rows } = await sourceCoverage(brainDir, pages, source);
  const missing = rows.flatMap((r) =>
    r.status === 'missing' && r.path ? [r.path] : [],
  );
  return missing.length
    ? `/pictures ${source} ${JSON.stringify(missing)}`
    : null;
}

/** After a job: a capture that left gaps queues one pictures job for its source. */
export async function afterPictureJob(
  job: BrainJob,
  d: {
    brainDir: (id: string) => string;
    enqueue: BrainJobRunner['enqueue'];
  },
): Promise<void> {
  if (job.kind !== 'capture' || job.status !== 'done' || !job.source) return;
  try {
    const dir = d.brainDir(job.brainId);
    const pages = await readPages(dir).catch(() => []);
    const { counts } = await sourceCoverage(dir, pages, job.source);
    if (counts.missing > 0) d.enqueue(job.brainId, 'pictures', job.source);
  } catch (e) {
    console.error('[brain] could not check pictures after a capture', e);
  }
}

/**
 * Rebuilds the drop records of sources added before drops were recorded, by converting each stored original again
 * (one at a time); a source that has a record, or no original (pasted text), is left alone. A source with nothing
 * dropped gets an empty record, so it is not converted again. Never writes `sources/`.
 * Commits DROPPED_FILE alone as 'Brain: dropped pictures of earlier sources' when it changed.
 */
export async function rebuildDrops(
  git: GitClient,
  brainDir: string,
  sources: BrainSourceRow[],
  opts: ConvertOptions,
): Promise<void> {
  const known = await readDropped(brainDir);
  const found: DroppedFile = {};
  for (const s of sources) {
    if (!s.original || s.path in known) continue;
    try {
      const c = await convertFile(absPath(brainDir, s.original), opts);
      found[s.path] =
        c === 'unsupported'
          ? { dropped: [], tiny: 0 }
          : {
              dropped: c.dropped.map((d) => ({ ...d, accepted: null })),
              tiny: c.tiny,
            };
    } catch (e) {
      console.error(`[brain] could not convert ${s.original} again`, e);
    }
  }
  if (!Object.keys(found).length) return;
  await withBrainGit(brainDir, async () => {
    // Read again under the lock: a source added meanwhile keeps the record its add wrote.
    await writeDropped(brainDir, (f) => ({ ...found, ...f }));
    const changed = (
      await git.run(brainDir, ['status', '--porcelain', '--', DROPPED_FILE])
    ).trim();
    if (!changed) return;
    await git.run(brainDir, ['add', '--', DROPPED_FILE]);
    await git.run(brainDir, [
      'commit',
      '-q',
      '-m',
      'Brain: dropped pictures of earlier sources',
      '--',
      DROPPED_FILE,
    ]);
  });
}

const PENDING: ReadonlySet<BrainJob['status']> = new Set([
  'queued',
  'running',
  'paused',
]);

/** A capture or pictures job still to come for a source: either one has Claude look at its pictures. */
const comingFor = (jobs: BrainJob[]): Set<string | null> =>
  new Set(
    jobs
      .filter(
        (j) =>
          (j.kind === 'pictures' || j.kind === 'capture') &&
          PENDING.has(j.status),
      )
      .map((j) => j.source),
  );

/**
 * Starts or resumes the one-time pass over earlier sources: rebuilds their drop records, then queues a background
 * pictures job per source with pictures not interpreted that is not in `picturePass.done` and has no capture or
 * pictures job pending, oldest first, the wiki mirror last. A resume keeps `startedAt` and `total`; a pass with nothing left
 * finishes. Returns the new `picturePass` for the caller to save.
 */
export async function runPicturePass(
  b: Brain,
  d: {
    git: GitClient;
    rasterize?: Rasterize;
    enqueue: BrainJobRunner['enqueue'];
    jobs: BrainJobRunner['jobs'];
    now: () => Date;
  },
): Promise<Brain['picturePass']> {
  const sources = await listSources(b.path, null);
  await rebuildDrops(d.git, b.path, sources, { rasterize: d.rasterize });
  const pages = await readPages(b.path).catch(() => []);
  const all = await brainCoverage(b.path, pages, sources);
  const done = new Set(b.picturePass?.done ?? []);
  const ingested = new Map(sources.map((s) => [s.path, s.ingestedAt]));
  const left = all
    .filter((c) => c.counts.missing > 0 && !done.has(c.source))
    .map((c) => c.source)
    .sort((x, y) => {
      if (x === MIRROR_SOURCE || y === MIRROR_SOURCE)
        return Number(x === MIRROR_SOURCE) - Number(y === MIRROR_SOURCE);
      return (
        (ingested.get(x) ?? '').localeCompare(ingested.get(y) ?? '') ||
        x.localeCompare(y)
      );
    });
  const pending = comingFor(d.jobs(b.id));
  for (const source of left)
    if (!pending.has(source))
      d.enqueue(b.id, 'pictures', source, { background: true });
  const at = d.now().toISOString();
  return {
    startedAt: b.picturePass?.startedAt ?? at,
    total: b.picturePass?.total ?? left.length,
    done: [...done],
    finishedAt: left.length ? null : at,
  };
}

/**
 * The pass as `runPicturePass` computed it, merged into the one saved meanwhile: sources noted done while it ran stay
 * done, and a pass that finished stays finished.
 */
export function mergePass(
  stored: Brain['picturePass'],
  computed: Brain['picturePass'],
): Brain['picturePass'] {
  if (!stored || !computed) return computed ?? stored;
  return {
    ...computed,
    done: [...new Set([...stored.done, ...computed.done])],
    finishedAt: stored.finishedAt ?? computed.finishedAt,
  };
}

/** The pass after a finished background pictures job: its source is done, and the pass is over at its total. */
export function notePassJob(
  brain: Brain,
  job: BrainJob,
  now: Date,
): Brain['picturePass'] {
  const pass = brain.picturePass;
  if (
    !pass ||
    !job.background ||
    job.kind !== 'pictures' ||
    (job.status !== 'done' && job.status !== 'failed') ||
    !job.source ||
    pass.done.includes(job.source)
  )
    return pass;
  const done = [...pass.done, job.source];
  return {
    ...pass,
    done,
    finishedAt:
      pass.finishedAt ?? (done.length >= pass.total ? now.toISOString() : null),
  };
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
