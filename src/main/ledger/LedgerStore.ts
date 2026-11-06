import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CostRecord } from '../../shared/ledger';
import { tick } from '../async';
import { monthFiles, writeAtomic } from '../fsRetry';

/** `YYYY-MM` (UTC) of an ISO timestamp, or of now when it has no usable month. */
const monthOf = (iso: string): string => {
  const m = typeof iso === 'string' ? iso.slice(0, 7) : '';
  return /^\d{4}-\d{2}$/.test(m) ? m : new Date().toISOString().slice(0, 7);
};

/** JSON with sorted keys, so two equal records hash and compare equal whatever their key order. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : x,
  );

const hashOf = (r: CostRecord): string =>
  createHash('sha1').update(canonical(r)).digest('hex');

/**
 * One cost record per AI request in monthly JSON-lines files; an upsert appends the new version
 * and the latest line per id wins. `sent.json` holds the hash of the version the server accepted.
 */
export class LedgerStore {
  private readonly byId = new Map<string, CostRecord>();
  /** Hash of each record's current version, kept so dirty() only compares strings. */
  private readonly hashes = new Map<string, string>();
  private sent: Record<string, string> = {};
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {}

  private file(month: string): string {
    return path.join(this.dir, `records-${month}.jsonl`);
  }

  private get sentFile(): string {
    return path.join(this.dir, 'sent.json');
  }

  /** Runs `fn` after every earlier write, whether or not those succeeded. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async load(): Promise<void> {
    this.byId.clear();
    this.hashes.clear();
    for (const f of await monthFiles(this.dir)) {
      const text = await fs.readFile(path.join(this.dir, f), 'utf8');
      const lines = text.split('\n').filter((l) => l.trim());
      const live = new Map<string, CostRecord>();
      for (const [i, line] of lines.entries()) {
        // A month file can hold tens of thousands of lines: let the event loop run between batches.
        if (i > 0 && i % 2000 === 0) await tick();
        try {
          const rec = JSON.parse(line) as CostRecord;
          if (typeof rec.id !== 'string' || typeof rec.at !== 'string')
            throw new Error('bad');
          live.set(rec.id, rec);
          this.byId.set(rec.id, rec);
        } catch {
          // A torn or damaged line is skipped; the rest of the file still loads.
        }
      }
      // A last line without its newline is a torn write: rewrite so the next append starts clean.
      const torn = text.length > 0 && !text.endsWith('\n');
      if (torn || lines.length - live.size > live.size) {
        const month = f.slice('records-'.length, -'.jsonl'.length);
        await this.serial(() => this.rewrite(month, [...live.values()]));
      }
    }
    for (const r of this.byId.values()) this.hashes.set(r.id, hashOf(r));
    try {
      const raw = JSON.parse(
        await fs.readFile(this.sentFile, 'utf8'),
      ) as unknown;
      this.sent =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as never)
          : {};
    } catch {
      this.sent = {};
    }
  }

  private async rewrite(month: string, recs: CostRecord[]): Promise<void> {
    await writeAtomic(
      this.file(month),
      recs.map((r) => `${JSON.stringify(r)}\n`).join(''),
    );
  }

  get(id: string): CostRecord | undefined {
    return this.byId.get(id);
  }

  all(): CostRecord[] {
    return [...this.byId.values()];
  }

  /** Appends the records that differ from the stored version; returns the ids that changed. */
  upsert(recs: CostRecord[]): Promise<string[]> {
    return this.serial(async () => {
      const changed = new Map<string, CostRecord>();
      const hashes = new Map<string, string>();
      for (const r of recs) {
        const hash = hashOf(r);
        if ((hashes.get(r.id) ?? this.hashes.get(r.id)) === hash) continue;
        changed.set(r.id, r);
        hashes.set(r.id, hash);
      }
      if (changed.size === 0) return [];
      const byMonth = new Map<string, string>();
      for (const r of changed.values()) {
        const m = monthOf(r.at);
        byMonth.set(m, `${byMonth.get(m) ?? ''}${JSON.stringify(r)}\n`);
      }
      await fs.mkdir(this.dir, { recursive: true });
      for (const [m, text] of byMonth)
        await fs.appendFile(this.file(m), text, 'utf8');
      for (const r of changed.values()) {
        this.byId.set(r.id, r);
        this.hashes.set(r.id, hashes.get(r.id)!);
      }
      return [...changed.keys()];
    });
  }

  /** Records whose current version the server has not accepted, oldest first. */
  dirty(limit: number): CostRecord[] {
    return this.all()
      .filter(
        (r) =>
          r.attribution.level !== 'brain' &&
          this.sent[r.id] !== this.hashes.get(r.id),
      )
      .sort((a, b) =>
        a.at < b.at
          ? -1
          : a.at > b.at
            ? 1
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0,
      )
      .slice(0, limit);
  }

  /** How many records dirty() would return, without sorting them. */
  dirtyCount(): number {
    let n = 0;
    for (const [id, h] of this.hashes)
      if (
        this.sent[id] !== h &&
        this.byId.get(id)?.attribution.level !== 'brain'
      )
        n++;
    return n;
  }

  markSent(recs: CostRecord[]): Promise<void> {
    return this.writeSent((s) => {
      for (const r of recs) s[r.id] = hashOf(r);
    });
  }

  /** New server or Disconnect: everything is dirty again. */
  resetSent(): Promise<void> {
    return this.writeSent((s) => {
      for (const k of Object.keys(s)) delete s[k];
    });
  }

  private writeSent(
    mutate: (s: Record<string, string>) => void,
  ): Promise<void> {
    return this.serial(async () => {
      const next = { ...this.sent };
      mutate(next);
      await fs.mkdir(this.dir, { recursive: true });
      await writeAtomic(this.sentFile, JSON.stringify(next));
      this.sent = next;
    });
  }
}
