import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BudgetRecord } from '../../shared/budget';
import { vendorOf } from '../../shared/budget';
import type { CostRecord } from '../../shared/ledger';
import type { UsageEvent, UsageRecord } from '../../shared/usage';
import type { FileCursor } from '../budget/claudeTranscripts';
import type { ClaudeTranscriptReader } from '../budget/claudeTranscripts';
import type { OpenCodeReader } from '../budget/openCode';
import { budgetRecordsFromUsage } from '../budget/usageRecords';
import { renameWithRetry } from '../fsRetry';
import { OFFICIAL_RATES } from '../pricing/officialRates';
import { modelLabeler } from '../pricing/RateTable';
import {
  type AttributionContext,
  attribute,
  merge,
  raises,
  taskOf,
} from './attribute';
import type { LedgerStore } from './LedgerStore';
import { priceRecord } from './price';

export type LedgerServiceDeps = {
  store: LedgerStore;
  claude: { read: ClaudeTranscriptReader['read'] };
  openCode: { read: OpenCodeReader['read'] };
  /** The usage store's records: Copilot CLI requests and PR-summary runs enter the ledger from here. */
  usageRecords: () => UsageRecord[];
  context: () => AttributionContext;
  isBillable: (taskId: string, sessionId: string) => boolean;
  developer: () => string | null;
  version: string;
  /** OpenCode requests attributed to a task, for the Usage tab (the usage store dedupes by id). */
  toUsage: (e: UsageEvent) => void;
  changed: () => void;
  /** Counts only, never amounts. */
  telemetry?: (event: string, props: Record<string, number>) => void;
  now?: () => Date;
};

type Cursors = { claude: Record<string, FileCursor>; openCode: number };
/**
 * What attribution and billable need that the record leaves out (never sent): session, folder, task id; and
 * for the Usage tab's lineage, an OpenCode child session's parent and agent.
 */
type Input = {
  id: string;
  s: string;
  c: string | null;
  t?: string;
  p?: string;
  a?: string;
};

const label = modelLabeler(OFFICIAL_RATES);
/** OpenCode rows per synchronous database read, and records handled between yields to the event loop. */
const OPENCODE_CHUNK = 1000;
const WORK_CHUNK = 500;
const UPSERT_CHUNK = 2000;
const tick = () => new Promise<void>((r) => setImmediate(r));

const asBudget = (r: CostRecord, i: Input): BudgetRecord => ({
  id: r.id,
  tool: r.tool,
  sessionId: i.s,
  model: r.model,
  provider: r.provider,
  at: r.at,
  cwd: i.c,
  fast: r.fast,
  ...(i.t ? { taskId: i.t } : {}),
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  cacheReadTokens: r.cacheReadTokens,
  cacheWrite5mTokens: r.cacheWrite5mTokens,
  cacheWrite1hTokens: r.cacheWrite1hTokens,
});

async function writeAtomic(file: string, text: string) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await renameWithRetry(tmp, file);
}

/**
 * Fills the cost ledger: every request the transcripts, OpenCode and the usage store have, priced and
 * attributed. Its readers keep their own cursors (`cursors.json`, first run reads everything); the
 * inputs attribution needs stay local in `inputs.jsonl`, so stored records can move up later.
 */
export class LedgerService {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loaded: Promise<void> | null = null;
  private cursors: Cursors = { claude: {}, openCode: 0 };
  private readonly inputs = new Map<string, Input>();
  /** The attribution context of the last pass; stored records are re-attributed when it changes. */
  private lastKey: string | null = null;
  private readonly sentToUsage = new Set<string>();
  private firstPass = true;
  private reportedDay: string | null = null;

  constructor(private readonly d: LedgerServiceDeps) {}

  private get cursorsFile() {
    return path.join(this.d.store.dir, 'cursors.json');
  }
  private get inputsFile() {
    return path.join(this.d.store.dir, 'inputs.jsonl');
  }

  private async load() {
    await this.d.store.load();
    try {
      const raw = JSON.parse(
        await fs.readFile(this.cursorsFile, 'utf8'),
      ) as Partial<Cursors>;
      this.cursors = {
        claude: raw.claude && typeof raw.claude === 'object' ? raw.claude : {},
        openCode: typeof raw.openCode === 'number' ? raw.openCode : 0,
      };
    } catch {
      this.cursors = { claude: {}, openCode: 0 };
    }
    let text = '';
    try {
      text = await fs.readFile(this.inputsFile, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    let n = 0;
    for (const line of text.split('\n')) {
      if (++n % 2000 === 0) await tick();
      if (!line.trim()) continue;
      try {
        const i = JSON.parse(line) as Input;
        if (typeof i.id === 'string' && typeof i.s === 'string')
          this.inputs.set(i.id, i);
      } catch {
        // A torn line is skipped; the file is rewritten below.
      }
    }
    // A last line without its newline is a torn write: rewrite so the next append starts clean.
    if (text.length > 0 && !text.endsWith('\n'))
      await writeAtomic(
        this.inputsFile,
        [...this.inputs.values()].map((i) => `${JSON.stringify(i)}\n`).join(''),
      );
  }

  pass(): Promise<void> {
    this.running ??= this.run()
      .catch((err) => {
        console.warn('[ledger] pass failed', err);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** A pass that starts after this call (a running one is waited for), so it sees what changed before it. */
  async freshPass(): Promise<void> {
    if (this.running) await this.running;
    await this.pass();
  }

  /**
   * Billable comes from the usage store for a task's session, also when the record sits at repo level because its
   * task has no connection; a task Shellie no longer has keeps the stored value; no task at all is billable.
   */
  private billableOf(
    r: CostRecord,
    i: Input,
    ctx: AttributionContext,
    stored: boolean,
  ) {
    const a = r.attribution;
    const taskId =
      a.level === 'task'
        ? a.taskId
        : (taskOf(asBudget(r, i), ctx)?.t.id ?? i.t);
    if (!taskId) return true;
    if (!ctx.byId.has(taskId)) return stored;
    return this.d.isBillable(taskId, i.s);
  }

  /** The OpenCode backlog in bounded chunks, yielding between them, so a first backfill never blocks the main process. */
  private async readOpenCode(cursor: number) {
    const records: BudgetRecord[] = [];
    let next = cursor;
    let after: { t: number; id: string } | undefined;
    for (;;) {
      const page = this.d.openCode.read(cursor, {
        limit: OPENCODE_CHUNK,
        after,
      });
      for (const r of page.records) records.push(r);
      next = Math.max(next, page.cursor);
      if (!page.more || !page.last) break;
      after = page.last;
      await tick();
    }
    return { records, cursor: next };
  }

  private build(
    r: BudgetRecord,
    ctx: AttributionContext,
    developer: string | null,
  ): CostRecord {
    const p = priceRecord(OFFICIAL_RATES, r.model, r.fast, r);
    return {
      id: r.id,
      tool: r.tool,
      provider: r.provider,
      vendor: vendorOf(r),
      model: r.model,
      modelLabel: label(r.model),
      at: r.at,
      fast: r.fast,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWrite5mTokens: r.cacheWrite5mTokens,
      cacheWrite1hTokens: r.cacheWrite1hTokens,
      costUsd: p?.costUsd ?? null,
      costEur: p?.costEur ?? null,
      rateId: p?.rateId ?? null,
      billable: true,
      attribution: attribute(r, ctx),
      developer,
      shellieVersion: this.d.version,
    };
  }

  private async run() {
    await (this.loaded ??= this.load());
    const store = this.d.store;
    const claude = await this.d.claude.read(this.cursors.claude);
    let oc: { records: BudgetRecord[]; cursor: number };
    try {
      oc = await this.readOpenCode(this.cursors.openCode);
    } catch (err) {
      console.warn('[ledger] OpenCode database not readable this pass', err);
      oc = { records: [], cursor: this.cursors.openCode };
    }
    let extra: BudgetRecord[] = [];
    try {
      extra = budgetRecordsFromUsage(this.d.usageRecords());
    } catch (err) {
      console.warn('[ledger] usage store not readable this pass', err);
    }
    const ctx = this.d.context();
    const developer = this.d.developer();
    const out = new Map<string, CostRecord>();
    const fresh: Input[] = [];
    let n = 0;
    for (const r of [...claude.records, ...oc.records, ...extra]) {
      if (++n % WORK_CHUNK === 0) await tick();
      let input = this.inputs.get(r.id);
      if (!input) {
        input = {
          id: r.id,
          s: r.sessionId,
          c: r.cwd,
          ...(r.taskId ? { t: r.taskId } : {}),
          ...(r.parentSessionId ? { p: r.parentSessionId } : {}),
          ...(r.agentLabel ? { a: r.agentLabel } : {}),
        };
        this.inputs.set(r.id, input);
        fresh.push(input);
      }
      const prev = out.get(r.id) ?? store.get(r.id);
      const m = merge(prev, this.build(r, ctx, developer));
      out.set(r.id, {
        ...m,
        billable: this.billableOf(m, input, ctx, prev?.billable ?? true),
      });
    }
    // Stored records the readers did not bring again: move up when the context changed, re-apply billable.
    const reattribute = ctx.key !== this.lastKey;
    for (const prev of store.all()) {
      if (++n % WORK_CHUNK === 0) await tick();
      if (out.has(prev.id)) continue;
      const input = this.inputs.get(prev.id);
      if (!input) continue;
      let rec = prev;
      if (reattribute && prev.attribution.level !== 'task') {
        const a = attribute(asBudget(prev, input), ctx);
        if (raises(prev.attribution, a)) rec = { ...rec, attribution: a };
      }
      const billable = this.billableOf(rec, input, ctx, prev.billable);
      if (billable !== rec.billable) rec = { ...rec, billable };
      // Every record carries the email saved in Settings › Cost server; a disconnect leaves it as it was.
      if (developer !== null && rec.developer !== developer)
        rec = { ...rec, developer };
      // A Shellie update may bring a rate for a model that had none.
      if (this.firstPass && rec.costEur === null) {
        const p = priceRecord(OFFICIAL_RATES, rec.model, rec.fast, rec);
        if (p) rec = { ...rec, ...p };
      }
      if (rec !== prev) out.set(prev.id, rec);
    }
    if (fresh.length > 0) {
      await fs.mkdir(store.dir, { recursive: true });
      await fs.appendFile(
        this.inputsFile,
        fresh.map((i) => `${JSON.stringify(i)}\n`).join(''),
        'utf8',
      );
    }
    // In chunks with a yield between them; cursors are saved only after every chunk is stored.
    const all = [...out.values()];
    const changed: string[] = [];
    for (let i = 0; i === 0 || i < all.length; i += UPSERT_CHUNK) {
      if (i > 0) await tick();
      for (const id of await store.upsert(all.slice(i, i + UPSERT_CHUNK)))
        changed.push(id);
    }
    const next: Cursors = { claude: claude.cursors, openCode: oc.cursor };
    if (JSON.stringify(next) !== JSON.stringify(this.cursors)) {
      await fs.mkdir(store.dir, { recursive: true });
      await writeAtomic(this.cursorsFile, JSON.stringify(next));
      this.cursors = next;
    }
    for (const r of this.firstPass ? store.all() : out.values()) {
      const a = r.attribution;
      if (r.tool !== 'opencode' || a.level !== 'task') continue;
      if (this.sentToUsage.has(r.id)) continue;
      const input = this.inputs.get(r.id);
      if (!input) continue;
      this.sentToUsage.add(r.id);
      this.d.toUsage({
        id: r.id,
        taskId: a.taskId,
        tool: 'opencode',
        sessionId: input.s,
        model: r.model,
        at: r.at,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWrite5mTokens + r.cacheWrite1hTokens,
        fast: r.fast,
        ...(input.p ? { parentSessionId: input.p } : {}),
        ...(input.a ? { agent: input.a } : {}),
      });
    }
    this.report();
    this.lastKey = ctx.key;
    this.firstPass = false;
    if (changed.length > 0) this.d.changed();
  }

  /** `ledger.records`: how many records of each tool and attribution level, at most once per local day. */
  private report() {
    if (!this.d.telemetry) return;
    const d = this.d.now?.() ?? new Date();
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (day === this.reportedDay) return;
    this.reportedDay = day;
    const n = {
      claudeCode: 0,
      opencode: 0,
      copilotCli: 0,
      task: 0,
      repo: 0,
      none: 0,
    };
    for (const r of this.d.store.all()) {
      if (r.tool === 'claude-code') n.claudeCode++;
      else if (r.tool === 'opencode') n.opencode++;
      else if (r.tool === 'copilot-cli') n.copilotCli++;
      n[r.attribution.level]++;
    }
    this.d.telemetry('ledger.records', n);
  }

  start(intervalMs = 30_000) {
    void this.pass();
    this.timer ??= setInterval(() => void this.pass(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
