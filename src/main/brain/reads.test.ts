import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitClient } from '../services/GitClient';
import {
  bodyHash,
  brainReads,
  brainReadsAndPages,
  checkWriteTarget,
  matchChapters,
  nextToWrite,
  parseLetter,
  parseRead,
  readRecord,
  READS_RECORD,
  stampReads,
  staleOf,
  writePrompt,
  written,
  type LongRead,
} from './reads';
import { scaffoldBrain } from './scaffold';

const page = (title: string, body: string, updated = '2026-11-01') =>
  `---\ntitle: ${title}\nsummary: s\nlast_updated: ${updated}\n---\n\n# ${title}\n\n${body}\n`;

const longRead = (
  over: {
    title?: string;
    chapter?: string;
    topic?: string;
    pages?: string[];
    body?: string;
  } = {},
) =>
  [
    '---',
    `title: ${over.title ?? 'Order to invoice'}`,
    'summary: How an order becomes an invoice.',
    over.topic
      ? `topic: ${over.topic}`
      : `chapter: ${over.chapter ?? 'Orders'}`,
    'pages:',
    ...(over.pages ?? ['wiki/subject-orders.md']).map((p) => `  - ${p}`),
    'written: 2026-11-09',
    '---',
    '',
    `# ${over.title ?? 'Order to invoice'}`,
    '',
    over.body ?? 'An order is a promise.',
    '',
    '## What the writer was missing',
    '',
    '- Who approves a credit note.',
    '',
  ].join('\n');

describe('bodyHash', () => {
  it('ignores frontmatter, line ends and trailing whitespace', () => {
    const a = page('Orders', 'One.\nTwo.');
    expect(bodyHash(a)).toBe(
      bodyHash(page('Orders', 'One.\nTwo.', '2026-11-10')),
    );
    expect(bodyHash(a)).toBe(bodyHash(a.replace(/\n/g, '\r\n')));
    expect(bodyHash(a)).toBe(bodyHash(a.replace('One.', 'One.   ')));
    expect(bodyHash(a)).not.toBe(bodyHash(page('Orders', 'One.\nThree.')));
  });
});

describe('parseRead', () => {
  it('reads the frontmatter and counts the essay, not the missing section', () => {
    const words = Array.from({ length: 460 }, () => 'word').join(' ');
    const r = parseRead(
      'reads/order-to-invoice.md',
      longRead({ body: words, pages: ['wiki/a.md', 'wiki/a.md', 'wiki/b.md'] }),
    );
    expect(r).toMatchObject({
      path: 'reads/order-to-invoice.md',
      title: 'Order to invoice',
      summary: 'How an order becomes an invoice.',
      chapter: 'Orders',
      topic: null,
      pages: ['wiki/a.md', 'wiki/b.md'],
      written: '2026-11-09',
      minutes: 2,
    });
    expect(r.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('falls back to the heading, then the file name, for a file without frontmatter', () => {
    expect(parseRead('reads/a-b.md', '# From the heading\n\ntext').title).toBe(
      'From the heading',
    );
    const bare = parseRead('reads/a-b.md', 'text');
    expect(bare).toMatchObject({
      title: 'a-b',
      summary: '',
      chapter: null,
      topic: null,
      pages: [],
      written: null,
      minutes: 1,
    });
  });

  it('changes its hash when the file changes', () => {
    expect(parseRead('reads/a.md', longRead()).hash).not.toBe(
      parseRead('reads/a.md', longRead({ body: 'Rewritten.' })).hash,
    );
  });
});

describe('a frontmatter block YAML cannot read', () => {
  const text = [
    '---',
    'title: Credit notes: who signs',
    'summary: "Why a credit note: needs two signatures."',
    "chapter: 'Getting paid: the rules'",
    'pages:',
    '  - wiki/subject-invoices.md',
    '  - "wiki/decision-credit.md"',
    'written: 2026-11-09',
    '---',
    '',
    '# Heading',
    '',
    'Text.',
  ].join('\n');

  it('still gives a long read its fields, line by line', () => {
    expect(parseRead('reads/credit.md', text)).toMatchObject({
      title: 'Credit notes: who signs',
      summary: 'Why a credit note: needs two signatures.',
      chapter: 'Getting paid: the rules',
      topic: null,
      pages: ['wiki/subject-invoices.md', 'wiki/decision-credit.md'],
      written: '2026-11-09',
    });
  });

  it('still tells which long read a letter is about', () => {
    const letter =
      '---\ntitle: Credit: changed\nread: reads/credit.md\nwritten: 2026-11-10\n---\n\nIt changed.\n';
    expect(parseLetter('reads/letters/2026-11-10-credit.md', letter)).toEqual(
      expect.objectContaining({
        title: 'Credit: changed',
        read: 'reads/credit.md',
        written: '2026-11-10',
      }),
    );
  });
});

describe('parseLetter', () => {
  it('reads which long read it is about', () => {
    expect(
      parseLetter(
        'reads/letters/2026-11-10-order-to-invoice.md',
        '---\ntitle: The credit check moved\nread: reads/order-to-invoice.md\nwritten: 2026-11-10\n---\n\n## What you read\n\nOld.\n',
      ),
    ).toMatchObject({
      title: 'The credit check moved',
      read: 'reads/order-to-invoice.md',
      written: '2026-11-10',
      minutes: 1,
    });
  });
});

describe('matchChapters', () => {
  const read = (path: string, chapter: string | null, pages: string[]) =>
    ({ path, chapter, pages }) as LongRead;
  const book = {
    chapters: [
      { title: 'Orders', summary: '', intro: '', pages: ['wiki/a.md'] },
      {
        title: 'Getting paid',
        summary: '',
        intro: '',
        pages: ['wiki/b.md', 'wiki/c.md', 'wiki/d.md'],
      },
    ],
  };

  it('matches by title, whatever the case', () => {
    const m = matchChapters(
      [read('reads/o.md', 'orders', ['wiki/a.md'])],
      book,
      { reads: {} },
    );
    expect([...m]).toEqual([['reads/o.md', 0]]);
  });

  it('follows a renamed chapter by the pages the long read was written from', () => {
    const m = matchChapters(
      [
        read('reads/i.md', 'Invoicing', [
          'wiki/b.md',
          'wiki/c.md',
          'wiki/x.md',
        ]),
      ],
      book,
      { reads: {} },
    );
    expect(m.get('reads/i.md')).toBe(1);
  });

  it('leaves a chapter that has its own long read alone', () => {
    const m = matchChapters(
      [
        read('reads/p.md', 'Getting paid', ['wiki/b.md']),
        read('reads/i.md', 'Invoicing', ['wiki/b.md', 'wiki/c.md']),
      ],
      book,
      { reads: {} },
    );
    expect([...m]).toEqual([['reads/p.md', 1]]);
  });

  it('counts on the pages of the chapter: more than half of them, whatever else the long read rests on', () => {
    const others = ['wiki/decision-1.md', 'wiki/decision-2.md', 'wiki/m.md'];
    const m = matchChapters(
      [
        read('reads/i.md', 'Invoicing', [
          'wiki/b.md',
          'wiki/c.md',
          ...others,
          'wiki/meeting-1.md',
        ]),
      ],
      book,
      { reads: {} },
    );
    expect(m.get('reads/i.md')).toBe(1);
    expect(
      matchChapters([read('reads/h.md', 'Half', ['wiki/b.md'])], book, {
        reads: {},
      }).size,
    ).toBe(0);
  });

  it('matches nothing for a topic or without a book', () => {
    expect(
      matchChapters([read('reads/t.md', null, ['wiki/a.md'])], book, {
        reads: {},
      }).size,
    ).toBe(0);
    expect(
      matchChapters([read('reads/o.md', 'Orders', [])], null, { reads: {} })
        .size,
    ).toBe(0);
  });
});

describe('staleOf', () => {
  const now: Record<string, string> = { 'wiki/a.md': 'h1', 'wiki/b.md': 'h2' };
  const hashOf = (p: string) => now[p] ?? null;
  const record = (pages: Record<string, string>) => ({
    at: 't',
    commit: 'c',
    pages,
  });

  it('is empty without a record, and when nothing changed', () => {
    expect(staleOf(undefined, ['wiki/a.md'], hashOf)).toEqual([]);
    expect(
      staleOf(record({ 'wiki/a.md': 'h1', 'wiki/b.md': 'h2' }), null, hashOf),
    ).toEqual([]);
  });

  it('names a page that changed, one that is gone, and a page new to the chapter', () => {
    expect(
      staleOf(
        record({ 'wiki/a.md': 'old', 'wiki/gone.md': 'h' }),
        ['wiki/a.md', 'wiki/b.md'],
        hashOf,
      ),
    ).toEqual(['wiki/a.md', 'wiki/gone.md', 'wiki/b.md']);
  });
});

describe('long reads in a brain', () => {
  const git = new GitClient();
  let root: string;
  let dir: string;

  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  };
  const commit = async (message = 'c') => {
    await git.run(dir, ['add', '-A']);
    await git.run(dir, ['commit', '-m', message]);
  };
  const head = async () => (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
  const book = (chapters: { title: string; pages: string[] }[]) =>
    write(
      'brain/book.json',
      JSON.stringify({
        chapters: chapters.map((c) => ({ ...c, summary: 's', intro: 'i' })),
      }),
    );
  const at = new Date('2026-11-11T09:00:00.000Z');

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-reads-')),
    );
    dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
    await write('wiki/subject-orders.md', page('Orders', 'An order.'));
    await write('wiki/subject-returns.md', page('Returns', 'A return.'));
    await write('wiki/subject-invoices.md', page('Invoices', 'An invoice.'));
    await book([
      {
        title: 'Orders',
        pages: ['wiki/subject-orders.md', 'wiki/subject-returns.md'],
      },
      { title: 'Getting paid', pages: ['wiki/subject-invoices.md'] },
      { title: 'Empty', pages: [] },
    ]);
    await commit('pages');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('has nothing in a brain without long reads', async () => {
    expect(await brainReads(dir)).toEqual({ reads: [], letters: [] });
    expect(await readRecord(dir)).toEqual({ reads: {} });
  });

  it('reads a record an agent or a hand got at tolerantly', async () => {
    await write(READS_RECORD, 'not json');
    expect(await readRecord(dir)).toEqual({ reads: {} });
    await write(
      READS_RECORD,
      JSON.stringify({
        reads: {
          'reads/a.md': {
            at: 't',
            commit: 7,
            pages: { 'wiki/a.md': 'h', x: 1 },
          },
          'reads/b.md': 'nope',
        },
      }),
    );
    expect(await readRecord(dir)).toEqual({
      reads: {
        'reads/a.md': { at: 't', commit: null, pages: { 'wiki/a.md': 'h' } },
      },
    });
  });

  it('stamps a new chapter long read with the pages of the read and of the chapter', async () => {
    const before = await head();
    await write('reads/order-to-invoice.md', longRead());
    await stampReads(git, dir, 'chapter:Orders', at);
    const record = await readRecord(dir);
    expect(record.reads['reads/order-to-invoice.md']).toEqual({
      at: at.toISOString(),
      commit: before,
      pages: {
        'wiki/subject-orders.md': bodyHash(page('Orders', 'An order.')),
        'wiki/subject-returns.md': bodyHash(page('Returns', 'A return.')),
      },
    });
    const rows = await brainReads(dir);
    expect(rows.reads).toHaveLength(1);
    expect(rows.reads[0]).toMatchObject({
      path: 'reads/order-to-invoice.md',
      chapter: 'Orders',
      topic: null,
      stale: [],
    });
  });

  it('leaves the stamp of a long read the job did not touch', async () => {
    await write('reads/order-to-invoice.md', longRead());
    await stampReads(git, dir, 'chapter:Orders', at);
    await commit('write');
    await write(
      'reads/getting-paid.md',
      longRead({
        title: 'Getting paid',
        chapter: 'Getting paid',
        pages: ['wiki/subject-invoices.md'],
      }),
    );
    await stampReads(
      git,
      dir,
      'chapter:Getting paid',
      new Date('2026-11-12T09:00:00.000Z'),
    );
    const record = await readRecord(dir);
    expect(record.reads['reads/order-to-invoice.md'].at).toBe(at.toISOString());
    expect(record.reads['reads/getting-paid.md'].at).toBe(
      '2026-11-12T09:00:00.000Z',
    );
  });

  it('is out of date when a page says something else, is gone, or joins the chapter', async () => {
    await write('reads/order-to-invoice.md', longRead());
    await stampReads(git, dir, 'chapter:Orders', at);
    await commit('write');

    // A new date alone is no change.
    await write(
      'wiki/subject-orders.md',
      page('Orders', 'An order.', '2026-11-11'),
    );
    expect((await brainReads(dir)).reads[0].stale).toEqual([]);

    await write('wiki/subject-orders.md', page('Orders', 'An order, held.'));
    await fs.rm(path.join(dir, 'wiki/subject-returns.md'));
    await write('wiki/subject-picking.md', page('Picking', 'A pick.'));
    await book([
      {
        title: 'Orders',
        pages: ['wiki/subject-orders.md', 'wiki/subject-picking.md'],
      },
      { title: 'Getting paid', pages: ['wiki/subject-invoices.md'] },
    ]);
    expect((await brainReads(dir)).reads[0].stale).toEqual([
      'wiki/subject-orders.md',
      'wiki/subject-returns.md',
      'wiki/subject-picking.md',
    ]);
  });

  it('is never out of date without a record', async () => {
    await write('reads/by-hand.md', longRead({ topic: 'By hand' }));
    await write('wiki/subject-orders.md', page('Orders', 'Changed.'));
    expect((await brainReads(dir)).reads[0]).toMatchObject({
      chapter: null,
      topic: 'By hand',
      stale: [],
    });
  });

  it('restamps an update, also when the skill changed nothing, and drops the record of a long read that is gone', async () => {
    await write('reads/order-to-invoice.md', longRead());
    await write('reads/gone.md', longRead({ topic: 'Gone' }));
    await stampReads(git, dir, 'chapter:Orders', at);
    await commit('write');
    await fs.rm(path.join(dir, 'reads/gone.md'));
    await write('wiki/subject-orders.md', page('Orders', 'An order, held.'));
    await commit('capture');
    expect((await brainReads(dir)).reads[0].stale).toEqual([
      'wiki/subject-orders.md',
    ]);

    const later = new Date('2026-11-12T09:00:00.000Z');
    await stampReads(git, dir, 'reads/order-to-invoice.md', later);
    const record = await readRecord(dir);
    expect(Object.keys(record.reads)).toEqual(['reads/order-to-invoice.md']);
    expect(record.reads['reads/order-to-invoice.md']).toMatchObject({
      at: later.toISOString(),
      commit: await head(),
    });
    expect((await brainReads(dir)).reads[0].stale).toEqual([]);
  });

  it('records an update that gave the long read another name under the new one', async () => {
    await write('reads/order-to-invoice.md', longRead());
    await stampReads(git, dir, 'chapter:Orders', at);
    await commit('write');
    await fs.rename(
      path.join(dir, 'reads/order-to-invoice.md'),
      path.join(dir, 'reads/how-an-order-is-paid.md'),
    );
    await stampReads(git, dir, 'reads/order-to-invoice.md', at);
    expect(Object.keys((await readRecord(dir)).reads)).toEqual([
      'reads/how-an-order-is-paid.md',
    ]);
  });

  it('leaves no record behind when no long read was written', async () => {
    await stampReads(git, dir, 'chapter:Orders', at);
    await expect(fs.access(path.join(dir, READS_RECORD))).rejects.toThrow();
  });

  it('lists letters newest first', async () => {
    const letter = (read: string, on: string) =>
      `---\ntitle: L ${on}\nread: ${read}\nwritten: ${on}\n---\n\n## What you read\n\nOld.\n`;
    await write(
      'reads/letters/2026-11-10-a.md',
      letter('reads/a.md', '2026-11-10'),
    );
    await write(
      'reads/letters/2026-11-12-a.md',
      letter('reads/a.md', '2026-11-12'),
    );
    await write('reads/letters/notes.txt', 'not a letter');
    expect((await brainReads(dir)).letters.map((l) => l.path)).toEqual([
      'reads/letters/2026-11-12-a.md',
      'reads/letters/2026-11-10-a.md',
    ]);
  });

  it('hands over the book and the texts it read the long reads and letters from', async () => {
    const letter =
      '---\ntitle: L\nread: reads/order-to-invoice.md\n---\n\nHi.\n';
    await write('reads/order-to-invoice.md', longRead());
    await write('reads/letters/2026-11-10-a.md', letter);
    const r = await brainReadsAndPages(dir);
    expect(r.book?.chapters.map((c) => c.title)).toEqual([
      'Orders',
      'Getting paid',
      'Empty',
    ]);
    expect(r.texts).toEqual({
      'reads/order-to-invoice.md': longRead(),
      'reads/letters/2026-11-10-a.md': letter,
    });
  });

  describe('checkWriteTarget', () => {
    it('takes a chapter with pages, by its title in the book', async () => {
      expect(await checkWriteTarget(dir, 'chapter:orders')).toEqual({
        chapter: 'Orders',
      });
    });

    it('refuses a chapter that is not in the book or has no pages', async () => {
      await expect(checkWriteTarget(dir, 'chapter:Nope')).rejects.toThrow(
        'The book has no such chapter',
      );
      await expect(checkWriteTarget(dir, 'chapter:Empty')).rejects.toThrow(
        'That chapter has no pages to write from',
      );
    });

    it('never names the chapter or the file in a refusal: the message is sent as telemetry', async () => {
      for (const target of [
        'chapter:Secret customer',
        'chapter:Empty',
        'reads/secret-customer.md',
      ]) {
        const message = await checkWriteTarget(dir, target).then(
          () => '',
          (e: Error) => e.message,
        );
        expect(message).not.toBe('');
        expect(message).not.toMatch(/secret|empty|reads\//i);
      }
    });

    it('takes a topic of one line', async () => {
      expect(await checkWriteTarget(dir, 'topic:  Credit notes ')).toEqual({
        topic: 'Credit notes',
      });
      await expect(checkWriteTarget(dir, 'topic:  ')).rejects.toThrow(
        'Say what the long read should be about',
      );
      await expect(checkWriteTarget(dir, 'topic:a\nb')).rejects.toThrow(
        'one line',
      );
      await expect(
        checkWriteTarget(dir, `topic:${'x'.repeat(201)}`),
      ).rejects.toThrow('one line');
    });

    it('takes a long read that exists, and nothing else', async () => {
      await write('reads/order-to-invoice.md', longRead());
      expect(await checkWriteTarget(dir, 'reads/order-to-invoice.md')).toEqual({
        update: 'reads/order-to-invoice.md',
      });
      await expect(checkWriteTarget(dir, 'reads/nope.md')).rejects.toThrow(
        'That long read is gone',
      );
      await expect(
        checkWriteTarget(dir, 'wiki/subject-orders.md'),
      ).rejects.toThrow('not something to write a long read on');
      await expect(
        checkWriteTarget(dir, 'reads/../wiki/a.md'),
      ).rejects.toThrow();
    });
  });

  describe('writePrompt', () => {
    it('asks for a chapter or a topic', async () => {
      expect(await writePrompt(git, dir, 'chapter:Orders')).toBe(
        '/write chapter Orders',
      );
      expect(await writePrompt(git, dir, 'topic:Credit notes')).toBe(
        '/write topic Credit notes',
      );
    });

    it('hands an update the commit of the record and the pages that changed', async () => {
      const before = await head();
      await write('reads/order-to-invoice.md', longRead());
      await stampReads(git, dir, 'chapter:Orders', at);
      await commit('write');
      await write('wiki/subject-orders.md', page('Orders', 'An order, held.'));
      await commit('capture');
      expect(await writePrompt(git, dir, 'reads/order-to-invoice.md')).toBe(
        `/write update reads/order-to-invoice.md since ${before} changed: wiki/subject-orders.md`,
      );
    });

    it('falls back to the commit that last touched a long read without a record', async () => {
      await write('reads/by-hand.md', longRead({ topic: 'By hand' }));
      await commit('by hand');
      const touched = await head();
      await write('wiki/subject-orders.md', page('Orders', 'Changed.'));
      await commit('capture');
      expect(await writePrompt(git, dir, 'reads/by-hand.md')).toBe(
        `/write update reads/by-hand.md since ${touched} changed: none`,
      );
    });

    it('throws for a target that does not hold', async () => {
      await expect(writePrompt(git, dir, 'chapter:Nope')).rejects.toThrow();
    });
  });

  describe('written', () => {
    it('tells whether the long read a target asks for is there', async () => {
      expect(await written(dir, 'chapter:Orders')).toBe(false);
      await write('reads/order-to-invoice.md', longRead());
      await write('reads/credit.md', longRead({ topic: 'Credit notes' }));
      expect(await written(dir, 'chapter:Orders')).toBe(true);
      expect(await written(dir, 'chapter:Getting paid')).toBe(false);
      expect(await written(dir, 'topic:credit notes')).toBe(true);
      expect(await written(dir, 'topic:Returns')).toBe(false);
      expect(await written(dir, 'reads/credit.md')).toBe(true);
      expect(await written(dir, 'reads/nope.md')).toBe(false);
    });
  });

  describe('nextToWrite', () => {
    it('starts with the first chapter that has pages and no long read', async () => {
      expect(await nextToWrite(dir, new Set())).toBe('chapter:Orders');
      expect(await nextToWrite(dir, new Set(['chapter:Orders']))).toBe(
        'chapter:Getting paid',
      );
    });

    it('brings an out-of-date long read up to date first, and ends when all is written', async () => {
      await write('reads/order-to-invoice.md', longRead());
      await stampReads(git, dir, 'chapter:Orders', at);
      await commit('write');
      expect(await nextToWrite(dir, new Set())).toBe('chapter:Getting paid');
      await write('wiki/subject-orders.md', page('Orders', 'An order, held.'));
      expect(await nextToWrite(dir, new Set())).toBe(
        'reads/order-to-invoice.md',
      );
      expect(
        await nextToWrite(dir, new Set(['reads/order-to-invoice.md'])),
      ).toBe('chapter:Getting paid');
      expect(
        await nextToWrite(
          dir,
          new Set(['reads/order-to-invoice.md', 'chapter:Getting paid']),
        ),
      ).toBeNull();
    });
  });
});
