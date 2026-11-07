import { describe, expect, it, vi } from 'vitest';
import { NoopTelemetry, type Telemetry } from './AppInsightsClient';
import { gitOperation, PerfStats } from './perf';

function fake() {
  const metric = vi.fn();
  const t: Telemetry = { ...NoopTelemetry, metric };
  return { t, metric };
}

describe('PerfStats', () => {
  it('sends one summary per operation and outcome, then starts over', () => {
    const p = new PerfStats();
    p.record('ipc.ms', 'tasks:list', 10);
    p.record('ipc.ms', 'tasks:list', 30.4);
    p.record('ipc.ms', 'tasks:list', 5, 'failed');
    const { t, metric } = fake();
    p.report(t);
    expect(metric.mock.calls).toEqual([
      [
        'ipc.ms',
        40,
        { op: 'tasks:list', outcome: 'ok' },
        { count: 2, min: 10, max: 30 },
      ],
      [
        'ipc.ms',
        5,
        { op: 'tasks:list', outcome: 'failed' },
        { count: 1, min: 5, max: 5 },
      ],
    ]);
    metric.mockClear();
    p.report(t);
    expect(metric).not.toHaveBeenCalled();
  });

  it('keeps at most maxKeys operations per report', () => {
    const p = new PerfStats(2);
    p.record('git.ms', 'a', 1);
    p.record('git.ms', 'b', 1);
    p.record('git.ms', 'c', 1);
    p.record('git.ms', 'a', 1);
    const { t, metric } = fake();
    p.report(t);
    expect(metric.mock.calls.map((c) => [c[2].op, c[3].count])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
  });

  it('times a promise and records a rejection as failed or timeout', async () => {
    const p = new PerfStats();
    await expect(p.time('git.ms', 'fetch', async () => 7)).resolves.toBe(7);
    await expect(
      p.time('git.ms', 'fetch', async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    await expect(
      p.time('git.ms', 'push', async () => {
        throw new Error('git push timed out');
      }),
    ).rejects.toThrow();
    const { t, metric } = fake();
    p.report(t);
    expect(metric.mock.calls.map((c) => `${c[2].op}:${c[2].outcome}`)).toEqual([
      'fetch:ok',
      'fetch:failed',
      'push:timeout',
    ]);
  });
});

describe('gitOperation', () => {
  it('keeps the subcommand and its action, never paths, refs or options', () => {
    expect(gitOperation(['status', '--porcelain'])).toBe('status');
    expect(
      gitOperation(['worktree', 'add', '-b', 'feat/x', '/Users/me/repo']),
    ).toBe('worktree add');
    expect(gitOperation(['-c', 'core.quotepath=off', 'diff', 'HEAD'])).toBe(
      'diff',
    );
    expect(gitOperation(['-C', '/tmp/x', 'rev-parse', 'HEAD'])).toBe(
      'rev-parse',
    );
    expect(gitOperation(['stash', 'push', '-u'])).toBe('stash push');
    expect(gitOperation(['branch', '-D', 'customer-x'])).toBe('branch');
    expect(gitOperation(['/weird/path'])).toBe('other');
    expect(gitOperation([])).toBe('other');
  });
});
