import {
  parseWriteTarget,
  type BrainJob,
  type BrainLetterRow,
  type BrainReadRow,
  type BrainReads,
} from '../../../shared/brain';
import { local } from '../../localStorage';

/** A piece of a long read's essay: prose, or the one question that interrupts it. */
export type ReadPart =
  | { kind: 'prose'; text: string }
  | { kind: 'question'; question: string; answer: string };

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const MISSING = /^##\s+What the writer was missing\s*$/i;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/**
 * Per line, whether it is code (inside a fence, or the fence itself): a heading or a marker quoted there is an
 * example, not structure.
 */
function codeLines(lines: string[]): boolean[] {
  let open: string | null = null;
  return lines.map((line) => {
    const f = FENCE.exec(line)?.[1];
    if (!open) {
      if (!f) return false;
      open = f;
      return true;
    }
    // Closed by the same character, at least as long, with nothing after it.
    if (
      f &&
      f[0] === open[0] &&
      f.length >= open.length &&
      !line.trim().slice(f.length)
    )
      open = null;
    return true;
  });
}
const QUOTED = /^\s{0,3}>\s?/;
const marker = (line: string, word: string) =>
  new RegExp(`^\\s{0,3}>\\s*\\*\\*${word}:?\\*\\*:?\\s*$`, 'i').test(line);
/** Link and footnote definitions: a part cut from the essay still needs the ones it uses. */
const DEFINITION = /^\[[^\]\n]+\]:\s+\S.*$/gm;

/** The text under a file's frontmatter, without the title heading the reader already shows. */
export const bodyOf = (text: string): string =>
  text
    .replace(FRONTMATTER, '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*#\s+.*\n/, '');

/**
 * A long read's body as the reader shows it: the essay in parts (each `Before you read on` blockquote is a question
 * with its answer held back), and the `What the writer was missing` section apart. A block without an answer stays prose.
 */
export function splitRead(body: string): {
  parts: ReadPart[];
  missing: string | null;
} {
  const all = body.split('\n');
  const allCode = codeLines(all);
  const cut = all.findIndex((l, i) => !allCode[i] && MISSING.test(l));
  const lines = cut < 0 ? all : all.slice(0, cut);
  const code = allCode.slice(0, lines.length);
  const essay = lines.join('\n');
  const missing =
    cut < 0
      ? null
      : all
          .slice(cut + 1)
          .join('\n')
          .trim() || null;
  const defs = essay.match(DEFINITION) ?? [];
  const parts: ReadPart[] = [];
  let prose: string[] = [];
  const flush = () => {
    const text = prose.join('\n').trim();
    prose = [];
    if (!text) return;
    const need = defs.filter((d) => !text.includes(d));
    parts.push({
      kind: 'prose',
      text: need.length ? `${text}\n\n${need.join('\n')}` : text,
    });
  };
  for (let i = 0; i < lines.length; i++) {
    if (code[i] || !marker(lines[i], 'Before you read on')) {
      prose.push(lines[i]);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && QUOTED.test(lines[end])) end++;
    const block = lines.slice(i + 1, end);
    const at = block.findIndex((l) => marker(l, 'Answer'));
    const strip = (ls: string[]) =>
      ls
        .map((l) => l.replace(QUOTED, ''))
        .join('\n')
        .trim();
    const question = at < 0 ? '' : strip(block.slice(0, at));
    const answer = at < 0 ? '' : strip(block.slice(at + 1));
    if (!question || !answer) {
      prose.push(...lines.slice(i, end));
    } else {
      flush();
      parts.push({ kind: 'question', question, answer });
    }
    i = end - 1;
  }
  flush();
  return { parts, missing };
}

export type LetterKind = 'read' | 'now' | 'why' | 'follows';
export type LetterChange = {
  /** The change in a few words, when the letter tells several. */
  title: string | null;
  intro: string;
  sections: { kind: LetterKind; label: string; text: string }[];
};

const LETTER_KINDS: Record<string, LetterKind> = {
  'what you read': 'read',
  'what holds now': 'now',
  'why it changed': 'why',
  'what follows': 'follows',
};

/**
 * A letter's body as the reader shows it: its opening, then each change with its four labelled sections. One change
 * has them as `##` sections; several have a `##` heading per change and the four as `###` under it. A body without
 * any of the four has no changes: it is shown as it is written.
 */
export function splitLetter(body: string): {
  opening: string;
  changes: LetterChange[];
} {
  const opening: string[] = [];
  const changes: LetterChange[] = [];
  let change: LetterChange | null = null;
  let into: string[] = opening;
  const close = (target: string[]) => target.join('\n').trim();
  const pending: (() => void)[] = [];
  const start = (set: (text: string) => void) => {
    const lines: string[] = [];
    into = lines;
    pending.push(() => set(close(lines)));
  };
  const lines = body.split('\n');
  const code = codeLines(lines);
  for (const [i, line] of lines.entries()) {
    const h = code[i] ? null : /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    const kind = h ? LETTER_KINDS[h[2].toLowerCase()] : undefined;
    if (h && kind) {
      if (!change) {
        change = { title: null, intro: '', sections: [] };
        changes.push(change);
      }
      const section = { kind, label: h[2], text: '' };
      change.sections.push(section);
      start((text) => (section.text = text));
    } else if (h && h[1] === '##') {
      const next: LetterChange = { title: h[2], intro: '', sections: [] };
      change = next;
      changes.push(next);
      start((text) => (next.intro = text));
    } else into.push(line);
  }
  for (const done of pending) done();
  if (!changes.some((c) => c.sections.length))
    return { opening: body.trim(), changes: [] };
  return { opening: close(opening), changes };
}

/** What a reader has marked as read: path → the text's hash and when. A convenience in localStorage, per brain. */
export type ReadMarks = Record<string, { hash: string; at: string }>;

const MARKS = (brainId: string) => `shellie.brain.reads.${brainId}`;

export function loadMarks(brainId: string): ReadMarks {
  try {
    const raw = local()?.getItem(MARKS(brainId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    const out: ReadMarks = {};
    for (const [path, m] of Object.entries(parsed as Record<string, unknown>)) {
      const mark = m as { hash?: unknown; at?: unknown } | null;
      if (typeof mark?.hash === 'string' && typeof mark.at === 'string')
        out[path] = { hash: mark.hash, at: mark.at };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveMarks(brainId: string, marks: ReadMarks) {
  try {
    local()?.setItem(MARKS(brainId), JSON.stringify(marks));
  } catch {
    /* no storage: the marks last as long as the view */
  }
}

/** Read is said of one text: a long read brought up to date is unread again. */
export const isRead = (
  marks: ReadMarks,
  row: Pick<BrainReadRow | BrainLetterRow, 'path' | 'hash'>,
) => marks[row.path]?.hash === row.hash;

export const unreadCount = (reads: BrainReads, marks: ReadMarks) =>
  [...reads.reads, ...reads.letters].filter((r) => !isRead(marks, r)).length;

const IN_FLIGHT = new Set<BrainJob['status']>(['queued', 'running', 'paused']);

/** The newest write job for the target (`jobs` come newest first), and whether it is still to run or running. */
export function writeJob(
  jobs: BrainJob[],
  target: string,
): { job: BrainJob; pending: boolean } | null {
  const job = jobs.find((j) => j.kind === 'write' && j.target === target);
  return job ? { job, pending: IN_FLIGHT.has(job.status) } : null;
}

/** The newest letter about the long read, or undefined: `letters` come newest first. */
export const newestLetter = (reads: BrainReads, path: string) =>
  reads.letters.find((l) => l.read === path);

/**
 * The topics asked for that have no long read to show: the newest write of each, when it is still to run, running or
 * failed. Newest first.
 */
export function openTopics(jobs: BrainJob[]): BrainJob[] {
  const seen = new Set<string>();
  return jobs.filter((j) => {
    if (j.kind !== 'write' || !j.target?.startsWith('topic:')) return false;
    if (seen.has(j.target)) return false;
    seen.add(j.target);
    return IN_FLIGHT.has(j.status) || j.status === 'failed';
  });
}

/** What a write job's row says while it waits or runs. */
export const writeStatus = (job: BrainJob): string =>
  job.status === 'running'
    ? 'Writing…'
    : job.status === 'paused'
      ? 'Paused: daily token cap'
      : 'Queued';

/** What a write job is for, as Activity says it: the chapter, the topic, or the long read it brings up to date. */
export function writeLabel(target: string): string {
  const t = parseWriteTarget(target);
  if (!t) return target;
  if ('chapter' in t) return `chapter ${t.chapter}`;
  if ('topic' in t) return t.topic;
  return `update of ${t.update.split('/').pop()}`;
}
