import path from 'node:path';
import { z } from 'zod';
import {
  DreamJournalEntrySchema,
  DreamRepoStateSchema,
  DreamSwitchedOffSchema,
  type DreamJournalEntry,
  type DreamOpened,
  type DreamProposal,
  type DreamRejection,
  type DreamRepoState,
  type DreamResult,
  type DreamSighting,
  type DreamSwitchedOff,
  endAsk,
} from '../../shared/dreams';
import { JsonFileStore } from '../usage/JsonFileStore';

const SIGHTING_DAYS = 90;
const JOURNAL_KEEP = 100;
/** Rejections kept per repo, the newest; the prompt gets fewer (`material.ts`). */
const REJECTIONS_KEEP = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const FileSchema = z.object({
  version: z.literal(1),
  repos: z.record(z.string(), DreamRepoStateSchema),
  /** Newest first. */
  journal: z.array(DreamJournalEntrySchema),
  /**
   * The one record of before dreams were per project; moved to `switchedOffBy` at the first start that knows the
   * repos (`adoptLegacySwitchedOff`), null from then on.
   */
  switchedOff: DreamSwitchedOffSchema.nullable().default(null),
  /**
   * By connection id: why the project's dreaming switched itself off (a call answered by another model); gone once
   * the project is switched on again.
   */
  switchedOffBy: z.record(z.string(), DreamSwitchedOffSchema).default({}),
});
type DreamFile = z.infer<typeof FileSchema>;

const emptyFile = (): DreamFile => ({
  version: 1,
  repos: {},
  journal: [],
  switchedOff: null,
  switchedOffBy: {},
});
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
  opened: null,
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

  /**
   * A corrupt file is backed up and loads as empty. Sightings past 90 days are dropped as it loads (written with the
   * next change), so a repo that stopped dreaming does not keep them.
   */
  async load(): Promise<{ recovered: boolean; backup?: string }> {
    const loaded = await this.store.load();
    const cutoff = this.now() - SIGHTING_DAYS * DAY_MS;
    for (const r of Object.values(this.store.value.repos))
      r.sightings = r.sightings.filter((x) => Date.parse(x.at) >= cutoff);
    return loaded;
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

  /** The project's switch-off record. The old record counts for every project until it is adopted. */
  switchedOff(project: string): DreamSwitchedOff | null {
    const f = this.store.value;
    return structuredClone(f.switchedOffBy[project] ?? f.switchedOff);
  }

  /** The projects that switched themselves off. */
  switchedOffProjects(): string[] {
    return Object.keys(this.store.value.switchedOffBy);
  }

  setSwitchedOff(
    project: string,
    value: DreamSwitchedOff | null,
  ): Promise<void> {
    return this.write((f) => {
      if (value === null) delete f.switchedOffBy[project];
      else f.switchedOffBy[project] = value;
    });
  }

  /**
   * Moves the old single record to the projects it belongs to (`projectsOf` names them; a project with a record of
   * its own keeps that) and clears it, in one write. Nothing is written without an old record.
   */
  adoptLegacySwitchedOff(
    projectsOf: (record: DreamSwitchedOff) => string[],
  ): Promise<void> {
    const old = this.store.value.switchedOff;
    if (old === null) return Promise.resolve();
    return this.write((f) => {
      for (const p of projectsOf(old)) f.switchedOffBy[p] ??= old;
      f.switchedOff = null;
    });
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

  /**
   * Changes the open result in place (an ask about a proposal: its start, its end, its undo), in one write. Nothing
   * when the open result is not `dreamId`'s: it closed meanwhile.
   */
  updateResult(
    repoId: string,
    dreamId: string,
    mutate: (result: DreamResult) => void,
  ): Promise<void> {
    return this.change(repoId, (r) => {
      if (r.result?.id === dreamId) mutate(r.result);
    });
  }

  /**
   * An ask that was being worked on when Shellie closed (`result.adjusting` left in the file) is marked as failed
   * with `reason`, so the page offers it again. At the start, after `load`; nothing is written when none was left.
   */
  async clearLeftAsks(reason: string): Promise<void> {
    const left = Object.values(this.store.value.repos).some(
      (r) => r.result?.adjusting,
    );
    if (!left) return;
    await this.write((f) => {
      for (const r of Object.values(f.repos)) {
        const a = r.result?.adjusting;
        if (!r.result || !a) continue;
        endAsk(r.result, a, {
          outcome: 'failed',
          at: new Date().toISOString(),
          reason,
        });
      }
    });
  }

  /** Open as task: the result goes and its branch is remembered, in one write. */
  openedAsTask(repoId: string, opened: DreamOpened): Promise<void> {
    return this.change(repoId, (r) => {
      r.result = null;
      r.opened = opened;
    });
  }

  setOpened(repoId: string, opened: DreamOpened | null): Promise<void> {
    return this.change(repoId, (r) => {
      r.opened = opened;
    });
  }

  /**
   * The task of an opened result was made: the journal entry names it and the record is cleared, in one write.
   * Nothing for another dream's id.
   */
  taskMade(repoId: string, dreamId: string, taskName: string): Promise<void> {
    return this.write((f) => {
      const r = f.repos[repoId];
      if (!r?.opened || r.opened.dreamId !== dreamId) return;
      r.opened = null;
      const e = f.journal.find(
        (x) => x.repoId === repoId && x.dreamId === dreamId,
      );
      if (e?.closed) e.closed = { ...e.closed, taskName };
    });
  }

  /** The repo ids that have stored state. */
  repoIds(): string[] {
    return Object.keys(this.store.value.repos);
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
      r.rejections = [...r.rejections, ...rejected].slice(-REJECTIONS_KEEP);
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

  /** Dream ids are per repo (`<date>-<n>`): two repos dreaming on one day share one. */
  closeJournal(
    repoId: string,
    dreamId: string,
    closed: NonNullable<DreamJournalEntry['closed']>,
  ): Promise<void> {
    return this.write((f) => {
      const e = f.journal.find(
        (x) => x.repoId === repoId && x.dreamId === dreamId,
      );
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
