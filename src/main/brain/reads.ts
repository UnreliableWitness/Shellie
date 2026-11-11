/**
 * Long reads and letters: prose under `reads/` that `/write` makes from the wiki for a person to read from start to
 * end. Shellie keeps, in `brain/reads.json`, which pages each long read was written from (a hash of each page's
 * body) and the commit it was written at, so it can tell without a model when a long read is out of date, and hand
 * the update the commit to compare with. Read tolerantly, because an agent wrote the files.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  isLongRead,
  MAX_TOPIC,
  parseWriteTarget,
  type BrainBook,
  type BrainLetterRow,
  type BrainReadRow,
  type BrainReads,
  type WriteTarget,
} from '../../shared/brain';
import type { GitClient } from '../services/GitClient';
import { readBook } from './book';
import { splitFrontmatter, str } from './pages';
import { absPath } from './paths';

export const READS_DIR = 'reads';
export const LETTERS_DIR = 'reads/letters';
export const READS_RECORD = 'brain/reads.json';
const WORDS_A_MINUTE = 230;
/** The section the writer lists its gaps in: shown apart, and not part of the reading time. */
const MISSING = /^##\s+What the writer was missing\s*$/im;

export type ReadRecord = {
  at: string;
  /** The brain's HEAD when the long read was written or last brought up to date. */
  commit: string | null;
  /** Wiki page to the hash of its body at that moment. */
  pages: Record<string, string>;
};
export type ReadsFile = { reads: Record<string, ReadRecord> };

/** A long read as its file says, before the book and the record are held against it. */
export type LongRead = {
  path: string;
  title: string;
  summary: string;
  chapter: string | null;
  topic: string | null;
  pages: string[];
  written: string | null;
  minutes: number;
  hash: string;
};

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** The hash a reader's mark is for: the whole file, so any rewrite makes it unread again. */
const fileHash = (text: string) => sha1(text).slice(0, 16);

/**
 * The hash of a page's body: without frontmatter, line ends alike, trailing whitespace dropped. A changed
 * `last_updated` or `verified` alone is no change to what the page says.
 */
export function bodyHash(text: string): string {
  const body = splitFrontmatter(text)
    .body.split(/\r?\n/)
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
  return sha1(body);
}

/** A date field as written; the yaml package hands a bare date over as a Date at UTC midnight. */
const day = (v: unknown): string | null =>
  v instanceof Date && !Number.isNaN(v.getTime())
    ? v.toISOString().slice(0, 10)
    : str(v);

const minutesOf = (prose: string) =>
  Math.max(
    1,
    Math.round(prose.split(/\s+/).filter(Boolean).length / WORDS_A_MINUTE),
  );

const nameOf = (path: string) => path.split('/').pop()!.replace(/\.md$/i, '');

const headingOf = (body: string) =>
  /^#\s+(.+)$/m.exec(body)?.[1].trim() ?? null;

const BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const unquote = (v: string) =>
  v
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .trim();

/**
 * The fields of a frontmatter block YAML could not read, line by line: `key: the rest of the line` and the `- item`
 * lines under a key. A title with a colon in it, copied unquoted, must not cost a long read its chapter and pages.
 */
function looseFields(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let list: string[] | null = null;
  for (const line of BLOCK.exec(text)?.[1].split(/\r?\n/) ?? []) {
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (item && list) {
      list.push(unquote(item[1]));
      continue;
    }
    const field = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    list = null;
    if (field[2].trim()) out[field[1]] = unquote(field[2]);
    else out[field[1]] = list = [];
  }
  return out;
}

export function parseRead(path: string, text: string): LongRead {
  const { data, body } = splitFrontmatter(text);
  const d = data ?? looseFields(text);
  const pages = Array.isArray(d.pages)
    ? d.pages.filter((p): p is string => typeof p === 'string')
    : [];
  const essay = body.split(MISSING)[0];
  return {
    path,
    title: str(d.title) ?? headingOf(body) ?? nameOf(path),
    summary: str(d.summary) ?? '',
    chapter: str(d.chapter),
    topic: str(d.topic),
    pages: [...new Set(pages.map((p) => p.trim()).filter(Boolean))],
    written: day(d.written),
    minutes: minutesOf(essay),
    hash: fileHash(text),
  };
}

export function parseLetter(path: string, text: string): BrainLetterRow {
  const { data, body } = splitFrontmatter(text);
  const d = data ?? looseFields(text);
  return {
    path,
    title: str(d.title) ?? headingOf(body) ?? nameOf(path),
    read: str(d.read) ?? '',
    written: day(d.written),
    minutes: minutesOf(body),
    hash: fileHash(text),
  };
}

/** The markdown files directly in a folder of the brain, as `{ path, text }`, by name; none when it is missing. */
async function markdownIn(
  brainDir: string,
  dir: string,
): Promise<{ path: string; text: string }[]> {
  let names: string[];
  try {
    names = (await fs.readdir(absPath(brainDir, dir), { withFileTypes: true }))
      .filter(
        (e) =>
          e.isFile() &&
          !e.name.startsWith('.') &&
          e.name.toLowerCase().endsWith('.md'),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: { path: string; text: string }[] = [];
  for (const n of names) {
    const path = `${dir}/${n}`;
    try {
      out.push({
        path,
        text: await fs.readFile(absPath(brainDir, path), 'utf8'),
      });
    } catch {
      /* gone since the listing */
    }
  }
  return out;
}

export async function readRecord(brainDir: string): Promise<ReadsFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await fs.readFile(absPath(brainDir, READS_RECORD), 'utf8'),
    );
  } catch {
    return { reads: {} };
  }
  const list = (raw as { reads?: unknown } | null)?.reads;
  const reads: Record<string, ReadRecord> = {};
  if (!list || typeof list !== 'object' || Array.isArray(list))
    return { reads };
  for (const [path, v] of Object.entries(list as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const pages: Record<string, string> = {};
    if (o.pages && typeof o.pages === 'object' && !Array.isArray(o.pages))
      for (const [p, h] of Object.entries(o.pages as Record<string, unknown>))
        if (typeof h === 'string') pages[p] = h;
    reads[path] = { at: str(o.at) ?? '', commit: str(o.commit), pages };
  }
  return { reads };
}

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Which chapter of the book each long read is the read of: read path to chapter index. By title first. A long read
 * whose chapter title is gone (a digest renamed it) goes to the chapter without a read that has more than half of
 * its pages among the ones the long read was written from, so a rename does not ask for a second essay. Counted on
 * the chapter's pages: a long read also rests on decisions and meetings no chapter lists. A chapter has one long read.
 */
export function matchChapters(
  reads: LongRead[],
  book: BrainBook | null,
  record: ReadsFile,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!book) return out;
  const taken = new Set<number>();
  for (const r of reads) {
    if (!r.chapter) continue;
    const n = book.chapters.findIndex(
      (c, i) => !taken.has(i) && same(c.title, r.chapter!),
    );
    if (n < 0) continue;
    taken.add(n);
    out.set(r.path, n);
  }
  for (const r of reads) {
    if (!r.chapter || out.has(r.path)) continue;
    const from = new Set([
      ...r.pages,
      ...Object.keys(record.reads[r.path]?.pages ?? {}),
    ]);
    if (!from.size) continue;
    let best = -1;
    let bestShared = 0;
    book.chapters.forEach((c, i) => {
      if (taken.has(i)) return;
      const shared = c.pages.filter((p) => from.has(p)).length;
      if (shared * 2 > c.pages.length && shared > bestShared) {
        best = i;
        bestShared = shared;
      }
    });
    if (best < 0) continue;
    taken.add(best);
    out.set(r.path, best);
  }
  return out;
}

/**
 * The pages that make a long read out of date: a recorded page that is gone or says something else now, and, for a
 * chapter's long read, a page of the chapter it was not written from. None without a record.
 */
export function staleOf(
  record: ReadRecord | undefined,
  chapterPages: string[] | null,
  hashOf: (page: string) => string | null,
): string[] {
  if (!record) return [];
  const out: string[] = [];
  for (const [page, hash] of Object.entries(record.pages))
    if (hashOf(page) !== hash) out.push(page);
  for (const p of chapterPages ?? [])
    if (!(p in record.pages) && !out.includes(p)) out.push(p);
  return out;
}

/** Hashes of wiki page bodies, read once each; null for a page that is not there. */
function pageHasher(brainDir: string) {
  const known = new Map<string, Promise<string | null>>();
  return (page: string): Promise<string | null> => {
    let h = known.get(page);
    if (!h) {
      h = page.startsWith('wiki/')
        ? fs
            .readFile(absPath(brainDir, page), 'utf8')
            .then(bodyHash, () => null)
        : Promise.resolve(null);
      known.set(page, h);
    }
    return h;
  };
}

type Loaded = {
  reads: LongRead[];
  letters: BrainLetterRow[];
  book: BrainBook | null;
  record: ReadsFile;
  chapters: Map<string, number>;
};

async function load(brainDir: string): Promise<Loaded> {
  const [files, letterFiles, book, record] = await Promise.all([
    markdownIn(brainDir, READS_DIR),
    markdownIn(brainDir, LETTERS_DIR),
    readBook(brainDir),
    readRecord(brainDir),
  ]);
  const reads = files.map((f) => parseRead(f.path, f.text));
  return {
    reads,
    letters: letterFiles.map((f) => parseLetter(f.path, f.text)),
    book,
    record,
    chapters: matchChapters(reads, book, record),
  };
}

/**
 * The brain's long reads (by title) and letters (newest first), each long read with what made it out of date; and
 * per long read the pages it was written from (its own list, the record's, and its chapter's as the book has it now).
 */
export async function brainReadsAndPages(
  brainDir: string,
): Promise<BrainReads & { under: Record<string, string[]> }> {
  const l = await load(brainDir);
  const hash = pageHasher(brainDir);
  const rows: BrainReadRow[] = [];
  const under: Record<string, string[]> = {};
  for (const r of l.reads) {
    const n = l.chapters.get(r.path);
    const chapter = n === undefined ? null : l.book!.chapters[n];
    const rec = l.record.reads[r.path];
    const pages = [...Object.keys(rec?.pages ?? {}), ...(chapter?.pages ?? [])];
    const hashes = new Map<string, string | null>();
    for (const p of pages) hashes.set(p, await hash(p));
    under[r.path] = [...new Set([...r.pages, ...pages])];
    rows.push({
      path: r.path,
      title: r.title,
      summary: r.summary,
      chapter: chapter?.title ?? null,
      topic: r.topic,
      written: r.written,
      minutes: r.minutes,
      hash: r.hash,
      stale: staleOf(rec, chapter?.pages ?? null, (p) => hashes.get(p) ?? null),
    });
  }
  return {
    reads: rows.sort((a, b) => a.title.localeCompare(b.title)),
    letters: l.letters.sort(
      (a, b) =>
        (b.written ?? '').localeCompare(a.written ?? '') ||
        b.path.localeCompare(a.path),
    ),
    under,
  };
}

export async function brainReads(brainDir: string): Promise<BrainReads> {
  const { reads, letters } = await brainReadsAndPages(brainDir);
  return { reads, letters };
}

/**
 * The target as a job may carry it, or a throw saying why not: a chapter of the book that has pages, a topic of one
 * line, or a long read that exists. The messages never name the chapter or the file: a refused call's message is
 * sent as telemetry.
 */
export async function checkWriteTarget(
  brainDir: string,
  target: string,
): Promise<WriteTarget> {
  const t = parseWriteTarget(target);
  if (!t) throw new Error('That is not something to write a long read on');
  if ('chapter' in t) {
    const book = await readBook(brainDir);
    const chapter = book?.chapters.find((c) => same(c.title, t.chapter));
    if (!chapter) throw new Error('The book has no such chapter');
    if (!chapter.pages.length)
      throw new Error('That chapter has no pages to write from');
    return { chapter: chapter.title };
  }
  if ('topic' in t) {
    const topic = t.topic.trim();
    if (!topic) throw new Error('Say what the long read should be about');
    if (topic.length > MAX_TOPIC || /[\r\n]/.test(topic))
      throw new Error(`Keep the topic to one line of ${MAX_TOPIC} characters`);
    return { topic };
  }
  try {
    await fs.access(absPath(brainDir, t.update));
  } catch {
    throw new Error('That long read is gone');
  }
  return t;
}

/**
 * What the `/write` skill gets for a target. An update names the commit the long read was written at (from the
 * record, else the commit that last touched the file) and the pages that made it out of date.
 */
export async function writePrompt(
  git: Pick<GitClient, 'run'>,
  brainDir: string,
  target: string,
): Promise<string> {
  const t = await checkWriteTarget(brainDir, target);
  if ('chapter' in t) return `/write chapter ${t.chapter}`;
  if ('topic' in t) return `/write topic ${t.topic}`;
  const record = (await readRecord(brainDir)).reads[t.update];
  const commit =
    record?.commit ??
    (
      await git
        .run(brainDir, ['log', '-1', '--format=%H', '--', t.update])
        .catch(() => '')
    ).trim();
  const stale =
    (await brainReads(brainDir)).reads.find((r) => r.path === t.update)
      ?.stale ?? [];
  return `/write update ${t.update} since ${commit || 'HEAD'} changed: ${stale.join(', ') || 'none'}`;
}

/** Whether the long read a target asks for is on disk. */
export async function written(
  brainDir: string,
  target: string,
): Promise<boolean> {
  const t = parseWriteTarget(target);
  if (!t) return false;
  const l = await load(brainDir);
  if ('update' in t) return l.reads.some((r) => r.path === t.update);
  if ('topic' in t)
    return l.reads.some((r) => r.topic !== null && same(r.topic, t.topic));
  return l.reads.some((r) => {
    const n = l.chapters.get(r.path);
    return n !== undefined && same(l.book!.chapters[n].title, t.chapter);
  });
}

/** Long reads git sees as changed or new (not committed yet). */
async function changedReads(
  git: Pick<GitClient, 'run'>,
  brainDir: string,
): Promise<string[]> {
  // -z: NUL-separated records, paths as they are; a rename record carries the new path, then the old one.
  const status = await git.run(brainDir, [
    '--literal-pathspecs',
    'status',
    '--porcelain',
    '-z',
    '-uall',
    '--',
    `${READS_DIR}/`,
  ]);
  const out: string[] = [];
  const records = status.split('\0');
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.length < 4) continue;
    if (r[0] !== 'D' && r[1] !== 'D') out.push(r.slice(3));
    if (r[0] === 'R' || r[0] === 'C') i++;
  }
  return out.filter(isLongRead);
}

/**
 * Records what a write job's long reads were written from, before its commit: every long read the job changed, and
 * for an update its long read also when the skill found nothing to change (so a change that does not matter stops
 * counting). Records of long reads that are gone are dropped.
 */
export async function stampReads(
  git: Pick<GitClient, 'run'>,
  brainDir: string,
  target: string,
  now: Date,
): Promise<void> {
  const t = parseWriteTarget(target);
  if (!t) return;
  const l = await load(brainDir);
  // An update's own long read counts unchanged too; one the skill gave another name is among the changed.
  const paths = new Set([
    ...('update' in t ? [t.update] : []),
    ...(await changedReads(git, brainDir)),
  ]);
  const commit =
    (await git.run(brainDir, ['rev-parse', 'HEAD']).catch(() => '')).trim() ||
    null;
  const hash = pageHasher(brainDir);
  const reads: Record<string, ReadRecord> = {};
  for (const r of l.reads) {
    if (!paths.has(r.path)) {
      if (l.record.reads[r.path]) reads[r.path] = l.record.reads[r.path];
      continue;
    }
    const n = l.chapters.get(r.path);
    const from = [
      ...new Set([
        ...r.pages,
        ...(n === undefined ? [] : l.book!.chapters[n].pages),
      ]),
    ].sort();
    const pages: Record<string, string> = {};
    for (const p of from) {
      const h = await hash(p);
      if (h) pages[p] = h;
    }
    reads[r.path] = { at: now.toISOString(), commit, pages };
  }
  await writeRecord(brainDir, { reads });
}

/** Writes the record when it says something else; whether it did. */
async function writeRecord(brainDir: string, record: ReadsFile) {
  const next = `${JSON.stringify(record, null, 2)}\n`;
  const file = absPath(brainDir, READS_RECORD);
  const current = await fs.readFile(file, 'utf8').catch(() => null);
  // Nothing to record and no record yet: a job that wrote no long read leaves no file behind.
  if (
    current === next ||
    (current === null && !Object.keys(record.reads).length)
  )
    return false;
  await fs.mkdir(absPath(brainDir, 'brain'), { recursive: true });
  await fs.writeFile(file, next, 'utf8');
  return true;
}

/**
 * After a scrub's commit: the pages it rewrote hash differently, and nothing a long read rests on changed. Every
 * record moves to the scrub's commit, so no update compares across it (git history keeps the scrubbed value, and
 * a letter quotes what it finds), and takes the pages as they are now. A page that was out of date before the
 * scrub (`stale`: long read to its pages, by their names now) keeps its old hash and stays out of date. Whether
 * the record changed.
 */
export async function restampAfterScrub(
  git: Pick<GitClient, 'run'>,
  brainDir: string,
  stale: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<boolean> {
  const record = await readRecord(brainDir);
  if (!Object.keys(record.reads).length) return false;
  const commit =
    (await git.run(brainDir, ['rev-parse', 'HEAD']).catch(() => '')).trim() ||
    null;
  const hash = pageHasher(brainDir);
  const reads: Record<string, ReadRecord> = {};
  for (const [path, rec] of Object.entries(record.reads)) {
    const pages: Record<string, string> = {};
    for (const [page, old] of Object.entries(rec.pages))
      pages[page] = stale.get(path)?.has(page)
        ? old
        : ((await hash(page)) ?? old);
    reads[path] = { at: rec.at, commit: commit ?? rec.commit, pages };
  }
  return writeRecord(brainDir, { reads });
}

/**
 * What to write next without being asked: the long read that has been out of date longest, else the first chapter of
 * the book with pages and no long read. Targets in `skip` (they failed twice) are passed over. Null when all is
 * written and up to date.
 */
export async function nextToWrite(
  brainDir: string,
  skip: ReadonlySet<string>,
): Promise<string | null> {
  const [{ reads }, book] = await Promise.all([
    brainReads(brainDir),
    readBook(brainDir),
  ]);
  const stale = reads
    .filter((r) => r.stale.length && !skip.has(r.path))
    .sort((a, b) => (a.written ?? '').localeCompare(b.written ?? ''));
  if (stale.length) return stale[0].path;
  for (const c of book?.chapters ?? []) {
    if (!c.pages.length || reads.some((r) => r.chapter === c.title)) continue;
    const target = `chapter:${c.title}`;
    if (!skip.has(target)) return target;
  }
  return null;
}
