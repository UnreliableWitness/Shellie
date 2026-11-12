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
};

type Files = {
  at: number;
  reads: BrainReadsAndPages;
  rows: BrainPageRow[];
  chapters: string[];
};

/** A brain's files are read again when it changed, and after this long whatever happened. */
const KEEP_MS = 5 * 60_000;

export class ReadingService {
  private readonly files = new Map<string, Promise<Files>>();

  constructor(private readonly d: ReadingDeps) {}

  /** The brain's files changed: read them again at the next ask. */
  brainChanged(brainId: string): void {
    this.files.delete(brainId);
  }

  /** Every brain that is not archived and has a long read or a letter. */
  async list(): Promise<ReadingBrain[]> {
    const items = await this.d.workItems().catch(() => []);
    const out: ReadingBrain[] = [];
    for (const brain of this.d.brains()) {
      if (brain.archived) continue;
      // A brain whose folder cannot be read has no list; the others still do.
      const f = await this.of(brain).catch(() => null);
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
    const now = this.d.now?.() ?? Date.now();
    const kept = this.files.get(brain.id);
    if (kept)
      return kept.then((f) =>
        now - f.at < KEEP_MS ? f : this.read(brain, now),
      );
    return this.read(brain, now);
  }

  private read(brain: Brain, at: number): Promise<Files> {
    const p = Promise.all([
      brainReadsAndPages(brain.path),
      pageRows(brain.path),
    ]).then(([reads, rows]) => ({
      at,
      reads,
      rows,
      chapters: chaptersOf(reads.book),
    }));
    this.files.set(brain.id, p);
    // A failed read is not kept: the next ask tries again.
    p.catch(() => {
      if (this.files.get(brain.id) === p) this.files.delete(brain.id);
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
