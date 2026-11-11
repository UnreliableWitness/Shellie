import { describe, expect, it } from 'vitest';
import {
  brainReadingList,
  entryKey,
  progressLine,
  readsForWork,
  type ReadingRead,
} from './reading';

const read = (over: Partial<ReadingRead>): ReadingRead => ({
  path: 'reads/a.md',
  title: 'A',
  summary: 's',
  chapter: null,
  topic: null,
  written: '2026-11-09',
  minutes: 10,
  hash: 'h1',
  stale: [],
  ...over,
});
const mark = (hash: string, isRead = true) => ({
  hash,
  at: '2026-11-10T08:00:00.000Z',
  read: isRead,
});

describe('progressLine', () => {
  it('says how many are read and how long the rest takes', () => {
    expect(progressLine({ total: 31, done: 9, minutesLeft: 110 })).toBe(
      '9 of 31 read · about 1 h 50 min left',
    );
    expect(progressLine({ total: 3, done: 1, minutesLeft: 120 })).toBe(
      '1 of 3 read · about 2 h left',
    );
    expect(progressLine({ total: 3, done: 0, minutesLeft: 25 })).toBe(
      '0 of 3 read · about 25 min left',
    );
  });

  it('says when all is read, and nothing without long reads', () => {
    expect(progressLine({ total: 4, done: 4, minutesLeft: 0 })).toBe(
      'All 4 read',
    );
    expect(progressLine({ total: 0, done: 0, minutesLeft: 0 })).toBe('');
  });
});

describe('readsForWork', () => {
  const work = [{ id: 412, title: 'Return flow' }];
  const brain = {
    reads: [
      read({ path: 'reads/returns.md', work }),
      read({ path: 'reads/orders.md', work: [{ id: 7, title: 'Orders' }] }),
      read({ path: 'reads/plain.md' }),
    ],
  };

  it('gives the unread long reads that bear on the work item', () => {
    expect(readsForWork(brain, {}, '412').map((r) => r.path)).toEqual([
      'reads/returns.md',
    ]);
    expect(readsForWork(brain, {}, '9')).toEqual([]);
    expect(readsForWork(brain, {}, 'AB-1')).toEqual([]);
  });

  it('leaves out one read as it is now, and keeps one that changed since or was marked unread', () => {
    expect(
      readsForWork(brain, { 'reads/returns.md': mark('h1') }, '412'),
    ).toEqual([]);
    expect(
      readsForWork(brain, { 'reads/returns.md': mark('old') }, '412'),
    ).toHaveLength(1);
    expect(
      readsForWork(brain, { 'reads/returns.md': mark('h1', false) }, '412'),
    ).toHaveLength(1);
  });
});

describe('entryKey', () => {
  it('is another key once the text changed, and per brain', () => {
    const list = (hash: string) =>
      brainReadingList(
        {
          chapters: ['One'],
          reads: [read({ chapter: 'One', hash })],
          letters: [],
        },
        {},
      ).foundations[0];
    expect(entryKey('b1', list('h1'))).toBe(entryKey('b1', list('h1')));
    expect(entryKey('b1', list('h2'))).not.toBe(entryKey('b1', list('h1')));
    expect(entryKey('b2', list('h1'))).not.toBe(entryKey('b1', list('h1')));
  });
});
