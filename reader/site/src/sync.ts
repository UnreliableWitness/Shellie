import {
  itemId,
  itemName,
  kindOf,
  mergeMarks,
  ReaderMarksSchema,
  ReaderPieceSchema,
  ReaderShelfSchema,
  seal,
  unseal,
  type ReaderKeys,
  type ReaderMarkSet,
  type ReaderPiece,
  type ReaderShelf,
} from '../../../src/shared/reader';
import { failureOf, type ReaderApi } from './api';
import type { ItemStore, KeptItem } from './cache';

/**
 * What the phone knows of the server: the shelves it could open, the marks per brain, and the items kept for
 * reading without a connection. Everything is kept as the server has it, sealed; it is opened when it is shown.
 */

export type Library = {
  shelves: ReaderShelf[];
  /** The marks per brain id: the server's merged with what was set here. */
  marks: Record<string, ReaderMarkSet>;
};

export type ReaderState = {
  /** Null until the kept items were opened. */
  library: Library | null;
  syncing: boolean;
  /** The last sync: `offline` no answer, `error` an answer that was no use. */
  problem: 'offline' | 'error' | null;
  /** The server does not know this phone any more. */
  gone: boolean;
};

/** Pieces fetched at a time in the background. The server allows an account 1200 requests a minute. */
const AT_A_TIME = 3;
/** Tries at writing the marks when someone else wrote first. */
const MARK_TRIES = 3;
const NO_MARKS: ReaderMarkSet = {};

export class Reader {
  private state: ReaderState = {
    library: null,
    syncing: false,
    problem: null,
    gone: false,
  };
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  /** Everything that reads or writes the marks goes one after the other. */
  private marksTurn: Promise<unknown> = Promise.resolve();
  private background: Promise<void> = Promise.resolve();
  /** Bumped by every sync and by `close`: a background fetch of an earlier one stops. */
  private round = 0;

  constructor(
    private keys: ReaderKeys,
    private api: ReaderApi,
    private store: ItemStore,
  ) {}

  getState = (): ReaderState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  private set(patch: Partial<ReaderState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Stops what runs in the background (the phone is forgotten, or the page goes). */
  close() {
    this.round++;
    this.listeners.clear();
  }

  /** Resolves when the background fetch of the last sync ended. */
  settled(): Promise<void> {
    return (this.running ?? Promise.resolve()).then(() => this.background);
  }

  /** Shows what is kept on the phone, before the server answered. */
  async open(): Promise<void> {
    try {
      const library = await this.keptLibrary();
      if (!this.state.library) this.set({ library });
    } catch {
      // A store that cannot be read: the sync shows what the server has.
    }
  }

  /** Brings the kept items in line with the server. One at a time: a second call joins the one running. */
  sync(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<void> {
    const round = ++this.round;
    this.set({ syncing: true });
    try {
      const listed = new Map(
        (await this.api.list()).map((item) => [item.id, item.rev]),
      );
      const kept = new Map(
        (await this.store.index()).map((item) => [item.id, item.rev]),
      );
      for (const id of kept.keys()) {
        // Marks that never reached the server are not listed yet; they are sorted out with their shelf below.
        if (listed.has(id) || kindOf(id) === 'k') continue;
        await this.store.delete(id);
        kept.delete(id);
      }
      for (const [id, rev] of listed)
        if (kindOf(id) === 'm' && kept.get(id) !== rev) await this.fetch(id);

      const shelves = await this.keptShelves(listed);
      const marks: Library['marks'] = {};
      const markIds = new Set<string>();
      // Marks that could not be sorted out do not hold the shelves back: the kept ones are shown.
      let trouble: unknown = null;
      for (const shelf of shelves) {
        const id = await this.marksId(shelf.brainId);
        markIds.add(id);
        marks[shelf.brainId] = await this.inTurn(async () => {
          try {
            return await this.syncMarks(id, listed.get(id) ?? null);
          } catch (err) {
            trouble ??= err;
            return this.keptMarks(id);
          }
        });
      }
      for (const id of kept.keys())
        if (kindOf(id) === 'k' && !markIds.has(id)) await this.store.delete(id);

      this.set({ library: { shelves, marks }, problem: null, gone: false });
      if (trouble) this.failed(trouble);
      this.background = this.fetchRest(round, listed, kept);
    } catch (err) {
      this.failed(err);
    } finally {
      this.set({ syncing: false });
    }
  }

  private failed(err: unknown) {
    const kind = failureOf(err);
    if (kind === 'gone') this.set({ gone: true });
    else if (kind === 'offline') this.set({ problem: 'offline' });
    // Over the rate limit, or the marks lost every race: the next sync picks it up, nothing to tell.
    else if (kind !== 'later' && kind !== 'conflict')
      this.set({ problem: 'error' });
  }

  /** Fetches an item and keeps it. Null when the server has no such item (any more). */
  private async fetch(id: string): Promise<KeptItem | null> {
    try {
      const item = { id, ...(await this.api.get(id)) };
      await this.store.put(item);
      return item;
    } catch (err) {
      if (failureOf(err) === 'missing') return null;
      throw err;
    }
  }

  private async opened(item: KeptItem | null): Promise<unknown> {
    return item ? unseal(this.keys, item.id, item.bytes) : null;
  }

  /** The kept shelves that open, in the server's order when it is known, each brain once. */
  private async keptShelves(
    listed?: ReadonlyMap<string, number>,
  ): Promise<ReaderShelf[]> {
    const ids = listed
      ? [...listed.keys()]
      : (await this.store.index()).map((item) => item.id).sort();
    const shelves = new Map<string, ReaderShelf>();
    for (const id of ids) {
      if (kindOf(id) !== 'm') continue;
      const shelf = ReaderShelfSchema.safeParse(
        await this.opened(await this.store.get(id)),
      );
      // One that does not open is not ours, or was made by a later Shellie: left alone.
      if (shelf.success) shelves.set(shelf.data.brainId, shelf.data);
    }
    return [...shelves.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async keptLibrary(): Promise<Library> {
    const shelves = await this.keptShelves();
    const marks: Library['marks'] = {};
    for (const shelf of shelves)
      marks[shelf.brainId] = await this.keptMarks(
        await this.marksId(shelf.brainId),
      );
    return { shelves, marks };
  }

  private marksId(brainId: string): Promise<string> {
    return itemId(this.keys, 'k', itemName(brainId));
  }

  private async marksIn(item: KeptItem | null): Promise<ReaderMarkSet> {
    const marks = ReaderMarksSchema.safeParse(await this.opened(item));
    return marks.success ? marks.data.marks : NO_MARKS;
  }

  private async keptMarks(id: string): Promise<ReaderMarkSet> {
    return this.marksIn(await this.store.get(id));
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.marksTurn.then(work, work);
    this.marksTurn = turn.catch(() => {});
    return turn;
  }

  /** Keeps marks set on this phone, sealed, until the server has them. */
  private async keepToSend(id: string, marks: ReaderMarkSet, rev: number) {
    const bytes = await seal(this.keys, id, { v: 1, marks });
    await this.store.put({ id, rev, bytes, toSend: true });
  }

  /** A brain's marks at a sync: the server's when they changed, merged with what this phone still has to send. */
  private async syncMarks(
    id: string,
    listedRev: number | null,
  ): Promise<ReaderMarkSet> {
    const kept = await this.store.get(id);
    let mine = await this.marksIn(kept);
    const known = kept && kept.rev > 0 ? kept.rev : null;
    if (listedRev === known && !kept?.toSend) return mine;
    if (!kept?.toSend) {
      // Nothing of ours to send: the server's are the marks.
      if (listedRev === null) {
        await this.store.delete(id);
        return NO_MARKS;
      }
      return this.marksIn(await this.fetch(id));
    }
    let rev = known;
    if (listedRev !== known) {
      const theirs = listedRev === null ? null : await this.theirs(id);
      const theirMarks = await this.marksIn(theirs);
      const merged = mergeMarks(theirMarks, mine);
      if (theirs && merged === theirMarks) {
        await this.store.put(theirs);
        return merged;
      }
      rev = theirs?.rev ?? null;
      await this.keepToSend(id, merged, rev ?? 0);
      mine = merged;
    }
    return this.send(id, mine, rev);
  }

  /** The marks as the server has them now, not kept. Null when it has none. */
  private async theirs(id: string): Promise<KeptItem | null> {
    try {
      return { id, ...(await this.api.get(id)) };
    } catch (err) {
      if (failureOf(err) === 'missing') return null;
      throw err;
    }
  }

  /**
   * Writes the marks over revision `rev`. When someone else wrote first: fetch theirs, merge, try again. Marks that
   * could not be sent stay kept as "to send" and the error is thrown.
   */
  private async send(
    id: string,
    marks: ReaderMarkSet,
    rev: number | null,
  ): Promise<ReaderMarkSet> {
    for (let tries = 1; ; tries++) {
      const bytes = await seal(this.keys, id, { v: 1, marks });
      try {
        const next = await this.api.put(id, bytes, rev);
        await this.store.put({ id, rev: next, bytes });
        return marks;
      } catch (err) {
        if (failureOf(err) !== 'conflict' || tries >= MARK_TRIES) throw err;
      }
      // Removed since, when there are none: written as new at the next try.
      const theirs = await this.theirs(id);
      const theirMarks = await this.marksIn(theirs);
      const merged = mergeMarks(theirMarks, marks);
      if (theirs && merged === theirMarks) {
        // They already have everything this phone had.
        await this.store.put(theirs);
        return merged;
      }
      marks = merged;
      rev = theirs?.rev ?? null;
      await this.keepToSend(id, marks, rev ?? 0);
    }
  }

  /**
   * Marks a piece read or unread: shown and kept at once, then sent. Without a connection it stays kept and goes
   * with the next sync.
   */
  async mark(
    brainId: string,
    piece: { path: string; hash: string },
    read: boolean,
  ): Promise<void> {
    const id = await this.marksId(brainId);
    await this.inTurn(async () => {
      const kept = await this.store.get(id);
      const before = await this.marksIn(kept);
      // A tap is the newest word, also when the other device's clock runs ahead of this one's.
      const last = Date.parse(before[piece.path]?.at ?? '');
      const at = new Date(
        Math.max(Date.now(), Number.isNaN(last) ? 0 : last + 1),
      ).toISOString();
      const marks = mergeMarks(before, {
        [piece.path]: { hash: piece.hash, at, read },
      });
      const rev = kept && kept.rev > 0 ? kept.rev : null;
      try {
        await this.keepToSend(id, marks, rev ?? 0);
      } catch {
        // A store that cannot be written: the mark is sent, and shown for as long as the page is open.
      }
      this.setMarks(brainId, marks);
      try {
        this.setMarks(brainId, await this.send(id, marks, rev));
        if (this.state.problem === 'offline') this.set({ problem: null });
      } catch (err) {
        this.failed(err);
      }
    });
  }

  private setMarks(brainId: string, marks: ReaderMarkSet) {
    const library = this.state.library ?? { shelves: [], marks: {} };
    if (library.marks[brainId] === marks) return;
    this.set({
      library: { ...library, marks: { ...library.marks, [brainId]: marks } },
    });
  }

  /**
   * A long read, a letter or a cited page: the kept one, else fetched now. Null when it cannot be opened or the
   * server has it no more; throws an `ApiError` when it has to be fetched and cannot be.
   */
  async piece(id: string): Promise<ReaderPiece | null> {
    let item: KeptItem | null = null;
    try {
      item = await this.store.get(id);
    } catch {
      // A store that cannot be read: fetched.
    }
    try {
      item ??= await this.fetch(id);
    } catch (err) {
      if (failureOf(err) === 'gone') this.set({ gone: true });
      throw err;
    }
    const piece = ReaderPieceSchema.safeParse(await this.opened(item));
    return piece.success ? piece.data : null;
  }

  /** After a sync: every long read, letter and cited page that is new or changed, a few at a time. */
  private async fetchRest(
    round: number,
    listed: ReadonlyMap<string, number>,
    kept: ReadonlyMap<string, number>,
  ): Promise<void> {
    const wanted = [...listed]
      .filter(([id, rev]) => 'rp'.includes(kindOf(id)) && kept.get(id) !== rev)
      .map(([id]) => id);
    let stopped = false;
    const worker = async () => {
      for (;;) {
        const id = wanted.shift();
        if (id === undefined || stopped || round !== this.round) return;
        try {
          await this.fetch(id);
        } catch (err) {
          stopped = true;
          // The pieces are for later: only a lost connection or account is worth telling.
          const kind = failureOf(err);
          if (round === this.round && (kind === 'gone' || kind === 'offline'))
            this.failed(err);
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: AT_A_TIME }, worker));
  }
}
