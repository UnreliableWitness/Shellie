import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanUp,
  INVITE,
  start,
  tempDir,
  type Running,
} from '../../../reader/server/testing';
import { BrainSchema, type Brain } from '../../shared/brain';
import {
  bearer,
  itemId,
  itemName,
  kindOf,
  readerKeys,
  ReaderShelfSchema,
  seal,
  secretFromLink,
  unseal,
  type ReaderKeys,
  type ReaderMarkSet,
  type ReaderStatus,
} from '../../shared/reader';
import { getItem, hello, listItems, putItem, ReaderError } from './client';
import { ReaderStore } from './ReaderStore';
import { ReaderSync } from './ReaderSync';

const crypto = {
  available: () => true,
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => b.toString().slice(4),
};

const READ = 'reads/order-to-invoice.md';
const LETTER = 'reads/letters/2026-11-10-order-to-invoice.md';
const longRead = (body = 'An order is a promise.') =>
  [
    '---',
    'title: Order to invoice',
    'summary: How an order becomes an invoice.',
    'chapter: Orders',
    'pages:',
    '  - wiki/subject-orders.md',
    'written: 2026-11-09',
    '---',
    '',
    '# Order to invoice',
    '',
    body,
    '',
    'See [orders](../wiki/subject-orders.md#rules) and [the mail][m].',
    '',
    '[m]: ../sources/mail.md',
    '',
  ].join('\n');
const page = (title: string, body: string) =>
  `---\ntitle: ${title}\nsummary: s\n---\n\n# ${title}\n\n${body}\n`;

type Bench = {
  server: Running;
  store: ReaderStore;
  sync: ReaderSync;
  brains: Brain[];
  dir: string;
  statuses: ReaderStatus[];
  told: string[];
  events: { event: string; props?: Record<string, unknown> }[];
  /** `METHOD /path` of every request the sync made. */
  requests: string[];
  /** Runs before each of the sync's requests goes out. */
  before: (method: string) => Promise<void>;
  write: (rel: string, text: string) => Promise<void>;
  /** The phone's side: the keys from the link, and the account they open. */
  phone: () => Promise<{
    keys: ReaderKeys;
    c: { url: string; bearer: string };
  }>;
};

const brain = (dir: string, over: Partial<Brain> = {}): Brain => ({
  ...BrainSchema.parse({
    id: 'b1',
    name: 'Acme',
    connectionId: 'c1',
    project: 'Shellie',
    path: dir,
    createdAt: '2026-11-01T09:00:00.000Z',
    options: { sendToPhone: true },
  }),
  ...over,
});

async function bench(
  limits?: Parameters<typeof start>[0],
  now: () => Date = () => new Date('2026-11-11T12:00:00.000Z'),
): Promise<Bench> {
  const server = await start(limits);
  const dir = await tempDir();
  const write = async (rel: string, text: string) => {
    const file = path.join(dir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  await write(READ, longRead());
  await write(
    LETTER,
    `---\ntitle: The credit check moved\nread: ${READ}\nwritten: 2026-11-10\n---\n\n## What you read\n\nOld.\n`,
  );
  await write('wiki/subject-orders.md', page('Orders', 'An order.'));
  await write('wiki/unlinked.md', page('Unlinked', 'Nobody cites this.'));
  await write('sources/mail.md', 'A mail without a heading.\n');
  await write(
    'brain/book.json',
    JSON.stringify({
      chapters: [
        { title: 'Orders', summary: 's', pages: ['wiki/subject-orders.md'] },
      ],
    }),
  );
  const store = new ReaderStore(
    path.join(await tempDir(), 'reader.json'),
    crypto,
  );
  await store.load();
  const b: Bench = {
    server,
    store,
    dir,
    write,
    brains: [brain(dir)],
    statuses: [],
    told: [],
    events: [],
    requests: [],
    before: async () => undefined,
    sync: undefined as unknown as ReaderSync,
    phone: async () => {
      const secret = secretFromLink(b.sync.link() ?? '');
      if (!secret) throw new Error('no link');
      const keys = await readerKeys(secret);
      return { keys, c: { url: server.url, bearer: bearer(keys) } };
    },
  };
  b.sync = new ReaderSync({
    store,
    brains: () => b.brains,
    status: (s) => b.statuses.push(s),
    marksChanged: (id) => b.told.push(id),
    telemetry: (event, props) => b.events.push({ event, props }),
    now,
    fetch: (async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      b.requests.push(
        `${method} ${new URL(input).pathname.replace(/\/items\/.+/, '/items/:id')}`,
      );
      await b.before(method);
      return fetch(input, init);
    }) as typeof fetch,
  });
  return b;
}

async function connected(
  ...args: Parameters<typeof bench>
): Promise<Bench & { keys: ReaderKeys; c: { url: string; bearer: string } }> {
  const b = await bench(...args);
  const st = await b.sync.connect(b.server.url, INVITE);
  expect(st).toMatchObject({ connected: true, url: b.server.url });
  expect(st.error).toBeUndefined();
  // The same object: tests swap its brains and hooks.
  return Object.assign(b, await b.phone());
}

const puts = (b: Bench) =>
  b.requests.filter((r) => r === 'PUT /api/v1/items/:id').length;

async function read<T>(
  b: { keys: ReaderKeys; c: { url: string; bearer: string } },
  id: string,
): Promise<T | null> {
  const got = await getItem(b.c, id);
  return got ? ((await unseal(b.keys, id, got.bytes)) as T) : null;
}

afterEach(cleanUp);

describe('connect', () => {
  it('makes an account from a new secret and hands it out only as the link', async () => {
    const b = await connected();
    expect(b.statuses.at(-1)).toMatchObject({ connected: true });
    await expect(hello(b.c)).resolves.toBeUndefined();
    expect(b.sync.link()).toMatch(
      new RegExp(`^${b.server.url}/#[A-Za-z0-9_-]{43}$`),
    );
    expect(b.events).toContainEqual({
      event: 'reader.connect',
      props: { ok: true },
    });
  });

  it('says what is wrong with the address or the code, and keeps nothing', async () => {
    const b = await bench();
    expect((await b.sync.connect('http://example.com', INVITE)).error).toBe(
      'Use an https:// address.',
    );
    expect((await b.sync.connect(b.server.url, '  ')).error).toBe(
      'Enter the invitation code.',
    );
    const wrong = await b.sync.connect(b.server.url, 'not-the-code');
    expect(wrong.connected).toBe(false);
    expect(wrong.error).toMatch(/invitation code/);
    expect(b.store.get()).toBeNull();
    expect(b.sync.link()).toBeNull();
    expect(b.events).toContainEqual({
      event: 'reader.connect',
      props: { ok: false, kind: 'invite' },
    });
  });

  it('refuses a second connection while one is saved', async () => {
    const b = await connected();
    const link = b.sync.link();
    expect((await b.sync.connect(b.server.url, INVITE)).error).toBe(
      'Disconnect the phone first.',
    );
    expect(b.sync.link()).toBe(link);
  });

  it('an address that is no reader server is not saved', async () => {
    const b = await bench();
    await b.server.close();
    const st = await b.sync.connect(b.server.url, INVITE);
    expect(st.connected).toBe(false);
    expect(st.error).toMatch(/could not be reached/);
  });
});

describe('push', () => {
  it('sends the long reads, letters and what they cite, sealed, with the shelf that lists them', async () => {
    const b = await connected();
    await b.sync.push();
    expect(b.store.status().lastPush).toEqual({
      at: '2026-11-11T12:00:00.000Z',
      ok: true,
      pieces: 2,
      error: null,
    });
    const listed = [...(await listItems(b.c)).keys()];
    expect(listed.map(kindOf).sort()).toEqual(['m', 'p', 'p', 'r', 'r']);
    const shelfId = await itemId(b.keys, 'm', itemName('b1'));
    const shelf = ReaderShelfSchema.parse(await read(b, shelfId));
    expect(shelf).toMatchObject({
      brainId: 'b1',
      name: 'Acme',
      chapters: ['Orders'],
      sentAt: '2026-11-11T12:00:00.000Z',
    });
    expect(shelf.reads).toEqual([
      expect.objectContaining({
        path: READ,
        title: 'Order to invoice',
        chapter: 'Orders',
        summary: 'How an order becomes an invoice.',
        stale: false,
      }),
    ]);
    expect(shelf.letters).toEqual([
      expect.objectContaining({ path: LETTER, read: READ }),
    ]);
    // Cited pages and sources go along, by their brain path; a page nobody cites does not.
    expect(Object.keys(shelf.refs).sort()).toEqual([
      'sources/mail.md',
      'wiki/subject-orders.md',
    ]);
    expect(shelf.refs['sources/mail.md'].title).toBe('mail');
    const piece = await read<{ title: string; text: string }>(
      b,
      shelf.reads[0].id,
    );
    expect(piece?.title).toBe('Order to invoice');
    expect(piece?.text).toContain('An order is a promise.');
    expect(piece?.text).not.toContain('summary:');
    expect(
      await read<{ text: string }>(b, shelf.refs['wiki/subject-orders.md'].id),
    ).toMatchObject({
      title: 'Orders',
      text: expect.stringContaining('An order.'),
    });
    // The server holds nothing it can read: no title, path or word of the text.
    const stored = await fs.readdir(b.server.dataDir, { recursive: true });
    for (const name of stored) {
      const file = path.join(b.server.dataDir, String(name));
      if (!(await fs.stat(file)).isFile()) continue;
      const bytes = (await fs.readFile(file)).toString('latin1');
      for (const word of ['promise', 'Order', 'Acme', 'subject-orders'])
        expect(bytes).not.toContain(word);
    }
    expect(b.events).toContainEqual({
      event: 'reader.push',
      props: { ok: true, sent: 5, removed: 0, brains: 1 },
    });
  });

  it('sends only what differs the next time, and removes what is gone', async () => {
    const b = await connected();
    await b.sync.push();
    expect(puts(b)).toBe(5);
    b.requests.length = 0;
    await b.sync.push();
    expect(puts(b)).toBe(0);
    expect(b.events.filter((e) => e.event === 'reader.push')).toHaveLength(1);

    await b.write(READ, longRead('An order is a promise, kept.'));
    await b.sync.push();
    // The long read and the shelf (its hash changed).
    expect(puts(b)).toBe(2);

    b.requests.length = 0;
    await fs.rm(path.join(b.dir, LETTER));
    await b.sync.push();
    expect(b.requests).toContain('DELETE /api/v1/items/:id');
    const shelf = ReaderShelfSchema.parse(
      await read(b, await itemId(b.keys, 'm', itemName('b1'))),
    );
    expect(shelf.letters).toEqual([]);
    expect(b.store.status().lastPush?.pieces).toBe(1);
    expect((await listItems(b.c)).size).toBe(4);
  });

  it('sends again what the server lost', async () => {
    const b = await connected();
    await b.sync.push();
    const shelfId = await itemId(b.keys, 'm', itemName('b1'));
    const shelf = ReaderShelfSchema.parse(await read(b, shelfId));
    await fetch(`${b.server.url}/api/v1/items/${shelf.reads[0].id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${b.c.bearer}` },
    });
    b.requests.length = 0;
    await b.sync.push();
    expect(puts(b)).toBe(1);
    expect(await read(b, shelf.reads[0].id)).not.toBeNull();
  });

  it('takes a brain off the server when its switch goes off, or it is archived or removed', async () => {
    const b = await connected();
    await b.sync.push();
    b.brains = [
      brain(b.dir, {
        options: { ...b.brains[0].options, sendToPhone: false },
      }),
    ];
    await b.sync.push();
    expect((await listItems(b.c)).size).toBe(0);
    expect(b.store.sentBrains()).toEqual([]);
    // Nothing wanted, nothing sent: the next push asks the server nothing.
    b.requests.length = 0;
    await b.sync.push();
    expect(b.requests).toEqual([]);

    b.brains = [brain(b.dir)];
    await b.sync.push();
    expect((await listItems(b.c)).size).toBe(5);
    b.brains = [brain(b.dir, { archived: true })];
    await b.sync.push();
    expect((await listItems(b.c)).size).toBe(0);

    b.brains = [brain(b.dir)];
    await b.sync.marks('b1', {
      [READ]: { hash: 'h', at: '2026-11-11T09:00:00.000Z', read: true },
    });
    await b.sync.push();
    b.brains = [];
    await b.sync.push();
    expect((await listItems(b.c)).size).toBe(0);
    // The marks of a brain that no longer exists go too.
    expect(b.store.knownBrains()).toEqual([]);
  });

  it('does nothing without a connection', async () => {
    const b = await bench();
    await b.sync.push();
    expect(b.requests).toEqual([]);
    expect(b.statuses).toEqual([]);
  });

  it('stops for good when the server no longer knows the account', async () => {
    const b = await connected();
    await fetch(`${b.server.url}/api/v1/reader`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${b.c.bearer}` },
    });
    await b.sync.push();
    expect(b.store.status()).toMatchObject({ connected: true, refused: true });
    expect(b.store.status().lastPush).toMatchObject({ ok: false });
    expect(b.events).toContainEqual({
      event: 'reader.push',
      props: { ok: false, kind: 'auth', sent: 0, removed: 0 },
    });
    b.requests.length = 0;
    await b.sync.push();
    expect(b.requests).toEqual([]);
  });

  it('picks up where a push stopped, and reports a failure once', async () => {
    // Sign-up and hello are not counted against the account's first minute here: connect comes first.
    const b = await connected({ limits: { requestsPerMinute: 5 } });
    await b.sync.push();
    const first = b.store.status().lastPush;
    expect(first).toMatchObject({ ok: false });
    expect(first?.error).toMatch(/slow down/);
    const sentBefore = Object.keys(b.store.sent('b1')).length;
    expect(sentBefore).toBeGreaterThan(0);
    expect(sentBefore).toBeLessThan(5);
    await b.sync.push();
    expect(
      b.events.filter((e) => e.event === 'reader.push' && !e.props?.ok),
    ).toHaveLength(1);

    b.server.advance(61_000);
    b.requests.length = 0;
    await b.sync.push();
    b.server.advance(61_000);
    await b.sync.push();
    expect(b.store.status().lastPush).toMatchObject({ ok: true, pieces: 2 });
    expect((await listItems(b.c)).size).toBe(5);
    // Nothing that had arrived was sent a second time.
    expect(puts(b)).toBe(5 - sentBefore);
  });

  it('a push asked for during a push runs after it', async () => {
    const b = await connected();
    const one = b.sync.push();
    await b.write(READ, longRead('Changed while the push ran.'));
    const two = b.sync.push();
    await Promise.all([one, two]);
    const shelf = ReaderShelfSchema.parse(
      await read(b, await itemId(b.keys, 'm', itemName('b1'))),
    );
    expect(
      (await read<{ text: string }>(b, shelf.reads[0].id))?.text,
    ).toContain('Changed while the push ran.');
  });
});

describe('marks', () => {
  const mark = (at: string, read = true) => ({ hash: 'h1', at, read });

  it('keeps the Read view marks here, and sends them for a brain that goes to the phone', async () => {
    const b = await connected();
    const local: ReaderMarkSet = { [READ]: mark('2026-11-11T09:00:00.000Z') };
    expect(await b.sync.marks('b1', local)).toEqual(local);
    expect(b.store.marks('b1')).toEqual(local);
    const id = await itemId(b.keys, 'k', itemName('b1'));
    expect(await read(b, id)).toEqual({ v: 1, marks: local });
    // The view that asked is not told about its own marks.
    expect(b.told).toEqual([]);
  });

  it('takes in what the phone marked, the newer mark of a text winning', async () => {
    const b = await connected();
    await b.sync.marks('b1', {
      [READ]: mark('2026-11-11T09:00:00.000Z'),
      [LETTER]: mark('2026-11-11T09:00:00.000Z'),
    });
    const id = await itemId(b.keys, 'k', itemName('b1'));
    const got = await getItem(b.c, id);
    // The phone: marks the long read unread later, and knows an older mark for the letter.
    await putItem(
      b.c,
      id,
      await seal(b.keys, id, {
        v: 1,
        marks: {
          [READ]: mark('2026-11-11T10:00:00.000Z', false),
          [LETTER]: mark('2026-11-10T09:00:00.000Z', false),
          'reads/other.md': mark('2026-11-11T08:00:00.000Z'),
        },
      }),
      got?.rev,
    );
    await b.sync.push();
    expect(b.told).toEqual(['b1']);
    const merged = {
      [READ]: mark('2026-11-11T10:00:00.000Z', false),
      [LETTER]: mark('2026-11-11T09:00:00.000Z'),
      'reads/other.md': mark('2026-11-11T08:00:00.000Z'),
    };
    expect(b.store.marks('b1')).toEqual(merged);
    // The server gets the merged set back: the letter's newer mark was only here.
    expect(await read(b, id)).toEqual({ v: 1, marks: merged });
    // Asking again changes nothing and tells nobody.
    expect(await b.sync.marks('b1', {})).toEqual(merged);
    expect(b.told).toEqual(['b1']);
  });

  it('starts over when the phone wrote in between', async () => {
    const b = await connected();
    const id = await itemId(b.keys, 'k', itemName('b1'));
    const theirs = { 'reads/phone.md': mark('2026-11-11T08:00:00.000Z') };
    let raced = false;
    b.before = async (method) => {
      // The phone writes just before the first write from here arrives.
      if (method !== 'PUT' || raced) return;
      raced = true;
      await putItem(b.c, id, await seal(b.keys, id, { v: 1, marks: theirs }));
    };
    const mine = { [READ]: mark('2026-11-11T09:00:00.000Z') };
    const merged = await b.sync.marks('b1', mine);
    expect(merged).toEqual({ ...mine, ...theirs });
    expect(await read(b, id)).toEqual({ v: 1, marks: merged });
  });

  it('keeps marks without a connection, and for a brain that does not go to the phone', async () => {
    const b = await bench();
    const local = { [READ]: mark('2026-11-11T09:00:00.000Z') };
    expect(await b.sync.marks('b1', local)).toEqual(local);
    expect(b.requests).toEqual([]);
    // What main knows comes back to a view that knows less (a cleared localStorage).
    expect(await b.sync.marks('b1', {})).toEqual(local);

    await b.sync.connect(b.server.url, INVITE);
    b.brains = [
      brain(b.dir, {
        options: { ...b.brains[0].options, sendToPhone: false },
      }),
    ];
    b.requests.length = 0;
    await b.sync.marks('b1', local);
    expect(b.requests).toEqual([]);
  });

  it('answers with what is known here when the server does not answer', async () => {
    const b = await connected();
    await b.server.close();
    const local = { [READ]: mark('2026-11-11T09:00:00.000Z') };
    expect(await b.sync.marks('b1', local)).toEqual(local);
  });
});

describe('disconnect', () => {
  it('removes the account with everything in it, and keeps the marks', async () => {
    const b = await connected();
    const local = {
      [READ]: { hash: 'h1', at: '2026-11-11T09:00:00.000Z', read: true },
    };
    await b.sync.marks('b1', local);
    await b.sync.push();
    const st = await b.sync.disconnect(false);
    expect(st).toEqual({
      connected: false,
      url: null,
      lastPush: null,
      refused: false,
    });
    await expect(hello(b.c)).rejects.toMatchObject({ kind: 'auth' });
    expect(b.sync.link()).toBeNull();
    expect(b.store.marks('b1')).toEqual(local);
    expect(b.store.sentBrains()).toEqual([]);
    expect(b.events).toContainEqual({
      event: 'reader.disconnect',
      props: { removed: true },
    });
    // A new connection is a new secret: the old link opens nothing.
    await b.sync.connect(b.server.url, INVITE);
    expect((await b.phone()).c.bearer).not.toBe(b.c.bearer);
  });

  it('keeps the connection when the server cannot be reached, unless told otherwise', async () => {
    const b = await connected();
    await b.server.close();
    const st = await b.sync.disconnect(false);
    expect(st.connected).toBe(true);
    expect(st.error).toMatch(/disconnect anyway/);
    expect((await b.sync.disconnect(true)).connected).toBe(false);
    expect(b.events).toContainEqual({
      event: 'reader.disconnect',
      props: { removed: false },
    });
  });

  it('an account the server already forgot is simply forgotten here', async () => {
    const b = await connected();
    await fetch(`${b.server.url}/api/v1/reader`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${b.c.bearer}` },
    });
    expect((await b.sync.disconnect(false)).connected).toBe(false);
  });
});

describe('the store', () => {
  it('keeps the secret only encrypted, and the connection across a restart', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'reader.json');
    const store = new ReaderStore(file, crypto);
    await store.load();
    const secret = new Uint8Array(32).fill(7);
    await store.set({ url: 'https://reader.example.com', secret });
    const text = await fs.readFile(file, 'utf8');
    expect(text).not.toContain(Buffer.from(secret).toString('base64url'));
    const again = new ReaderStore(file, crypto);
    await again.load();
    expect(again.get()).toEqual({ url: 'https://reader.example.com', secret });
    expect(again.status()).toEqual({
      connected: true,
      url: 'https://reader.example.com',
      lastPush: null,
      refused: false,
    });
  });

  it('saves nothing without encryption, and is not connected with a secret it cannot read', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'reader.json');
    const none = new ReaderStore(file, { ...crypto, available: () => false });
    await none.load();
    await expect(
      none.set({ url: 'https://x.example', secret: new Uint8Array(32) }),
    ).rejects.toThrow(/Encryption is not available/);
    expect(none.get()).toBeNull();

    const store = new ReaderStore(file, crypto);
    await store.load();
    await store.set({ url: 'https://x.example', secret: new Uint8Array(32) });
    const other = new ReaderStore(file, {
      ...crypto,
      decrypt: () => {
        throw new Error('another keychain');
      },
    });
    await other.load();
    expect(other.get()).toBeNull();
    expect(other.status().connected).toBe(false);
  });
});

describe('the client', () => {
  it('never follows a redirect, and names nothing in its errors', async () => {
    const seen: RequestInit[] = [];
    const fake = (async (_input: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response('{"error":"unauthorized"}', { status: 401 });
    }) as typeof fetch;
    const err = await hello(
      { url: 'https://reader.example.com', bearer: 'abc.def' },
      fake,
    ).catch((e: unknown) => e);
    expect(seen[0].redirect).toBe('error');
    expect(err).toBeInstanceOf(ReaderError);
    expect((err as ReaderError).kind).toBe('auth');
    expect((err as Error).message).not.toMatch(/example|abc|unauthorized/);
  });

  it('an answer that is not a reader server is rejected', async () => {
    const fake = (async () =>
      new Response('<html>hello</html>', { status: 200 })) as typeof fetch;
    await expect(
      hello({ url: 'https://x.example', bearer: 'a.b' }, fake),
    ).rejects.toMatchObject({ kind: 'rejected' });
    const other = (async () =>
      Response.json({ server: 'something-else', v: 1 })) as typeof fetch;
    await expect(
      hello({ url: 'https://x.example', bearer: 'a.b' }, other),
    ).rejects.toMatchObject({ kind: 'rejected' });
  });
});
