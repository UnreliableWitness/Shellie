import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OFFICIAL_USD_TO_EUR, type UsageEvent } from '../../shared/usage';
import { OFFICIAL_RATES } from '../pricing/officialRates';
import { UsageStore } from './UsageStore';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'shellie-usage-'));
  dirs.push(d);
  return d;
};
const ev = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  id: 'r1',
  taskId: 't1',
  tool: 'claude-code',
  sessionId: 's1',
  model: 'claude-opus-5-5',
  at: '2026-10-14T10:00:00.000Z',
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 10000,
  cacheWriteTokens: 2000,
  fast: false,
  ...over,
});

describe('UsageStore', () => {
  it('prices, appends to the monthly file and emits changed', async () => {
    const d = dir();
    const s = new UsageStore(d, () => OFFICIAL_RATES);
    await s.load();
    const changed: string[] = [];
    s.on('changed', (t) => changed.push(t));
    const rec = await s.add(ev());
    expect(rec?.costUsd).toBe(0.026);
    expect(readdirSync(d)).toContain('records-2026-10.jsonl');
    expect(changed).toEqual(['t1']);
  });

  it('dedupes by id, also across a reload', async () => {
    const d = dir();
    const a = new UsageStore(d, () => OFFICIAL_RATES);
    await a.load();
    await a.add(ev());
    expect(await a.add(ev())).toBeNull();
    const b = new UsageStore(d, () => OFFICIAL_RATES);
    await b.load();
    expect(await b.add(ev())).toBeNull();
    expect(b.records('t1')).toHaveLength(1);
    expect(
      readFileSync(path.join(d, 'records-2026-10.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
  });

  it('lists every record across tasks', async () => {
    const s = new UsageStore(dir(), () => OFFICIAL_RATES);
    await s.load();
    await s.add(ev());
    await s.add(ev({ id: 'r2', taskId: 't2' }));
    expect(
      s
        .allRecords()
        .map((r) => [r.id, r.taskId])
        .sort(),
    ).toEqual([
      ['r1', 't1'],
      ['r2', 't2'],
    ]);
  });

  it('keeps the rate it was priced with when rates change later', async () => {
    const d = dir();
    let rates = OFFICIAL_RATES;
    const s = new UsageStore(d, () => rates);
    await s.load();
    await s.add(ev());
    rates = OFFICIAL_RATES.map((r) =>
      r.id === 'anthropic-opus-5-5' ? { ...r, inputPerM: 100 } : r,
    );
    await s.add(ev({ id: 'r2' }));
    const [first, second] = s.records('t1');
    expect(first.rate?.inputPerM).toBe(4);
    expect(second.rate?.inputPerM).toBe(100);
  });

  it('skips damaged lines and counts them', async () => {
    const d = dir();
    const a = new UsageStore(d, () => OFFICIAL_RATES);
    await a.load();
    await a.add(ev());
    appendFileSync(path.join(d, 'records-2026-10.jsonl'), '{"id":"broken"\n');
    const b = new UsageStore(d, () => OFFICIAL_RATES);
    expect(await b.load()).toEqual({ damagedLines: 1, billableBackup: null });
    expect(b.records('t1')).toHaveLength(1);
  });

  it('summarizes per session with billable flags, EUR and unpriced counts', async () => {
    const s = new UsageStore(dir(), () => OFFICIAL_RATES);
    await s.load();
    await s.add(ev({ id: 'a', sessionId: 's1' }));
    await s.add(
      ev({
        id: 'b',
        sessionId: 's1',
        model: 'claude-sonnet-5-5',
        at: '2026-10-14T10:05:00.000Z',
      }),
    );
    await s.add(
      ev({
        id: 'c',
        sessionId: 's2',
        tool: 'copilot-cli',
        model: 'mystery',
        at: '2026-10-14T11:00:00.000Z',
      }),
    );
    await s.setBillable('t1', 's1', true);
    let u = s.summarize('t1');
    expect(u.sessions.map((x) => [x.sessionId, x.requests, x.models])).toEqual([
      ['s1', 2, ['claude-opus-5-5', 'claude-sonnet-5-5']],
      ['s2', 1, ['mystery']],
    ]);
    expect(u.unpricedRequests).toBe(1);
    expect(u.byTool['claude-code'].sessions).toBe(1);
    expect(u.billable.costEur).toBeCloseTo(
      u.billable.costUsd * OFFICIAL_USD_TO_EUR,
      6,
    );
    expect(u.usdToEur).toBe(0.92);
    expect('markupPct' in u).toBe(false);
    await s.setBillable('t1', 's1', false);
    u = s.summarize('t1');
    expect(u.sessions.find((x) => x.sessionId === 's1')?.billable).toBe(false);
    expect(u.billable.costUsd).toBe(0);
  });

  it('lists tasks changed since a time', async () => {
    const s = new UsageStore(dir(), () => OFFICIAL_RATES);
    await s.load();
    await s.add(ev({ id: 'x', taskId: 'tA' }));
    const mark = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await s.add(ev({ id: 'y', taskId: 'tB' }));
    expect(s.changedSince(mark)).toEqual(['tB']);
  });

  it('backs up a corrupt billable.json and starts with every session billable', async () => {
    for (const garbage of ['{not json', '[1,2]']) {
      const d = dir();
      const a = new UsageStore(d, () => OFFICIAL_RATES);
      await a.load();
      await a.add(ev());
      await a.setBillable('t1', 's1', false);
      writeFileSync(path.join(d, 'billable.json'), garbage);
      const b = new UsageStore(d, () => OFFICIAL_RATES);
      const res = await b.load();
      expect(res.damagedLines).toBe(0);
      expect(res.billableBackup).not.toBeNull();
      expect(res.billableBackup).toMatch(/billable\.json\.corrupt-\d+$/);
      expect(existsSync(res.billableBackup as string)).toBe(true);
      expect(existsSync(path.join(d, 'billable.json'))).toBe(false);
      expect(b.isBillable('t1', 's1')).toBe(true);
      expect(b.summarize('t1').sessions[0].billable).toBe(true);
    }
  });

  it('persists concurrent setBillable calls for different sessions', async () => {
    const d = dir();
    const s = new UsageStore(d, () => OFFICIAL_RATES);
    await s.load();
    await Promise.all([
      s.setBillable('t1', 's1', false),
      s.setBillable('t1', 's2', false),
    ]);
    const b = new UsageStore(d, () => OFFICIAL_RATES);
    await b.load();
    expect(b.isBillable('t1', 's1')).toBe(false);
    expect(b.isBillable('t1', 's2')).toBe(false);
  });
  it('files a record with an unusable timestamp under the current month', async () => {
    const d = dir();
    const s = new UsageStore(d, () => OFFICIAL_RATES);
    await s.load();
    await s.add(ev({ id: 'far', at: '+010000-01-01T00:00:00.000Z' }));
    const month = new Date().toISOString().slice(0, 7);
    expect(readdirSync(d)).toEqual([`records-${month}.jsonl`]);
    const b = new UsageStore(d, () => OFFICIAL_RATES);
    await b.load();
    expect(b.records('t1').map((r) => r.id)).toEqual(['far']);
  });
});

describe('summarize views', () => {
  it('reports lastAt per session and recent billable priced points in the last 6 hours', async () => {
    const s = new UsageStore(dir(), () => OFFICIAL_RATES);
    await s.load();
    const now = Date.parse('2026-10-14T12:00:00.000Z');
    const iso = (minAgo: number) =>
      new Date(now - minAgo * 60_000).toISOString();
    await s.add(ev({ id: 'e1', sessionId: 's1', at: iso(400) }));
    await s.add(ev({ id: 'e2', sessionId: 's1', at: iso(30) }));
    await s.add(ev({ id: 'e3', sessionId: 's2', at: iso(10) }));
    await s.setBillable('t1', 's2', false);
    const u = s.summarize('t1', now);
    expect(u.sessions.find((x) => x.sessionId === 's1')!.lastAt).toBe(iso(30));
    expect(u.sessions.find((x) => x.sessionId === 's1')!.startedAt).toBe(
      iso(400),
    );
    expect(u.recent.map((r) => r.at)).toEqual([iso(30)]);
    expect(u.recent[0].costEur).toBeGreaterThan(0);
  });
});

describe('summarize byModel', () => {
  it('totals billable usage per tool and readable model name, most expensive first', async () => {
    const s = new UsageStore(dir(), () => OFFICIAL_RATES);
    await s.load();
    await s.add(ev({ id: 'a', model: 'claude-haiku-5-5' }));
    await s.add(ev({ id: 'b', model: 'claude-sonnet-5-5' }));
    await s.add(ev({ id: 'c', model: 'claude-sonnet-5-5-20261001' }));
    await s.add(ev({ id: 'd', model: 'mystery-1', sessionId: 's2' }));
    await s.add(ev({ id: 'e', model: 'claude-opus-5-5', sessionId: 's3' }));
    await s.setBillable('t1', 's3', false);
    const u = s.summarize('t1');
    const cost = (ids: string[]) =>
      s
        .records('t1')
        .filter((r) => ids.includes(r.id))
        .reduce((n, r) => n + (r.costUsd ?? 0) * OFFICIAL_USD_TO_EUR, 0);
    expect(u.byModel.map((m) => [m.label, m.requests])).toEqual([
      ['Claude Sonnet 5.5', 2],
      ['Claude Haiku 5.5', 1],
      ['mystery-1', 1],
    ]);
    expect(u.byModel[0].model).toBe('claude-sonnet-5-5');
    expect(u.byModel[0].costEur).toBeCloseTo(cost(['b', 'c']), 5);
    expect(u.byModel[1].costEur).toBeCloseTo(cost(['a']), 5);
    expect(u.byModel[2]).toMatchObject({ costEur: 0, unpricedRequests: 1 });
    expect(u.byModel[0].tokens).toBe(2 * 13500);
  });
});

describe('summarize lineage', () => {
  it('nests subagents under their session and adds up to the billable total', async () => {
    const s = new UsageStore(dir(), () => OFFICIAL_RATES);
    await s.load();
    await s.add(ev({ id: 'main', effort: 'high' }));
    await s.add(ev({ id: 'x', agent: 'Explore', model: 'claude-haiku-5-5' }));
    await s.add(ev({ id: 'p', agent: 'Plan', model: 'claude-sonnet-5-5' }));
    await s.add(ev({ id: 'off', sessionId: 's2' }));
    await s.setBillable('t1', 's2', false);
    const u = s.summarize('t1');
    expect(u.lineage).toHaveLength(1);
    const [root] = u.lineage!;
    expect(root).toMatchObject({
      id: 's1',
      modelLabel: 'Claude Opus 5.5',
      effort: 'high',
      requests: 3,
    });
    expect(root.children.map((c) => [c.label, c.modelLabel])).toEqual([
      ['Explore', 'Claude Haiku 5.5'],
      ['Plan', 'Claude Sonnet 5.5'],
    ]);
    const own = s
      .records('t1')
      .filter((r) => r.sessionId === 's1')
      .reduce((n, r) => n + r.costUsd!, 0);
    expect(root.costUsd).toBeCloseTo(own, 6);
    expect(root.costEur).toBeCloseTo(u.billable.costEur, 6);
    expect(root.tokens).toBe(u.billable.tokens);
  });
});

describe('OpenCode usage', () => {
  it('accepts OpenCode requests and totals them as their own tool', async () => {
    const s = new UsageStore(dir(), () => OFFICIAL_RATES);
    await s.load();
    await s.add(ev({ id: 'a' }));
    await s.add(
      ev({
        id: 'oc:1',
        tool: 'opencode',
        sessionId: 'o1',
        model: 'claude-sonnet-5-5',
      }),
    );
    const u = s.summarize('t1', Date.parse('2026-10-14T11:00:00.000Z'));
    expect(u.byTool.opencode.sessions).toBe(1);
    expect(u.byTool.opencode.costEur).toBeGreaterThan(0);
    expect(u.byTool['claude-code'].sessions).toBe(1);
    expect(u.sessions.map((x) => x.tool)).toEqual(['claude-code', 'opencode']);
    expect(u.byModel.find((m) => m.tool === 'opencode')?.label).toBe(
      'Claude Sonnet 5.5',
    );
    expect(u.recent.map((r) => r.tool)).toContain('opencode');
  });
});
