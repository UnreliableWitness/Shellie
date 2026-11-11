import {
  parseWriteTarget,
  type BrainJob,
  type BrainLetterRow,
  type BrainReadRow,
  type BrainReads,
} from '../../../shared/brain';
import { isMarkedRead, type ReaderMarkSet } from '../../../shared/reader';
import { local } from '../../localStorage';

export {
  bodyOf,
  splitLetter,
  splitRead,
  type LetterChange,
  type LetterKind,
  type ReadPart,
} from '../../../shared/readParts';

/**
 * What a reader has marked: path → the text's hash, when, and whether it says read ("Mark unread" is kept as a mark
 * too, so it wins over an older one from the phone). In localStorage per brain, and exchanged with main, which
 * keeps them for the phone (`useReadMarks`).
 */
export type ReadMarks = ReaderMarkSet;

const MARKS = (brainId: string) => `shellie.brain.reads.${brainId}`;

export function loadMarks(brainId: string): ReadMarks {
  try {
    const raw = local()?.getItem(MARKS(brainId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    const out: ReadMarks = {};
    for (const [path, m] of Object.entries(parsed as Record<string, unknown>)) {
      const mark = m as { hash?: unknown; at?: unknown; read?: unknown } | null;
      if (typeof mark?.hash === 'string' && typeof mark.at === 'string')
        // A mark from before the phone has no `read`: only read ones were kept then.
        out[path] = { hash: mark.hash, at: mark.at, read: mark.read !== false };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveMarks(brainId: string, marks: ReadMarks) {
  try {
    local()?.setItem(MARKS(brainId), JSON.stringify(marks));
  } catch {
    /* no storage: the marks last as long as the view */
  }
}

/** Read is said of one text: a long read brought up to date is unread again. */
export const isRead = (
  marks: ReadMarks,
  row: Pick<BrainReadRow | BrainLetterRow, 'path' | 'hash'>,
) => isMarkedRead(marks, row);

export const unreadCount = (reads: BrainReads, marks: ReadMarks) =>
  [...reads.reads, ...reads.letters].filter((r) => !isRead(marks, r)).length;

const IN_FLIGHT = new Set<BrainJob['status']>(['queued', 'running', 'paused']);

/** The newest write job for the target (`jobs` come newest first), and whether it is still to run or running. */
export function writeJob(
  jobs: BrainJob[],
  target: string,
): { job: BrainJob; pending: boolean } | null {
  const job = jobs.find((j) => j.kind === 'write' && j.target === target);
  return job ? { job, pending: IN_FLIGHT.has(job.status) } : null;
}

/** The newest letter about the long read, or undefined: `letters` come newest first. */
export const newestLetter = (reads: BrainReads, path: string) =>
  reads.letters.find((l) => l.read === path);

/**
 * The topics asked for that have no long read to show: the newest write of each, when it is still to run, running or
 * failed. Newest first.
 */
export function openTopics(jobs: BrainJob[]): BrainJob[] {
  const seen = new Set<string>();
  return jobs.filter((j) => {
    if (j.kind !== 'write' || !j.target?.startsWith('topic:')) return false;
    if (seen.has(j.target)) return false;
    seen.add(j.target);
    return IN_FLIGHT.has(j.status) || j.status === 'failed';
  });
}

/** What a write job's row says while it waits or runs. */
export const writeStatus = (job: BrainJob): string =>
  job.status === 'running'
    ? 'Writing…'
    : job.status === 'paused'
      ? 'Paused: daily token cap'
      : 'Queued';

/** What a write job is for, as Activity says it: the chapter, the topic, or the long read it brings up to date. */
export function writeLabel(target: string): string {
  const t = parseWriteTarget(target);
  if (!t) return target;
  if ('chapter' in t) return `chapter ${t.chapter}`;
  if ('topic' in t) return t.topic;
  return `update of ${t.update.split('/').pop()}`;
}
