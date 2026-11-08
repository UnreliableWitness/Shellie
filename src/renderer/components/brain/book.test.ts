import { describe, expect, it } from 'vitest';
import type { BrainBook, BrainPageRow } from '../../../shared/brain';
import {
  chapterOf,
  sectionBeingRead,
  sectionId,
  shownBefore,
  stripTitle,
} from './book';

const book: BrainBook = {
  chapters: [
    { title: 'A', summary: '', intro: '', pages: ['wiki/a.md', 'wiki/b.md'] },
    { title: 'B', summary: '', intro: '', pages: [] },
    { title: 'C', summary: '', intro: '', pages: ['wiki/c.md'] },
  ],
};
const row = (path: string, pictures: string[]): BrainPageRow => ({
  path,
  title: path,
  summary: '',
  type: 'other',
  lastUpdated: null,
  confidence: null,
  verified: null,
  changedSinceVerified: false,
  sources: [],
  linkedFrom: [],
  pictures,
});
const el = (top: number, height = 0) =>
  ({
    getBoundingClientRect: () => ({ top, height }),
  }) as unknown as Element;

describe('book', () => {
  it('finds the chapter of a page, -1 for none', () => {
    expect(chapterOf(book, 'wiki/b.md')).toBe(0);
    expect(chapterOf(book, 'wiki/c.md')).toBe(2);
    expect(chapterOf(book, 'wiki/x.md')).toBe(-1);
  });

  it('numbers section ids', () => {
    expect(sectionId(3)).toBe('section-3');
  });

  it('collects the pictures of the pages before the nth', () => {
    const rows = [
      row('wiki/a.md', ['x.png', 'y.png']),
      row('wiki/b.md', ['z.png']),
    ];
    const pages = ['wiki/a.md', 'wiki/b.md', 'wiki/gone.md'];
    expect([...shownBefore(rows, pages, 0)]).toEqual([]);
    expect([...shownBefore(rows, pages, 1)]).toEqual(['x.png', 'y.png']);
    expect([...shownBefore(rows, pages, 3)]).toEqual([
      'x.png',
      'y.png',
      'z.png',
    ]);
  });

  it('strips the frontmatter and a leading title heading only', () => {
    expect(stripTitle('---\ntitle: T\n---\n\n# T\n\nFirst.\n')).toBe(
      '\nFirst.\n',
    );
    expect(stripTitle('# T\nFirst.')).toBe('First.');
    expect(stripTitle('First.\n\n# Later\n')).toBe('First.\n\n# Later\n');
    expect(stripTitle('## Sub\n\nx')).toBe('## Sub\n\nx');
  });

  it('reads the last section whose top is above a third of the scroller', () => {
    const scroller = el(100, 900); // line at 400
    const sections = [el(-300), el(350), el(401), el(900)];
    expect(sectionBeingRead(sections, scroller, 3)).toBe(1);
  });

  it('reads the first section when none is above the line', () => {
    expect(sectionBeingRead([el(700), el(900)], el(0, 900), 1)).toBe(0);
  });

  it('falls back without layout', () => {
    expect(sectionBeingRead([el(0), el(0)], el(0, 0), 1)).toBe(1);
  });
});
