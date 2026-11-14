/**
 * The reading list's data: per brain its long reads and letters, the reader's marks and, per long read, the work in
 * front of the reader it bears on. The renderer orders it (`readingList`, as the phone does); the phone's shelf gets
 * the same work links.
 */
import type { Brain, BrainPageRow } from '../../shared/brain';
import type { ReaderMarkSet } from '../../shared/reader';
import type { ReadingBrain, ReadWork } from '../../shared/reading';
import { chaptersOf } from '../brain/book';
import { pageRows } from '../brain/browse';
import { brainReadsAndPages, type BrainReadsAndPages } from '../brain/reads';
import type { PhoneFiles } from '../reader/build';
import { workFor, type WorkItem } from './work';

/** A work item in front of the reader and where it lives; `id` as the tracker writes it. */
export type ReadingWorkItem = {
  connectionId: string;
  project: string;
  id: string;
  title: string;
  /** Its task's name, when it has one. */
  name?: string;
};

export type ReadingDeps = {
  brains: () => Brain[];
  /** My items in current sprints that are not finished, and the work items of my open tasks. */
  workItems: () => Promise<ReadingWorkItem[]>;
  marks: (brainId: string) => ReaderMarkSet;
  now?: () => number;
  /** How long a list took: the whole of it, the work items, and the brains it had to read (count and time). */
  timing?: (t: ReadingTiming) => void;
};

export type ReadingTiming = {
  ms: number;
  workItemsMs: number;
  coldBrains: number;
  coldMs: number;
};

type Files = {
  reads: BrainReadsAndPages;
  rows: BrainPageRow[];
  chapters: string[];
};

/** A brain's files as read, or being read, from `at` on. */
type Kept = { at: number; files: Promise<Files> };

/** A brain's files are read again when it changed, and after this long whatever happened. */
const KEEP_MS = 5 * 60_000;

export class ReadingService {
  private readonly files = new Map<string, Kept>();

  constructor(private readonly d: ReadingDeps) {}

  /** The brain's files changed: read them again at the next ask. */
  brainChanged(brainId: string): void {
    this.files.delete(brainId);
  }

  /** Every brain that is not archived and has a long read or a letter. */
  async list(): Promise<ReadingBrain[]> {
    const t0 = performance.now();
    let workItemsMs = 0;
    let coldBrains = 0;
    let coldMs = 0;
    const brains = this.d.brains().filter((b) => !b.archived);
    // The work items and every brain are read at the same time: a cold brain does not wait for the one before it.
    const [items, files] = await Promise.all([
      this.d
        .workItems()
        .catch(() => [])
        .finally(() => (workItemsMs = performance.now() - t0)),
      Promise.all(
        brains.map((brain) => {
          const { files, cold } = this.kept(brain);
          if (cold) coldBrains++;
          // A brain whose folder cannot be read has no list; the others still do.
          return files
            .catch(() => null)
            .finally(() => {
              if (cold) coldMs += performance.now() - t0;
            });
        }),
      ),
    ]);
    this.d.timing?.({
      ms: performance.now() - t0,
      workItemsMs,
      coldBrains,
      coldMs,
    });
    const out: ReadingBrain[] = [];
    for (const [i, brain] of brains.entries()) {
      const f = files[i];
      if (!f || !(f.reads.reads.length || f.reads.letters.length)) continue;
      const work = match(brain, items, f);
      out.push({
        brainId: brain.id,
        name: brain.name,
        connectionId: brain.connectionId,
        chapters: f.chapters,
        reads: f.reads.reads.map((r) =>
          work[r.path] ? { ...r, work: work[r.path] } : r,
        ),
        letters: f.reads.letters,
        marks: this.d.marks(brain.id),
      });
    }
    return out;
  }

  /** The work each of the brain's long reads bears on, for the phone's shelf. */
  async work(brain: Brain): Promise<ReadWork> {
    return (await this.forPhone(brain)).work;
  }

  /** What the phone's shelf is built from: the files as read for the list, and the work each long read bears on. */
  async forPhone(brain: Brain): Promise<PhoneFiles & { work: ReadWork }> {
    const [items, f] = await Promise.all([
      this.d.workItems().catch(() => []),
      this.of(brain),
    ]);
    return {
      reads: f.reads.reads,
      letters: f.reads.letters,
      chapters: f.chapters,
      texts: f.reads.texts,
      work: items.length ? match(brain, items, f) : {},
    };
  }

  private of(brain: Brain): Promise<Files> {
    return this.kept(brain).files;
  }

  /** The brain's files, read again when they expired; `cold` when this ask started the read. */
  private kept(brain: Brain): { files: Promise<Files>; cold: boolean } {
    const now = this.d.now?.() ?? Date.now();
    const kept = this.files.get(brain.id);
    // Checked and replaced at once, so callers asking together share one read.
    if (kept && now - kept.at < KEEP_MS)
      return { files: kept.files, cold: false };
    return { files: this.read(brain, now), cold: true };
  }

  private read(brain: Brain, at: number): Promise<Files> {
    const p = Promise.all([
      brainReadsAndPages(brain.path),
      pageRows(brain.path),
    ]).then(([reads, rows]) => ({
      reads,
      rows,
      chapters: chaptersOf(reads.book),
    }));
    const entry = { at, files: p };
    this.files.set(brain.id, entry);
    // A failed read is not kept: the next ask tries again.
    p.catch(() => {
      if (this.files.get(brain.id) === entry) this.files.delete(brain.id);
    });
    return p;
  }
}

function match(brain: Brain, items: ReadingWorkItem[], f: Files): ReadWork {
  const mine: WorkItem[] = [];
  for (const i of items) {
    if (i.connectionId !== brain.connectionId || i.project !== brain.project)
      continue;
    const id = Number(i.id);
    if (Number.isSafeInteger(id))
      mine.push({ id, title: i.title, name: i.name });
  }
  if (!mine.length || !f.reads.reads.length) return {};
  return workFor(mine, f.reads.reads, f.reads.under, f.rows);
}
