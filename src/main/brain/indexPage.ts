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

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function pageTitle(p: WikiPage): string {
  return oneLine(p.title ?? p.heading ?? path.posix.basename(p.path, '.md'));
}

export function pageSummary(p: WikiPage): string {
  const s = p.summary ?? p.firstLine;
  return s ? clip(oneLine(s), SUMMARY_LENGTH) : '(no summary)';
}

const rank = (name: string) => {
  const i = TYPE_ORDER.findIndex((t) => name.startsWith(t));
  return i < 0 ? TYPE_ORDER.length : i;
};

function order(a: WikiPage, b: WikiPage): number {
  const an = path.posix.basename(a.path);
  const bn = path.posix.basename(b.path);
  const r = rank(an) - rank(bn);
  if (r !== 0) return r;
  if (DATED.test(an) && DATED.test(bn) && datePrefix(an) === datePrefix(bn))
    return bn.localeCompare(an);
  return an.localeCompare(bn);
}

const line = (p: WikiPage) =>
  `- [${pageTitle(p).replace(/[[\]]/g, '')}](${p.path}): ${pageSummary(p)}`;

/**
 * The title line and the intro of an existing index.md: everything between the first `# ` heading and the first
 * list item or `## ` heading. Nothing else of the old file is kept.
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
    if (/^(- |\* |## )/.test(l)) break;
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
    folders.set(folder, [...(folders.get(folder) ?? []), p]);
  }
  if (!top.length && !folders.size) out.push('(no pages yet)', '');
  if (top.length) out.push(...top.sort(order).map(line), '');
  for (const folder of [...folders.keys()].sort()) {
    out.push(`## ${folder}`, '');
    out.push(...folders.get(folder)!.sort(order).map(line), '');
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
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, next, 'utf8');
  await fs.rename(tmp, file);
  return true;
}
