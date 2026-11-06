import { z } from 'zod';
import type {
  AlertKind,
  BudgetRecord,
  BudgetRow,
  BudgetTokens,
} from '../../shared/budget';
import { budgetMonth, dayKey, tokensOf, vendorOf } from '../../shared/budget';
import type { Rate } from '../../shared/usage';
import { priceRecord } from '../ledger/price';
import { round6 } from '../pricing/RateTable';
import { JsonFileStore } from '../usage/JsonFileStore';
import type { FileCursor } from './claudeTranscripts';

export type SeenContribution = BudgetTokens & {
  day: string;
  key: string;
  requests: 1;
  costEur: number | null;
};
export type BudgetFile = {
  version: 2;
  days: Record<string, BudgetRow[]>;
  /** Dedupe: a recent id keeps what it contributed (so a larger copy replaces it); an older id is just its day key (final). */
  seen: Record<string, string | SeenContribution>;
  claudeCursors: Record<string, FileCursor>;
  openCodeCursor: number;
  /** '<vendor>:<budget month start day key>' → alerts fired for that budget in that month. */
  alerts: Record<string, AlertKind[]>;
  sources: { claudeCode: boolean; openCode: boolean };
  /** Local day key of the last maintenance run (compaction, pruning, repricing); '' never. */
  maintainedOn: string;
  /** True once the first pass has been applied; the band shows a loading line until then. */
  scanned: boolean;
};

const tokens = {
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWrite5mTokens: z.number(),
  cacheWrite1hTokens: z.number(),
};
const Row = z.object({
  ...tokens,
  tool: z.enum(['claude-code', 'opencode', 'copilot-cli']),
  model: z.string(),
  provider: z.string(),
  vendor: z.enum(['claude', 'copilot']).nullable(),
  inShellie: z.boolean(),
  requests: z.number(),
  fast: z.boolean(),
  costEur: z.number().nullable(),
});
const Seen = z.union([
  z.string(),
  z.object({
    ...tokens,
    day: z.string(),
    key: z.string(),
    requests: z.literal(1),
    costEur: z.number().nullable(),
  }),
]);
/** Version 1 rows had `counted` (Claude or not) instead of a vendor; rows, seen keys, Claude cursors and alerts carry over, so no transcript rescan is needed. */
function migrateV1(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const f = raw as Record<string, unknown>;
  if (f.version !== 1) return raw;
  const vendor = (counted: unknown, provider: unknown) =>
    counted === true || counted === 'true'
      ? 'claude'
      : provider === 'github-copilot'
        ? 'copilot'
        : null;
  const days: Record<string, unknown[]> = {};
  for (const [day, rows] of Object.entries(
    (f.days ?? {}) as Record<string, Record<string, unknown>[]>,
  )) {
    days[day] = rows.map(({ counted, ...row }) => ({
      ...row,
      vendor: vendor(counted, row.provider),
    }));
  }
  const seen: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(
    (f.seen ?? {}) as Record<string, unknown>,
  )) {
    if (!s || typeof s !== 'object') {
      seen[id] = s;
      continue;
    }
    const e = s as { key?: unknown };
    // key: tool|model|provider|counted|inShellie|fast
    const parts = typeof e.key === 'string' ? e.key.split('|') : [];
    if (parts.length !== 6) {
      seen[id] = s;
      continue;
    }
    parts[3] = vendor(parts[3], parts[2]) ?? '';
    seen[id] = { ...e, key: parts.join('|') };
  }
  const alerts: Record<string, unknown> = {};
  for (const [month, kinds] of Object.entries(
    (f.alerts ?? {}) as Record<string, unknown>,
  ))
    alerts[`claude:${month}`] = kinds;
  // An empty maintenance day makes the next pass price the rows that were "not counted". OpenCode is read again
  // from the start: v1 dropped its requests without a vendor-counted provider (GPT through Copilot), and `seen`
  // keeps the ones it had from counting twice.
  return {
    ...f,
    version: 2,
    days,
    seen,
    alerts,
    maintainedOn: '',
    openCodeCursor: 0,
  };
}

const FileSchema: z.ZodType<BudgetFile> = z.preprocess(
  migrateV1,
  z.object({
    version: z.literal(2),
    days: z.record(z.string(), z.array(Row)),
    seen: z.record(z.string(), Seen),
    claudeCursors: z.record(
      z.string(),
      z.object({
        offset: z.number(),
        size: z.number(),
        mtimeMs: z.number(),
        ino: z.number(),
      }),
    ),
    openCodeCursor: z.number(),
    alerts: z.record(
      z.string(),
      z.array(z.enum(['at80', 'forecastOver', 'at100'])),
    ),
    sources: z.object({ claudeCode: z.boolean(), openCode: z.boolean() }),
    maintainedOn: z.string().default(''),
    scanned: z.boolean().default(false),
  }),
);
const empty = (): BudgetFile => ({
  version: 2,
  days: {},
  seen: {},
  claudeCursors: {},
  openCodeCursor: 0,
  alerts: {},
  sources: { claudeCode: false, openCode: false },
  maintainedOn: '',
  scanned: false,
});

const sameCursors = (
  a: Record<string, FileCursor>,
  b: Record<string, FileCursor>,
) => {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => {
    const x = a[k];
    const y = b[k];
    return (
      !!y &&
      x.offset === y.offset &&
      x.size === y.size &&
      x.mtimeMs === y.mtimeMs &&
      x.ino === y.ino
    );
  });
};

const TOKEN_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWrite5mTokens',
  'cacheWrite1hTokens',
] as const;
/** Seen entries older than this many days are compacted to their day key. */
const COMPACT_AFTER_DAYS = 2;

export const rowKey = (
  r: Pick<
    BudgetRow,
    'tool' | 'model' | 'provider' | 'vendor' | 'inShellie' | 'fast'
  >,
) =>
  [r.tool, r.model, r.provider, r.vendor ?? '', r.inShellie, r.fast].join('|');

export function priceTokens(
  rates: Rate[],
  model: string,
  fast: boolean,
  t: BudgetTokens,
  /** Input size that picks the price tier; defaults to the tokens' own input total. */
  tierInput?: number,
): number | null {
  return priceRecord(rates, model, fast, t, tierInput)?.costEur ?? null;
}

/** A pass changes budget.json (megabytes) every 30 s while any agent works; it is written at most this often. */
const WRITE_WITHIN_MS = 2 * 60_000;

/** The month rollup behind the budget bands: one row per day × tool × model × provider × vendor × in Shellie × fast. Every request is kept; rows with a vendor count against that budget. */
export class BudgetStore {
  private readonly store: JsonFileStore<BudgetFile>;
  constructor(
    readonly file: string,
    private readonly rates: () => Rate[],
  ) {
    this.store = new JsonFileStore(file, FileSchema, empty, 0);
  }
  async load() {
    await this.store.load();
  }
  get value(): BudgetFile {
    return this.store.value;
  }
  /** Writes what passes kept in memory. Losing them is safe: the cursors are saved with the rows, so the next launch reads those requests again. */
  flush(): Promise<void> {
    return this.store.flush();
  }

  async apply(input: {
    records: BudgetRecord[];
    inShellie: (r: BudgetRecord) => boolean;
    now: Date;
    monthStartDay: number;
    claudeCursors?: Record<string, FileCursor>;
    openCodeCursor?: number;
    sources: { claudeCode: boolean; openCode: boolean };
  }): Promise<boolean> {
    const rates = this.rates();
    const keepFrom = dayKey(
      budgetMonth(input.now, input.monthStartDay, -1).start,
    );
    const compactBefore = dayKey(
      new Date(
        input.now.getFullYear(),
        input.now.getMonth(),
        input.now.getDate() - COMPACT_AFTER_DAYS,
      ),
    );
    const today = dayKey(input.now);
    const cur = this.store.value;
    // Repeats that cannot change anything (seen, smaller, too old) are dropped up front.
    const fresh = input.records.filter((rec) => {
      const prev = cur.seen[rec.id];
      if (typeof prev === 'string') return false;
      if (prev) return tokensOf(rec) > tokensOf(prev);
      return dayKey(new Date(rec.at)) >= keepFrom;
    });
    // Nothing new: skip the write entirely (the file can be megabytes; passes run every 30 s).
    if (
      fresh.length === 0 &&
      cur.scanned &&
      cur.maintainedOn === today &&
      (!input.claudeCursors ||
        sameCursors(cur.claudeCursors, input.claudeCursors)) &&
      (input.openCodeCursor === undefined ||
        input.openCodeCursor === cur.openCodeCursor) &&
      cur.sources.claudeCode === input.sources.claudeCode &&
      cur.sources.openCode === input.sources.openCode
    )
      return false;
    let changed = false;
    await this.store.update(
      (f) => {
        if (!f.scanned) {
          f.scanned = true;
          changed = true;
        }
        const rowFor = (
          day: string,
          proto: Omit<
            BudgetRow,
            'requests' | 'costEur' | (typeof TOKEN_KEYS)[number]
          >,
        ) => {
          const list = (f.days[day] ??= []);
          const k = rowKey(proto);
          let row = list.find((r) => rowKey(r) === k);
          if (!row) {
            row = {
              ...proto,
              requests: 0,
              costEur: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWrite5mTokens: 0,
              cacheWrite1hTokens: 0,
            };
            list.push(row);
          }
          return row;
        };
        const add = (
          row: BudgetRow,
          t: BudgetTokens,
          requests: number,
          cost: number | null,
          sign: 1 | -1,
        ) => {
          for (const key of TOKEN_KEYS) row[key] += sign * t[key];
          row.requests += sign * requests;
          row.costEur =
            cost === null || row.costEur === null
              ? null
              : round6(row.costEur + sign * cost);
        };
        for (const rec of fresh) {
          const prev = f.seen[rec.id];
          if (typeof prev === 'string') continue;
          const day = dayKey(new Date(rec.at));
          // Older history is frozen: a resumed session copying it must not re-add it once its ids were pruned.
          if (!prev && day < keepFrom) continue;
          // A repeat only wins when it is larger; Claude Code and OpenCode both re-write messages with more tokens.
          if (prev && tokensOf(rec) <= tokensOf(prev)) continue;
          const proto = {
            tool: rec.tool,
            model: rec.model,
            provider: rec.provider,
            vendor: vendorOf(rec),
            inShellie: input.inShellie(rec),
            fast: rec.fast,
          };
          const cost = priceTokens(rates, rec.model, rec.fast, rec);
          if (prev) {
            const old = f.days[prev.day]?.find((r) => rowKey(r) === prev.key);
            if (old) {
              const oldCost =
                prev.costEur === null && old.costEur !== null
                  ? priceTokens(rates, old.model, old.fast, prev)
                  : prev.costEur;
              add(old, prev, 1, oldCost, -1);
              if (old.requests <= 0) {
                const list = f.days[prev.day]!;
                list.splice(list.indexOf(old), 1);
                if (list.length === 0) delete f.days[prev.day];
              }
            }
          }
          add(rowFor(day, proto), rec, 1, cost, 1);
          const t = Object.fromEntries(
            TOKEN_KEYS.map((key) => [key, rec[key]]),
          ) as BudgetTokens;
          f.seen[rec.id] = {
            ...t,
            day,
            key: rowKey(proto),
            requests: 1,
            costEur: cost,
          };
          changed = true;
        }
        // Maintenance runs at most once per local day, or when records arrived.
        const maintain = fresh.length > 0 || f.maintainedOn !== today;
        if (maintain) f.maintainedOn = today;
        // Rows that were unpriced: price them from their tokens once a rate exists.
        for (const [day, list] of maintain ? Object.entries(f.days) : []) {
          if (day < keepFrom) continue;
          for (const row of list) {
            if (row.costEur !== null) continue;
            const avgInput =
              (row.inputTokens +
                row.cacheReadTokens +
                row.cacheWrite5mTokens +
                row.cacheWrite1hTokens) /
              Math.max(1, row.requests);
            const cost = priceTokens(rates, row.model, row.fast, row, avgInput);
            if (cost !== null) {
              row.costEur = cost;
              changed = true;
            }
          }
        }
        for (const [id, s] of maintain ? Object.entries(f.seen) : []) {
          const d = typeof s === 'string' ? s : s.day;
          if (d < keepFrom) {
            delete f.seen[id];
            changed = true;
          } else if (typeof s !== 'string' && d < compactBefore) {
            f.seen[id] = d;
            changed = true;
          }
        }
        if (input.claudeCursors) f.claudeCursors = input.claudeCursors;
        if (input.openCodeCursor !== undefined)
          f.openCodeCursor = input.openCodeCursor;
        if (
          f.sources.claudeCode !== input.sources.claudeCode ||
          f.sources.openCode !== input.sources.openCode
        )
          changed = true;
        f.sources = input.sources;
      },
      { writeWithinMs: WRITE_WITHIN_MS },
    );
    return changed;
  }

  async markAlert(monthKey: string, kind: AlertKind) {
    await this.store.update((f) => {
      const list = (f.alerts[monthKey] ??= []);
      if (!list.includes(kind)) list.push(kind);
    });
  }
}
