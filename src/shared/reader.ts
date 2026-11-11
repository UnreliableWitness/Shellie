import { z } from 'zod';

/**
 * What Shellie and the phone reading site share: the keys made from one secret, how an item is sealed, the shapes that
 * travel, and the order of the reading list. Web Crypto only, so the same code runs in Electron's main process and in
 * a phone's browser. Design: docs/superpowers/specs/2026-11-11-phone-reader-design.md.
 */

type Bytes = Uint8Array<ArrayBuffer>;

const SALT = 'shellie-reader-v1';
const SEAL_V1 = 1;
const NONCE_BYTES = 12;
export const SECRET_BYTES = 32;
/** A cited page or source longer than this is not sent. */
export const MAX_REF_CHARS = 300_000;
export const READER_SERVER = 'shellie-reader';

const utf8 = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function newSecret(): Bytes {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

/** Everything made from the secret. The secret itself is only kept to draw the link again. */
export type ReaderKeys = {
  /** The account's name on the server. */
  reader: string;
  /** Proves the account to the server. */
  token: string;
  enc: CryptoKey;
  ids: CryptoKey;
};

export async function readerKeys(secret: Uint8Array): Promise<ReaderKeys> {
  if (secret.length !== SECRET_BYTES) throw new Error('Not a reader secret');
  const base = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(secret),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = async (info: string, bytes: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: utf8.encode(SALT),
          info: utf8.encode(info),
        },
        base,
        bytes * 8,
      ),
    );
  const [id, token, enc, ids] = await Promise.all([
    bits('id', 16),
    bits('token', 32),
    bits('enc', 32),
    bits('ids', 32),
  ]);
  return {
    reader: hex(id),
    token: b64url(token),
    enc: await crypto.subtle.importKey('raw', enc, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]),
    ids: await crypto.subtle.importKey(
      'raw',
      ids,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ),
  };
}

/** The `Authorization: Bearer` value. */
export const bearer = (keys: Pick<ReaderKeys, 'reader' | 'token'>) =>
  `${keys.reader}.${keys.token}`;

/** m: a brain's shelf, r: a long read or letter, p: a cited page or source, k: a brain's marks. */
export type ItemKind = 'm' | 'r' | 'p' | 'k';
export const ITEM_ID = /^[mrpk]-[0-9a-f]{32}$/;
export const kindOf = (id: string) => id[0] as ItemKind;

/** The id the server knows an item by: it says the kind and nothing else. */
export async function itemId(
  keys: Pick<ReaderKeys, 'ids'>,
  kind: ItemKind,
  name: string,
): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', keys.ids, utf8.encode(name));
  return `${kind}-${hex(new Uint8Array(mac)).slice(0, 32)}`;
}
/** The name behind an item id: the brain for a shelf or the marks, the brain and the path for the others. */
export const itemName = (brainId: string, path?: string) =>
  path === undefined ? brainId : `${brainId}:${path}`;

/** A value as the server stores it. The id is bound in: the server cannot hand out one item as another. */
export async function seal(
  keys: Pick<ReaderKeys, 'enc'>,
  id: string,
  value: unknown,
): Promise<Bytes> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: utf8.encode(id) },
      keys.enc,
      utf8.encode(JSON.stringify(value)),
    ),
  );
  const out = new Uint8Array(1 + NONCE_BYTES + sealed.length);
  out[0] = SEAL_V1;
  out.set(nonce, 1);
  out.set(sealed, 1 + NONCE_BYTES);
  return out;
}

/** The value in a sealed item, or null when it is not one of ours, was changed, or belongs to another id. */
export async function unseal(
  keys: Pick<ReaderKeys, 'enc'>,
  id: string,
  blob: Uint8Array,
): Promise<unknown> {
  if (blob.length <= 1 + NONCE_BYTES || blob[0] !== SEAL_V1) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(blob.subarray(1, 1 + NONCE_BYTES)),
        additionalData: utf8.encode(id),
      },
      keys.enc,
      new Uint8Array(blob.subarray(1 + NONCE_BYTES)),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as unknown;
  } catch {
    return null;
  }
}

/** The site's address as it is stored and called: https (http for this machine only), no path, no trailing slash. */
export function readerOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    return null;
  if (url.username || url.password) return null;
  return url.origin;
}

/** What the QR code holds. The secret is in the fragment, which a browser never sends. */
export const readerLink = (origin: string, secret: Uint8Array) =>
  `${origin}/#${b64url(secret)}`;

/** The secret in a link, in a fragment, or pasted by itself. */
export function secretFromLink(text: string): Bytes | null {
  const t = text.trim();
  const secret = fromB64url(t.includes('#') ? t.slice(t.indexOf('#') + 1) : t);
  return secret?.length === SECRET_BYTES ? secret : null;
}

const day = z.string().nullable();
export const ReaderReadSchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  summary: z.string(),
  chapter: z.string().nullable(),
  topic: z.string().nullable(),
  written: day,
  minutes: z.number(),
  hash: z.string(),
  /** Pages under it changed since it was written. */
  stale: z.boolean(),
  /** The work items in front of the reader (their sprint, their open tasks) it bears on. */
  work: z.array(z.object({ id: z.number(), title: z.string() })).optional(),
});
export type ReaderRead = z.infer<typeof ReaderReadSchema>;

export const ReaderLetterSchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  /** The path of the long read it is about. */
  read: z.string(),
  written: day,
  minutes: z.number(),
  hash: z.string(),
});
export type ReaderLetter = z.infer<typeof ReaderLetterSchema>;

/** One brain as the phone lists it. */
export const ReaderShelfSchema = z.object({
  v: z.literal(1),
  brainId: z.string(),
  name: z.string(),
  sentAt: z.string(),
  /** The book's chapters that have pages, in order. */
  chapters: z.array(z.string()),
  reads: z.array(ReaderReadSchema),
  letters: z.array(ReaderLetterSchema),
  /** Every cited page or source that was sent, by its path in the brain. */
  refs: z.record(z.string(), z.object({ id: z.string(), title: z.string() })),
});
export type ReaderShelf = z.infer<typeof ReaderShelfSchema>;

/** A long read, a letter, or something one of them cites: the file's text under its frontmatter. */
export const ReaderPieceSchema = z.object({
  v: z.literal(1),
  path: z.string(),
  title: z.string(),
  text: z.string(),
});
export type ReaderPiece = z.infer<typeof ReaderPieceSchema>;

export const ReaderMarkSchema = z.object({
  /** The hash of the text the mark was set on. */
  hash: z.string(),
  at: z.string(),
  /** False is "Mark unread": kept, so that it wins over an older mark from the other device. */
  read: z.boolean(),
});
export type ReaderMark = z.infer<typeof ReaderMarkSchema>;
export type ReaderMarkSet = Record<string, ReaderMark>;
export const ReaderMarksSchema = z.object({
  v: z.literal(1),
  marks: z.record(z.string(), ReaderMarkSchema),
});
export type ReaderMarks = z.infer<typeof ReaderMarksSchema>;

/** Two sets of marks as one: per path the newer wins. Returns `a` itself when `b` adds nothing. */
export function mergeMarks(a: ReaderMarkSet, b: ReaderMarkSet): ReaderMarkSet {
  let out = a;
  for (const [path, mark] of Object.entries(b)) {
    const mine = a[path];
    if (mine && mine.at >= mark.at) continue;
    if (out === a) out = { ...a };
    out[path] = mark;
  }
  return out;
}
export const sameMarks = (a: ReaderMarkSet, b: ReaderMarkSet) =>
  mergeMarks(a, b) === a && mergeMarks(b, a) === b;

type Marked = { path: string; hash: string };
/** Read is said of one text: a long read brought up to date is unread again. */
export const isMarkedRead = (marks: ReaderMarkSet, piece: Marked) =>
  marks[piece.path]?.read === true && marks[piece.path].hash === piece.hash;

/** What the list needs of a long read and of a letter: the phone's shelf and Shellie's own rows both have it. */
export type ListRead = Pick<
  ReaderRead,
  'path' | 'title' | 'chapter' | 'written' | 'minutes' | 'hash' | 'work'
>;
export type ListLetter = Pick<
  ReaderLetter,
  'path' | 'title' | 'read' | 'written' | 'minutes' | 'hash'
>;

export type ListEntry<
  R extends ListRead = ReaderRead,
  L extends ListLetter = ReaderLetter,
> =
  | {
      kind: 'read';
      read: R;
      done: boolean;
      /** Its text changed since the reader's mark and no letter says how. */
      changed: boolean;
    }
  | {
      kind: 'letter';
      letter: L;
      /** The title of the long read it is about. */
      about: string;
      done: boolean;
    };
export type ReadingList<
  R extends ListRead = ReaderRead,
  L extends ListLetter = ReaderLetter,
> = {
  /** Unread pieces that bear on the sprint's work. */
  work: ListEntry<R, L>[];
  /** What changed in things the reader already read. */
  changed: ListEntry<R, L>[];
  /** The chapters' long reads, in book order, read ones included. */
  foundations: ListEntry<R, L>[];
  /** Long reads on a topic and those whose chapter left the book, except the unread ones under `work`. */
  later: ListEntry<R, L>[];
  /** Long reads plus what is listed under `changed`. */
  total: number;
  done: number;
  minutesLeft: number;
};

/**
 * What to read next, in the order the owner chose: the sprint's work, changes to what was read, the foundations in
 * book order, the rest.
 *
 * A long read counts as read once it was marked, also after it changed: the change is then listed by its letters
 * (those written since the mark and not yet read), or by the long read itself when no letter was written. A letter
 * about a long read that was never read is not listed: the long read says what holds now.
 */
export function readingList<R extends ListRead, L extends ListLetter>(
  shelf: { chapters: string[]; reads: R[]; letters: L[] },
  marks: ReaderMarkSet,
): ReadingList<R, L> {
  type Entry = ListEntry<R, L>;
  const everRead = (r: R) => marks[r.path]?.read === true;
  const changed: Entry[] = [];
  for (const read of shelf.reads) {
    const mark = marks[read.path];
    if (!mark?.read || mark.hash === read.hash) continue;
    const since = shelf.letters.filter(
      (l) =>
        l.read === read.path &&
        (l.written === null || l.written >= mark.at.slice(0, 10)),
    );
    const unread = since.filter((l) => !isMarkedRead(marks, l));
    for (const letter of unread)
      changed.push({ kind: 'letter', letter, about: read.title, done: false });
    if (!since.length)
      changed.push({ kind: 'read', read, done: false, changed: true });
  }
  const when = (e: Entry) =>
    (e.kind === 'letter' ? e.letter.written : e.read.written) ?? '';
  changed.sort((a, b) => when(b).localeCompare(when(a)));

  const entry = (read: R): Entry => ({
    kind: 'read',
    read,
    done: everRead(read),
    changed: false,
  });
  const order = new Map(shelf.chapters.map((c, i) => [c, i]));
  const inBook = (r: R) => r.chapter !== null && order.has(r.chapter);
  const foundations = shelf.reads
    .filter(inBook)
    .sort((a, b) => order.get(a.chapter!)! - order.get(b.chapter!)!)
    .map(entry);
  const forWork = (r: R) => !!r.work?.length && !everRead(r);
  // A long read for the sprint's work is not for later; in the book it keeps its place, the book being the map.
  const later = shelf.reads.filter((r) => !inBook(r) && !forWork(r)).map(entry);
  const work = shelf.reads.filter(forWork).map(entry);

  const done = shelf.reads.filter(everRead).length;
  const minutes = (e: Entry) =>
    e.kind === 'letter' ? e.letter.minutes : e.read.minutes;
  return {
    work,
    changed,
    foundations,
    later,
    total: shelf.reads.length + changed.length,
    done,
    minutesLeft:
      shelf.reads
        .filter((r) => !everRead(r))
        .reduce((n, r) => n + r.minutes, 0) +
      changed.reduce((n, e) => n + minutes(e), 0),
  };
}

/** Why a piece is up next: it bears on the sprint's work, it changed since it was read, or it is next in the book. */
export type UpNextWhy = 'work' | 'changed' | 'next';
export type UpNext<
  R extends ListRead = ReaderRead,
  L extends ListLetter = ReaderLetter,
> = { why: UpNextWhy; entry: ListEntry<R, L> };

export const entryPath = <R extends ListRead, L extends ListLetter>(
  e: ListEntry<R, L>,
) => (e.kind === 'letter' ? e.letter.path : e.read.path);

/**
 * The handful to read next: unread long reads for the sprint's work, then what changed in things already read, then
 * the one next unread foundation in book order. "Later" is never up next: it waits until asked for.
 */
export function upNext<R extends ListRead, L extends ListLetter>(
  list: ReadingList<R, L>,
  limit = 3,
): UpNext<R, L>[] {
  const out: UpNext<R, L>[] = [];
  const seen = new Set<string>();
  const add = (why: UpNextWhy, entries: ListEntry<R, L>[]) => {
    for (const entry of entries) {
      const path = entryPath(entry);
      if (entry.done || seen.has(path)) continue;
      seen.add(path);
      out.push({ why, entry });
    }
  };
  add('work', list.work);
  add('changed', list.changed);
  const before = out.length;
  for (const entry of list.foundations) {
    if (out.length > before) break;
    add('next', [entry]);
  }
  return out.slice(0, limit);
}

/** The connection as the renderer may know it: never the secret, except as the link it asks for. */
export type ReaderStatus = {
  connected: boolean;
  /** The site's address. */
  url: string | null;
  /** When the last push ended, and how. */
  lastPush: {
    at: string;
    ok: boolean;
    /** Long reads and letters on the server after it. */
    pieces: number;
    error: string | null;
  } | null;
  /** The server refused the token: nothing is sent until the connection changes. */
  refused: boolean;
  /** What went wrong with the attempt this answer is for (connect, disconnect). */
  error?: string;
};
