import { describe, expect, it } from 'vitest';
import type { BrainActivityEntry } from '../../../../shared/brainShare';
import {
  arrivedText,
  byDay,
  pageName,
  perPerson,
  unseenFromColleagues,
  withSeen,
} from './history';

const entry = (over: Partial<BrainActivityEntry>): BrainActivityEntry => ({
  id: 'c',
  at: '2026-11-27T10:00:00Z',
  who: 'Anna',
  me: false,
  kind: 'captured',
  subject: 'plan.md',
  pages: [],
  morePages: 0,
  ...over,
});
const page = (path: string, added = true) => ({ path, added });

describe('unseenFromColleagues', () => {
  const list = [
    entry({ id: 'c3' }),
    entry({ id: 'c2', me: true, who: 'Dries' }),
    entry({ id: 'c1' }),
  ];
  it('announces nothing on the first look at a brain', () => {
    expect(unseenFromColleagues(list, null)).toEqual([]);
  });
  it("is the colleagues' entries not seen yet, never this person's own", () => {
    expect(
      unseenFromColleagues(list, new Set(['c1'])).map((e) => e.id),
    ).toEqual(['c3']);
    expect(unseenFromColleagues(list, new Set(withSeen(list, null)))).toEqual(
      [],
    );
  });
});

describe('arrivedText', () => {
  it('counts each page once, and the pages past the named ones', () => {
    expect(
      arrivedText([
        entry({ pages: [page('wiki/a.md'), page('wiki/b.md')], morePages: 2 }),
        entry({ pages: [page('wiki/a.md', false)] }),
      ]),
    ).toBe('Anna added 4 pages');
  });
  it('names two people, then counts the others', () => {
    const two = [
      entry({ pages: [page('wiki/a.md')] }),
      entry({ who: 'Bert', pages: [] }),
    ];
    expect(arrivedText(two)).toBe('Anna and Bert added 1 page');
    expect(arrivedText([...two, entry({ who: 'Cem' })])).toBe(
      'Anna and 2 others added 1 page',
    );
  });
  it('says sources, a join or a change when no page came', () => {
    expect(arrivedText([entry({ kind: 'source' })])).toBe(
      'Anna added 1 source',
    );
    expect(arrivedText([entry({ kind: 'joined', subject: null })])).toBe(
      'Anna joined',
    );
    expect(arrivedText([entry({ kind: 'settled', subject: null })])).toBe(
      'Anna changed the brain',
    );
  });
});

describe('perPerson', () => {
  it('sums what each person added since a moment, this person first', () => {
    const since = Date.parse('2026-11-20T00:00:00Z');
    expect(
      perPerson(
        [
          entry({ pages: [page('wiki/a.md'), page('wiki/b.md')] }),
          entry({ kind: 'source' }),
          entry({ me: true, who: 'Dries', kind: 'source' }),
          entry({ who: 'Bert', kind: 'joined' }),
          entry({ at: '2026-11-01T10:00:00Z', pages: [page('wiki/old.md')] }),
        ],
        since,
      ),
    ).toEqual([
      { who: 'You', me: true, sources: 1, pages: 0 },
      { who: 'Anna', me: false, sources: 1, pages: 2 },
    ]);
  });
});

describe('byDay', () => {
  it('groups under Today, Yesterday and a date', () => {
    const now = new Date(2026, 10, 27, 15);
    const at = (d: number, h: number) => new Date(2026, 10, d, h).toISOString();
    const days = byDay(
      [
        entry({ id: 'a', at: at(27, 9) }),
        entry({ id: 'b', at: at(27, 8) }),
        entry({ id: 'c', at: at(26, 8) }),
        entry({ id: 'd', at: at(23, 8) }),
      ],
      now,
    );
    expect(days.map((d) => [d.day, d.entries.map((e) => e.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      ['Mon 23 Nov', ['d']],
    ]);
  });
});

describe('pageName', () => {
  it('reads a name from a path', () => {
    expect(pageName('wiki/people/api-keys.md')).toBe('api keys');
  });
});
