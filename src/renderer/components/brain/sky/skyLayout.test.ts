import { describe, expect, it } from 'vitest';
import type { BrainBook, BrainPageRow } from '../../../../shared/brain';
import { newPathsSince } from '../newPaths';
import { skyFacts, skyLayout, skyMatches } from './skyLayout';

const TODAY = Date.parse('2026-11-26');
const row = (name: string, over: Partial<BrainPageRow> = {}): BrainPageRow => ({
  path: `wiki/${name}.md`,
  title: name,
  summary: '',
  type: 'subject',
  lastUpdated: '2026-11-26',
  confidence: null,
  verified: null,
  changedSinceVerified: false,
  sources: [],
  linkedFrom: [],
  pictures: [],
  ...over,
});
const p = (name: string) => `wiki/${name}.md`;
const book = (...chapters: [string, string[]][]): BrainBook => ({
  chapters: chapters.map(([title, pages]) => ({
    title,
    summary: '',
    intro: '',
    pages: pages.map(p),
  })),
});
const sky = (
  rows: BrainPageRow[],
  b: BrainBook | null = null,
  fresh: string[] = [],
  max?: number,
) => skyLayout(rows, b, new Set(fresh.map(p)), TODAY, max);
const star = (s: ReturnType<typeof sky>, name: string) =>
  s.stars.find((x) => x.path === p(name))!;

describe('skyLayout', () => {
  it('follows the book: a cluster per chapter in order, numbered from 1', () => {
    const s = sky(
      [row('a'), row('b'), row('c')],
      book(['One', ['a']], ['Two', ['b']], ['Three', ['c']]),
    );
    expect(s.clusters.map((c) => [c.number, c.title])).toEqual([
      [1, 'One'],
      [2, 'Two'],
      [3, 'Three'],
    ]);
    expect(['a', 'b', 'c'].map((n) => star(s, n).cluster)).toEqual([0, 1, 2]);
  });

  it('puts pages no chapter lists in Back of the book, whatever their type', () => {
    const s = sky(
      [row('a'), row('d', { type: 'decision' }), row('loose')],
      book(['One', ['a']]),
    );
    expect(s.clusters.map((c) => [c.number, c.title])).toEqual([
      [1, 'One'],
      [0, 'Back of the book'],
    ]);
    expect(star(s, 'd').cluster).toBe(1);
    expect(star(s, 'loose').cluster).toBe(1);
  });

  it('has no Back of the book when every page is placed', () => {
    const s = sky([row('a')], book(['One', ['a']]));
    expect(s.clusters.map((c) => c.title)).toEqual(['One']);
  });

  it('clusters by type without a book, in BRAIN_PAGE_TYPES order, skipping empty types', () => {
    const s = sky([
      row('m', { type: 'meeting' }),
      row('c', { type: 'component' }),
      row('s'),
    ]);
    expect(s.clusters.map((c) => [c.number, c.title])).toEqual([
      [0, 'Subjects'],
      [0, 'Components'],
      [0, 'Meetings'],
    ]);
    expect(star(s, 'm').cluster).toBe(2);
  });

  it('counts a link once whichever way it points and ignores sources and missing pages', () => {
    const s = sky([
      row('a', { linkedFrom: [p('b'), 'sources/x.md', p('gone'), p('a')] }),
      row('b', { linkedFrom: [p('a')] }),
    ]);
    expect(s.links).toHaveLength(1);
    expect(star(s, 'a').links).toEqual([s.stars.indexOf(star(s, 'b'))]);
    expect(star(s, 'b').links).toEqual([s.stars.indexOf(star(s, 'a'))]);
  });

  it('sizes by links and brightens by freshness', () => {
    const s = sky([
      row('hub', { linkedFrom: [p('x'), p('y')], verified: '2026-11-26' }),
      row('x'),
      row('y'),
      row('alone', { lastUpdated: null }),
    ]);
    expect(star(s, 'alone').size).toBeCloseTo(6.5);
    expect(star(s, 'hub').size).toBeCloseTo(15.5);
    expect(star(s, 'x').bright).toBeCloseTo(1);
    expect(star(s, 'hub').bright).toBeCloseTo(1.12);
    expect(star(s, 'alone').ageDays).toBe(200);
    expect(star(s, 'alone').bright).toBeLessThan(0.4);
  });

  it('marks the new pages', () => {
    const s = sky([row('a'), row('b')], null, ['b']);
    expect([star(s, 'a').isNew, star(s, 'b').isNew]).toEqual([false, true]);
  });

  it('places a page listed in two chapters once, in the first, and skips a listed path without a row', () => {
    const s = sky(
      [row('a'), row('b')],
      book(['One', ['a', 'ghost']], ['Two', ['a', 'b']]),
    );
    expect(s.stars).toHaveLength(2);
    expect(star(s, 'a').cluster).toBe(0);
    expect(star(s, 'b').cluster).toBe(1);
  });

  it('gives the same sky for the same input, with every star at a finite place', () => {
    const rows = [row('a', { linkedFrom: [p('b')] }), row('b'), row('c')];
    const one = sky(rows, book(['One', ['a', 'b']]));
    expect(sky(rows, book(['One', ['a', 'b']]))).toEqual(one);
    for (const s of one.stars)
      expect([s.x, s.y, s.z].every(Number.isFinite)).toBe(true);
    // Two stars never share a place.
    expect(new Set(one.stars.map((s) => `${s.x},${s.y},${s.z}`)).size).toBe(3);
  });

  it('keeps the most linked pages over the limit and reports the total', () => {
    const s = sky(
      [
        row('a', { linkedFrom: [p('b'), p('c')] }),
        row('b', { linkedFrom: [p('c')] }),
        row('c'),
        row('d'),
        row('e'),
      ],
      null,
      [],
      3,
    );
    expect(s.total).toBe(5);
    expect(s.stars.map((x) => x.title).sort()).toEqual(['a', 'b', 'c']);
    expect(s.links).toHaveLength(3);
  });

  it('an empty brain is an empty sky', () => {
    const s = sky([], book(['One', ['a']]));
    expect(s).toEqual({ stars: [], links: [], clusters: [], total: 0 });
    expect(skyFacts(s)).toEqual({
      pages: 0,
      links: 0,
      changed14: 0,
      untouched120: 0,
    });
  });

  it('counts what changed lately and what was left alone', () => {
    const s = sky([
      row('today', { linkedFrom: [p('old')] }),
      row('recent', { lastUpdated: '2026-11-14' }),
      row('old', { lastUpdated: '2026-06-01' }),
      row('undated', { lastUpdated: null }),
    ]);
    expect(skyFacts(s)).toEqual({
      pages: 4,
      links: 1,
      changed14: 2,
      untouched120: 2,
    });
  });
});

describe('skyMatches', () => {
  const rows = [
    row('Checkout', { summary: 'How paying works' }),
    row('Cart', { linkedFrom: [p('Checkout'), p('Paying rules')] }),
    row('Paying rules', { type: 'decision' }),
  ];
  const s = sky(rows);
  const titles = (q: string) =>
    skyMatches(rows, s, q).map((i) => s.stars[i].title);

  it('puts a title that starts with the query first, then the most linked', () => {
    expect(titles('pay')).toEqual(['Paying rules', 'Checkout']);
    expect(titles('c')).toEqual(['Cart', 'Checkout', 'Paying rules']);
  });

  it('matches the summary and the type, in any case', () => {
    expect(titles('HOW PAYING')).toEqual(['Checkout']);
    expect(titles('decision')).toEqual(['Paying rules']);
  });

  it('finds nothing for an empty query', () => {
    expect(titles('  ')).toEqual([]);
  });
});

describe('newPathsSince', () => {
  const rows = [row('a'), row('b')];
  const log = [
    '- 2026-11-25T10:00:00Z capture note.md → pages: b; takeaway: x',
    '- 2026-11-20T10:00:00Z capture old.md → pages: a; takeaway: y',
  ].join('\n');

  it('names the pages of log entries after the last visit', () => {
    expect([...newPathsSince(log, rows, '2026-11-22T00:00:00Z')]).toEqual([
      p('b'),
    ]);
  });

  it('names none without a last visit', () => {
    expect(newPathsSince(log, rows, null).size).toBe(0);
  });
});
