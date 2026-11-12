import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrainSchema } from '../../shared/brain';
import { readerKeys, SECRET_BYTES } from '../../shared/reader';
import { ReadingService } from '../reading/ReadingService';
import { buildBrain, citedPaths, contentHash, phoneFiles } from './build';

const READ = 'reads/order-to-invoice.md';

describe('citedPaths', () => {
  it('finds the pages and sources a text links to, by their brain path', () => {
    const body = [
      'See [orders](../wiki/subject-orders.md#rules), [again](../wiki/subject-orders.md)',
      'and [a mail][m], [a space](../sources/a%20mail.md).',
      '',
      '[m]: ../sources/mail.md "The mail"',
      '[angle]: <../wiki/with space.md>',
    ].join('\n');
    expect(citedPaths('reads/order-to-invoice.md', body).sort()).toEqual([
      'sources/a mail.md',
      'sources/mail.md',
      'wiki/subject-orders.md',
      'wiki/with space.md',
    ]);
  });

  it('resolves from where the text is', () => {
    expect(
      citedPaths('reads/letters/2026-11-10-a.md', '[p](../../wiki/a.md)'),
    ).toEqual(['wiki/a.md']);
  });

  it('leaves out everything that is not a page or source of the brain', () => {
    const body = [
      '[web](https://example.com/a.md) [mail](mailto:a@b.c) [abs](/wiki/a.md)',
      '[other read](other.md) [picture](../sources/files/scan.png)',
      '[out](../../../etc/passwd.md) [up](../wiki/../../secrets/a.md)',
      '```',
      '[in code](../wiki/code.md)',
      '```',
    ].join('\n');
    expect(citedPaths('reads/a.md', body)).toEqual([]);
  });
});

describe('contentHash', () => {
  it('is the same for the same value and differs for another', () => {
    expect(contentHash({ a: 1, b: 'x' })).toBe(contentHash({ a: 1, b: 'x' }));
    expect(contentHash({ a: 1, b: 'x' })).not.toBe(contentHash({ a: 2 }));
  });
});

const write = async (dir: string, rel: string, text: string) => {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};

/** A chapter's long read that is out of date, a topic's long read, a letter, and the page and source they cite. */
async function fill(dir: string) {
  await write(
    dir,
    'reads/order-to-invoice.md',
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
      'An order is a promise. See [orders](../wiki/subject-orders.md#rules)',
      'and [the mail](../sources/mail.md).',
      '',
    ].join('\n'),
  );
  await write(
    dir,
    'reads/payments.md',
    '---\ntitle: Payments\ntopic: How we get paid\n---\n\n# Payments\n\nMoney in.\n',
  );
  await write(
    dir,
    'reads/letters/2026-11-10-orders.md',
    '---\ntitle: About orders\nread: reads/order-to-invoice.md\nwritten: 2026-11-10\n---\n\nDear reader, [orders](../../wiki/subject-orders.md).\n',
  );
  await write(
    dir,
    'wiki/subject-orders.md',
    '---\ntitle: Orders\nsummary: s\n---\n\n# Orders\n\nAn order, now changed.\n',
  );
  await write(dir, 'sources/mail.md', '# The mail\n\nHello.\n');
  await write(
    dir,
    'brain/book.json',
    JSON.stringify({
      chapters: [
        { title: 'Orders', summary: 's', pages: ['wiki/subject-orders.md'] },
        { title: 'Empty', summary: 's', pages: [] },
      ],
    }),
  );
  await write(
    dir,
    'brain/reads.json',
    JSON.stringify({
      reads: {
        'reads/order-to-invoice.md': {
          at: '2026-11-09T09:00:00.000Z',
          commit: 'abc',
          pages: { 'wiki/subject-orders.md': 'old' },
        },
      },
    }),
  );
}

describe('buildBrain', () => {
  // What the push built before it was given the reading list's files: the same, or the phone gets everything again.
  const BEFORE = {
    shelfId: 'm-a930b2d260cf3095380e1b62c837d707',
    shelfHash: 'b3fa546a6f741d549f2a7991054f49287be6f4df',
    pieces: [
      [
        'reads/order-to-invoice.md',
        'r-a4b0b63f252f2de9fce0b7d6bef62716',
        '1329ad9a5173d2fbc0f8b145fd4124d358e6f139',
      ],
      [
        'reads/payments.md',
        'r-4a9068b80e2d7fcc5f34720485d4b0fa',
        '2da249c340ce2af74d65d2367b6114c31d9e8633',
      ],
      [
        'reads/letters/2026-11-10-orders.md',
        'r-74ab67f068db6faf00a55f74229871f8',
        '45be2287790a1336bf605a83c30b7ac27400873d',
      ],
      [
        'sources/mail.md',
        'p-d4cbfa6f2760500cb675d9c2daeb1c01',
        '9d79903d5c4dc059441449cc3bcbff6d0299a029',
      ],
      [
        'wiki/subject-orders.md',
        'p-e1d11d8b400da0ef24c94d6f2eb634fd',
        '6bc1b9fd7e773551225aa672dd36f39cc3eef1cf',
      ],
    ],
  };
  const work = {
    'reads/order-to-invoice.md': [{ id: 412, title: 'Return flow' }],
  };
  const summary = (built: Awaited<ReturnType<typeof buildBrain>>) => ({
    shelfId: built.shelfId,
    shelfHash: built.shelfHash,
    pieces: built.pieces.map((p) => [p.value.path, p.id, p.hash]),
  });

  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-build-'));
    await fill(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const keys = () => readerKeys(new Uint8Array(SECRET_BYTES).fill(7));

  it('builds the same shelf, ids and hashes as before from the files it reads itself', async () => {
    const built = await buildBrain(
      { id: 'b1', name: 'Acme', path: dir },
      await keys(),
      { ...(await phoneFiles(dir)), work },
    );
    expect(summary(built)).toEqual(BEFORE);
    expect(built.shelf).toMatchObject({
      chapters: ['Orders'],
      reads: [
        { path: 'reads/order-to-invoice.md', stale: true, work: work[READ] },
        { path: 'reads/payments.md', stale: false },
      ],
      letters: [{ path: 'reads/letters/2026-11-10-orders.md' }],
    });
  });

  it("builds the same from the reading list's files", async () => {
    const brain = BrainSchema.parse({
      id: 'b1',
      name: 'Acme',
      connectionId: 'c1',
      project: 'Shellie',
      path: dir,
      createdAt: '2026-11-01T09:00:00.000Z',
    });
    const reading = new ReadingService({
      brains: () => [brain],
      workItems: async () => [],
      marks: () => ({}),
    });
    const files = await reading.forPhone(brain);
    expect(files.work).toEqual({});
    expect(
      summary(await buildBrain(brain, await keys(), { ...files, work })),
    ).toEqual(BEFORE);
  });

  it('leaves out a long read whose text was not read with the list', async () => {
    const files = await phoneFiles(dir);
    delete files.texts['reads/payments.md'];
    const built = await buildBrain(
      { id: 'b1', name: 'Acme', path: dir },
      await keys(),
      files,
    );
    expect(built.shelf.reads.map((r) => r.path)).toEqual([READ]);
  });
});
