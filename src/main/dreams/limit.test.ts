import { describe, expect, it, vi } from 'vitest';
import type { BudgetTokens } from '../../shared/budget';
import {
  dayWindow,
  hasPrice,
  limitChecks,
  overLimit,
  priceDreamEur,
  usageToday,
} from './limit';

const zero: BudgetTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
};
const at = (d: number, h: number, m: number) =>
  new Date(2026, 10, d, h, m, 0).getTime();

describe('overLimit', () => {
  it('tokens: at the limit is over, below it is not', () => {
    const l = { kind: 'tokens', perDay: 1000 } as const;
    expect(overLimit(l, { day: 'd', tokens: 1000, eur: 0 })).toBe(true);
    expect(overLimit(l, { day: 'd', tokens: 999, eur: 0 })).toBe(false);
  });
  it('none is never over', () => {
    expect(
      overLimit({ kind: 'none' }, { day: 'd', tokens: 1e12, eur: 1e9 }),
    ).toBe(false);
  });
  it('eur: compares euros; an unmeasurable (null) spend is over', () => {
    const l = { kind: 'eur', perDay: 2 } as const;
    expect(overLimit(l, { day: 'd', tokens: 1, eur: 2 })).toBe(true);
    expect(overLimit(l, { day: 'd', tokens: 1, eur: 1.99 })).toBe(false);
    expect(overLimit(l, { day: 'd', tokens: 1, eur: null })).toBe(true);
  });
});

describe('dayWindow', () => {
  it('23:59 and 00:01 the next day are different days that meet', () => {
    const a = dayWindow(at(20, 23, 59));
    const b = dayWindow(at(21, 0, 1));
    expect(a.day).toBe('2026-11-20');
    expect(b.day).toBe('2026-11-21');
    expect(a.until).toBe(b.since);
    expect(a.since).toBe(at(20, 0, 0));
  });
});

describe('usageToday', () => {
  const reader = (byModel: Record<string, BudgetTokens>, tokens = 0) => ({
    dreamTokens: vi.fn(() => ({ tokens, byModel })),
  });
  it('asks for the window of the given time and prices per model', () => {
    const r = reader(
      {
        'p/a': { ...zero, inputTokens: 1 },
        'p/b': { ...zero, inputTokens: 2 },
      },
      3,
    );
    const price = vi.fn((_m: string, t: BudgetTokens) => t.inputTokens * 0.5);
    const u = usageToday(r, price, at(20, 12, 0), 'p1');
    expect(r.dreamTokens).toHaveBeenCalledWith(
      at(20, 0, 0),
      at(21, 0, 0),
      'Shellie dream p1:',
    );
    expect(u).toEqual({ day: '2026-11-20', tokens: 3, eur: 1.5 });
  });
  it('eur is null when a used model has no price; zero with no usage', () => {
    expect(
      usageToday(
        reader({ 'p/a': { ...zero, inputTokens: 1 } }, 1),
        () => null,
        1,
        'p1',
      ).eur,
    ).toBeNull();
    expect(usageToday(reader({}), () => null, 1, 'p1').eur).toBe(0);
  });
});

describe('pricing', () => {
  it('hasPrice is true for a model with a rate (provider prefix ignored), false without', () => {
    expect(hasPrice('anthropic/claude-sonnet-5-5')).toBe(true);
    expect(hasPrice('nobody/not-a-model-7')).toBe(false);
  });
  it('priceDreamEur prices with the official table, null without a rate', () => {
    const t = { ...zero, inputTokens: 1_000_000 };
    expect(priceDreamEur('anthropic/claude-sonnet-5-5', t)).toBeGreaterThan(0);
    expect(priceDreamEur('nobody/not-a-model-7', t)).toBeNull();
  });
});

describe('limitChecks', () => {
  /** Project `p1` used 500 tokens on the 20th; every other project nothing. */
  const make = (
    limit: Parameters<typeof limitChecks>[0]['limit'],
    clock: { t: number },
  ) => {
    const dreamTokens = vi.fn(
      (since: number, _until: number, prefix?: string) => ({
        tokens:
          since === at(20, 0, 0) && prefix === 'Shellie dream p1:' ? 500 : 0,
        byModel: {},
      }),
    );
    const c = limitChecks({
      reader: { dreamTokens },
      priceEur: () => 0,
      limit,
      now: () => clock.t,
    });
    return { c, dreamTokens };
  };
  it('no limit chosen means no room', () => {
    expect(make(() => null, { t: at(20, 10, 0) }).c.hasRoom('p1')).toBe(false);
  });
  it('room while under the limit, none once over', () => {
    const clock = { t: at(20, 10, 0) };
    expect(
      make(() => ({ kind: 'tokens', perDay: 501 }), clock).c.hasRoom('p1'),
    ).toBe(true);
    expect(
      make(() => ({ kind: 'tokens', perDay: 500 }), clock).c.hasRoom('p1'),
    ).toBe(false);
    expect(make(() => ({ kind: 'none' }), clock).c.hasRoom('p1')).toBe(true);
  });
  it('each project has its own limit and its own usage', () => {
    const clock = { t: at(20, 10, 0) };
    const { c } = make(
      (p) => ({ kind: 'tokens', perDay: p === 'p1' ? 500 : 100 }),
      clock,
    );
    expect(c.hasRoom('p1')).toBe(false);
    expect(c.hasRoom('p2')).toBe(true);
    expect(c.usage('p2').tokens).toBe(0);
  });
  it('a run is measured against the day it started in, also after midnight', () => {
    const clock = { t: at(20, 23, 59) };
    const { c } = make(() => ({ kind: 'tokens', perDay: 500 }), clock);
    const startedAt = clock.t;
    expect(c.overLimitFor('p1', startedAt)).toBe(true);
    clock.t = at(21, 0, 1);
    expect(c.overLimitFor('p1', startedAt)).toBe(true); // still yesterday's day
    expect(c.hasRoom('p1')).toBe(true); // a new dream sees zero
    expect(c.overLimitFor('p1', clock.t)).toBe(false);
  });
  it('overLimitFor with no limit chosen is over; usage and tokens pass through', () => {
    const { c, dreamTokens } = make(() => null, { t: at(20, 10, 0) });
    expect(c.overLimitFor('p1', at(20, 10, 0))).toBe(true);
    expect(c.usage('p1')).toEqual({ day: '2026-11-20', tokens: 500, eur: 0 });
    expect(c.tokens('p1', at(20, 0, 0), 2)).toBe(500);
    expect(dreamTokens).toHaveBeenLastCalledWith(
      at(20, 0, 0),
      2,
      'Shellie dream p1:',
    );
  });
});
