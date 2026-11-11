/**
 * A brain as the phone gets it: its long reads and letters, the pages and sources they cite, and the shelf that
 * lists them. Built from the files every time; the sync sends what differs from what it sent before.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  itemId,
  itemName,
  MAX_REF_CHARS,
  type ReaderKeys,
  type ReaderPiece,
  type ReaderShelf,
} from '../../shared/reader';
import { readBook } from '../brain/book';
import {
  linkTargets,
  outsideFences,
  splitFrontmatter,
  str,
} from '../brain/pages';
import { absPath } from '../brain/paths';
import { brainReads } from '../brain/reads';

/** A shelf before it is sent: `sentAt` is set then, so it is not part of what makes a shelf differ. */
export type ShelfDraft = Omit<ReaderShelf, 'sentAt'>;
export type BuiltItem = { id: string; value: ReaderPiece; hash: string };
export type BuiltBrain = {
  shelfId: string;
  shelf: ShelfDraft;
  shelfHash: string;
  /** Long reads, letters and what they cite. */
  pieces: BuiltItem[];
};

export const contentHash = (value: unknown) =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex');

/** The folders whose pages go along when a long read or a letter cites them. */
const CITED = /^(wiki|sources)\//;
const DEFINITION = /^\s{0,3}\[[^\]\n]+\]:\s+(?:<([^>]*)>|(\S+))/;

/** The brain paths of the `.md` files under `wiki/` and `sources/` that a text at `from` links to. */
export function citedPaths(from: string, body: string): string[] {
  const targets = linkTargets(body);
  for (const line of outsideFences(body)) {
    const m = DEFINITION.exec(line);
    if (m) targets.push(m[1] ?? m[2]);
  }
  const out = new Set<string>();
  for (const target of targets) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
    let file = target.split('#')[0].split('?')[0];
    try {
      file = decodeURIComponent(file);
    } catch {
      /* as written */
    }
    if (!file.toLowerCase().endsWith('.md')) continue;
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(from), file),
    );
    if (CITED.test(resolved)) out.add(resolved);
  }
  return [...out];
}

const body = (text: string) =>
  splitFrontmatter(text).body.replace(/\r\n/g, '\n');

/** A cited file's title: its frontmatter's, else its first heading, else its file name. */
function titleOf(file: string, text: string): string {
  const { data, body: b } = splitFrontmatter(text);
  return (
    str(data?.title) ??
    /^#\s+(.+?)\s*#*\s*$/m.exec(b)?.[1] ??
    path.posix.basename(file, '.md')
  );
}

const read = async (brainDir: string, rel: string): Promise<string | null> => {
  try {
    return await fs.readFile(absPath(brainDir, rel), 'utf8');
  } catch {
    return null;
  }
};

export async function buildBrain(
  brain: { id: string; name: string; path: string },
  keys: Pick<ReaderKeys, 'ids'>,
): Promise<BuiltBrain> {
  const [rows, book] = await Promise.all([
    brainReads(brain.path),
    readBook(brain.path),
  ]);
  const id = (kind: 'r' | 'p', rel: string) =>
    itemId(keys, kind, itemName(brain.id, rel));
  const pieces: BuiltItem[] = [];
  const piece = (itemIdOf: string, value: ReaderPiece) =>
    pieces.push({ id: itemIdOf, value, hash: contentHash(value) });
  const cited = new Set<string>();

  const shelf: ShelfDraft = {
    v: 1,
    brainId: brain.id,
    name: brain.name,
    chapters: (book?.chapters ?? [])
      .filter((c) => c.pages.length)
      .map((c) => c.title),
    reads: [],
    letters: [],
    refs: {},
  };
  for (const row of [...rows.reads, ...rows.letters]) {
    const text = await read(brain.path, row.path);
    // Gone since it was listed: the next push says so.
    if (text === null) continue;
    const value: ReaderPiece = {
      v: 1,
      path: row.path,
      title: row.title,
      text: body(text),
    };
    const pieceId = await id('r', row.path);
    piece(pieceId, value);
    for (const p of citedPaths(row.path, value.text)) cited.add(p);
    const common = {
      id: pieceId,
      path: row.path,
      title: row.title,
      written: row.written,
      minutes: row.minutes,
      hash: row.hash,
    };
    if ('read' in row) shelf.letters.push({ ...common, read: row.read });
    else
      shelf.reads.push({
        ...common,
        summary: row.summary,
        chapter: row.chapter,
        topic: row.topic,
        stale: row.stale.length > 0,
      });
  }
  for (const rel of [...cited].sort()) {
    const text = await read(brain.path, rel);
    if (text === null) continue;
    const value: ReaderPiece = {
      v: 1,
      path: rel,
      title: titleOf(rel, text),
      text: body(text),
    };
    if (value.text.length > MAX_REF_CHARS) continue;
    const refId = await id('p', rel);
    piece(refId, value);
    shelf.refs[rel] = { id: refId, title: value.title };
  }
  return {
    shelfId: await itemId(keys, 'm', itemName(brain.id)),
    shelf,
    shelfHash: contentHash(shelf),
    pieces,
  };
}
