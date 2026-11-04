import { describe, expect, it } from 'vitest';
import type { BrainPageRow } from '../../../shared/brain';
import {
  folderOf,
  matchPage,
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
