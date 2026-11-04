import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrainFinding, BrainSourceRow } from '../../shared/brain';
import { linkTargets, type WikiPage } from './pages';

/** The finding kinds Shellie computes itself; `/lint` owns the others. */
export const SHELLIE_FINDING_KINDS: ReadonlySet<BrainFinding['kind']> = new Set(
  ['broken-link', 'stale', 'uncaptured', 'frontmatter'],
);

const isUrl = (target: string) => /^[a-z][a-z0-9+.-]*:/i.test(target);

/** A link target as a repo-relative path (forward slashes, no fragment, decoded), or null when it is not a local path. */
export function localTarget(fromPage: string, target: string): string | null {
  // Backslashes are separators on the release target: normalise them before the `..` check.
  const t = target.trim().replace(/\\/g, '/');
  if (!t || t.startsWith('#') || isUrl(t)) return null;
  let p = t.split('#')[0].split('?')[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep as written */
  }
  if (!p) return null;
  const from = path.posix.dirname(fromPage.replace(/\\/g, '/'));
  const joined = p.startsWith('/')
    ? path.posix.normalize(p.slice(1))
    : path.posix.normalize(path.posix.join(from, p));
  return joined.replace(/\/+$/, '');
}

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?!\d)/;
const pad = (n: number) => String(n).padStart(2, '0');
const CONFIDENCE = new Set(['high', 'medium', 'low']);
/** The local day of a timestamp: `last_updated` is the writer's local day, `ingested_at` a UTC instant. */
export function localDay(iso: string): string {
  // A bare date is already a day, not an instant.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The sources a page cites: its `sources` frontmatter entries and its links into sources/, repo-relative. */
export function citedSources(page: WikiPage): string[] {
  const out = new Set<string>();
  for (const s of page.sources ?? []) {
    // A `sources/…` entry is root-relative; anything else relative to the page.
    const rel = localTarget(
      s.startsWith('sources/') ? 'index.md' : page.path,
      s,
    );
    if (rel?.startsWith('sources/')) out.add(rel);
  }
  for (const l of page.links) {
    const rel = localTarget(page.path, l);
    if (rel?.startsWith('sources/') && rel.endsWith('.md')) out.add(rel);
  }
  return [...out];
}

export type CheckInput = {
  brainDir: string;
  pages: WikiPage[];
  sources: BrainSourceRow[];
  /** index.md's text, or null when the file is missing. */
  indexMd: string | null;
  /** Sources with a capture queued or running: not uncaptured, a job is on it. */
  inFlight?: string[];
};

/**
 * What a program can find exactly: broken links, pages older than a source they cite, uncaptured sources and
 * frontmatter gaps. Contradictions and scope changes stay with /lint.
 */
export async function checkBrain(
  { brainDir, pages, sources, indexMd, inFlight = [] }: CheckInput,
  now: Date = new Date(),
): Promise<BrainFinding[]> {
  const at = now.toISOString();
  const out: BrainFinding[] = [];
  const add = (kind: BrainFinding['kind'], page: string, detail: string) =>
    out.push({ kind, page, detail, at });
  const exists = new Map<string, Promise<boolean>>();
  const has = (rel: string) => {
    let p = exists.get(rel);
    if (!p) {
      p = fs.stat(path.join(brainDir, ...rel.split('/'))).then(
        () => true,
        () => false,
      );
      exists.set(rel, p);
    }
    return p;
  };

  const linksOf: { page: string; targets: string[] }[] = pages.map((p) => ({
    page: p.path,
    targets: p.links,
  }));
  if (indexMd !== null)
    linksOf.unshift({ page: 'index.md', targets: linkTargets(indexMd) });
  for (const { page, targets } of linksOf) {
    const seen = new Set<string>();
    for (const t of targets) {
      const rel = localTarget(page, t);
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      // Never look outside the brain folder.
      if (rel === '..' || rel.startsWith('../'))
        add('broken-link', page, `${t} points outside the brain`);
      else if (!(await has(rel)))
        add('broken-link', page, `${t} does not exist`);
    }
  }

  const ingested = new Map(sources.map((s) => [s.path, s.ingestedAt]));
  for (const p of pages) {
    if (!p.hasFrontmatter) {
      add('frontmatter', p.path, 'no frontmatter');
      continue;
    }
    const missing: string[] = [];
    if (!p.title) missing.push('title');
    if (!p.summary) missing.push('summary');
    if (!p.sources?.length && !p.path.startsWith('wiki/digests/'))
      missing.push('sources');
    if (missing.length)
      add('frontmatter', p.path, `missing ${missing.join(', ')}`);
    if (p.confidence && !CONFIDENCE.has(p.confidence))
      add(
        'frontmatter',
        p.path,
        `confidence is not high, medium or low: ${p.confidence}`,
      );
    if (p.verified && !DAY.test(p.verified))
      add(
        'frontmatter',
        p.path,
        `verified is not a date (yyyy-mm-dd): ${p.verified}`,
      );
    if (!p.lastUpdated) continue;
    if (!DAY.test(p.lastUpdated)) {
      add(
        'frontmatter',
        p.path,
        `last_updated is not a date (yyyy-mm-dd): ${p.lastUpdated}`,
      );
      continue;
    }
    const updated = p.lastUpdated.slice(0, 10);
    // A person who verified the page after the source arrived has seen it against that source.
    const verified =
      p.verified && DAY.test(p.verified) ? p.verified.slice(0, 10) : '';
    for (const s of citedSources(p)) {
      const when = ingested.get(s);
      if (!when) continue;
      const ingestedDay = localDay(when);
      if (ingestedDay > updated && ingestedDay > verified)
        add(
          'stale',
          p.path,
          `updated ${updated}, cites ${s} ingested ${ingestedDay}`,
        );
    }
  }

  const busy = new Set(inFlight);
  for (const s of sources)
    if (!s.captured && !busy.has(s.path) && !s.path.startsWith('sources/wiki/'))
      add('uncaptured', s.path, 'not captured yet');

  return out;
}
