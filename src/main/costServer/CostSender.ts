import { createHash } from 'node:crypto';
import type { CostServerStatus, ServerBudgets } from '../../shared/costServer';
import type { CostRecord } from '../../shared/ledger';
import {
  CostServerError,
  hello as helloImpl,
  sendRecords as sendImpl,
} from './client';
import type { CostServerConnection } from './CostServerStore';

const BATCH = 500;
const FIRST_RUN_MS = 30_000;
const EVERY_MS = 5 * 60_000;
const KICK_MS = 5_000;
const HELLO_EVERY_MS = 60 * 60_000;
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export type CostSenderDeps = {
  ledger: {
    dirty: (limit: number) => CostRecord[];
    markSent: (recs: CostRecord[]) => Promise<void>;
    /** Writes the sent marks the ledger kept in memory; absent, markSent is taken to have written them. */
    flushSent?: () => Promise<void>;
    resetSent: () => Promise<void>;
    dirtyCount: () => number;
  };
  server: {
    get: () => CostServerConnection | null;
    budgets: ServerBudgets | null;
    setBudgets: (b: ServerBudgets | null) => Promise<void>;
    /** Kept in cost-server.json, so Settings and a refused key survive a relaunch. */
    readonly lastSentAt: string | null;
    setLastSentAt: (at: string | null) => Promise<void>;
    readonly refused: string | null;
    setRefused: (sig: string | null) => Promise<void>;
  };
  send?: typeof sendImpl;
  hello?: typeof helloImpl;
  now?: () => Date;
  status: (s: CostServerStatus) => void;
  notice: (text: string) => void;
  telemetry: (event: string, props: Record<string, string | number>) => void;
};

/** A hash of the connection, so the refused one can be stored without the key. */
const sig = (c: CostServerConnection) =>
  createHash('sha256').update(`${c.url}\n${c.email}\n${c.key}`).digest('hex');
const REFUSED = 'The server refused the key';

/**
 * Sends the ledger's dirty records to the cost server in the background. Never throws and never blocks
 * its caller: a down server means a growing backoff, a refused key means stopping until the connection
 * changes. Records stay dirty until the server accepted them.
 */
export class CostSender {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  /** A pass was asked for while one ran: it runs again when that one ends. */
  private rerun = false;
  /** Bumped by onConnected/onDisconnected: a pass (or hello) of an older connection stops and marks nothing sent. */
  private gen = 0;
  /** The next pass says hello first (after start() and onConnected()). */
  private helloDue = false;
  private started = false;
  private backoffMs = 0;
  private inBackoff = false;
  /** The connection the server refused; sending resumes when it differs or onConnected() runs. */
  private blockedOn: string | null;
  private lastSentAt: string | null;
  private error: string | null = null;

  constructor(private readonly d: CostSenderDeps) {
    this.blockedOn = d.server.refused;
    this.lastSentAt = d.server.lastSentAt;
    const c = this.blockedOn ? d.server.get() : null;
    if (c && sig(c) === this.blockedOn) this.error = REFUSED;
  }

  private block(on: string | null) {
    if (this.blockedOn === on) return;
    this.blockedOn = on;
    this.d.server
      .setRefused(on)
      .catch((err) => console.warn('[costServer] could not save state', err));
  }

  private sentNow() {
    this.lastSentAt = (this.d.now?.() ?? new Date()).toISOString();
    this.d.server
      .setLastSentAt(this.lastSentAt)
      .catch((err) => console.warn('[costServer] could not save state', err));
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.helloDue = true;
    this.schedule(FIRST_RUN_MS);
    this.helloTimer = setInterval(() => void this.hello(), HELLO_EVERY_MS);
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.helloTimer) clearInterval(this.helloTimer);
    this.timer = this.helloTimer = null;
  }

  /** New records exist: send soon (debounced), unless the server is backing off or refused the key. */
  kick() {
    if (!this.started || this.inBackoff || this.blockedOn) return;
    this.schedule(KICK_MS);
  }

  /** New server or key: everything is sent again. */
  async onConnected() {
    this.gen++;
    this.helloDue = true;
    this.block(null);
    this.inBackoff = false;
    this.backoffMs = 0;
    this.error = null;
    await this.d.ledger.resetSent();
    if (!this.started) this.started = true;
    if (!this.helloTimer)
      this.helloTimer = setInterval(() => void this.hello(), HELLO_EVERY_MS);
    this.schedule(KICK_MS);
  }

  /** The store's clear() has dropped the saved state with the connection. */
  onDisconnected() {
    this.gen++;
    this.helloDue = false;
    this.blockedOn = null;
    this.inBackoff = false;
    this.backoffMs = 0;
    this.error = null;
    this.lastSentAt = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.emit();
  }

  status(): CostServerStatus {
    const c = this.d.server.get();
    return {
      connected: c !== null && this.error === null,
      url: c?.url ?? null,
      email: c?.email ?? null,
      lastSentAt: this.lastSentAt,
      waiting: c ? this.d.ledger.dirtyCount() : 0,
      error: this.error,
      budgets: this.d.server.budgets,
    };
  }

  private emit() {
    this.d.status(this.status());
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  private run(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.work()
      .catch((err) => console.warn('[costServer] send pass failed', err))
      .finally(() => {
        this.running = null;
        if (this.rerun) {
          this.rerun = false;
          void this.run();
        }
      });
    return this.running;
  }

  private async hello() {
    const c = this.d.server.get();
    if (!c || this.blockedOn === sig(c)) return;
    const gen = this.gen;
    try {
      const r = await (this.d.hello ?? helloImpl)(c);
      if (gen !== this.gen) return;
      await this.d.server.setBudgets(r.budgets);
      this.emit();
    } catch (err) {
      if (gen === this.gen) this.fail(err, c);
    }
  }

  private fail(err: unknown, c: CostServerConnection) {
    const e =
      err instanceof CostServerError ? err : new CostServerError('network');
    this.d.telemetry('costServer.sendFailed', {
      kind: e.kind,
      status: e.status ?? 0,
    });
    if (e.kind === 'auth') {
      if (this.blockedOn !== sig(c))
        this.d.notice(
          'Your cost server refused the key. Check Settings › Cost server.',
        );
      this.block(sig(c));
      this.error = REFUSED;
    } else if (e.kind === 'rejected') {
      this.error = 'The server did not accept the request';
    } else {
      this.error =
        e.kind === 'server'
          ? 'The server had a problem; trying again soon'
          : 'The server could not be reached; trying again soon';
    }
    this.emit();
    return e;
  }

  private async work() {
    const c = this.d.server.get();
    if (!c) return;
    if (this.blockedOn) {
      if (this.blockedOn === sig(c)) return;
      this.block(null);
    }
    this.inBackoff = false;
    const gen = this.gen;
    if (this.helloDue || this.d.server.budgets === null) {
      this.helloDue = false;
      await this.hello();
    }
    if (this.blockedOn || gen !== this.gen) return;
    const send = this.d.send ?? sendImpl;
    const skipped = new Set<string>();
    let failure: CostServerError | null = null;
    // Listed once per pass: each listing filters and sorts the whole ledger, so one per batch made a full
    // resend quadratic. A record that changes meanwhile stays dirty (its new hash differs) for the next pass.
    const pending = this.d.ledger.dirty(Number.MAX_SAFE_INTEGER);
    let at = 0;
    try {
      for (;;) {
        // The connection changed: what this pass holds belongs to the old one, and onConnected() scheduled a new pass.
        if (gen !== this.gen) return;
        const batch = pending
          .slice(at, at + BATCH)
          .filter((r) => !skipped.has(r.id));
        at += BATCH;
        if (batch.length === 0) {
          if (at < pending.length) continue;
          break;
        }
        try {
          await send(c, batch);
          if (gen !== this.gen) return;
          await this.d.ledger.markSent(batch);
          this.sentNow();
        } catch (err) {
          if (gen !== this.gen) return;
          const e = err instanceof CostServerError ? err : null;
          if (e?.kind === 'rejected' && batch.length > 1) {
            failure = await this.oneByOne(c, batch, skipped, send, gen);
            if (gen !== this.gen) return;
            if (failure) break;
            continue;
          }
          if (e?.kind === 'rejected') {
            console.warn('[costServer] record rejected', batch[0]!.id);
            skipped.add(batch[0]!.id);
            this.fail(e, c);
            continue;
          }
          failure = this.fail(err, c);
          break;
        }
      }
    } finally {
      await this.d.ledger
        .flushSent?.()
        .catch((err) =>
          console.warn('[costServer] could not save sent marks', err),
        );
    }
    if (!failure) {
      this.error = skipped.size > 0 ? this.error : null;
      this.backoffMs = 0;
      this.emit();
    } else if (failure.kind !== 'auth') {
      this.backoffMs = Math.min(
        this.backoffMs ? this.backoffMs * 2 : BACKOFF_START_MS,
        BACKOFF_MAX_MS,
      );
      this.inBackoff = true;
      this.emit();
      this.schedule(this.backoffMs);
      return;
    } else {
      this.emit();
      return;
    }
    if (this.started) this.schedule(EVERY_MS);
  }

  /** A rejected batch is sent record by record; the ones the server refuses are skipped for this run. */
  private async oneByOne(
    c: CostServerConnection,
    batch: CostRecord[],
    skipped: Set<string>,
    send: typeof sendImpl,
    gen: number,
  ): Promise<CostServerError | null> {
    for (const r of batch) {
      if (gen !== this.gen) return null;
      try {
        await send(c, [r]);
        if (gen !== this.gen) return null;
        await this.d.ledger.markSent([r]);
        this.sentNow();
      } catch (err) {
        if (gen !== this.gen) return null;
        if (err instanceof CostServerError && err.kind === 'rejected') {
          console.warn('[costServer] record rejected', r.id);
          skipped.add(r.id);
          continue;
        }
        return this.fail(err, c);
      }
    }
    return null;
  }
}
