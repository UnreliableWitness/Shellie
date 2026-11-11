import type { Brain } from '../../shared/brain';
import {
  b64url,
  bearer,
  itemId,
  itemName,
  kindOf,
  mergeMarks,
  newSecret,
  readerKeys,
  readerLink,
  ReaderMarksSchema,
  readerOrigin,
  seal,
  unseal,
  type ReaderKeys,
  type ReaderMarkSet,
  type ReaderShelf,
  type ReaderStatus,
} from '../../shared/reader';
import type { ReadWork } from '../../shared/reading';
import type { TelemetryProps } from '../../shared/telemetry';
import { errorMessage } from '../../shared/errors';
import { buildBrain } from './build';
import {
  deleteItem,
  getItem,
  hello,
  listItems,
  putItem,
  ReaderError,
  readerErrorKind,
  removeAccount,
  signUp,
  type ReaderConn,
  type ReaderErrorKind,
} from './client';
import type { ReaderStore } from './ReaderStore';

/** After a brain's files change: long enough for a job's last writes and its commit. */
export const CHANGE_DELAY_MS = 20_000;
/** After the launch, so the push never weighs on it. */
export const LAUNCH_DELAY_MS = 30_000;
export const TICK_MS = 15 * 60_000;
/** After the server asked to slow down (it counts per minute). */
const BUSY_DELAY_MS = 70_000;
/** Under the server's limit for one item, with room for the seal. */
const MAX_ITEM_BYTES = 1_000_000;
const MARK_TRIES = 3;

const CONNECT_ERRORS: Record<ReaderErrorKind, string> = {
  network:
    'The reader server could not be reached. Check the address and your network.',
  invite: 'The reader server refused the invitation code.',
  auth: 'The reader server did not accept the new connection.',
  conflict: 'The reader server did not accept the new connection.',
  busy: 'The reader server has had too many attempts. Wait a minute and try again.',
  full: 'The reader server did not accept the new connection.',
  server: 'The reader server answered with an error. Try again later.',
  rejected: 'This address did not answer like a reader server.',
};

export type ReaderSyncDeps = {
  store: ReaderStore;
  brains: () => Brain[];
  /** The connection, the last push or `refused` changed. */
  status: (s: ReaderStatus) => void;
  /** A brain's marks changed from the phone's side. */
  marksChanged: (brainId: string) => void;
  telemetry: (event: string, props?: TelemetryProps) => void;
  /** Long read path → the work in front of the reader it bears on (the reading list's); none without it. */
  work?: (brain: Brain) => Promise<ReadWork>;
  fetch?: typeof fetch;
  now?: () => Date;
};

/**
 * Keeps the phone reading site's server the same as the brains that have "Send to my phone" on: everything sealed
 * with keys made from the connection's secret, so the server holds nothing it can read. One push at a time, in the
 * background; a failure is kept for Settings and tried again later.
 */
export class ReaderSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private keysFor: { secret: string; keys: ReaderKeys } | null = null;
  /** The kind of the last failure sent as telemetry: the same one is not sent every tick. */
  private reported: string | null = null;

  constructor(private readonly d: ReaderSyncDeps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  private get fetch(): typeof fetch {
    return this.d.fetch ?? fetch;
  }

  status(): ReaderStatus {
    return this.d.store.status();
  }

  private changed(): ReaderStatus {
    const st = this.status();
    this.d.status(st);
    return st;
  }

  private async keys(secret: Uint8Array): Promise<ReaderKeys> {
    const name = b64url(secret);
    if (this.keysFor?.secret !== name)
      this.keysFor = { secret: name, keys: await readerKeys(secret) };
    return this.keysFor.keys;
  }

  /** The saved connection as the client calls it, with its keys; null without one. */
  private async conn(): Promise<{ c: ReaderConn; keys: ReaderKeys } | null> {
    const saved = this.d.store.get();
    if (!saved) return null;
    const keys = await this.keys(saved.secret);
    return { c: { url: saved.url, bearer: bearer(keys) }, keys };
  }

  private sends(b: Brain): boolean {
    return !b.archived && b.options.sendToPhone;
  }

  /** Makes a secret and an account from it on the server at `address`, and saves the connection when it answers. */
  async connect(address: string, invite: string): Promise<ReaderStatus> {
    const failed = (error: string): ReaderStatus => ({
      ...this.status(),
      error,
    });
    if (this.d.store.get()) return failed('Disconnect the phone first.');
    const url = readerOrigin(address);
    // The token must never go to plain http elsewhere.
    if (!url) return failed('Use an https:// address.');
    const code = invite.trim();
    if (!code) return failed('Enter the invitation code.');
    const secret = newSecret();
    const keys = await this.keys(secret);
    const c = { url, bearer: bearer(keys) };
    try {
      await signUp(
        url,
        { reader: keys.reader, token: keys.token, invite: code },
        this.fetch,
      );
      await hello(c, this.fetch);
    } catch (err) {
      const kind = readerErrorKind(err);
      this.d.telemetry('reader.connect', { ok: false, kind });
      return failed(CONNECT_ERRORS[kind]);
    }
    try {
      await this.d.store.set({ url, secret });
    } catch (err) {
      // An account nobody holds the secret of: it must not stay behind.
      await removeAccount(c, this.fetch).catch(() => undefined);
      return failed(errorMessage(err));
    }
    this.reported = null;
    this.d.telemetry('reader.connect', { ok: true });
    this.schedule(1000);
    return this.changed();
  }

  /**
   * Removes the account, with everything on the server, and forgets the connection. When the server cannot be
   * reached the connection stays, unless `anyway`: what is on the server then stays there, unreadable.
   */
  async disconnect(anyway: boolean): Promise<ReaderStatus> {
    const conn = await this.conn();
    let removed = false;
    if (conn)
      try {
        await removeAccount(conn.c, this.fetch);
        removed = true;
      } catch (err) {
        // An account the server no longer knows is gone already.
        if (readerErrorKind(err) !== 'auth' && !anyway)
          return {
            ...this.status(),
            error:
              'The reader server could not be reached, so what is on it was not removed. Try again, or disconnect anyway.',
          };
      }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.d.store.clear();
    this.keysFor = null;
    this.d.telemetry('reader.disconnect', { removed });
    return this.changed();
  }

  /** What the QR code holds; null without a connection. Whoever has it can read everything that is sent. */
  link(): string | null {
    const saved = this.d.store.get();
    return saved ? readerLink(saved.url, saved.secret) : null;
  }

  /** Pushes at launch and on every tick; returns the stop function. */
  start(tick = TICK_MS): () => void {
    this.schedule(LAUNCH_DELAY_MS);
    const every = setInterval(() => void this.push(), tick);
    every.unref?.();
    return () => {
      clearInterval(every);
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    };
  }

  /** A brain's files, options or existence changed. */
  brainChanged(): void {
    if (this.d.store.get() && !this.d.store.refused)
      this.schedule(CHANGE_DELAY_MS);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.push();
    }, ms);
    this.timer.unref?.();
  }

  /** "Send now": a push the answer waits for. */
  async sendNow(): Promise<ReaderStatus> {
    await this.push();
    return this.status();
  }

  /** Brings the server up to date. Never rejects; one asked for during another runs after it. */
  push(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pushOnce();
        } while (this.again);
      } catch (err) {
        console.error('[reader] push', errorMessage(err));
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async pushOnce(): Promise<void> {
    const { store } = this.d;
    const brains = this.d.brains();
    for (const id of store.knownBrains())
      if (!brains.some((b) => b.id === id)) await store.dropMarks(id);
    const conn = await this.conn();
    if (!conn || store.refused) return;
    const wanted = brains.filter((b) => this.sends(b));
    // Nothing to send and nothing of ours on the server: not a single request.
    if (!wanted.length && !store.sentBrains().length) return;
    const { c, keys } = conn;
    let sent = 0;
    let removed = 0;
    let pieces = 0;
    try {
      const listed = await listItems(c, this.fetch);
      const keep = new Set<string>();
      for (const brain of wanted) {
        // The work links are an extra: a push goes without them when they cannot be worked out.
        const work = (await this.d.work?.(brain).catch(() => undefined)) ?? {};
        const built = await buildBrain(brain, keys, work);
        const before = store.sent(brain.id);
        // What is known to be on the server, kept as the push goes: a push that stops halfway is picked up there.
        const after: Record<string, string> = {};
        for (const [id, hash] of Object.entries(before))
          if (listed.has(id)) after[id] = hash;
        const put = async (id: string, value: unknown, hash: string) => {
          keep.add(id);
          if (after[id] === hash) return;
          const bytes = await seal(keys, id, value);
          // Left out: the phone says it was not sent.
          if (bytes.length > MAX_ITEM_BYTES) return;
          await putItem(c, id, bytes, undefined, this.fetch);
          after[id] = hash;
          sent++;
        };
        try {
          for (const item of built.pieces)
            await put(item.id, item.value, item.hash);
          keep.add(await this.marksId(keys, brain.id));
          await this.syncMarks(c, keys, brain.id, true);
          // Last: a shelf never lists a piece the server does not have yet.
          const shelf: ReaderShelf = {
            ...built.shelf,
            sentAt: this.now().toISOString(),
          };
          await put(built.shelfId, shelf, built.shelfHash);
        } catch (err) {
          await store.setSent(brain.id, after);
          throw err;
        }
        for (const id of Object.keys(after))
          if (!keep.has(id)) delete after[id];
        await store.setSent(brain.id, after);
        pieces += built.pieces.filter((p) => kindOf(p.id) === 'r').length;
      }
      for (const id of listed.keys()) {
        if (keep.has(id)) continue;
        await deleteItem(c, id, this.fetch);
        removed++;
      }
      for (const id of store.sentBrains())
        if (!wanted.some((b) => b.id === id)) await store.setSent(id, null);
    } catch (err) {
      await this.failed(err, sent, removed);
      return;
    }
    await store.setLastPush({
      at: this.now().toISOString(),
      ok: true,
      pieces,
      error: null,
    });
    this.reported = null;
    if (sent + removed > 0)
      this.d.telemetry('reader.push', {
        ok: true,
        sent,
        removed,
        brains: wanted.length,
      });
    this.changed();
  }

  private async failed(
    err: unknown,
    sent: number,
    removed: number,
  ): Promise<void> {
    const { store } = this.d;
    // Disconnected while the push ran: there is nothing left to say it about.
    if (!store.get()) return;
    // Anything that is not the server's is this machine's: a brain's files could not be read.
    const kind = err instanceof ReaderError ? err.kind : 'local';
    if (kind === 'local') console.error('[reader] push', errorMessage(err));
    if (kind === 'auth') await store.setRefused(true);
    if (kind === 'busy') this.schedule(BUSY_DELAY_MS);
    await store.setLastPush({
      at: this.now().toISOString(),
      ok: false,
      pieces: store.status().lastPush?.pieces ?? 0,
      error:
        err instanceof ReaderError
          ? err.message
          : 'A brain could not be read for the phone',
    });
    if (this.reported !== kind) {
      this.reported = kind;
      this.d.telemetry('reader.push', { ok: false, kind, sent, removed });
    }
    this.changed();
  }

  private marksId(keys: ReaderKeys, brainId: string): Promise<string> {
    return itemId(keys, 'k', itemName(brainId));
  }

  /**
   * One brain's marks, here and on the server, made the same: per path the newer wins. The phone writes the same
   * item, so a write names the revision it read and starts over when the phone was first.
   */
  private async syncMarks(
    c: ReaderConn,
    keys: ReaderKeys,
    brainId: string,
    /** Whether to tell the Read view about marks from the phone (not when it is the one asking). */
    tell: boolean,
  ): Promise<void> {
    const { store } = this.d;
    const id = await this.marksId(keys, brainId);
    for (let attempt = 0; ; attempt++) {
      const got = await getItem(c, id, this.fetch);
      const parsed = got
        ? ReaderMarksSchema.safeParse(await unseal(keys, id, got.bytes))
        : null;
      const remote = parsed?.success ? parsed.data.marks : null;
      const mine = store.marks(brainId);
      const merged = mergeMarks(mine, remote ?? {});
      if (merged !== mine) {
        await store.setMarks(brainId, merged);
        if (tell) this.d.marksChanged(brainId);
      }
      if (
        remote
          ? mergeMarks(remote, merged) === remote
          : !got && !Object.keys(merged).length
      )
        return;
      try {
        await putItem(
          c,
          id,
          await seal(keys, id, { v: 1, marks: merged }),
          got ? got.rev : 'new',
          this.fetch,
        );
        return;
      } catch (err) {
        if (readerErrorKind(err) !== 'conflict' || attempt + 1 >= MARK_TRIES)
          throw err;
      }
    }
  }

  /** The marks as kept here, without asking the phone's side. */
  knownMarks(brainId: string): ReaderMarkSet {
    return this.d.store.marks(brainId);
  }

  /**
   * The Read view's marks for a brain, merged with what is kept here and, for a brain that goes to the phone, with
   * the phone's. Answers with the merged set; the server not answering leaves it at what is known here.
   */
  async marks(brainId: string, local: ReaderMarkSet): Promise<ReaderMarkSet> {
    const { store } = this.d;
    const mine = store.marks(brainId);
    const merged = mergeMarks(mine, local);
    if (merged !== mine) await store.setMarks(brainId, merged);
    const brain = this.d.brains().find((b) => b.id === brainId);
    const conn = brain && this.sends(brain) ? await this.conn() : null;
    if (conn && !store.refused)
      try {
        await this.syncMarks(conn.c, conn.keys, brainId, false);
      } catch {
        /* the next push exchanges them */
      }
    return store.marks(brainId);
  }
}
