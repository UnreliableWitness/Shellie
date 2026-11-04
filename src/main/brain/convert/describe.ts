/**
 * One line saying what a converted source holds, from its markdown alone (no model): counts of its parts,
 * then the first titles. Shown beside the source in the Brain screen and in the drop notes.
 */

const MAX_LENGTH = 180;
const MAX_TITLES = 4;
const TITLE_LENGTH = 48;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

/** A line of body text with markdown dressing removed (underscores inside words stay: `Q1_Budget`). */
const plain = (line: string) =>
  line
    .replace(/^#+\s*/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|`/g, '')
    .replace(/(^|\s)[*_]+|[*_]+(?=\s|$)/g, '$1')
    .trim();

/** The lines outside fenced code blocks: a `# comment` in a code sample is not a heading. */
function outsideFences(lines: string[]): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(l);
  }
  return out;
}

function titlesOf(
  lines: string[],
  pick: (line: string, i: number) => boolean,
): string[] {
  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (!pick(line, i)) continue;
    const t = plain(line);
    if (!t || t.startsWith('|') || out.includes(t)) continue;
    out.push(clip(t, TITLE_LENGTH));
    if (out.length === MAX_TITLES) break;
  }
  return out;
}

/**
 * The first text line after each heading of the given shape (a slide's or a page's title line). Pictures,
 * notes and tables are not titles, and any other heading ends the search for that section.
 */
function firstLinesAfter(lines: string[], heading: RegExp): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < MAX_TITLES; i++) {
    if (!heading.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (l === '') continue;
      if (/^#{1,6} /.test(l)) break;
      if (/^(!\[|\||_|\()/.test(l)) continue;
      const t = plain(l);
      if (t && !out.includes(t)) out.push(clip(t, TITLE_LENGTH));
      break;
    }
  }
  return out;
}

export function describeContents(
  markdown: string,
  imageCount: number,
  ext: string,
): string {
  const lines = outsideFences(markdown.split('\n'));
  const parts: string[] = [];
  const e = ext.toLowerCase();
  const tables = lines.filter((l) => /^\|\s*---/.test(l)).length;
  const headings = (re: RegExp) => lines.filter((l) => re.test(l)).length;
  let titles: string[] = [];

  if (e === 'pptx') {
    const slides = headings(/^## Slide \d+$/);
    parts.push(plural(slides, 'slide'));
    titles = firstLinesAfter(lines, /^## Slide \d+$/);
  } else if (e === 'pdf') {
    const pages = headings(/^## p\.\d+$/);
    parts.push(plural(pages, 'page'));
    const drawn = lines.filter((l) => /^!\[p\.\d+ as drawn\]/.test(l)).length;
    if (drawn > 0) parts.push(plural(drawn, 'drawn page'));
    titles = firstLinesAfter(lines, /^## p\.\d+$/).slice(0, 2);
  } else if (e === 'xlsx') {
    const sheets = lines.filter((l) => /^## /.test(l));
    parts.push(plural(sheets.length, 'sheet'));
    // Data rows: the table lines without header and separator, plus what the converter left out.
    let rows = lines.filter((l) => /^\| /.test(l)).length - 2 * tables;
    for (const m of markdown.matchAll(/^_(\d+) more rows not shown/gm)) {
      rows += Number(m[1]);
    }
    if (rows > 0) parts.push(plural(rows, 'row'));
    titles = sheets
      .map((l) => clip(plain(l), TITLE_LENGTH))
      .slice(0, MAX_TITLES);
  } else if (e === 'vtt') {
    const minutes = headings(/^## /);
    if (minutes > 0) parts.push(`${minutes} min`);
    const speakers = new Set(
      lines.flatMap((l) => {
        const m = /^\*\*([^*]+):\*\*/.exec(l);
        return m ? [m[1].trim()] : [];
      }),
    );
    if (speakers.size > 0) parts.push(plural(speakers.size, 'speaker'));
  } else if (e === 'drawio') {
    const pages = headings(/^## /);
    parts.push(plural(pages, 'diagram page'));
    titles = titlesOf(lines, (l) => /^## /.test(l));
  } else {
    const hs = headings(/^#{1,3} /);
    if (hs > 0) parts.push(plural(hs, 'heading'));
    else {
      const words = markdown.split(/\s+/).filter(Boolean).length;
      parts.push(plural(words, 'word'));
    }
    titles = titlesOf(lines, (l) => /^#{1,3} /.test(l));
    if (titles.length === 0) {
      titles = titlesOf(lines, (l) => /[\p{L}\p{N}]/u.test(l)).slice(0, 1);
    }
  }
  if (imageCount > 0) parts.push(plural(imageCount, 'picture'));
  if (tables > 0 && e !== 'xlsx') parts.push(plural(tables, 'table'));

  const head = parts.join(' · ');
  const tail = titles.join('; ');
  return clip(tail ? `${head}: ${tail}` : head, MAX_LENGTH);
}
