import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CostRecord } from '../../shared/ledger';
import { CostSender } from './CostSender';
import { CostServerError } from './client';

const conn = { url: 'https://cost.example', email: 'a@b.c', key: 'k' };
const rec = (id: string, at = '2026-10-01T00:00:00Z') =>
  ({ id, at }) as CostRecord;
const budgets = { claude: null, copilot: null };

/** What cost-server.json keeps between launches. */
type Persisted = { lastSentAt: string | null; refused: string | null };

function make(
  ids: string[],
  connection: typeof conn | null = conn,
  persisted: Persisted = { lastSentAt: null, refused: null },
) {
  const sent = new Set<string>();
  const records = ids.map((id, i) =>
    rec(
      id,
      `2026-10-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
    ),
  );
  const ledger = {
    dirty: vi.fn((limit: number) =>
      records.filter((r) => !sent.has(r.id)).slice(0, limit),
    ),
    markSent: vi.fn(async (rs: CostRecord[]) => {
      for (const r of rs) sent.add(r.id);
    }),
    resetSent: vi.fn(async () => sent.clear()),
    dirtyCount: vi.fn(() => records.filter((r) => !sent.has(r.id)).length),
    flushSent: vi.fn(async () => {}),
  };
  const server = {
    get: vi.fn((): typeof conn | null => connection),
    budgets: null as typeof budgets | null,
    setBudgets: vi.fn(async () => {}),
    get lastSentAt() {
      return persisted.lastSentAt;
    },
    get refused() {
      return persisted.refused;
    },
    setLastSentAt: vi.fn(async (at: string | null) => {
      persisted.lastSentAt = at;
    }),
    setRefused: vi.fn(async (sig: string | null) => {
      persisted.refused = sig;
    }),
  };
  const send = vi.fn(async (_c: unknown, rs: CostRecord[]) => rs.length);
  const hello = vi.fn(async () => ({ email: 'a@b.c', budgets }));
  const notice = vi.fn();
  const telemetry = vi.fn();
  const sender = new CostSender({
    ledger,
    server,
    send: send as never,
    hello: hello as never,
    status: vi.fn(),
    notice,
    telemetry,
  });
  return {
    sender,
    ledger,
    server,
    send,
    hello,
    notice,
    telemetry,
    sent,
    persisted,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('CostSender', () => {
  it('sends dirty records in batches of 500, oldest first', async () => {
    const t = make(Array.from({ length: 1200 }, (_, i) => `cc:${i}`));
    t.sender.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.send.mock.calls.map((c) => c[1].length)).toEqual([500, 500, 200]);
    expect(t.send.mock.calls[0]![1][0]!.id).toBe('cc:0');
    expect(t.sent.size).toBe(1200);
    expect(t.server.setBudgets).toHaveBeenCalledWith(budgets);
    t.sender.stop();
  });

  it('lists the dirty records once per pass and saves the sent marks once at its end', async () => {
    const t = make(Array.from({ length: 1200 }, (_, i) => `cc:${i}`));
    t.sender.start();
    // The first pass runs 30 s after start; the next one would be minutes later.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.send).toHaveBeenCalledTimes(3);
    expect(t.ledger.dirty).toHaveBeenCalledTimes(1);
    expect(t.ledger.markSent).toHaveBeenCalledTimes(3);
    expect(t.ledger.flushSent).toHaveBeenCalledTimes(1);
    t.sender.stop();
  });

  it('keeps records and backs off while the server is down, then catches up', async () => {
    const t = make(['cc:1', 'cc:2']);
    const fail = () => Promise.reject(new CostServerError('network'));
    t.send
      .mockImplementationOnce(fail)
      .mockImplementationOnce(fail)
      .mockImplementationOnce(fail);
    t.sender.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.sent.size).toBe(0);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(t.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000); // 1 min
    expect(t.send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(t.send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000); // 2 min
    expect(t.send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(240_000); // 4 min
    expect(t.send).toHaveBeenCalledTimes(4);
    expect(t.sent).toEqual(new Set(['cc:1', 'cc:2']));
    expect(t.telemetry).toHaveBeenCalledWith('costServer.sendFailed', {
      kind: 'network',
      status: 0,
    });
    t.sender.stop();
  });

  it('stops and tells once on a refused key', async () => {
    const t = make(['cc:1']);
    t.send.mockRejectedValue(new CostServerError('auth', 401));
    t.sender.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    t.sender.kick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.notice).toHaveBeenCalledTimes(1);
    expect(t.notice).toHaveBeenCalledWith(
      'Your cost server refused the key. Check Settings › Cost server.',
    );
    expect(t.sender.status().error).toBe('The server refused the key');
    t.send.mockImplementation(async (_c, rs) => rs.length);
    await t.sender.onConnected();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.sent.size).toBe(1);
    t.sender.stop();
  });

  it('remembers the last send and a refused key across a restart', async () => {
    const t = make(['cc:1', 'cc:2']);
    t.sender.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const at = t.sender.status().lastSentAt;
    expect(at).not.toBeNull();
    expect(t.persisted.lastSentAt).toBe(at);
    t.sender.stop();

    // Relaunch: the same file, the server now refuses the key.
    const again = make(['cc:1', 'cc:2', 'cc:3'], conn, t.persisted);
    for (const id of ['cc:1', 'cc:2']) again.sent.add(id);
    expect(again.sender.status()).toMatchObject({
      lastSentAt: at,
      waiting: 1,
    });
    again.hello.mockRejectedValue(new CostServerError('auth', 401));
    again.sender.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(again.notice).toHaveBeenCalledTimes(1);
    // The marker is a hash: never the key itself.
    expect(again.persisted.refused).toMatch(/^[0-9a-f]{64}$/);
    expect(again.persisted.refused).not.toContain(conn.key);
    again.sender.stop();

    // Another relaunch with the same refused key: no notice, nothing tried, the status says why.
    const third = make(['cc:3'], conn, again.persisted);
    third.sender.start();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(third.notice).not.toHaveBeenCalled();
    expect(third.hello).not.toHaveBeenCalled();
    expect(third.send).not.toHaveBeenCalled();
    expect(third.sender.status()).toMatchObject({
      connected: false,
      error: 'The server refused the key',
      lastSentAt: at,
    });
    // Connecting again clears the marker.
    await third.sender.onConnected();
    expect(third.persisted.refused).toBeNull();
    third.sender.stop();
  });

  it('counts what is waiting when asked, not only after a pass', async () => {
    const t = make(['cc:1', 'cc:2', 'cc:3']);
    expect(t.sender.status().waiting).toBe(3);
    t.sent.add('cc:1');
    expect(t.sender.status().waiting).toBe(2);
    expect(t.ledger.dirty).not.toHaveBeenCalled();
    expect(make(['cc:1'], null).sender.status().waiting).toBe(0);
  });

  it('skips one bad record without blocking the rest', async () => {
    const t = make(['cc:1', 'cc:bad', 'cc:3']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.send.mockImplementation(async (_c, rs) => {
      if (rs.some((r) => r.id === 'cc:bad'))
        throw new CostServerError('rejected', 400);
      return rs.length;
    });
    t.sender.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.sent).toEqual(new Set(['cc:1', 'cc:3']));
    expect(warn.mock.calls.flat().join(' ')).toContain('cc:bad');
    t.sender.stop();
    warn.mockRestore();
  });

  it('backfills everything after connecting', async () => {
    const t = make(['cc:1', 'cc:2']);
    t.sent.add('cc:1');
    t.sent.add('cc:2');
    await t.sender.onConnected();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.ledger.resetSent).toHaveBeenCalled();
    expect(t.sent.size).toBe(2);
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.hello).toHaveBeenCalledTimes(1);
    t.sender.stop();
  });

  it('says hello on the first pass after start, once per pass', async () => {
    const t = make(['cc:1']);
    t.server.budgets = budgets;
    t.sender.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.hello).toHaveBeenCalledTimes(1);
    expect(t.server.setBudgets).toHaveBeenCalledWith(budgets);
    t.sender.kick();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.hello).toHaveBeenCalledTimes(1);
    t.sender.stop();
  });

  it('sends records again to a new server when it changes mid-send', async () => {
    const t = make(['cc:1', 'cc:2']);
    let release: () => void = () => {};
    t.send.mockImplementationOnce(
      (_c, rs) =>
        new Promise<number>((resolve) => {
          release = () => resolve(rs.length);
        }),
    );
    t.sender.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.send).toHaveBeenCalledTimes(1);
    const next = { ...conn, url: 'https://new.example' };
    t.server.get.mockReturnValue(next);
    await t.sender.onConnected();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.size).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.send).toHaveBeenCalledTimes(2);
    expect(t.send.mock.calls[1]![0]).toEqual(next);
    expect(t.sent).toEqual(new Set(['cc:1', 'cc:2']));
    t.sender.stop();
  });

  it('does nothing without a connection', async () => {
    const t = make(['cc:1'], null);
    t.sender.start();
    await vi.advanceTimersByTimeAsync(30_000);
    t.sender.kick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.hello).not.toHaveBeenCalled();
    expect(t.sender.status().connected).toBe(false);
    t.sender.stop();
  });
});
