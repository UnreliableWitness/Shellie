import { describe, expect, it } from 'vitest';
import type {
  BrainBook,
  BrainPageRow,
  BrainPageType,
  BrainSourceRow,
  SourceType,
} from '../../../shared/brain';
import {
  backOfBook,
  pageGroups,
  pinnedPages,
  sourceGroup,
  unplaced,
} from './brainTree';

const row = (
  path: string,
  type: BrainPageType,
  title = path,
): BrainPageRow => ({
  path,
  title,
  summary: '',
  type,
  lastUpdated: null,
  confidence: null,
  verified: null,
  changedSinceVerified: false,
  sources: [],
  linkedFrom: [],
  pictures: [],
});
const src = (path: string, type: SourceType): BrainSourceRow => ({
  path,
  type,
  ingestedAt: '2026-11-01T09:00:00.000Z',
  captured: false,
  original: null,
  contents: null,
  note: null,
});

describe('pageGroups', () => {
  it('makes one group per type that has pages, in type order, items in row order', () => {
    const groups = pageGroups([
      row('wiki/d1.md', 'decision', 'First'),
      row('wiki/a.md', 'account', 'Acme'),
      row('wiki/d2.md', 'decision', 'Second'),
    ]);
    expect(groups).toEqual([
      {
        key: 'account',
        label: 'Accounts',
        items: [{ path: 'wiki/a.md', label: 'Acme' }],
      },
      {
        key: 'decision',
        label: 'Decisions',
        items: [
          { path: 'wiki/d1.md', label: 'First' },
          { path: 'wiki/d2.md', label: 'Second' },
        ],
      },
    ]);
  });

  it('gives no groups for no rows', () => {
    expect(pageGroups([])).toEqual([]);
  });
});

describe('sourceGroup', () => {
  it('has a subgroup per source type, then the DevOps wiki last', () => {
    const g = sourceGroup([
      src('sources/wiki/Home.md', 'wiki-page'),
      src('sources/2026-11-01-note-a.md', 'note'),
      src('sources/sow.md', 'sow'),
    ]);
    expect(g?.key).toBe('sources');
    expect(g?.label).toBe('Sources');
    expect(g?.items).toEqual([]);
    expect(g?.subgroups?.map((s) => [s.key, s.label])).toEqual([
      ['sow', 'sow'],
      ['note', 'note'],
      ['wiki-mirror', 'DevOps wiki'],
    ]);
    expect(g?.subgroups?.[1].items).toEqual([
      { path: 'sources/2026-11-01-note-a.md', label: 'note-a' },
    ]);
  });

  it('has no DevOps wiki subgroup without wiki sources', () => {
    const g = sourceGroup([src('sources/sow.md', 'sow')]);
    expect(g?.subgroups?.map((s) => s.key)).toEqual(['sow']);
  });

  it('is null without sources', () => {
    expect(sourceGroup([])).toBeNull();
  });
});

describe('pinnedPages', () => {
  it('returns account, scope, then only the latest digest', () => {
    const pinned = pinnedPages([
      row('wiki/digests/2026-w44.md', 'digest'),
      row('wiki/x.md', 'other'),
      row('wiki/scope.md', 'scope'),
      row('wiki/digests/2026-w45.md', 'digest'),
      row('wiki/account.md', 'account'),
    ]);
    expect(pinned.map((r) => r.path)).toEqual([
      'wiki/account.md',
      'wiki/scope.md',
      'wiki/digests/2026-w45.md',
    ]);
  });
});

describe('backOfBook', () => {
  it('groups decisions, meetings, digests, lessons and glossary, then the sources, leaving out the empty ones', () => {
    const groups = backOfBook(
      [
        row('wiki/g.md', 'glossary', 'Terms'),
        row('wiki/m.md', 'meeting', 'Kickoff'),
        row('wiki/d.md', 'decision', 'Database'),
        row('wiki/w.md', 'digest', 'W45'),
        row('wiki/s.md', 'scope', 'Scope'),
      ],
      [src('sources/sow.md', 'sow')],
    );
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ['decision', 'Decisions'],
      ['meeting', 'Meetings'],
      ['digest', 'Weekly digests'],
      ['glossary', 'Glossary'],
      ['sources', 'Sources'],
    ]);
    expect(groups[0].items).toEqual([{ path: 'wiki/d.md', label: 'Database' }]);
  });

  it('is empty for no such pages and no sources', () => {
    expect(backOfBook([row('wiki/s.md', 'scope')], [])).toEqual([]);
  });
});

describe('unplaced', () => {
  const book: BrainBook = {
    chapters: [{ title: 'A', summary: '', intro: '', pages: ['wiki/in.md'] }],
  };
  it('lists the pages in no chapter and not at the back of the book', () => {
    expect(
      unplaced(
        [
          row('wiki/in.md', 'scope', 'In'),
          row('wiki/out.md', 'component', 'Out'),
          row('wiki/d.md', 'decision', 'Database'),
        ],
        book,
      ),
    ).toEqual([{ path: 'wiki/out.md', label: 'Out' }]);
  });
});
