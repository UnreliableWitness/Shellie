import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

/** A page under wiki/, as Shellie's checks and the index see it. */
export type WikiPage = {
  /** Repo-relative, forward slashes: `wiki/account.md`. */
  path: string;
  hasFrontmatter: boolean;
  title: string | null;
  summary: string | null;
  /** `last_updated` as written (a date or a timestamp), or null. */
  lastUpdated: string | null;
  /** The `sources` entries as written, or null when the field is absent or not a list of strings. */
  sources: string[] | null;
  /** Markdown link and image targets in the body, outside fenced code, as written (fragment included). */
  links: string[];
  /** The first `# ` heading of the body, or null. */
  heading: string | null;
  /** The first paragraph line of the body (not a heading, list, table, image or blank), or null. */
  firstLine: string | null;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** The frontmatter block and the body, tolerant: an unparsable block counts as absent. */
export function splitFrontmatter(text: string): {
  data: Record<string, unknown> | null;
  body: string;
} {
  const m = FRONTMATTER.exec(text);
  if (!m) return { data: null, body: text };
  try {
    const data: unknown = parse(m[1]);
    if (data && typeof data === 'object' && !Array.isArray(data))
      return {
        data: data as Record<string, unknown>,
        body: text.slice(m[0].length),
      };
  } catch {
    /* not YAML */
  }
  return { data: null, body: text.slice(m[0].length) };
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A date or timestamp field as `yyyy-mm-dd…`. The yaml package parses a bare date to a Date at UTC midnight (its
 * UTC day is the day written) and a timestamp to an instant (its local day is the writer's day).
 */
const dateStr = (v: unknown): string | null => {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const bare =
      v.getUTCHours() === 0 &&
      v.getUTCMinutes() === 0 &&
      v.getUTCSeconds() === 0 &&
      v.getUTCMilliseconds() === 0;
    return bare
      ? v.toISOString().slice(0, 10)
      : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  if (typeof v === 'number') return String(v);
  const s = str(v);
  // A timestamp written as a string (the default yaml schema keeps dates as strings): the writer's local day.
  if (s && /^\d{4}-\d{2}-\d{2}[T ]\d/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime()))
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return s;
};

const stringList = (v: unknown): string[] | null => {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return null;
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim());
};

/** The lines of a body outside fenced code blocks. */
export function outsideFences(text: string): string[] {
  const out: string[] = [];
  // A block closes only with its own marker: same character, at least as long, nothing after it.
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) {
      if (fence === null) {
        fence = m[1];
        continue;
      }
      if (
        m[1][0] === fence[0] &&
        m[1].length >= fence.length &&
        m[2].trim() === ''
      ) {
        fence = null;
        continue;
      }
    }
    if (fence === null) out.push(line);
  }
  return out;
}

const LINK =
  /!?\[[^\]]*\]\(\s*(?:<([^>]*)>|([^\s()]*(?:\([^\s()]*\)[^\s()]*)*))(?:\s+("[^"]*"|'[^']*'))?\s*\)/g;

/** Link and image targets of markdown text (outside fences), as written. Inline code is left out. */
export function linkTargets(text: string): string[] {
  const out: string[] = [];
  for (const line of outsideFences(text)) {
    const plain = line.replace(/`[^`]*`/g, '');
    for (const m of plain.matchAll(LINK)) {
      const target = (m[1] ?? m[2] ?? '').trim();
      if (target) out.push(target);
    }
  }
  return out;
}

export function parsePage(relPath: string, text: string): WikiPage {
  const { data, body } = splitFrontmatter(text);
  const lines = outsideFences(body);
  const heading =
    lines
      .find((l) => l.startsWith('# '))
      ?.slice(2)
      .trim() ?? null;
  const firstLine =
    lines
      .find(
        (l) =>
          l.trim() !== '' &&
          !/^(#|[-*+] |\d+\. |\||!\[|---|>|<)/.test(l.trim()),
      )
      ?.trim() ?? null;
  return {
    path: relPath,
    hasFrontmatter: data !== null,
    title: str(data?.title),
    summary: str(data?.summary),
    lastUpdated: dateStr(data?.last_updated),
    sources: data ? stringList(data.sources) : null,
    links: linkTargets(body),
    heading,
    firstLine,
  };
}

/** Every `wiki/**\/*.md` page, sorted by path. A missing wiki/ is an empty list. */
export async function readPages(brainDir: string): Promise<WikiPage[]> {
  const root = path.join(brainDir, 'wiki');
  const out: WikiPage[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(
        path.join(root, ...rel.split('/').filter(Boolean)),
        {
          withFileTypes: true,
        },
      );
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(next);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const text = await fs.readFile(
          path.join(root, ...next.split('/')),
          'utf8',
        );
        out.push(parsePage(`wiki/${next}`, text));
      }
    }
  };
  await walk('');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
