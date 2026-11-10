/** The composer's small text rules: a title for pasted text, the toolbar's Markdown edits, and file kinds. */

const MAX_TITLE = 60;

/** The title typed, else the first heading's text, else the first line (list and quote markers off), cut at a word. */
export function titleFor(title: string, text: string): string {
  const typed = title.trim();
  if (typed) return typed;
  const lines = text.split(/\r?\n/);
  for (const l of lines) {
    const m = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (m?.[1]) return cut(m[1]);
  }
  const first = lines
    .map((l) =>
      l.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/, '').trim(),
    )
    .find((l) => l !== '');
  return first ? cut(first) : '';
}

function cut(s: string): string {
  if (s.length <= MAX_TITLE) return s;
  const head = s.slice(0, MAX_TITLE);
  const space = head.lastIndexOf(' ');
  return `${(space > MAX_TITLE / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

export type Format =
  | 'heading'
  | 'bold'
  | 'italic'
  | 'bullets'
  | 'checklist'
  | 'link'
  | 'code'
  | 'table';

export type Edited = { text: string; start: number; end: number };

const WRAP: Partial<Record<Format, string>> = {
  bold: '**',
  italic: '_',
  code: '`',
};
const PREFIX: Partial<Record<Format, string>> = {
  heading: '## ',
  bullets: '- ',
  checklist: '- [ ] ',
};

/** One toolbar button on the text and its selection (offsets): the new text and what to select after. */
export function applyFormat(
  f: Format,
  text: string,
  start: number,
  end: number,
): Edited {
  const sel = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (f === 'code' && sel.includes('\n')) {
    const block = `\`\`\`\n${sel}\n\`\`\``;
    return { text: before + block + after, start, end: start + block.length };
  }
  const wrap = WRAP[f];
  if (wrap) {
    const s = start + wrap.length;
    return {
      text: before + wrap + sel + wrap + after,
      start: s,
      end: s + sel.length,
    };
  }
  const prefix = PREFIX[f];
  if (prefix) return prefixLines(text, start, end, prefix);
  if (f === 'link') {
    const link = `[${sel}](url)`;
    const s = start + sel.length + 3;
    return { text: before + link + after, start: s, end: s + 3 };
  }
  // table
  const lead =
    before === '' || before.endsWith('\n\n')
      ? ''
      : before.endsWith('\n')
        ? '\n'
        : '\n\n';
  const table = `${lead}| Column | Column |\n| --- | --- |\n|  |  |\n`;
  const caret = before.length + table.length - 5;
  return { text: before + table + after, start: caret, end: caret };
}

/** Prefixes every line the selection touches, or takes the prefix off when every one has it already. */
function prefixLines(
  text: string,
  start: number,
  end: number,
  prefix: string,
): Edited {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const nl = text.indexOf(
    '\n',
    Math.max(end, from) - (end > start && text[end - 1] === '\n' ? 1 : 0),
  );
  const to = nl < 0 ? text.length : nl;
  const lines = text.slice(from, to).split('\n');
  const all = lines.every((l) => l.startsWith(prefix));
  const next = lines
    .map((l) => (all ? l.slice(prefix.length) : prefix + l))
    .join('\n');
  return {
    text: text.slice(0, from) + next + text.slice(to),
    start: from,
    end: from + next.length,
  };
}

/** Text the editor opens instead of attaching: Markdown and plain text. */
export const isEditorText = (name: string): boolean =>
  /\.(md|markdown|txt)$/i.test(name);

export type FileKind =
  | 'pdf'
  | 'word'
  | 'deck'
  | 'sheet'
  | 'drawio'
  | 'transcript'
  | 'text'
  | 'picture'
  | 'other';

const KINDS: [RegExp, FileKind][] = [
  [/\.pdf$/i, 'pdf'],
  [/\.docx?$/i, 'word'],
  [/\.pptx?$/i, 'deck'],
  [/\.(xlsx?|csv)$/i, 'sheet'],
  [/\.drawio$/i, 'drawio'],
  [/\.vtt$/i, 'transcript'],
  [/\.(md|markdown|txt)$/i, 'text'],
  [/\.(png|jpe?g|gif|webp|svg)$/i, 'picture'],
];

/** The kind a file chip shows, by extension. */
export const fileKind = (name: string): FileKind =>
  KINDS.find(([re]) => re.test(name))?.[1] ?? 'other';

export const BIG_FILE_BYTES = 5 * 1024 * 1024;

/** What the Capture with hint names when a stronger model may help: a deck, else a large file; null for neither. */
export function suggestStronger(
  files: { name: string; bytes: number }[],
): string | null {
  if (files.some((f) => fileKind(f.name) === 'deck')) return 'the deck';
  if (files.some((f) => f.bytes >= BIG_FILE_BYTES)) return 'the large file';
  return null;
}
