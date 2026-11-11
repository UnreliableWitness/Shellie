import { entryPath, upNext } from '../shared/reader';
import {
  brainReadingList,
  entryKey,
  type BrainReadingList,
  type ReadingBrain,
  type ReadingEntry,
  type ReadingUpNext,
  type WorkRef,
} from '../shared/reading';

/** A brain's reading list as the nudges show it: the whole list and the handful that is up next. */
export type BrainReading = {
  brain: ReadingBrain;
  list: BrainReadingList;
  next: ReadingUpNext[];
};

export function readingOf(brain: ReadingBrain): BrainReading {
  const list = brainReadingList(brain, brain.marks);
  return { brain, list, next: upNext(list) };
}

/**
 * Whether the list holds an event: a long read for the reader's work, or a change in something they read. Unread
 * foundations are no event: they are the pile.
 */
export const hasEvent = (r: Pick<BrainReading, 'list'>) =>
  r.list.work.length + r.list.changed.length > 0;

/** What the notice says when a brain's build brought something to read. */
export type ReadingNudge = {
  brainId: string;
  path: string;
  title: string;
  minutes: number;
  piece: 'read' | 'letter';
  /** changed: something the reader read no longer holds; work: a long read was written that bears on their work. */
  kind: 'changed' | 'work';
  /** The long read a letter is about. */
  about?: string;
  /** The work item a newly written long read bears on. */
  work?: WorkRef;
  /** How many more came with it. */
  more: number;
};

const nudgeOf = (
  brainId: string,
  e: ReadingEntry,
  kind: ReadingNudge['kind'],
): Omit<ReadingNudge, 'more'> =>
  e.kind === 'letter'
    ? {
        brainId,
        path: e.letter.path,
        title: e.letter.title,
        minutes: e.letter.minutes,
        piece: 'letter',
        kind,
        about: e.about,
      }
    : {
        brainId,
        path: e.read.path,
        title: e.read.title,
        minutes: e.read.minutes,
        piece: 'read',
        kind,
        ...(kind === 'work' && e.read.work?.[0]
          ? { work: e.read.work[0] }
          : {}),
      };

/**
 * What is new to read since the last look, as one nudge: a change in something read (its letter, or the long read
 * itself), or a long read that was not there before and bears on the reader's work. `seen` is what earlier looks
 * held (null at the first: what is there when Shellie starts is no news); each text is news once.
 */
export function freshNudge(
  seen: ReadonlySet<string> | null,
  reading: ReadingBrain[],
): { seen: Set<string>; nudge: ReadingNudge | null } {
  const next = new Set(seen ?? []);
  const fresh: Omit<ReadingNudge, 'more'>[] = [];
  for (const brain of reading) {
    const list = brainReadingList(brain, brain.marks);
    for (const e of list.changed) {
      const key = `c\n${entryKey(brain.brainId, e)}`;
      if (seen && !seen.has(key))
        fresh.push(nudgeOf(brain.brainId, e, 'changed'));
      next.add(key);
    }
    const forWork = new Map(list.work.map((e) => [entryPath(e), e]));
    for (const read of brain.reads) {
      const key = `r\n${brain.brainId}\n${read.path}`;
      const e = forWork.get(read.path);
      if (seen && !seen.has(key) && e)
        fresh.push(nudgeOf(brain.brainId, e, 'work'));
      next.add(key);
    }
  }
  return {
    seen: next,
    nudge: fresh.length ? { ...fresh[0], more: fresh.length - 1 } : null,
  };
}

/** The open tasks' work items, as one string: when it changes, the work the list is for has changed. */
export const workKey = (
  tasks: { status: string; workItem: { id: string } | null }[],
) =>
  tasks
    .filter((t) => t.status !== 'done' && t.workItem)
    .map((t) => t.workItem!.id)
    .sort()
    .join(',');
