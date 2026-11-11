import type { BrainLetterRow } from '../../shared/brain';
import type { ReadingBrain, ReadingRead } from '../../shared/reading';

export const readingRead = (over: Partial<ReadingRead> = {}): ReadingRead => ({
  path: 'reads/returns.md',
  title: 'How a return becomes a credit',
  summary: 'From the parcel back to the credit note.',
  chapter: null,
  topic: null,
  written: '2026-11-09',
  minutes: 9,
  hash: 'h1',
  stale: [],
  ...over,
});

export const readingLetter = (
  over: Partial<BrainLetterRow> = {},
): BrainLetterRow => ({
  path: 'reads/letters/2026-11-11-returns.md',
  title: 'The credit check moved',
  read: 'reads/returns.md',
  written: '2026-11-11',
  minutes: 2,
  hash: 'l1',
  ...over,
});

export const readingBrain = (
  over: Partial<ReadingBrain> = {},
): ReadingBrain => ({
  brainId: 'b1',
  name: 'Acme',
  connectionId: 'c1',
  chapters: ['Orders', 'Returns'],
  reads: [],
  letters: [],
  marks: {},
  ...over,
});

/** A mark as the reader makes one: read, at a moment before the fixtures' letters. */
export const readMark = (hash: string, at = '2026-11-10T08:00:00.000Z') => ({
  hash,
  at,
  read: true,
});
