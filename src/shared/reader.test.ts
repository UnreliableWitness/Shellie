import { describe, expect, it } from 'vitest';
import {
  b64url,
  bearer,
  fromB64url,
  isMarkedRead,
  ITEM_ID,
  itemId,
  itemName,
  mergeMarks,
  newSecret,
  readerKeys,
  readerLink,
  readerOrigin,
  readingList,
  sameMarks,
  seal,
  secretFromLink,
  unseal,
  type ReaderLetter,
  type ReaderMarkSet,
  type ReaderRead,
  type ReaderShelf,
} from './reader';

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i);

describe('keys', () => {
  it('makes the same keys from the same secret, and others from another', async () => {
    const a = await readerKeys(SECRET);
    const b = await readerKeys(SECRET);
    const c = await readerKeys(newSecret());
    expect(a.reader).toMatch(/^[0-9a-f]{32}$/);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bearer(b)).toBe(`${a.reader}.${a.token}`);
    expect(c.reader).not.toBe(a.reader);
    expect(c.token).not.toBe(a.token);
  });

  it('refuses a secret of another length', async () => {
    await expect(readerKeys(new Uint8Array(16))).rejects.toThrow();
  });

  it('names an item by its kind and a hash nobody else can make', async () => {
    const a = await readerKeys(SECRET);
    const id = await itemId(a, 'r', itemName('b1', 'reads/x.md'));
    expect(id).toMatch(ITEM_ID);
    expect(id.startsWith('r-')).toBe(true);
    expect(await itemId(a, 'r', itemName('b1', 'reads/x.md'))).toBe(id);
    expect(await itemId(a, 'r', itemName('b2', 'reads/x.md'))).not.toBe(id);
    expect((await itemId(a, 'p', itemName('b1', 'reads/x.md'))).slice(2)).toBe(
      id.slice(2),
    );
    const other = await readerKeys(newSecret());
    expect(await itemId(other, 'r', itemName('b1', 'reads/x.md'))).not.toBe(id);
  });
});

describe('seal', () => {
  it('opens what it sealed, and never seals the same way twice', async () => {
    const keys = await readerKeys(SECRET);
    const value = { title: 'Order to cash — “why”', n: 3 };
    const a = await seal(keys, 'r-1', value);
    const b = await seal(keys, 'r-1', value);
    expect(b64url(a)).not.toBe(b64url(b));
    expect(await unseal(keys, 'r-1', a)).toEqual(value);
    expect(new TextDecoder().decode(a)).not.toContain('Order');
  });

  it('gives null for another id, another key, a changed or a foreign blob', async () => {
    const keys = await readerKeys(SECRET);
    const blob = await seal(keys, 'r-1', { a: 1 });
    expect(await unseal(keys, 'r-2', blob)).toBeNull();
    expect(await unseal(await readerKeys(newSecret()), 'r-1', blob)).toBeNull();
    const bent = new Uint8Array(blob);
    bent[bent.length - 1] ^= 1;
    expect(await unseal(keys, 'r-1', bent)).toBeNull();
    const versioned = new Uint8Array(blob);
    versioned[0] = 2;
    expect(await unseal(keys, 'r-1', versioned)).toBeNull();
    expect(await unseal(keys, 'r-1', new Uint8Array(5))).toBeNull();
  });
});

describe('the link', () => {
  it('carries the secret in the fragment and gives it back', () => {
    const link = readerLink('https://reader.example', SECRET);
    expect(link).toBe(`https://reader.example/#${b64url(SECRET)}`);
    expect(secretFromLink(link)).toEqual(SECRET);
    expect(secretFromLink(`  #${b64url(SECRET)} `)).toEqual(SECRET);
    expect(secretFromLink(b64url(SECRET))).toEqual(SECRET);
  });

  it('gives null for anything that is not a secret', () => {
    expect(secretFromLink('https://reader.example/')).toBeNull();
    expect(secretFromLink('https://reader.example/#abc')).toBeNull();
    expect(secretFromLink('#not base64 !')).toBeNull();
    expect(fromB64url('a+b')).toBeNull();
  });

  it('takes an https address, or http on this machine, down to its origin', () => {
    expect(readerOrigin(' https://reader.example/x?y#z ')).toBe(
      'https://reader.example',
    );
    expect(readerOrigin('http://localhost:8091/')).toBe(
      'http://localhost:8091',
    );
    expect(readerOrigin('http://127.0.0.1:8091')).toBe('http://127.0.0.1:8091');
    expect(readerOrigin('http://reader.example')).toBeNull();
    expect(readerOrigin('https://u:p@reader.example')).toBeNull();
    expect(readerOrigin('reader.example')).toBeNull();
    expect(readerOrigin('')).toBeNull();
  });
});

describe('marks', () => {
  const m = (at: string, read = true, hash = 'h') => ({ hash, at, read });

  it('merges per path, the newer wins, an unread mark too', () => {
    const a: ReaderMarkSet = { x: m('2026-11-10T10:00:00Z'), y: m('1') };
    const b: ReaderMarkSet = {
      x: m('2026-11-11T10:00:00Z', false),
      z: m('2'),
    };
    expect(mergeMarks(a, b)).toEqual({ x: b.x, y: a.y, z: b.z });
    expect(mergeMarks(b, a)).toEqual({ x: b.x, y: a.y, z: b.z });
  });

  it('returns the first set itself when the second adds nothing', () => {
    const a: ReaderMarkSet = { x: m('2') };
    expect(mergeMarks(a, { x: m('1') })).toBe(a);
    expect(mergeMarks(a, {})).toBe(a);
    expect(sameMarks(a, { x: m('2') })).toBe(true);
    expect(sameMarks(a, { x: m('2'), y: m('1') })).toBe(false);
  });

  it('is read only for the text that was marked', () => {
    const marks: ReaderMarkSet = { x: m('1'), y: m('1', false) };
    expect(isMarkedRead(marks, { path: 'x', hash: 'h' })).toBe(true);
    expect(isMarkedRead(marks, { path: 'x', hash: 'other' })).toBe(false);
    expect(isMarkedRead(marks, { path: 'y', hash: 'h' })).toBe(false);
    expect(isMarkedRead(marks, { path: 'none', hash: 'h' })).toBe(false);
  });
});

describe('readingList', () => {
  const read = (over: Partial<ReaderRead>): ReaderRead => ({
    id: `r-${over.path}`,
    path: 'reads/a.md',
    title: 'A',
    summary: 's',
    chapter: null,
    topic: null,
    written: '2026-11-09',
    minutes: 10,
    hash: 'h1',
    stale: false,
    ...over,
  });
  const letter = (over: Partial<ReaderLetter>): ReaderLetter => ({
    id: `r-${over.path}`,
    path: 'reads/letters/2026-11-11-a.md',
    title: 'L',
    read: 'reads/a.md',
    written: '2026-11-11',
    minutes: 3,
    hash: 'l1',
    ...over,
  });
  const shelf = (over: Partial<ReaderShelf>): ReaderShelf => ({
    v: 1,
    brainId: 'b',
    name: 'B',
    sentAt: 't',
    chapters: ['One', 'Two', 'Three'],
    reads: [],
    letters: [],
    refs: {},
    ...over,
  });
  const mark = (hash: string, at = '2026-11-10T08:00:00.000Z') => ({
    hash,
    at,
    read: true,
  });
  const paths = (entries: { kind: string }[]) =>
    entries.map((e) =>
      'letter' in e
        ? (e as { letter: ReaderLetter }).letter.path
        : (e as unknown as { read: ReaderRead }).read.path,
    );

  it('lists the foundations in book order and the rest later', () => {
    const list = readingList(
      shelf({
        reads: [
          read({ path: 'reads/topic.md', topic: 'credit notes' }),
          read({ path: 'reads/three.md', chapter: 'Three' }),
          read({ path: 'reads/gone.md', chapter: 'Left the book' }),
          read({ path: 'reads/one.md', chapter: 'One', minutes: 7 }),
        ],
      }),
      { 'reads/one.md': mark('h1') },
    );
    expect(paths(list.foundations)).toEqual(['reads/one.md', 'reads/three.md']);
    expect(list.foundations.map((e) => e.done)).toEqual([true, false]);
    expect(paths(list.later)).toEqual(['reads/topic.md', 'reads/gone.md']);
    expect(list.changed).toEqual([]);
    expect(list.work).toEqual([]);
    expect(list).toMatchObject({ total: 4, done: 1, minutesLeft: 30 });
  });

  it('lists the letters written since a long read was marked, newest first', () => {
    const list = readingList(
      shelf({
        reads: [read({ chapter: 'One', hash: 'h2' })],
        letters: [
          letter({ path: 'reads/letters/2026-11-11-a.md' }),
          letter({
            path: 'reads/letters/2026-11-12-a.md',
            written: '2026-11-12',
          }),
          // from before the reader read it: what they read already said so
          letter({
            path: 'reads/letters/2026-11-01-a.md',
            written: '2026-11-01',
          }),
          letter({ path: 'reads/letters/2026-11-11-b.md', read: 'reads/b.md' }),
        ],
      }),
      { 'reads/a.md': mark('h1') },
    );
    expect(paths(list.changed)).toEqual([
      'reads/letters/2026-11-12-a.md',
      'reads/letters/2026-11-11-a.md',
    ]);
    expect(list.changed[0]).toMatchObject({ kind: 'letter', about: 'A' });
    // still a foundation that was read
    expect(list.foundations[0].done).toBe(true);
    expect(list).toMatchObject({ total: 3, done: 1, minutesLeft: 6 });
  });

  it('drops a letter once it is read, and lists the long read itself when no letter was written', () => {
    const letters = [letter({})];
    const reads = [read({ chapter: 'One', hash: 'h2' })];
    const caughtUp = readingList(shelf({ reads, letters }), {
      'reads/a.md': mark('h1'),
      'reads/letters/2026-11-11-a.md': mark('l1'),
    });
    expect(caughtUp.changed).toEqual([]);
    const noLetter = readingList(shelf({ reads }), {
      'reads/a.md': mark('h1'),
    });
    expect(noLetter.changed).toEqual([
      { kind: 'read', read: reads[0], done: false, changed: true },
    ]);
  });

  it('lists nothing as changed for a long read never read, up to date, or marked unread', () => {
    const s = shelf({
      reads: [read({ chapter: 'One', hash: 'h2' })],
      letters: [letter({})],
    });
    expect(readingList(s, {}).changed).toEqual([]);
    expect(readingList(s, { 'reads/a.md': mark('h2') }).changed).toEqual([]);
    const unread = readingList(s, {
      'reads/a.md': { hash: 'h1', at: 't', read: false },
    });
    expect(unread.changed).toEqual([]);
    expect(unread.foundations[0].done).toBe(false);
  });

  it('puts unread pieces that bear on the sprint first', () => {
    const work = [{ id: 412, title: 'Partial returns' }];
    const list = readingList(
      shelf({
        reads: [
          read({ path: 'reads/one.md', chapter: 'One', work }),
          read({ path: 'reads/two.md', chapter: 'Two', work }),
        ],
      }),
      { 'reads/two.md': mark('h1') },
    );
    expect(paths(list.work)).toEqual(['reads/one.md']);
  });
});
