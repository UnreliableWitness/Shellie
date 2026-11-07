import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../platform/Platform';
import { brainOpencodePermission } from './templates';
import { ExitError } from '../services/prSummary';
import {
  BrainJobRunner,
  brainJobEnv,
  opencodeJobArgs,
  opencodeJobEnv,
  type BrainJobDeps,
} from './jobs';
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
      opencodeCommand: (_b, args) => ({
        command: 'opencode',
        args: args ?? [],
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
    agent: () => 'claude',
    opencodeModel: () => null,
    ready: () => true,
    onChange: () => undefined,
    commit: async (id, message) => {
      commits.push([id, message]);
    },
    beforeJob: async () => undefined,
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

  it('commits outside edits before the skill runs, with the lock held', async () => {
    const seen: { calls: number; locked: boolean }[] = [];
    const r = runner({
      beforeJob: async (id) => {
        seen.push({
          calls: calls.length,
          locked: existsSync(path.join(dirs[id], 'brain', 'lock')),
        });
      },
    });
    r.enqueue('b1', 'sync');
    await idle(r, 'b1');
    expect(seen).toEqual([{ calls: 0, locked: true }]);
    expect(calls).toHaveLength(1);
  });

  it('fails the job when beforeJob throws, without running the skill', async () => {
    const r = runner({
      beforeJob: async () => {
        throw new Error('index.lock exists');
      },
    });
    r.enqueue('b1', 'sync');
    await idle(r, 'b1');
    expect(r.jobs('b1')[0]).toMatchObject({
      status: 'failed',
      error: 'index.lock exists',
    });
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(dirs.b1, 'brain', 'lock'))).toBe(false);
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
    let armed: () => void = () => undefined;
    const retryArmed = new Promise<void>((res) => (armed = res));
    const r = runner({ onLockRetry: () => armed() });
    r.enqueue('b1', 'sync');
    // The first lock attempt (real file I/O) fails and arms the retry timer.
    await retryArmed;
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

describe('retract and lessons jobs', () => {
  it('take a source, prompt the matching skill, and a lessons run records the capture', async () => {
    dirs = { b: await mk('b') };
    run = async () => ok('sess-1');
    const r = runner();
    expect(() => r.enqueue('b', 'retract')).toThrow(/needs a source/);
    expect(() => r.enqueue('b', 'lessons')).toThrow(/needs a source/);
    r.enqueue('b', 'retract', 'sources/gone.md');
    r.enqueue('b', 'lessons', 'sources/2026-11-04-task-session.md');
    await idle(r, 'b');
    expect(calls.map((c) => c.input)).toEqual([
      '/retract sources/gone.md',
      '/lessons sources/2026-11-04-task-session.md',
    ]);
    expect(commits.map(([, m]) => m)).toEqual([
      'Brain: retract sources/gone.md',
      'Brain: lessons sources/2026-11-04-task-session.md',
    ]);
    const { state } = await readState(dirs.b);
    expect(Object.keys(state?.captured ?? {})).toEqual([
      'sources/2026-11-04-task-session.md',
    ]);
    // No automatic lint after these, unlike a capture.
    expect(r.jobs('b').map((j) => j.kind)).toEqual(['lessons', 'retract']);
  });
});

describe('dropQueued', () => {
  it('forgets the queued jobs on a source, not a running one', async () => {
    dirs = { b: await mk('b') };
    // The first job waits until released; the ones after it finish at once.
    let release: () => void = () => undefined;
    let held = false;
    run = () => {
      if (held) return Promise.resolve(ok('s2'));
      held = true;
      return new Promise((resolve) => {
        release = () => resolve(ok('s'));
      });
    };
    const r = runner();
    r.enqueue('b', 'capture', 'sources/going.md');
    await vi.waitFor(() => expect(r.jobs('b')[0].status).toBe('running'));
    r.enqueue('b', 'capture', 'sources/going.md');
    r.enqueue('b', 'lessons', 'sources/going.md');
    r.enqueue('b', 'capture', 'sources/staying.md');
    expect(r.dropQueued('b', 'sources/going.md')).toBe(2);
    expect(r.jobs('b').map((j) => [j.kind, j.source, j.status])).toEqual([
      ['capture', 'sources/staying.md', 'queued'],
      ['capture', 'sources/going.md', 'running'],
    ]);
    expect(r.dropQueued('b', 'sources/none.md')).toBe(0);
    release();
    await idle(r, 'b');
  });
});

describe('dropQueued and paused jobs', () => {
  it('drops a job paused at the cap too', async () => {
    dirs = { b: await mk('b') };
    tokens = 1_000_000;
    const r = runner();
    r.enqueue('b', 'capture', 'sources/going.md');
    await vi.waitFor(() => expect(r.jobs('b')[0].status).toBe('paused'));
    expect(r.dropQueued('b', 'sources/going.md')).toBe(1);
    expect(r.jobs('b')).toEqual([]);
  });
});

describe('pictures jobs and the runner hooks', () => {
  it('runs a non-background job before queued background ones', async () => {
    dirs = { b: await mk('b') };
    let release: () => void = () => undefined;
    let held = false;
    run = () => {
      if (held) return Promise.resolve(ok('s2'));
      held = true;
      return new Promise((resolve) => {
        release = () => resolve(ok('s'));
      });
    };
    const r = runner();
    r.enqueue('b', 'sync');
    await vi.waitFor(() => expect(r.jobs('b')[0].status).toBe('running'));
    const bg = r.enqueue('b', 'pictures', 'sources/old.md', {
      background: true,
    });
    r.enqueue('b', 'pictures', 'sources/older.md', { background: true });
    const fg = r.enqueue('b', 'lint');
    expect([bg.background, fg.background]).toEqual([true, false]);
    release();
    await idle(r, 'b');
    expect(calls.map((c) => c.input)).toEqual([
      '/sync',
      '/lint',
      '/pictures sources/old.md',
      '/pictures sources/older.md',
    ]);
  });

  it('a pictures job queued by hand replaces a background one still queued for the same source', async () => {
    dirs = { b: await mk('b') };
    let release: () => void = () => undefined;
    let held = false;
    run = () => {
      if (held) return Promise.resolve(ok('s2'));
      held = true;
      return new Promise((resolve) => {
        release = () => resolve(ok('s'));
      });
    };
    const r = runner();
    r.enqueue('b', 'sync');
    await vi.waitFor(() => expect(r.jobs('b')[0].status).toBe('running'));
    r.enqueue('b', 'pictures', 'sources/old.md', { background: true });
    r.enqueue('b', 'pictures', 'sources/other.md', { background: true });
    const fg = r.enqueue('b', 'pictures', 'sources/old.md');
    expect(
      r
        .jobs('b')
        .filter((j) => j.kind === 'pictures')
        .map((j) => [j.source, j.background]),
    ).toEqual([
      ['sources/old.md', false],
      ['sources/other.md', true],
    ]);
    release();
    await idle(r, 'b');
    expect(calls.map((c) => c.input)).toEqual([
      '/sync',
      '/pictures sources/old.md',
      '/pictures sources/other.md',
    ]);
    expect(fg.status).toBe('done');
  });

  it('promptFor replaces the prompt', async () => {
    const seen: string[] = [];
    const r = runner({
      promptFor: async (job) => {
        seen.push(
          `${job.kind}:${existsSync(path.join(dirs[job.brainId], 'brain', 'lock'))}`,
        );
        return job.kind === 'pictures'
          ? `/pictures ${job.source} a.png b.png`
          : undefined;
      },
    });
    r.enqueue('b1', 'pictures', 'sources/a.md');
    r.enqueue('b1', 'sync');
    await idle(r, 'b1');
    expect(seen).toEqual(['pictures:true', 'sync:true']);
    expect(calls.map((c) => c.input)).toEqual([
      '/pictures sources/a.md a.png b.png',
      '/sync',
    ]);
  });

  it('a null prompt finishes the job without running claude', async () => {
    const r = runner({ promptFor: async () => null });
    r.enqueue('b1', 'pictures', 'sources/a.md');
    await idle(r, 'b1');
    expect(calls.length).toBe(0);
    expect(r.jobs('b1')[0]).toMatchObject({
      status: 'done',
      result: 'Nothing to re-evaluate',
    });
    expect(existsSync(path.join(dirs.b1, 'brain', 'lock'))).toBe(false);
  });

  it('fails the job when promptFor throws', async () => {
    const r = runner({
      promptFor: async () => {
        throw new Error('no statuses');
      },
    });
    r.enqueue('b1', 'pictures', 'sources/a.md');
    await idle(r, 'b1');
    expect(r.jobs('b1')[0]).toMatchObject({
      status: 'failed',
      error: 'no statuses',
    });
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(dirs.b1, 'brain', 'lock'))).toBe(false);
  });

  it('afterJob sees each finished job once', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let n = 0;
    run = async () => {
      if (++n === 2) throw new Error('exit 1');
      return ok(`s${n}`);
    };
    const seen: string[] = [];
    const r = runner({
      afterJob: (job) => {
        seen.push(`${job.kind}:${job.status}`);
        throw new Error('listener broke');
      },
    });
    r.enqueue('b1', 'capture', 'sources/a.md');
    r.enqueue('b1', 'sync');
    await idle(r, 'b1');
    // capture ok, its auto lint fails, then sync ok.
    expect(seen).toEqual(['capture:done', 'lint:failed', 'sync:done']);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('does not call afterJob for a job paused at the cap', async () => {
    tokens = 600_000;
    const seen: string[] = [];
    const r = runner({ afterJob: (job) => seen.push(job.status) });
    r.enqueue('b1', 'sync');
    await idle(r, 'b1');
    expect(r.jobs('b1')[0].status).toBe('paused');
    expect(seen).toEqual([]);
  });

  it('a pictures job needs a source', async () => {
    const r = runner();
    expect(() => r.enqueue('b1', 'pictures')).toThrow(/needs a source/);
    r.enqueue('b1', 'pictures', 'sources/a.md');
    await idle(r, 'b1');
    expect(calls.map((c) => c.input)).toEqual(['/pictures sources/a.md']);
    expect(commits).toEqual([['b1', 'Brain: pictures sources/a.md']]);
    // No automatic lint after a pictures job, and it does not mark the source captured.
    expect(r.jobs('b1').map((j) => j.kind)).toEqual(['pictures']);
    expect((await readState(dirs.b1)).state?.captured).toEqual({});
  });
});

const oc = (text: string, id = 'ses_1') =>
  [
    { type: 'step_start', sessionID: id, part: { type: 'step-start' } },
    { type: 'text', sessionID: id, part: { type: 'text', text } },
    { type: 'step_finish', sessionID: id, part: { type: 'step-finish' } },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
const RULES = JSON.stringify({ permission: brainOpencodePermission() });

describe('opencodeJobArgs and opencodeJobEnv', () => {
  it('runs the command headless with json events, a job title, and the model only when one is set', () => {
    expect(opencodeJobArgs('capture', 'opencode/big-pickle')).toEqual([
      'run',
      '--command',
      'capture',
      '--format',
      'json',
      '--title',
      'Shellie brain job: capture',
      '-m',
      'opencode/big-pickle',
    ]);
    expect(opencodeJobArgs('lint', null)).toEqual([
      'run',
      '--command',
      'lint',
      '--format',
      'json',
      '--title',
      'Shellie brain job: lint',
    ]);
    // A typed model that is not a plain provider/model never reaches the command line.
    expect(opencodeJobArgs('lint', 'a/b" & calc')).toEqual(
      opencodeJobArgs('lint', null),
    );
  });

  it("sets the brain's rules as the inline config, replacing an inherited one", () => {
    expect(
      opencodeJobEnv({
        A: '1',
        OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"allow"}}',
      }),
    ).toEqual({ A: '1', OPENCODE_CONFIG_CONTENT: RULES });
  });
});

describe('jobs on the brain agent', () => {
  it('a Claude brain runs as before and the job says claude', async () => {
    const r = runner();
    const job = r.enqueue('b1', 'capture', 'sources/x.md');
    expect(job.agent).toBe('claude');
    await idle(r, 'b1');
    expect(calls[0].cmd.command).toBe('claude');
    expect(calls[0].input).toBe('/capture sources/x.md');
    expect(calls[0].env).toEqual({ BRAIN: 'b1' });
  });

  it('an OpenCode brain runs opencode with the argument on stdin and its rules in the env', async () => {
    run = async () => oc('DONE');
    const r = runner({
      agent: () => 'opencode',
      opencodeModel: () => 'opencode/big-pickle',
      env: (id) => ({
        BRAIN: id,
        OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"allow"}}',
      }),
    });
    const job = r.enqueue('b1', 'capture', 'sources/x.md');
    expect(job.agent).toBe('opencode');
    await idle(r, 'b1');
    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toEqual({
      command: 'opencode',
      args: opencodeJobArgs('capture', 'opencode/big-pickle'),
      env: {},
    });
    expect(calls[0].input).toBe('sources/x.md');
    expect(calls[0].env).toEqual({
      BRAIN: 'b1',
      OPENCODE_CONFIG_CONTENT: RULES,
    });
    // The auto lint takes no argument.
    expect(calls[1].cmd.args).toEqual(
      opencodeJobArgs('lint', 'opencode/big-pickle'),
    );
    expect(calls[1].input).toBe('');
    const capture = r.jobs('b1').find((j) => j.kind === 'capture');
    expect(capture).toMatchObject({
      status: 'done',
      result: 'DONE',
      sessionId: 'ses_1',
      agent: 'opencode',
    });
    expect(
      (await readState(dirs.b1)).state?.captured['sources/x.md']?.sessionId,
    ).toBe('ses_1');
  });

  it('a pictures job on OpenCode gets exactly the argument after /pictures', async () => {
    run = async () => oc('ok');
    const arg = 'sources/a b.md ["sources/a b-assets/x \\"1\\".png"]';
    const r = runner({
      agent: () => 'opencode',
      promptFor: async (j) =>
        j.kind === 'pictures' ? `/pictures ${arg}` : undefined,
    });
    r.enqueue('b1', 'pictures', 'sources/a b.md');
    await idle(r, 'b1');
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd.args).toEqual(opencodeJobArgs('pictures', null));
    expect(calls[0].input).toBe(arg);
  });

  it('holds the queue of an OpenCode brain on old skills: no run, no timer, no failure, until release', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let ready = false;
    const finished: string[] = [];
    const retries = vi.fn();
    run = async () => oc('DONE');
    const r = runner({
      agent: () => 'opencode',
      ready: () => ready,
      afterJob: (j) => finished.push(j.status),
      onLockRetry: retries,
    });
    const job = r.enqueue('b1', 'capture', 'sources/x.md');
    r.enqueue('b1', 'sync');
    expect(r.held('b1')).toBe(true);
    expect(r.held('b2')).toBe(false);
    expect(r.running('b1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // Releasing while the skills are still old keeps holding.
    r.release('b1');
    expect(r.held('b1')).toBe(true);
    expect(calls).toHaveLength(0);
    expect(job.status).toBe('queued');
    expect(finished).toEqual([]);
    expect(retries).not.toHaveBeenCalled();
    vi.useRealTimers();
    ready = true;
    r.release('b1');
    expect(r.held('b1')).toBe(false);
    await idle(r, 'b1');
    expect(calls.map((c) => c.cmd.args[2])).toEqual([
      'capture',
      'lint',
      'sync',
    ]);
    expect(finished).toEqual(['done', 'done', 'done']);
    // A release with nothing held runs nothing.
    r.release('b1');
    await new Promise((res) => setTimeout(res, 20));
    expect(calls).toHaveLength(3);
  });

  it('stops holding once dropQueued removes every held job, and when the brain becomes ready', async () => {
    let ready = false;
    const changes: boolean[] = [];
    const r = runner({
      agent: () => 'opencode',
      ready: () => ready,
      onChange: (id) => changes.push(r.held(id)),
    });
    r.enqueue('b1', 'capture', 'sources/x.md');
    r.enqueue('b1', 'capture', 'sources/y.md');
    expect(r.held('b1')).toBe(true);
    r.dropQueued('b1', 'sources/x.md');
    // One held job is left: still held.
    expect(r.held('b1')).toBe(true);
    r.dropQueued('b1', 'sources/y.md');
    expect(r.held('b1')).toBe(false);
    // The change sent with the drop already says not held.
    expect(changes.at(-1)).toBe(false);
    // Held again, then ready on the next pump (an enqueue), without a release.
    r.enqueue('b1', 'sync');
    expect(r.held('b1')).toBe(true);
    ready = true;
    r.enqueue('b1', 'lint');
    expect(r.held('b1')).toBe(false);
    await idle(r, 'b1');
    expect(calls).toHaveLength(2);
  });

  it('a held job runs on the agent the brain has when it starts', async () => {
    let agent: 'claude' | 'opencode' = 'opencode';
    const r = runner({
      agent: () => agent,
      ready: () => agent === 'claude',
    });
    const job = r.enqueue('b1', 'sync');
    expect(r.held('b1')).toBe(true);
    agent = 'claude';
    r.release('b1');
    await idle(r, 'b1');
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('/sync');
    expect(job.agent).toBe('claude');
  });

  it('a missing opencode fails the job once, naming OpenCode, and the queue moves on', async () => {
    let n = 0;
    run = async () => {
      if (++n === 1)
        throw Object.assign(new Error('spawn opencode ENOENT'), {
          code: 'ENOENT',
        });
      if (n === 2)
        throw new ExitError('Claude Code (claude) was not found', 127, '');
      return oc('ok');
    };
    const r = runner({ agent: () => 'opencode' });
    r.enqueue('b1', 'capture', 'sources/a.md');
    r.enqueue('b1', 'capture', 'sources/b.md');
    r.enqueue('b1', 'sync');
    await idle(r, 'b1');
    expect(calls).toHaveLength(3);
    const byKind = r.jobs('b1').reverse();
    expect(byKind.map((j) => [j.kind, j.status])).toEqual([
      ['capture', 'failed'],
      ['capture', 'failed'],
      ['sync', 'done'],
    ]);
    expect(byKind[0].error).toBe('OpenCode (opencode) was not found');
    expect(byKind[1].error).toBe('OpenCode (opencode) was not found');
  });

  it("a failed opencode run carries the error event's message", async () => {
    const event = JSON.stringify({
      type: 'error',
      sessionID: 'ses_e',
      error: {
        name: 'UnknownError',
        data: { message: 'Model not found: nope/nope.' },
      },
    });
    let n = 0;
    run = async () => {
      if (++n === 1) throw new ExitError('exited with code 1', 1, event);
      throw new ExitError('boom on stderr', 1, '');
    };
    const r = runner({ agent: () => 'opencode' });
    r.enqueue('b1', 'sync');
    r.enqueue('b1', 'lint');
    await idle(r, 'b1');
    const [lint, sync] = r.jobs('b1');
    expect(sync.error).toBe('OpenCode stopped (Model not found: nope/nope.)');
    expect(lint.error).toBe('OpenCode stopped (boom on stderr)');
    expect(calls).toHaveLength(2);
  });

  it('a failed claude run keeps its message', async () => {
    run = async () => {
      throw new ExitError('boom', 1, 'out');
    };
    const r = runner();
    r.enqueue('b1', 'sync');
    await idle(r, 'b1');
    expect(r.jobs('b1')[0].error).toBe('boom');
  });
});
