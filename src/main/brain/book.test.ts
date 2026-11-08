import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrainPageType } from '../../shared/brain';
import { parseBook, readBook } from './book';

const known = new Map<string, BrainPageType>([
  ['wiki/account.md', 'account'],
  ['wiki/subject-mission.md', 'subject'],
  ['wiki/component-api.md', 'component'],
  ['wiki/decision-2026-11-03-db.md', 'decision'],
  ['wiki/meeting-2026-11-01-kickoff.md', 'meeting'],
  ['wiki/digests/2026-w45.md', 'digest'],
  ['wiki/lesson-2026-11-04-retries.md', 'lesson'],
  ['wiki/glossary.md', 'glossary'],
]);

const book = (chapters: unknown) => JSON.stringify({ chapters });

describe('parseBook', () => {
  it('keeps chapters and their pages in order', () => {
    const b = parseBook(
      book([
        {
          title: 'Who',
          summary: 'The client.',
          intro: 'Intro.',
          pages: ['wiki/account.md', 'wiki/subject-mission.md'],
        },
        {
          title: 'How',
          summary: 's',
          intro: 'i',
          pages: ['wiki/component-api.md'],
        },
      ]),
      known,
    );
    expect(b).toEqual({
      chapters: [
        {
          title: 'Who',
          summary: 'The client.',
          intro: 'Intro.',
          pages: ['wiki/account.md', 'wiki/subject-mission.md'],
        },
        {
          title: 'How',
          summary: 's',
          intro: 'i',
          pages: ['wiki/component-api.md'],
        },
      ],
    });
  });

  it('is null for text that is not a book', () => {
    expect(parseBook('{nope', known)).toBeNull();
    expect(parseBook('[]', known)).toBeNull();
    expect(parseBook('"x"', known)).toBeNull();
    expect(parseBook('null', known)).toBeNull();
    expect(parseBook('{}', known)).toBeNull();
    expect(parseBook(book([]), known)).toBeNull();
    expect(parseBook(book([{ pages: ['wiki/account.md'] }]), known)).toBeNull();
    expect(parseBook(book([{ title: '  ' }]), known)).toBeNull();
    expect(parseBook(book([7, null, 'x']), known)).toBeNull();
  });

  it('skips a chapter without a title or that is not an object, and keeps the rest', () => {
    const b = parseBook(
      book([
        { pages: ['wiki/account.md'] },
        7,
        null,
        { title: 'Good', pages: ['wiki/account.md'] },
      ]),
      known,
    );
    expect(b?.chapters.map((c) => [c.title, c.pages])).toEqual([
      ['Good', ['wiki/account.md']],
    ]);
  });

  it('drops paths that are not pages', () => {
    const b = parseBook(
      book([{ title: 'A', pages: ['wiki/gone.md', 'wiki/account.md', 7] }]),
      known,
    );
    expect(b?.chapters[0].pages).toEqual(['wiki/account.md']);
  });

  it('keeps a page at its first place', () => {
    const b = parseBook(
      book([
        { title: 'A', pages: ['wiki/account.md', 'wiki/account.md'] },
        { title: 'B', pages: ['wiki/account.md', 'wiki/component-api.md'] },
      ]),
      known,
    );
    expect(b?.chapters.map((c) => c.pages)).toEqual([
      ['wiki/account.md'],
      ['wiki/component-api.md'],
    ]);
  });

  it('drops the back of the book types', () => {
    const b = parseBook(
      book([
        {
          title: 'A',
          pages: [
            'wiki/decision-2026-11-03-db.md',
            'wiki/meeting-2026-11-01-kickoff.md',
            'wiki/digests/2026-w45.md',
            'wiki/lesson-2026-11-04-retries.md',
            'wiki/glossary.md',
            'wiki/component-api.md',
          ],
        },
      ]),
      known,
    );
    expect(b?.chapters[0].pages).toEqual(['wiki/component-api.md']);
  });

  it('keeps a chapter left with no pages, and defaults summary and intro', () => {
    const b = parseBook(
      book([{ title: 'Empty', pages: ['wiki/gone.md'] }, { title: 'Bare' }]),
      known,
    );
    expect(b).toEqual({
      chapters: [
        { title: 'Empty', summary: '', intro: '', pages: [] },
        { title: 'Bare', summary: '', intro: '', pages: [] },
      ],
    });
  });
});

describe('readBook', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-book-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is null without a book file', async () => {
    expect(await readBook(dir)).toBeNull();
  });

  it('reads the book against the pages on disk', async () => {
    await fs.mkdir(path.join(dir, 'wiki'), { recursive: true });
    await fs.mkdir(path.join(dir, 'brain'), { recursive: true });
    await fs.writeFile(path.join(dir, 'wiki', 'subject-mission.md'), '# M\n');
    await fs.writeFile(path.join(dir, 'wiki', 'glossary.md'), '# G\n');
    await fs.writeFile(
      path.join(dir, 'brain', 'book.json'),
      book([
        {
          title: 'Why',
          pages: ['wiki/subject-mission.md', 'wiki/glossary.md', 'wiki/x.md'],
        },
      ]),
    );
    expect(await readBook(dir)).toEqual({
      chapters: [
        {
          title: 'Why',
          summary: '',
          intro: '',
          pages: ['wiki/subject-mission.md'],
        },
      ],
    });
  });

  it('is null when the pages cannot be read, not a book of empty chapters', async () => {
    await fs.mkdir(path.join(dir, 'wiki'), { recursive: true });
    await fs.mkdir(path.join(dir, 'brain'), { recursive: true });
    const page = path.join(dir, 'wiki', 'subject-mission.md');
    await fs.writeFile(page, '# M\n');
    await fs.writeFile(
      path.join(dir, 'brain', 'book.json'),
      book([{ title: 'Why', pages: ['wiki/subject-mission.md'] }]),
    );
    await fs.chmod(page, 0o000);
    try {
      expect(await readBook(dir)).toBeNull();
    } finally {
      await fs.chmod(page, 0o644);
    }
  });
});
