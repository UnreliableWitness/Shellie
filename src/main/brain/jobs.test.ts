import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../platform/Platform';
import { BrainJobRunner, brainJobEnv, type BrainJobDeps } from './jobs';
import { acquireLock, readState } from './state';

const ok = (id: string) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'ok',
    session_id: id,
  });

let dirs: Record<string, string>;
let calls: {
  cmd: Command;
  cwd: string;
  input: string;
  env?: Record<string, string>;
}[];
let tokens: number;
let commits: [string, string][];
let runners: BrainJobRunner[];
let run: (
  cmd: Command,
  o: { cwd: string; input: string; env?: Record<string, string> },
) => Promise<string>;

async function mk(name: string) {
  const d = await mkdtemp(path.join(tmpdir(), `brain-jobs-${name}-`));
  await mkdir(path.join(d, 'brain'));
  await writeFile(path.join(d, 'brain', 'state.json'), '{"schemaVersion":1}');
  return d;
}

function runner(over: Partial<BrainJobDeps> = {}) {
  const r = new BrainJobRunner({
    platform: {
      claudeCommand: (_c, flags) => ({
        command: 'claude',
        args: flags ?? [],
        env: {},
      }),
    },
    run: ((cmd, o) => {
      calls.push({ cmd, cwd: o.cwd, input: o.input, env: o.env });
      return run(cmd, o);
    }) as BrainJobDeps['run'],
    env: (id) => ({ BRAIN: id }),
    tokensToday: () => tokens,
    cap: () => 500_000,
    brainDir: (id) => dirs[id],
    model: () => 'sonnet',
    onChange: () => undefined,
    commit: async (id, message) => {
      commits.push([id, message]);
    },
    lockRetryMs: 5000,
    ...over,
  });
  runners.push(r);
  return r;
}

const idle = (r: BrainJobRunner, id: string) =>
  vi.waitFor(() => {
    expect(r.running(id)).toBe(false);
    expect(
      r.jobs(id).every((j) => j.status !== 'queued' && j.status !== 'running'),
    ).toBe(true);
  });

beforeEach(async () => {
  dirs = { b1: await mk('1'), b2: await mk('2') };
  calls = [];
  commits = [];
  tokens = 0;
  runners = [];
  let n = 0;
  run = async () => ok(`sess-${++n}`);
});
afterEach(async () => {
  runners.forEach((r) => r.stop());
  vi.useRealTimers();
  await Promise.all(
    Object.values(dirs).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe('BrainJobRunner', () => {
  it('runs a capture then an auto lint, in order, with the right prompt and flags', async () => {
    const r = runner();
    r.enqueue('b1', 'capture', 'sources/a.md');
    r.enqueue('b1', 'sync');
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    await idle(r, 'b1');
    expect(calls.map((c) => c.input)).toEqual([
      '/capture sources/a.md',
      '/lint',
      '/sync',
    ]);
    expect(calls[0].cmd.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'sonnet',
      '--permission-mode',
      'acceptEdits',
      '--strict-mcp-config',
    ]);
    expect(calls[0].cwd).toBe(dirs.b1);
    expect(calls[0].env).toEqual({ BRAIN: 'b1' });
    expect(
      (await readState(dirs.b1)).state?.captured['sources/a.md']?.sessionId,
    ).toBe('sess-1');
    expect(r.jobs('b1').map((j) => j.kind)).toEqual([
      'lint',
      'sync',
      'capture',
    ]);
    expect(commits).toEqual([
      ['b1', 'Brain: capture sources/a.md'],
      ['b1', 'Brain: lint'],
      ['b1', 'Brain: sync'],
    ]);
  });

  it('fails the job when the commit throws and releases the lock', async () => {
    const r = runner({
      commit: async () => {
        throw new Error('index.lock exists');
      },
    });
    r.enqueue('b1', 'capture', 'sources/a.md');
    await idle(r, 'b1');
    expect(r.jobs('b1')).toHaveLength(1);
    expect(r.jobs('b1')[0]).toMatchObject({
      status: 'failed',
      error: 'index.lock exists',
    });
    expect(existsSync(path.join(dirs.b1, 'brain', 'lock'))).toBe(false);
  });

  it('needs a source for a capture', () => {
    expect(() => runner().enqueue('b1', 'capture')).toThrow();
  });

  it('parses the last JSON line', async () => {
    run = async () => `profile noise\n${ok('s')}`;
    const r = runner();
    r.enqueue('b1', 'sync');
    await idle(r, 'b1');
    const j = r.jobs('b1')[0];
    expect([j.status, j.result, j.sessionId]).toEqual(['done', 'ok', 's']);
  });

  it('releases the lock when the job fails and carries on', async () => {
    run = async () => {
      throw new Error('exit 1: boom');
    };
    const r = runner();
    r.enqueue('b1', 'sync');
    await idle(r, 'b1');
    expect(r.jobs('b1')[0]).toMatchObject({
      status: 'failed',
      error: 'exit 1: boom',
    });
    expect(commits).toEqual([]);
    expect(existsSync(path.join(dirs.b1, 'brain', 'lock'))).toBe(false);
    run = async () => ok('x');
    r.enqueue('b1', 'lint');
    await idle(r, 'b1');
    expect(r.jobs('b1')[0].status).toBe('done');
  });

  it('pauses at the cap and resumes', async () => {
    tokens = 600_000;
    const r = runner();
    r.enqueue('b1', 'sync');
    await idle(r, 'b1');
    expect(r.jobs('b1')[0].status).toBe('paused');
    expect(calls).toHaveLength(0);
    tokens = 0;
    r.resume('b1');
    await vi.waitFor(() => expect(r.jobs('b1')[0].status).toBe('done'));
    expect(calls).toHaveLength(1);
  });

  it('does not run two jobs of one brain at once but runs two brains in parallel', async () => {
    const gates: (() => void)[] = [];
    run = () => new Promise((res) => gates.push(() => res(ok('s'))));
    const r = runner();
    r.enqueue('b1', 'sync');
    r.enqueue('b1', 'lint');
    r.enqueue('b2', 'sync');
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(calls.map((c) => c.cwd).sort()).toEqual([dirs.b1, dirs.b2].sort());
    expect(r.running('b1')).toBe(true);
    gates[0]();
    gates[1]();
    await vi.waitFor(() => expect(gates).toHaveLength(3));
    gates[2]();
    await idle(r, 'b1');
    await idle(r, 'b2');
  });

  it('retries after 5 s when the lock is held', async () => {
    await acquireLock(dirs.b1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = runner();
    r.enqueue('b1', 'sync');
    // Let the first lock attempt (real file I/O) fail and arm the retry timer.
    for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls).toHaveLength(0);
    const { releaseLock } = await import('./state');
    await releaseLock(dirs.b1);
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(r.jobs('b1')[0].status).toBe('done'));
    expect(calls).toHaveLength(1);
  });

  it('keeps at most 50 jobs, newest first', async () => {
    const r = runner();
    for (let i = 0; i < 55; i++) r.enqueue('b1', 'sync');
    await idle(r, 'b1');
    expect(r.jobs('b1')).toHaveLength(50);
  });

  it('survives an onChange that throws while running', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let thrown = false;
    const r = runner({
      onChange: (_id, jobs) => {
        if (!thrown && jobs[0]?.status === 'running') {
          thrown = true;
          throw new Error('window destroyed');
        }
      },
    });
    r.enqueue('b1', 'sync');
    r.enqueue('b1', 'lint');
    await idle(r, 'b1');
    expect(thrown).toBe(true);
    expect(r.jobs('b1').map((j) => j.status)).toEqual(['done', 'done']);
    expect(existsSync(path.join(dirs.b1, 'brain', 'lock'))).toBe(false);
    err.mockRestore();
  });

  it('fails a job when tokensToday throws and still runs the next one', async () => {
    let boom = true;
    const r = runner({
      tokensToday: () => {
        if (boom) {
          boom = false;
          throw new Error('ledger unavailable');
        }
        return 0;
      },
    });
    r.enqueue('b1', 'sync');
    r.enqueue('b1', 'lint');
    await idle(r, 'b1');
    const [lint, sync] = r.jobs('b1');
    expect(sync).toMatchObject({
      status: 'failed',
      error: 'ledger unavailable',
    });
    expect(lint.status).toBe('done');
    expect(calls.map((c) => c.input)).toEqual(['/lint']);
  });

  it('does not start jobs after stop', async () => {
    const r = runner();
    r.stop();
    r.enqueue('b1', 'sync');
    await new Promise((res) => setTimeout(res, 20));
    expect(calls).toHaveLength(0);
  });
});

describe('brainJobEnv', () => {
  it("adds the brain's pseudo task id and brain id to the telemetry env", () => {
    expect(brainJobEnv('b1', { OTEL: 'x' })).toEqual({
      OTEL: 'x',
      SHELLIE_TASK_ID: 'brain:b1',
      SHELLIE_BRAIN_ID: 'b1',
    });
  });
});
