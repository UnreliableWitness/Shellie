/**
 * Shellie, the reader server and the phone's site together: what `ReaderSync` pushes is read back by the site's own
 * code (`reader/site/src/sync.ts`) through the real server, and a mark made on either side reaches the other.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  cleanUp,
  INVITE,
  start,
  tempDir,
} from '../../../reader/server/testing';
import { createApi } from '../../../reader/site/src/api';
import { memoryStore } from '../../../reader/site/src/cache';
import { Reader } from '../../../reader/site/src/sync';
import { BrainSchema } from '../../shared/brain';
import {
  isMarkedRead,
  readerKeys,
  readingList,
  secretFromLink,
} from '../../shared/reader';
import { ReaderStore } from './ReaderStore';
import { ReaderSync } from './ReaderSync';

const crypto = {
  available: () => true,
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => b.toString().slice(4),
};

const READ = 'reads/order-to-invoice.md';
const longRead = (body: string) =>
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
    'See [orders](../wiki/subject-orders.md#rules).',
    '',
  ].join('\n');

afterEach(cleanUp);

async function setUp() {
  const server = await start();
  const dir = await tempDir();
  const write = async (rel: string, text: string) => {
    const file = path.join(dir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  await write(READ, longRead('An order is a promise.'));
  await write(
    'wiki/subject-orders.md',
    '---\ntitle: Orders\nsummary: s\n---\n\n# Orders\n\nAn order.\n',
  );
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
  const told: string[] = [];
  const shellie = new ReaderSync({
    store,
    brains: () => [
      BrainSchema.parse({
        id: 'b1',
        name: 'Acme',
        connectionId: 'c1',
        project: 'Shellie',
        path: dir,
        createdAt: '2026-11-01T09:00:00.000Z',
        options: { sendToPhone: true },
      }),
    ],
    status: () => undefined,
    marksChanged: (id) => told.push(id),
    telemetry: () => undefined,
  });
  expect((await shellie.connect(server.url, INVITE)).connected).toBe(true);

  // The phone has the link and nothing else.
  const secret = secretFromLink(shellie.link() ?? '');
  if (!secret) throw new Error('no link');
  const keys = await readerKeys(secret);
  const phone = new Reader(
    keys,
    // The site asks its own origin; here that is the test's server.
    createApi(keys, (input, init) => fetch(`${server.url}${input}`, init)),
    memoryStore(),
  );
  return { server, shellie, phone, write, told };
}

it('shows on the phone what Shellie sent, and keeps it for reading offline', async () => {
  const { shellie, phone } = await setUp();
  expect((await shellie.sendNow()).lastPush).toMatchObject({
    ok: true,
    pieces: 1,
  });

  await phone.sync();
  await phone.settled();
  const state = phone.getState();
  expect(state).toMatchObject({ gone: false, problem: null });
  const [shelf] = state.library?.shelves ?? [];
  expect(shelf).toMatchObject({ brainId: 'b1', name: 'Acme' });
  expect(shelf.reads.map((r) => r.title)).toEqual(['Order to invoice']);

  const list = readingList(shelf, {});
  expect(list.foundations).toMatchObject([{ kind: 'read', done: false }]);
  expect(list).toMatchObject({ total: 1, done: 0 });

  const piece = await phone.piece(shelf.reads[0].id);
  expect(piece?.text).toContain('An order is a promise.');
  // The page it cites came along, and opens by the path the link names.
  const cited = shelf.refs['wiki/subject-orders.md'];
  expect((await phone.piece(cited.id))?.title).toBe('Orders');
});

it('brings a mark made on the phone back to Shellie, and one made in Shellie to the phone', async () => {
  const { shellie, phone, told } = await setUp();
  await shellie.sendNow();
  await phone.sync();
  const [shelf] = phone.getState().library?.shelves ?? [];
  const read = shelf.reads[0];

  await phone.mark('b1', read, true);
  expect(isMarkedRead(phone.getState().library?.marks.b1 ?? {}, read)).toBe(
    true,
  );

  // Shellie learns it at its next push, and tells its windows.
  await shellie.sendNow();
  expect(told).toContain('b1');
  const inShellie = await shellie.marks('b1', {});
  expect(isMarkedRead(inShellie, read)).toBe(true);

  // "Mark unread" in Shellie is the newer word, and the phone follows.
  const later = new Date(Date.parse(inShellie[read.path].at) + 1000);
  await shellie.marks('b1', {
    [read.path]: { hash: read.hash, at: later.toISOString(), read: false },
  });
  await phone.sync();
  expect(isMarkedRead(phone.getState().library?.marks.b1 ?? {}, read)).toBe(
    false,
  );
});

it('shows a long read brought up to date as unread again on the phone', async () => {
  const { shellie, phone, write } = await setUp();
  await shellie.sendNow();
  await phone.sync();
  const before = phone.getState().library!.shelves[0].reads[0];
  await phone.mark('b1', before, true);

  await write(READ, longRead('An order is a promise, since the new rule.'));
  await shellie.sendNow();
  await phone.sync();
  await phone.settled();

  const { shelves, marks } = phone.getState().library!;
  const after = shelves[0].reads[0];
  expect(after.hash).not.toBe(before.hash);
  expect(isMarkedRead(marks.b1, after)).toBe(false);
  expect((await phone.piece(after.id))?.text).toContain('since the new rule');
  // Read once and changed since, with no letter to say how: it is under "changed", not back among the foundations.
  const list = readingList(shelves[0], marks.b1);
  expect(list.changed).toHaveLength(1);
});

it('tells the phone it is no longer connected once Shellie disconnects', async () => {
  const { shellie, phone } = await setUp();
  await shellie.sendNow();
  await phone.sync();
  expect(phone.getState().library?.shelves).toHaveLength(1);

  expect((await shellie.disconnect(false)).connected).toBe(false);
  await phone.sync();
  expect(phone.getState().gone).toBe(true);
});
