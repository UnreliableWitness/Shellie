import { dayKey, type BudgetTokens } from '../../shared/budget';
import type { DreamLimit, DreamUsage } from '../../shared/dreams';
import { OFFICIAL_RATES } from '../pricing/officialRates';
import type { OpenCodeReader } from '../budget/openCode';
import { priceRecord } from '../ledger/price';
import { selectRate } from '../pricing/RateTable';

/** The local calendar day of `now`: its key and [since, until) in epoch ms. */
export function dayWindow(now: number): {
  day: string;
  since: number;
  until: number;
} {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = d.getMonth();
  const date = d.getDate();
  return {
    day: dayKey(d),
    since: new Date(y, m, date).getTime(),
    until: new Date(y, m, date + 1).getTime(),
  };
}

/** What dreams used in the local day of `now`; the tokens are counted the way the ledger counts them. */
export function usageToday(
  reader: Pick<OpenCodeReader, 'dreamTokens'>,
  priceEur: (model: string, t: BudgetTokens) => number | null,
  now: number,
): DreamUsage {
  const w = dayWindow(now);
  const { tokens, byModel } = reader.dreamTokens(w.since, w.until);
  let eur: number | null = 0;
  for (const [model, t] of Object.entries(byModel)) {
    const p = priceEur(model, t);
    eur = eur === null || p === null ? null : eur + p;
  }
  return { day: w.day, tokens, eur };
}

/** True when no more may be spent in the window the usage was measured for. A euro limit that cannot be measured stops dreaming. */
export function overLimit(limit: DreamLimit, usage: DreamUsage): boolean {
  if (limit.kind === 'none') return false;
  if (limit.kind === 'tokens') return usage.tokens >= limit.perDay;
  return usage.eur === null || usage.eur >= limit.perDay;
}

/** The model id without its provider (`anthropic/claude-sonnet-5-5` is priced as `claude-sonnet-5-5`), as the ledger prices a record. */
const modelOf = (model: string) => model.slice(model.indexOf('/') + 1);

/** The ledger's list price in EUR for a `provider/model`; null without a rate. */
export function priceDreamEur(model: string, t: BudgetTokens): number | null {
  return priceRecord(OFFICIAL_RATES, modelOf(model), false, t)?.costEur ?? null;
}

/** Whether the model has a rate; a euro limit is offered only then. */
export function hasPrice(model: string): boolean {
  return selectRate(OFFICIAL_RATES, modelOf(model), 0, false) !== null;
}

/** The limit as the runner and the scheduler use it. A limit not chosen yet (null) leaves no room. */
export function limitChecks(deps: {
  reader: Pick<OpenCodeReader, 'dreamTokens'>;
  priceEur?: (model: string, t: BudgetTokens) => number | null;
  limit: () => DreamLimit | null;
  now: () => number;
}) {
  const price = deps.priceEur ?? priceDreamEur;
  const usageAt = (t: number) => usageToday(deps.reader, price, t);
  return {
    usage: (): DreamUsage => usageAt(deps.now()),
    /** For the scheduler: may a new dream start now? */
    hasRoom(): boolean {
      const limit = deps.limit();
      return limit !== null && !overLimit(limit, usageAt(deps.now()));
    },
    /** For the runner: measured in the day the dream started in, also after midnight. */
    overLimitFor(startedAt: number): boolean {
      const limit = deps.limit();
      return limit === null || overLimit(limit, usageAt(startedAt));
    },
    /** For `DreamRunnerDeps.dreamTokens`. */
    tokens: (since: number, until: number): number =>
      deps.reader.dreamTokens(since, until).tokens,
  };
}
