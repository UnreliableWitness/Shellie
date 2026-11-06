import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CostRecord } from '../../shared/ledger';
import { LedgerStore } from './LedgerStore';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const rec = (id: string, over: Partial<CostRecord> = {}): CostRecord => ({
  id,
  tool: 'claude-code',
  provider: 'anthropic',
  vendor: 'claude',
  model: 'claude-sonnet-5-5',
  modelLabel: 'Sonnet 5.5',
  at: '2026-10-10T10:00:00Z',
  fast: false,
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  costUsd: 0.01,
  costEur: 0.0092,
  rateId: 'r1',
  billable: true,
  attribution: { level: 'none' },
  developer: null,
  shellieVersion: '1.0.0',
  ...over,
});

const lines = async (f: string) =>
  (await fs.readFile(path.join(dir, f), 'utf8'))
    .split('\n')
    .filter((l) => l.trim());

describe('LedgerStore', () => {
  it('keeps the latest version per id across reloads', async () => {
    const s = new LedgerStore(dir);
    await s.load();
    await s.upsert([rec('cc:a', { inputTokens: 1 })]);
    await s.upsert([rec('cc:a', { inputTokens: 9 })]);
    const s2 = new LedgerStore(dir);
    await s2.load();
    expect(s2.get('cc:a')?.inputTokens).toBe(9);
    expect(s2.all()).toHaveLength(1);
  });

  it('returns no change for an identical upsert', async () => {
    const s = new LedgerStore(dir);
    await s.load();
    expect(await s.upsert([rec('cc:a')])).toEqual(['cc:a']);
    const before = await lines('records-2026-10.jsonl');
    expect(await s.upsert([rec('cc:a')])).toEqual([]);
    expect(await lines('records-2026-10.jsonl')).toHaveLength(before.length);
  });

  it('lists dirty records oldest first and clears them when sent', async () => {
    const s = new LedgerStore(dir);
    await s.load();
    const a = rec('cc:a', { at: '2026-10-01T00:00:00Z' });
    const b = rec('cc:b', { at: '2026-10-02T00:00:00Z' });
    const c = rec('cc:c', { at: '2026-10-03T00:00:00Z' });
    await s.upsert([c, b, a]);
    expect(s.dirty(500).map((r) => r.id)).toEqual(['cc:a', 'cc:b', 'cc:c']);
    await s.markSent([a, b]);
    expect(s.dirty(500).map((r) => r.id)).toEqual(['cc:c']);
    expect(s.dirtyCount()).toBe(1);
    await s.upsert([{ ...a, billable: false }]);
    expect(s.dirty(500).map((r) => r.id)).toEqual(['cc:a', 'cc:c']);
    await s.resetSent();
    expect(s.dirty(500)).toHaveLength(3);
    expect(s.dirtyCount()).toBe(3);
    expect(s.dirty(2)).toHaveLength(2);
  });

  it('never lists brain records as dirty', async () => {
    const s = new LedgerStore(dir);
    await s.load();
    const brain = rec('br:a', {
      attribution: {
        level: 'brain',
        brainId: 'b1',
        organization: 'o',
        project: 'p',
      },
      billable: false,
    });
    await s.upsert([brain, rec('cc:a')]);
    expect(s.dirty(500).map((r) => r.id)).toEqual(['cc:a']);
    expect(s.dirtyCount()).toBe(1);
  });

  it('keeps sent state across reloads', async () => {
    const s = new LedgerStore(dir);
    await s.load();
    const a = rec('cc:a');
    await s.upsert([a]);
    await s.markSent([a]);
    // Kept in memory until flushed: a reload before that sends the record again.
    expect(s.dirty(500)).toEqual([]);
    const early = new LedgerStore(dir);
    await early.load();
    expect(early.dirty(500).map((r) => r.id)).toEqual(['cc:a']);
    await s.flushSent();
    const s2 = new LedgerStore(dir);
    await s2.load();
    expect(s2.dirty(500)).toEqual([]);
  });

  it('writes sent marks within a few seconds without a flush', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const s = new LedgerStore(dir);
      await s.load();
      const a = rec('cc:a');
      await s.upsert([a]);
      await s.markSent([a]);
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }
    // The timer started the write; it finishes on the real file system.
    await vi.waitFor(() =>
      expect(existsSync(path.join(dir, 'sent.json'))).toBe(true),
    );
    const s2 = new LedgerStore(dir);
    await s2.load();
    expect(s2.dirty(500)).toEqual([]);
  });

  it('compacts a month file with more superseded lines than live', async () => {
    const s = new LedgerStore(dir);
    await s.load();
    for (let i = 1; i <= 5; i++)
      await s.upsert([rec('cc:a', { inputTokens: i })]);
    expect(await lines('records-2026-10.jsonl')).toHaveLength(5);
    const s2 = new LedgerStore(dir);
    await s2.load();
    expect(await lines('records-2026-10.jsonl')).toHaveLength(1);
    expect(s2.get('cc:a')?.inputTokens).toBe(5);
  });

  it('splits by UTC month of at', async () => {
    const s = new LedgerStore(dir);
    await s.load();
    await s.upsert([
      rec('cc:a', { at: '2026-09-30T23:30:00Z' }),
      rec('cc:b', { at: '2026-10-01T00:30:00Z' }),
    ]);
    expect(await lines('records-2026-09.jsonl')).toHaveLength(1);
    expect(await lines('records-2026-10.jsonl')).toHaveLength(1);
  });

  it('skips a corrupt line', async () => {
    const good = (id: string) => JSON.stringify(rec(id));
    await fs.writeFile(
      path.join(dir, 'records-2026-10.jsonl'),
      `${good('cc:a')}\n{garbage\n${good('cc:b')}\n`,
    );
    const s = new LedgerStore(dir);
    await s.load();
    expect(
      s
        .all()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['cc:a', 'cc:b']);
  });

  it('leaves nothing dirty after a no-op re-upsert following markSent', async () => {
    const s = new LedgerStore(dir);
    await s.load();
    const a = rec('cc:a');
    await s.upsert([a]);
    await s.markSent([a]);
    expect(await s.upsert([rec('cc:a')])).toEqual([]);
    expect(s.dirty(500)).toEqual([]);
  });

  it('keeps everything dirty after resetSent and a reload', async () => {
    const s = new LedgerStore(dir);
    await s.load();
    const a = rec('cc:a');
    await s.upsert([a]);
    await s.markSent([a]);
    await s.resetSent();
    const s2 = new LedgerStore(dir);
    await s2.load();
    expect(s2.dirty(500).map((r) => r.id)).toEqual(['cc:a']);
  });

  it('repairs a month file that ends in a partial line before the next append', async () => {
    const file = path.join(dir, 'records-2026-10.jsonl');
    await fs.writeFile(
      file,
      `${JSON.stringify(rec('cc:a'))}\n{"id":"cc:torn","at":"2026-1`,
    );
    const s = new LedgerStore(dir);
    await s.load();
    await s.upsert([rec('cc:b')]);
    const s2 = new LedgerStore(dir);
    await s2.load();
    expect(
      s2
        .all()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['cc:a', 'cc:b']);
  });
});
