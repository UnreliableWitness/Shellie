import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  OFFICIAL_USD_TO_EUR,
  type ModelTotals,
  type Rate,
  type SessionSummary,
  type TaskUsage,
  type UsageEvent,
  type UsageRecord,
  type UsageTool,
} from '../../shared/usage';
import { buildUsageTree } from '../../shared/usageViews';
import { modelLabeler, priceEvent, round6 } from '../pricing/RateTable';
import { JsonFileStore } from './JsonFileStore';

const TOOLS: UsageTool[] = ['claude-code', 'copilot-cli', 'opencode'];
const BillableSchema = z.record(z.string(), z.array(z.string()));
type Billable = z.infer<typeof BillableSchema>;

/** `YYYY-MM` of an ISO timestamp, or of now when the timestamp has no usable month. */
const monthOf = (iso: string): string => {
  const m = iso.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(m) ? m : new Date().toISOString().slice(0, 7);
};

/** Priced usage records in append-only monthly JSON-lines files, indexed in memory by task. */
export class UsageStore extends EventEmitter<{ changed: [taskId: string] }> {
  private readonly byId = new Map<string, UsageRecord>();
  private readonly byTask = new Map<string, UsageRecord[]>();
  private readonly lastChange = new Map<string, string>();
  private notBillable = new Map<string, Set<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Task id to the session ids marked not billable; stored compact. */
  private readonly billable: JsonFileStore<Billable>;

  constructor(
    private readonly dir: string,
    private readonly rates: () => Rate[],
  ) {
    super();
    this.billable = new JsonFileStore(
      path.join(dir, 'billable.json'),
      BillableSchema,
      () => ({}),
      0,
    );
  }

  async load(): Promise<{
    damagedLines: number;
    billableBackup: string | null;
  }> {
    let damaged = 0;
    let files: string[] = [];
    try {
      files = (await fs.readdir(this.dir))
        .filter((f) => /^records-\d{4}-\d{2}\.jsonl$/.test(f))
        .sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    for (const f of files) {
      const text = await fs.readFile(path.join(this.dir, f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as UsageRecord;
          if (typeof rec.id !== 'string' || typeof rec.taskId !== 'string')
            throw new Error('bad record');
          this.index(rec);
        } catch {
          damaged++;
        }
      }
    }
    const billable = await this.billable.load();
    this.notBillable = new Map(
      Object.entries(this.billable.value).map(([t, ids]) => [t, new Set(ids)]),
    );
    const billableBackup = billable.backup ?? null;
    return { damagedLines: damaged, billableBackup };
  }

  add(e: UsageEvent): Promise<UsageRecord | null> {
    const run = async () => {
      if (this.byId.has(e.id)) return null;
      const rec: UsageRecord = { ...e, ...priceEvent(this.rates(), e) };
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(
        path.join(this.dir, `records-${monthOf(e.at)}.jsonl`),
        `${JSON.stringify(rec)}\n`,
        'utf8',
      );
      this.index(rec);
      this.lastChange.set(e.taskId, new Date().toISOString());
      this.emit('changed', e.taskId);
      return rec;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  records(taskId: string): UsageRecord[] {
    return [...(this.byTask.get(taskId) ?? [])].sort((a, b) =>
      a.at.localeCompare(b.at),
    );
  }

  /** Every loaded record, across tasks. */
  allRecords(): UsageRecord[] {
    return [...this.byId.values()];
  }

  isBillable(taskId: string, sessionId: string): boolean {
    return !this.notBillable.get(taskId)?.has(sessionId);
  }

  setBillable(
    taskId: string,
    sessionId: string,
    billable: boolean,
  ): Promise<void> {
    const run = async () => {
      const next = new Map<string, Set<string>>();
      for (const [t, ids] of this.notBillable) next.set(t, new Set(ids));
      const set = next.get(taskId) ?? new Set<string>();
      if (billable) set.delete(sessionId);
      else set.add(sessionId);
      next.set(taskId, set);
      await this.billable.update(() =>
        Object.fromEntries(
          [...next].filter(([, s]) => s.size > 0).map(([t, s]) => [t, [...s]]),
        ),
      );
      this.notBillable = next;
      this.lastChange.set(taskId, new Date().toISOString());
      this.emit('changed', taskId);
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  changedSince(iso: string): string[] {
    return [...this.lastChange].filter(([, at]) => at > iso).map(([t]) => t);
  }

  summarize(taskId: string, now = Date.now()): TaskUsage {
    const sessions = new Map<string, SessionSummary>();
    for (const r of this.records(taskId)) {
      const s = sessions.get(r.sessionId) ?? {
        sessionId: r.sessionId,
        tool: r.tool,
        startedAt: r.at,
        lastAt: r.at,
        models: [],
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        unpricedRequests: 0,
        billable: this.isBillable(taskId, r.sessionId),
      };
      if (r.at > s.lastAt) s.lastAt = r.at;
      if (r.at < s.startedAt) s.startedAt = r.at;
      s.requests++;
      if (!s.models.includes(r.model)) s.models.push(r.model);
      s.inputTokens += r.inputTokens;
      s.outputTokens += r.outputTokens;
      s.cacheReadTokens += r.cacheReadTokens;
      s.cacheWriteTokens += r.cacheWriteTokens;
      if (r.costUsd === null) s.unpricedRequests++;
      else s.costUsd = round6(s.costUsd + r.costUsd);
      sessions.set(r.sessionId, s);
    }
    const list = [...sessions.values()].sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    );
    const factor = OFFICIAL_USD_TO_EUR;
    const tokensOf = (s: SessionSummary) =>
      s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens;
    const billableList = list.filter((s) => s.billable);
    const byTool = Object.fromEntries(
      TOOLS.map((tool) => {
        const ss = billableList.filter((s) => s.tool === tool);
        const costUsd = round6(ss.reduce((n, s) => n + s.costUsd, 0));
        return [
          tool,
          {
            costUsd,
            costEur: round6(costUsd * factor),
            sessions: ss.length,
            tokens: ss.reduce((n, s) => n + tokensOf(s), 0),
          },
        ];
      }),
    ) as TaskUsage['byTool'];
    const costUsd = round6(billableList.reduce((n, s) => n + s.costUsd, 0));
    const since = now - 6 * 3600_000;
    const recent = this.records(taskId)
      .filter((r) => r.costUsd !== null && sessions.get(r.sessionId)!.billable)
      .filter((r) => {
        const t = Date.parse(r.at);
        return t >= since && t <= now;
      })
      .map((r) => ({
        at: r.at,
        tool: r.tool,
        costEur: round6(r.costUsd! * factor),
      }))
      .sort((a, b) => a.at.localeCompare(b.at));
    const label = modelLabeler(this.rates());
    const models = new Map<string, ModelTotals>();
    for (const r of this.records(taskId)) {
      if (!sessions.get(r.sessionId)!.billable) continue;
      const name = label(r.model);
      const key = `${r.tool}\u0000${name}`;
      const m = models.get(key) ?? {
        tool: r.tool,
        model: r.model,
        label: name,
        costEur: 0,
        tokens: 0,
        requests: 0,
        unpricedRequests: 0,
      };
      m.requests++;
      m.tokens +=
        r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
      if (r.costUsd === null) m.unpricedRequests++;
      else m.costEur = round6(m.costEur + r.costUsd * factor);
      models.set(key, m);
    }
    const byModel = [...models.values()].sort(
      (a, b) => b.costEur - a.costEur || b.tokens - a.tokens,
    );
    return {
      taskId,
      sessions: list,
      billable: {
        costUsd,
        costEur: round6(costUsd * factor),
        tokens: billableList.reduce((n, s) => n + tokensOf(s), 0),
      },
      byTool,
      unpricedRequests: list.reduce((n, s) => n + s.unpricedRequests, 0),
      usdToEur: OFFICIAL_USD_TO_EUR,
      recent,
      byModel,
      lineage: buildUsageTree(this.records(taskId), {
        billable: (sessionId) => sessions.get(sessionId)!.billable,
        label,
        usdToEur: factor,
      }),
    };
  }

  private index(rec: UsageRecord): void {
    if (this.byId.has(rec.id)) return;
    this.byId.set(rec.id, rec);
    const list = this.byTask.get(rec.taskId) ?? [];
    list.push(rec);
    this.byTask.set(rec.taskId, list);
  }
}
