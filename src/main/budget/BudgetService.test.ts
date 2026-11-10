import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BudgetRecord } from '../../shared/budget';
import { defaultBudgetSettings } from '../../shared/budget';
import type { Rate } from '../../shared/usage';
import { BudgetService, inShellieFor } from './BudgetService';
import { OFFICIAL_RATES } from '../pricing/officialRates';
import { BudgetStore } from './BudgetStore';

const opus = {
  id: 'anthropic-opus-5-5',
  label: 'Opus',
  match: ['claude-opus-5-5'],
  minInputTokens: 0,
  fast: false,
  inputPerM: 4,
  cachedInputPerM: 0.2,
  cacheWritePerM: 5,
  cacheWrite1hPerM: 8,
  outputPerM: 20,
} as Rate;
const rec = (id: string, eurMillions = 1): BudgetRecord => ({
  id,
  tool: 'claude-code',
  sessionId: 's',
  model: 'claude-opus-5-5',
  provider: 'anthropic',
  at: new Date(2026, 9, 10, 9).toISOString(),
  cwd: null,
  fast: false,
  inputTokens: eurMillions * 1e6,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
});

async function setup(
  records: BudgetRecord[],
  budget: number | null = 5,
  o: {
    copilot?: number | null;
    extra?: () => BudgetRecord[];
    forecastAlert?: boolean;
  } = {},
) {
  const store = new BudgetStore(
    path.join(mkdtempSync(path.join(os.tmpdir(), 'bsv-')), 'budget.json'),
    () => [opus],
  );
  await store.load();
  const notify = vi.fn();
  const changed = vi.fn();
  const telemetry = vi.fn();
  const claudeRead = vi.fn(async () => ({ records, cursors: {}, found: true }));
  const svc = new BudgetService({
    store,
    claude: { read: claudeRead },
    openCode: { read: () => ({ records: [], cursor: 0, found: false }) },
    settings: (v) => ({
      ...defaultBudgetSettings(),
      monthlyEur: v === 'claude' ? budget : (o.copilot ?? null),
      alerts: {
        at80: true,
        forecastOver: o.forecastAlert ?? true,
        at100: true,
      },
    }),
    extra: o.extra ?? (() => []),
    inShellie: () => () => false,
    now: () => new Date(2026, 9, 19, 12),
    changed,
    notify,
    telemetry,
  });
  return { svc, store, notify, changed, claudeRead, telemetry };
}

describe('BudgetService', () => {
  it('runs one pass at a time', async () => {
    const { svc, claudeRead } = await setup([]);
    await Promise.all([svc.pass(), svc.pass()]);
    expect(claudeRead).toHaveBeenCalledTimes(1);
  });

  it('broadcasts only when something changed', async () => {
    const { svc, changed } = await setup([rec('cc:a')]);
    await svc.pass();
    await svc.pass();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('fires each alert once per month, also after a restart', async () => {
    const { svc, store, notify } = await setup([rec('cc:a', 2)], 4); // 2M input at $4 = $8 → ~€7.36 > €4
    await svc.pass();
    await svc.pass();
    expect(notify.mock.calls.map((c) => c[0].title)).toEqual([
      'Claude budget: 80% used',
      'Claude budget: on pace to go over',
      'Claude budget: used up',
    ]);
    expect(store.value.alerts['claude:2026-10-01']).toEqual([
      'at80',
      'forecastOver',
      'at100',
    ]);
  });

  it('resolves a failed pass and logs it', async () => {
    const { svc, claudeRead } = await setup([]);
    claudeRead.mockRejectedValueOnce(new Error('disk gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(svc.pass()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    await svc.pass();
    expect(claudeRead).toHaveBeenCalledTimes(2);
  });

  it('labels models by their official rate, merging dated ids', async () => {
    const haiku = (id: string, model: string) => ({
      ...rec(id),
      model,
      inputTokens: 1000,
    });
    const store = new BudgetStore(
      path.join(mkdtempSync(path.join(os.tmpdir(), 'bsv-')), 'budget.json'),
      () => OFFICIAL_RATES,
    );
    await store.load();
    const svc = new BudgetService({
      store,
      claude: {
        read: async () => ({
          records: [
            haiku('cc:h1', 'claude-haiku-4-5-20251001'),
            haiku('cc:h2', 'claude-haiku-4-5'),
          ],
          cursors: {},
          found: true,
        }),
      },
      openCode: { read: () => ({ records: [], cursor: 0, found: false }) },
      settings: () => defaultBudgetSettings(),
      extra: () => [],
      inShellie: () => () => false,
      now: () => new Date(2026, 9, 19, 12),
      changed: () => {},
      notify: () => {},
    });
    await svc.pass();
    expect(
      svc.view('claude', 0).models.map((m) => [m.model, m.requests]),
    ).toEqual([['Claude Haiku 4.5', 2]]);
  });

  it('waits for an OpenCode read that answers later', async () => {
    const { svc, store } = await setup([rec('cc:a')], 4.33);
    (svc as unknown as { d: { openCode: { read: unknown } } }).d.openCode = {
      read: async () => ({ records: [], cursor: 42, found: true }),
    };
    await svc.pass();
    expect(store.value.openCodeCursor).toBe(42);
  });

  it('alerts per vendor', async () => {
    // 1M input at $4 = €3.68 → 85% of €4.33; Copilot spends nothing of €10.
    const { svc, notify, telemetry } = await setup([rec('cc:a')], 4.33, {
      copilot: 10,
      forecastAlert: false,
    });
    await svc.pass();
    await svc.pass();
    expect(notify.mock.calls.map((c) => c[0].title)).toEqual([
      'Claude budget: 80% used',
    ]);
    expect(telemetry).toHaveBeenCalledWith('claude', 'at80');
  });

  it('rolls up Copilot CLI records from the usage store', async () => {
    const cp: BudgetRecord = {
      ...rec('cp:trace:span'),
      tool: 'copilot-cli',
      provider: 'github-copilot',
      taskId: 't1',
    };
    const { svc } = await setup([], 5, { extra: () => [cp] });
    await svc.pass();
    const v = svc.view('copilot', 0);
    expect(v.spentEur).toBeGreaterThan(0);
    expect(v.models.map((m) => m.requests)).toEqual([1]);
    expect(svc.view('claude', 0).spentEur).toBe(0);
  });

  it('records sources and builds the view', async () => {
    const { svc } = await setup([rec('cc:a')]);
    await svc.pass();
    const v = svc.view('claude', 0);
    expect(v.sources).toEqual({ claudeCode: true, openCode: false });
    expect(v.spentEur).toBeGreaterThan(0);
  });
});

describe('inShellieFor', () => {
  const task = {
    id: 't',
    worktreePath: '/w/a',
    extraWorkspaces: [
      { id: 'x', repoId: 'r2', worktreePath: '/w/b', dropped: false },
    ],
    terminals: [{ id: '1', kind: 'claude', label: 'C', sessionId: 'S1' }],
    closedTerminals: [{ id: '2', kind: 'claude', label: 'C', sessionId: 'S2' }],
  } as never;
  const f = inShellieFor(() => [task])();
  const r = (o: Partial<BudgetRecord>) => ({ ...rec('x'), ...o });
  it('matches Claude Code by session id, open or closed tab', () => {
    expect(f(r({ sessionId: 'S1' }))).toBe(true);
    expect(f(r({ sessionId: 'S2' }))).toBe(true);
    expect(f(r({ sessionId: 'other' }))).toBe(false);
  });
  it('also matches sessions the usage store saw for a task, built once per pass', () => {
    const extra = vi.fn(() => new Set(['U1']));
    const g = inShellieFor(() => [task], extra)();
    expect(g(r({ sessionId: 'U1' }))).toBe(true);
    expect(g(r({ sessionId: 'S1' }))).toBe(true);
    expect(g(r({ sessionId: 'nope' }))).toBe(false);
    expect(g(r({ sessionId: 'nope2' }))).toBe(false);
    expect(extra).toHaveBeenCalledTimes(1);
  });
  it('counts records tagged with a task as in Shellie', () => {
    expect(
      f(r({ tool: 'copilot-cli', sessionId: 'x', cwd: null, taskId: 't' })),
    ).toBe(true);
    expect(f(r({ sessionId: 'sh-run', cwd: null, taskId: 't' }))).toBe(true);
  });
  it('matches OpenCode by working directory inside any task worktree', () => {
    expect(f(r({ tool: 'opencode', cwd: '/w/b/src' }))).toBe(true);
    expect(f(r({ tool: 'opencode', cwd: '/elsewhere' }))).toBe(false);
  });
});
