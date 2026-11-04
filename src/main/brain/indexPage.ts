import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readPages, type WikiPage } from './pages';

const SUMMARY_LENGTH = 160;
/** Top-level pages in this order of file-name prefix; the rest after, by name. */
const TYPE_ORDER = [
  'account',
  'scope-',
  'component-',
  'glossary',
  'decision-',
  'meeting-',
];
/** Dated names (`decision-2026-11-04-…`, `2026-w45`) list newest first within their prefix. */
const DATED = /^(?:[a-z]+-)?\d{4}-/;
const datePrefix = (name: string) => name.replace(/\d{4}-.*$/, '');

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

/**
 * One line of plain text: links and images reduced to their text (a page-relative link would be broken at the
 * root), brackets and backslashes dropped so the line cannot break the index's own link.
 */
const oneLine = (s: string) =>
  s
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/[[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function pageTitle(p: WikiPage): string {
  return (
    oneLine(p.title ?? p.heading ?? '') || path.posix.basename(p.path, '.md')
  );
}

export function pageSummary(p: WikiPage): string {
  const s = oneLine(p.summary ?? p.firstLine ?? '');
  return s ? clip(s, SUMMARY_LENGTH) : '(no summary)';
}

/** The page path as a link destination: `#`, `?`, `%`, `<` and `>` encoded, angle brackets around spaces or parens. */
export function linkPath(p: string): string {
  const enc = p.replace(/[%#?<>]/g, (c) => encodeURIComponent(c));
  return /[\s()]/.test(enc) ? `<${enc}>` : enc;
}

const rank = (name: string) => {
  const i = TYPE_ORDER.findIndex((t) => name.startsWith(t));
  return i < 0 ? TYPE_ORDER.length : i;
};

/** How pages of one folder are listed: by type prefix, dated names newest first, then by name. */
export function pageOrder(a: WikiPage, b: WikiPage): number {
  const an = path.posix.basename(a.path);
  const bn = path.posix.basename(b.path);
  const r = rank(an) - rank(bn);
  if (r !== 0) return r;
  if (DATED.test(an) && DATED.test(bn) && datePrefix(an) === datePrefix(bn))
    return bn.localeCompare(an);
  return an.localeCompare(bn);
}

const line = (p: WikiPage) =>
  `- [${pageTitle(p)}](${linkPath(p.path)}): ${pageSummary(p)}`;

/** Where an old index's own listing starts: a list item, a heading, a table row, or any line linking into wiki/. */
const LISTING = /^\s*(?:[-*+]\s|\d+[.)]\s|#|\|)|\]\(<?wiki\//;

/**
 * The title line and the intro of an existing index.md: everything between the first `# ` heading and the first
 * list item, heading, table or link into wiki/. Nothing else of the old file is kept.
 */
export function indexIntro(existing: string | null): {
  title: string | null;
  intro: string[];
} {
  if (existing === null) return { title: null, intro: [] };
  const lines = existing.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith('# '));
  if (at < 0) return { title: null, intro: [] };
  const intro: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (LISTING.test(l)) break;
    if (l.trim() === '(no pages yet)') continue;
    intro.push(l);
  }
  while (intro.length && intro[intro.length - 1].trim() === '') intro.pop();
  while (intro.length && intro[0].trim() === '') intro.shift();
  return { title: lines[at].replace(/^# /, '').trim(), intro };
}

/** index.md from the pages' frontmatter: top-level pages, then one section per subfolder. */
export function renderIndex(
  title: string,
  intro: string[],
  pages: WikiPage[],
): string {
  const out = [`# ${title}`, ''];
  if (intro.length) out.push(...intro, '');
  const top = pages.filter((p) => !p.path.slice('wiki/'.length).includes('/'));
  const folders = new Map<string, WikiPage[]>();
  for (const p of pages) {
    const rel = p.path.slice('wiki/'.length);
    const i = rel.indexOf('/');
    if (i < 0) continue;
    const folder = rel.slice(0, i);
    const list = folders.get(folder);
    if (list) list.push(p);
    else folders.set(folder, [p]);
  }
  if (!top.length && !folders.size) out.push('(no pages yet)', '');
  if (top.length) out.push(...top.sort(pageOrder).map(line), '');
  for (const folder of [...folders.keys()].sort()) {
    out.push(`## ${folder}`, '');
    out.push(...folders.get(folder)!.sort(pageOrder).map(line), '');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * Rewrites index.md from the pages when the result differs from the file; true when it wrote. A brain without a
 * wiki/ folder is left alone.
 */
export async function rebuildIndex(
  brainDir: string,
  brainName: string,
): Promise<boolean> {
  const hasWiki = await fs.stat(path.join(brainDir, 'wiki')).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!hasWiki) return false;
  const file = path.join(brainDir, 'index.md');
  const existing = await fs.readFile(file, 'utf8').catch(() => null);
  const { title, intro } = indexIntro(existing);
  const pages = await readPages(brainDir);
  const next = renderIndex(title ?? `${brainName} brain`, intro, pages);
  if (existing !== null && existing.replace(/\r\n/g, '\n') === next)
    return false;
  // Unique per write: two rebuilds at once (a Health read and a job start) must not share a temp file.
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, next, 'utf8');
  await fs.rename(tmp, file);
  return true;
}
