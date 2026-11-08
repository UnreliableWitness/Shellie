/**
 * What the front page and the task tab read: pages as rows with their links, a text search over pages and
 * sources, and the pages that matter for a task. Files only, no model, no git.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import GithubSlugger from 'github-slugger';
import {
  BRAIN_PAGE_TYPES,
  type BrainPageRow,
  type BrainPageType,
  type BrainSearchHit,
} from '../../shared/brain';
import { citedSources, localTarget } from './check';
import { pageOrder, pageSummary, pageTitle } from './indexPage';
import { parsePage, readPages, splitFrontmatter, type WikiPage } from './pages';
import { absPath } from './paths';
import { parseSourceFrontmatter } from './sourceFile';

const DAY = /^\d{4}-\d{2}-\d{2}/;
const CONFIDENCE = new Set(['high', 'medium', 'low']);

/** The type a page's file name says it is; a page under digests/ is a digest; the rest is other. */
export function pageType(pagePath: string): BrainPageType {
  const rel = pagePath.replace(/^wiki\//, '');
  if (rel.startsWith('digests/')) return 'digest';
  const name = path.posix.basename(rel);
  if (name === 'account.md') return 'account';
  if (name === 'glossary.md') return 'glossary';
  for (const t of [
    'subject',
    'scope',
    'component',
    'decision',
    'meeting',
    'lesson',
  ] as const)
    if (name.startsWith(`${t}-`)) return t;
  return 'other';
}

const PICTURE = /\.(?:png|jpe?g|gif|webp|svg|bmp)$/i;

/** The picture files a page links or embeds, repo-relative, in document order, each once. */
function pagePictures(page: WikiPage): string[] {
  const out = new Set<string>();
  for (const l of page.links) {
    const rel = localTarget(page.path, l);
    if (rel && PICTURE.test(rel)) out.add(rel);
  }
  return [...out];
}

/** Every wiki page as a row, in the front page's order: by type, then as the index sorts. */
export async function pageRows(brainDir: string): Promise<BrainPageRow[]> {
  const pages = await readPages(brainDir);
  const known = new Set(pages.map((p) => p.path));
  const linkedFrom = new Map<string, Set<string>>();
  for (const p of pages)
    for (const l of p.links) {
      const rel = localTarget(p.path, l);
      if (!rel || rel === p.path || !known.has(rel)) continue;
      let set = linkedFrom.get(rel);
      if (!set) linkedFrom.set(rel, (set = new Set()));
      set.add(p.path);
    }
  const rows = pages.map((p): BrainPageRow => {
    const verified =
      p.verified && DAY.test(p.verified) ? p.verified.slice(0, 10) : null;
    const updated =
      p.lastUpdated && DAY.test(p.lastUpdated)
        ? p.lastUpdated.slice(0, 10)
        : null;
    return {
      path: p.path,
      title: pageTitle(p),
      summary: p.summary || p.firstLine ? pageSummary(p) : '',
      type: pageType(p.path),
      lastUpdated: p.lastUpdated,
      confidence:
        p.confidence && CONFIDENCE.has(p.confidence)
          ? (p.confidence as 'high' | 'medium' | 'low')
          : null,
      verified,
      changedSinceVerified: !!verified && !!updated && updated > verified,
      sources: citedSources(p),
      linkedFrom: [...(linkedFrom.get(p.path) ?? [])].sort(),
      pictures: pagePictures(p),
    };
  });
  const byPath = new Map(pages.map((p) => [p.path, p]));
  return rows.sort(
    (a, b) =>
      BRAIN_PAGE_TYPES.indexOf(a.type) - BRAIN_PAGE_TYPES.indexOf(b.type) ||
      pageOrder(byPath.get(a.path)!, byPath.get(b.path)!),
  );
}

export const SEARCH_MIN = 2;
const SEARCH_MAX_HITS = 50;
const SEARCH_PER_FILE = 3;
const SEARCH_MAX_BYTES = 2 * 1024 * 1024;
const SNIPPET = 160;

async function markdownFiles(
  brainDir: string,
  root: string,
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = await fs.readdir(absPath(brainDir, rel), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name.endsWith('-assets')) continue;
      const next = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(next);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md'))
        out.push(next);
    }
  };
  await walk(root);
  return out;
}

/**
 * A heading's text as the viewer slugs it (rehype-slug on the rendered text): pictures gone, links to their text,
 * code spans verbatim, emphasis marks dropped only where they delimit (`_` inside a word stays). Not trimmed: the
 * viewer keeps a leading space as a dash.
 */
export function headingText(raw: string): string {
  const noPictures = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  const noLinks = noPictures.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  return noLinks
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part.slice(1, -1) : unemphasised(part)))
    .join('');
}

/** Punctuation that may sit next to an emphasis mark; not `_`, `*` or `~`, which are marks themselves. */
const EDGE = `[\\s"'.,:;!?()[\\]{}<>]`;
/** `(^|edge)(mark)(text)(same mark)(?=edge|$)`: only a paired mark is emphasis; `_private` keeps its underscore. */
const PAIRED = new RegExp(
  `(^|${EDGE})(\\*\\*|__|\\*|_|~~)(\\S(?:.*?\\S)??)\\2(?=${EDGE}|$)`,
  'g',
);

/** Emphasis marks dropped where they pair up, as the viewer renders them; run until nothing pairs any more. */
function unemphasised(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(PAIRED, '$1$3');
    if (next === out) return out;
    out = next;
  }
}

/** The matching line cut to SNIPPET characters around the match. */
export function snippet(line: string, index: number): string {
  const l = line.trim();
  const i = Math.max(0, index - (line.length - l.length));
  if (l.length <= SNIPPET) return l;
  const start = Math.max(0, Math.min(i - 60, l.length - SNIPPET));
  const end = Math.min(l.length, start + SNIPPET);
  return `${start > 0 ? '…' : ''}${l.slice(start, end)}${end < l.length ? '…' : ''}`;
}

/**
 * Lines of pages (first) and sources (after) holding the query, case-insensitive, outside the frontmatter, at most
 * SEARCH_PER_FILE per file and SEARCH_MAX_HITS in all, each with the nearest heading above it as an anchor.
 */
export async function searchBrain(
  brainDir: string,
  query: string,
): Promise<BrainSearchHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < SEARCH_MIN) return [];
  const out: BrainSearchHit[] = [];
  const files: { rel: string; kind: 'page' | 'source' }[] = [
    ...(await markdownFiles(brainDir, 'wiki')).map((rel) => ({
      rel,
      kind: 'page' as const,
    })),
    ...(await markdownFiles(brainDir, 'sources')).map((rel) => ({
      rel,
      kind: 'source' as const,
    })),
  ];
  for (const { rel, kind } of files) {
    if (out.length >= SEARCH_MAX_HITS) break;
    const abs = absPath(brainDir, rel);
    if ((await fs.stat(abs)).size > SEARCH_MAX_BYTES) continue;
    const text = await fs.readFile(abs, 'utf8');
    const { body } = splitFrontmatter(text);
    const offset = text.split(/\r?\n/).length - body.split(/\r?\n/).length;
    const title =
      kind === 'page'
        ? pageTitle(parsePage(rel, text))
        : (parseSourceFrontmatter(text)?.title ??
          path.posix.basename(rel, '.md'));
    const slugger = new GithubSlugger();
    let anchor: string | null = null;
    let found = 0;
    // Fenced code is not headings: the viewer gives a `#` line inside it no id. A fence closes with its own marker.
    let fence: string | null = null;
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length && found < SEARCH_PER_FILE; i++) {
      const line = lines[i];
      const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (f) {
        if (fence === null) fence = f[1];
        else if (
          f[1][0] === fence[0] &&
          f[1].length >= fence.length &&
          f[2].trim() === ''
        )
          fence = null;
      }
      const h = fence === null ? /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line) : null;
      if (h) anchor = slugger.slug(headingText(h[1]));
      const at = line.toLowerCase().indexOf(q);
      if (at < 0) continue;
      out.push({
        path: rel,
        kind,
        title,
        line: offset + i + 1,
        text: snippet(line, at),
        anchor,
      });
      found++;
      if (out.length >= SEARCH_MAX_HITS) break;
    }
  }
  return out;
}

const STOP = new Set([
  'with',
  'from',
  'this',
  'that',
  'task',
  'work',
  'item',
  'when',
  'then',
  'have',
  'will',
  'should',
  'would',
  'their',
  'there',
  'about',
  'into',
  'they',
  'them',
  'what',
  'which',
  // Dutch and German, the owner's other languages.
  'voor',
  'niet',
  'deze',
  'naar',
  'zijn',
  'maar',
  'ook',
  'nicht',
  'eine',
  'auch',
  'werden',
  'wird',
  'über',
  'dass',
]);

/** The words (4+ letters, lower case, no stop words) of the texts, each once, in order of first appearance. */
export function taskWords(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts)
    for (const m of t
      .normalize('NFC')
      .toLowerCase()
      .matchAll(/\p{L}{4,}/gu))
      if (!STOP.has(m[0]) && !out.includes(m[0])) out.push(m[0]);
  return out;
}

const RELEVANT_MAX = 5;

/** The pages that mention the task's words: title words count twice, summary words once; the top 5 with a score. */
export function relevantPages(rows: BrainPageRow[], words: string[]): string[] {
  if (!words.length) return [];
  const scored = rows
    .map((r) => {
      const title = r.title.toLowerCase();
      const summary = r.summary.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (title.includes(w)) score += 2;
        if (summary.includes(w)) score += 1;
      }
      return { path: r.path, title: r.title, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return scored.slice(0, RELEVANT_MAX).map((s) => s.path);
}
