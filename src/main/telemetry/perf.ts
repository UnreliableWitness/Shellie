import type { Telemetry } from './AppInsightsClient';

export type Outcome = 'ok' | 'failed' | 'timeout';

type Stat = {
  metric: string;
  op: string;
  outcome: Outcome;
  count: number;
  sum: number;
  min: number;
  max: number;
};

/**
 * Timings of frequent operations (IPC calls, git commands), summed in memory and sent as one
 * aggregated metric per operation and outcome every few minutes: a busy session costs a few dozen
 * items per report, not one per call.
 */
export class PerfStats {
  private stats = new Map<string, Stat>();

  /** Operations kept per report at most; samples of further ones are dropped until the next report. */
  constructor(private readonly maxKeys = 300) {}

  record(metric: string, op: string, ms: number, outcome: Outcome = 'ok') {
    if (!Number.isFinite(ms)) return;
    const key = `${metric}\u0000${op}\u0000${outcome}`;
    const s = this.stats.get(key);
    if (s) {
      s.count++;
      s.sum += ms;
      s.min = Math.min(s.min, ms);
      s.max = Math.max(s.max, ms);
      return;
    }
    if (this.stats.size >= this.maxKeys) return;
    this.stats.set(key, {
      metric,
      op,
      outcome,
      count: 1,
      sum: ms,
      min: ms,
      max: ms,
    });
  }

  /** Times `fn` under `metric`/`op`; a rejection counts as `failed` (or `timeout`) and is rethrown. */
  async time<T>(metric: string, op: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      const out = await fn();
      this.record(metric, op, performance.now() - t0);
      return out;
    } catch (e) {
      this.record(
        metric,
        op,
        performance.now() - t0,
        isTimeout(e) ? 'timeout' : 'failed',
      );
      throw e;
    }
  }

  /** Sends one aggregated metric per operation and outcome, then starts over. */
  report(telemetry: Telemetry) {
    for (const s of this.stats.values())
      telemetry.metric(
        s.metric,
        Math.round(s.sum),
        { op: s.op, outcome: s.outcome },
        { count: s.count, min: Math.round(s.min), max: Math.round(s.max) },
      );
    this.stats.clear();
  }
}

function isTimeout(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === 'TimeoutError' || /timed out/i.test(e.message))
  );
}

/** The app's one instance: the git client and the IPC wrapper record here, main reports it. */
export const perf = new PerfStats();

/**
 * `git worktree add -b x /path` becomes `worktree add`; options and their values, paths, refs and
 * anything else that is not a plain subcommand word are left out.
 */
export function gitOperation(args: readonly string[]): string {
  let i = 0;
  // Global options before the subcommand; -c and -C take a value.
  while (i < args.length && args[i].startsWith('-')) {
    i += args[i] === '-c' || args[i] === '-C' ? 2 : 1;
  }
  const word = /^[a-z][a-z-]{0,30}$/;
  const sub = args[i];
  if (sub === undefined || !word.test(sub)) return 'other';
  const next = args[i + 1];
  return WITH_ACTION.has(sub) && next !== undefined && word.test(next)
    ? `${sub} ${next}`
    : sub;
}

/** Subcommands whose next word is an action worth telling apart (`worktree add` vs `worktree remove`). */
const WITH_ACTION = new Set([
  'worktree',
  'stash',
  'remote',
  'submodule',
  'lfs',
  'notes',
]);
