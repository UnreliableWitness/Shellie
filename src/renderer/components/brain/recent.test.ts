import { describe, expect, it } from 'vitest';
import type { BrainJob, BrainPageRow } from '../../../shared/brain';
import {
  folderOf,
  isAfter,
  matchPage,
  pagesChangedBy,
  recentEntries,
  shortDay,
  sourceLabel,
} from './recent';

const row = (path: string, title: string): BrainPageRow => ({
  path,
  title,
  summary: '',
  type: 'other',
  lastUpdated: null,
  confidence: null,
  verified: null,
  changedSinceVerified: false,
  sources: [],
  linkedFrom: [],
  pictures: [],
});
const rows = [
  row('wiki/account.md', 'Acme'),
  row('wiki/decision-2026-11-03-db.md', 'Database choice'),
  row('wiki/digests/2026-w45.md', 'Week 45'),
];

describe('recentEntries', () => {
  it('reads the log lines that name pages, newest first, matching paths, stems and titles', () => {
    const log = [
      '# Log',
      '',
      '- 2026-11-04T10:00:00Z capture sources/2026-11-04-deck.md → pages: account, decision-2026-11-03-db.md; takeaway: x',
      '- 2026-11-03T09:00:00Z sync -> pages: `Database choice`, wiki/digests/2026-w45.md, nowhere; takeaway: y',
      '- 2026-11-02T09:00:00Z lint → 0 findings',
      'not an entry',
    ].join('\n');
    expect(recentEntries(log, rows)).toEqual([
      {
        at: '2026-11-04T10:00:00Z',
        skill: 'capture',
        source: 'sources/2026-11-04-deck.md',
        pages: [
          { label: 'account', path: 'wiki/account.md' },
          {
            label: 'decision-2026-11-03-db.md',
            path: 'wiki/decision-2026-11-03-db.md',
          },
        ],
      },
      {
        at: '2026-11-03T09:00:00Z',
        skill: 'sync',
        source: '',
        pages: [
          {
            label: '`Database choice`',
            path: 'wiki/decision-2026-11-03-db.md',
          },
          {
            label: 'wiki/digests/2026-w45.md',
            path: 'wiki/digests/2026-w45.md',
          },
          { label: 'nowhere', path: null },
        ],
      },
    ]);
    expect(recentEntries(log, rows, 1)).toHaveLength(1);
    expect(matchPage('2026-W45', rows)).toBe('wiki/digests/2026-w45.md');
    expect(matchPage('', rows)).toBeNull();
  });

  it('formats days, source chips and folders', () => {
    expect(shortDay('2026-11-04')).toMatch(/4/);
    expect(shortDay('2026-11-04T10:00:00Z')).toMatch(/4/);
    expect(shortDay('yesterday')).toBe('yesterday');
    expect(shortDay(null)).toBe('');
    expect(sourceLabel('sources/2026-11-04-acme-deck.md')).toBe('acme-deck');
    expect(sourceLabel('sources/wiki/Page.md')).toBe('Page');
    expect(folderOf('wiki/digests/2026-w45.md')).toEqual(['digests']);
    expect(folderOf('wiki/account.md')).toEqual([]);
  });
});

describe('after review', () => {
  it('cleans a trailing period and a markdown link in a pages entry, and compares instants', () => {
    const log =
      '- 2026-11-04T10:00:00Z capture x → pages: account., [Database](wiki/decision-2026-11-03-db.md); takeaway: x\n';
    expect(recentEntries(log, rows)[0].pages).toEqual([
      { label: 'account', path: 'wiki/account.md' },
      { label: 'Database', path: 'wiki/decision-2026-11-03-db.md' },
    ]);
    expect(
      isAfter('2026-11-04T11:30:00+01:00', '2026-11-04T11:00:00.000Z'),
    ).toBe(false);
    expect(
      isAfter('2026-11-04T12:30:00+01:00', '2026-11-04T11:00:00.000Z'),
    ).toBe(true);
    expect(isAfter('later', 'earlier')).toBe(true);
  });
});

describe('pagesChangedBy', () => {
  const log = [
    '- 2026-11-05T09:30:00Z /capture sources/2026-11-05-deck.md → pages: decision-2026-11-03-db; takeaway: later',
    '- 2026-11-05T08:40:00Z /capture sources/2026-11-05-deck.md → pages: a, account; takeaway: x',
    '- 2026-11-05T08:00:00Z /lint → pages: week 45',
  ].join('\n');
  const job = (over: Partial<BrainJob>): BrainJob => ({
    id: 'j',
    brainId: 'b',
    kind: 'capture',
    source: 'sources/2026-11-05-deck.md',
    status: 'done',
    startedAt: '2026-11-05T08:39:00Z',
    endedAt: '2026-11-05T08:41:00Z',
    sessionId: null,
    result: null,
    error: null,
    background: false,
    agent: 'claude',
    model: null,
    ...over,
  });

  it('keeps the source of a log entry', () => {
    const l =
      '- 2026-11-05T08:40:00Z /capture sources/2026-11-05-deck.md → pages: a, b; takeaway: x';
    expect(recentEntries(l, rows)[0].source).toBe('sources/2026-11-05-deck.md');
  });

  it('gives the pages of the entry written by that job, not a later one', () => {
    expect(pagesChangedBy(job({}), log, rows)).toEqual([
      { label: 'a', path: null },
      { label: 'account', path: 'wiki/account.md' },
    ]);
  });

  it('does not filter by time while the job has no end', () => {
    expect(pagesChangedBy(job({ endedAt: null }), log, rows)[0].label).toBe(
      'decision-2026-11-03-db',
    );
  });

  it('gives nothing for a failed job, a lint job, or an unnamed source', () => {
    expect(pagesChangedBy(job({ status: 'failed' }), log, rows)).toEqual([]);
    expect(pagesChangedBy(job({ kind: 'lint' }), log, rows)).toEqual([]);
    expect(
      pagesChangedBy(job({ source: 'sources/other.md' }), log, rows),
    ).toEqual([]);
    expect(pagesChangedBy(job({ source: null }), log, rows)).toEqual([]);
  });
});
