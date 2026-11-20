import path from 'node:path';
import { z } from 'zod';
import {
  DreamJournalEntrySchema,
  DreamRepoStateSchema,
  type DreamJournalEntry,
  type DreamProposal,
  type DreamRejection,
  type DreamRepoState,
  type DreamResult,
  type DreamSighting,
} from '../../shared/dreams';
import { JsonFileStore } from '../usage/JsonFileStore';

const SIGHTING_DAYS = 90;
const JOURNAL_KEEP = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const FileSchema = z.object({
  version: z.literal(1),
  repos: z.record(z.string(), DreamRepoStateSchema),
  /** Newest first. */
  journal: z.array(DreamJournalEntrySchema),
});
type DreamFile = z.infer<typeof FileSchema>;

const emptyFile = (): DreamFile => ({ version: 1, repos: {}, journal: [] });
const emptyRepo = (): DreamRepoState => ({
  covered: {},
  sightings: [],
  rejections: [],
  failures: 0,
  lastFailureAt: null,
  lastFailure: null,
  lastDreamAt: null,
  lastOutcome: null,
  result: null,
});

/** What dreams remember between runs: covered sessions, sightings, rejections, failures, the open result and a journal. */
export class DreamStore {
  private readonly store: JsonFileStore<DreamFile>;
  private readonly listeners = new Set<() => void>();

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new JsonFileStore(
      path.join(dataDir, 'dreams.json'),
      FileSchema,
      emptyFile,
    );
  }

  /** A corrupt file is backed up and loads as empty. */
  load(): Promise<{ recovered: boolean; backup?: string }> {
    return this.store.load();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  repo(repoId: string): DreamRepoState {
    return structuredClone(this.store.value.repos[repoId] ?? emptyRepo());
  }

  journal(): DreamJournalEntry[] {
    return structuredClone(this.store.value.journal);
  }

  markCovered(repoId: string, marks: Record<string, number>): Promise<void> {
    return this.change(repoId, (r) => {
      for (const [task, time] of Object.entries(marks)) {
        r.covered[task] = Math.max(r.covered[task] ?? 0, time);
      }
    });
  }

  setResult(repoId: string, result: DreamResult | null): Promise<void> {
    return this.change(repoId, (r) => {
      r.result = result;
    });
  }

  setDropped(
    repoId: string,
    proposalId: string,
    dropped: boolean,
  ): Promise<void> {
    return this.change(repoId, (r) => {
      const p = r.result?.proposals.find(
        (x: DreamProposal) => x.id === proposalId,
      );
      if (p) p.dropped = dropped;
    });
  }

  addSightings(repoId: string, sightings: DreamSighting[]): Promise<void> {
    const cutoff = this.now() - SIGHTING_DAYS * DAY_MS;
    return this.change(repoId, (r) => {
      r.sightings = [...r.sightings, ...sightings].filter(
        (s) => Date.parse(s.at) >= cutoff,
      );
    });
  }

  reject(repoId: string, proposals: DreamProposal[]): Promise<void> {
    const at = new Date(this.now()).toISOString();
    return this.change(repoId, (r) => {
      const rejected: DreamRejection[] = proposals.map((p) => ({
        at,
        title: p.title,
        why: p.why,
      }));
      r.rejections.push(...rejected);
    });
  }

  failed(repoId: string, reason: string): Promise<void> {
    const at = new Date(this.now()).toISOString();
    return this.change(repoId, (r) => {
      r.failures += 1;
      r.lastFailureAt = at;
      r.lastFailure = reason;
    });
  }

  succeeded(repoId: string, outcome: 'proposed' | 'nothing'): Promise<void> {
    const at = new Date(this.now()).toISOString();
    return this.change(repoId, (r) => {
      r.failures = 0;
      r.lastFailureAt = null;
      r.lastFailure = null;
      r.lastDreamAt = at;
      r.lastOutcome = outcome;
    });
  }

  forgetRepo(repoId: string): Promise<void> {
    return this.write((f) => {
      delete f.repos[repoId];
    });
  }

  log(entry: DreamJournalEntry): Promise<void> {
    return this.write((f) => {
      f.journal = [entry, ...f.journal].slice(0, JOURNAL_KEEP);
    });
  }

  closeJournal(
    dreamId: string,
    closed: NonNullable<DreamJournalEntry['closed']>,
  ): Promise<void> {
    return this.write((f) => {
      const e = f.journal.find((x) => x.dreamId === dreamId);
      if (e) e.closed = closed;
    });
  }

  private change(
    repoId: string,
    mutate: (r: DreamRepoState) => void,
  ): Promise<void> {
    return this.write((f) => {
      const r = f.repos[repoId] ?? emptyRepo();
      mutate(r);
      f.repos[repoId] = r;
    });
  }

  private async write(mutate: (f: DreamFile) => void): Promise<void> {
    await this.store.update((f) => {
      mutate(f);
    });
    for (const fn of this.listeners) fn();
  }
}
