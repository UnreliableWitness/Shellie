import type { BrainLetterRow, BrainReadRow } from './brain';
import {
  entryPath,
  readingList,
  type ListEntry,
  type ReaderMarkSet,
  type ReadingList,
  type UpNext,
} from './reader';

/** A work item in front of the reader: in their sprint, or of a task they have open. */
export type WorkRef = { id: number; title: string };
/** Long read path → the work it bears on. Only long reads with some are listed. */
export type ReadWork = Record<string, WorkRef[]>;

export type ReadingRead = BrainReadRow & { work?: WorkRef[] };
/** One brain's long reads and letters, with what the list needs to order them and to say how far the reader is. */
export type ReadingBrain = {
  brainId: string;
  name: string;
  connectionId: string;
  /** The book's chapters that have pages, in order. */
  chapters: string[];
  reads: ReadingRead[];
  letters: BrainLetterRow[];
  /** The reader's marks as main keeps them. */
  marks: ReaderMarkSet;
};

export type ReadingEntry = ListEntry<ReadingRead, BrainLetterRow>;
export type BrainReadingList = ReadingList<ReadingRead, BrainLetterRow>;
export type ReadingUpNext = UpNext<ReadingRead, BrainLetterRow>;

export const brainReadingList = (
  b: Pick<ReadingBrain, 'chapters' | 'reads' | 'letters'>,
  marks: ReaderMarkSet,
): BrainReadingList => readingList(b, marks);

/** "9 of 31 read · about 1 h 50 min left", or "All 31 read". */
export function progressLine(
  list: Pick<ReadingList, 'total' | 'done' | 'minutesLeft'>,
): string {
  if (!list.total) return '';
  if (list.minutesLeft <= 0) return `All ${list.total} read`;
  const h = Math.floor(list.minutesLeft / 60);
  const m = list.minutesLeft % 60;
  const left = h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
  return `${list.done} of ${list.total} read · about ${left} left`;
}

/** The text an entry is: a mark, and a nudge, are for this one. */
export const entryKey = (brainId: string, e: ReadingEntry) =>
  `${brainId}\n${entryPath(e)}\n${e.kind === 'letter' ? e.letter.hash : e.read.hash}`;

/** The long reads of a brain that bear on the work item and are not read as they are now: unread, or changed since. */
export function readsForWork(
  brain: Pick<ReadingBrain, 'reads'>,
  marks: ReaderMarkSet,
  workItemId: string,
): ReadingRead[] {
  const id = Number(workItemId);
  return brain.reads.filter(
    (r) =>
      r.work?.some((w) => w.id === id) &&
      !(marks[r.path]?.read === true && marks[r.path].hash === r.hash),
  );
}
