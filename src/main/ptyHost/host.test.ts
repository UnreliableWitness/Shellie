import type { IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { ExitError } from '../services/prSummary';
import { createPtyHost, type PtyModule } from './host';
import type { FromHost } from './protocol';

type FakePty = {
  file: string;
  args: string[];
  options: Record<string, unknown>;
  written: string[];
  sizes: [number, number][];
  killed: number;
  data(d: string): void;
  exit(code: number): void;
};

function fake(fail?: Error) {
  const ptys: FakePty[] = [];
  const pty: PtyModule = {
    spawn: (file, args, options) => {
      if (fail) throw fail;
      let onData: (d: string) => void = () => {};
      let onExit: (e: { exitCode: number }) => void = () => {};
      const p: FakePty = {
        file,
        args,
        options: options as Record<string, unknown>,
        written: [],
        sizes: [],
        killed: 0,
        data: (d) => onData(d),
        exit: (exitCode) => onExit({ exitCode }),
      };
      ptys.push(p);
      return {
        pid: 40 + ptys.length,
        write: (d: string) => p.written.push(d),
        resize: (c: number, r: number) => p.sizes.push([c, r]),
        kill: () => p.killed++,
        onData: (l: (d: string) => void) => {
          onData = l;
        },
        onExit: (l: (e: { exitCode: number }) => void) => {
          onExit = l;
        },
      } as unknown as IPty;
    },
  };
  return { pty, ptys };
}

const spawnMsg = (n: number) => ({
  t: 'spawn' as const,
  n,
  file: 'sh',
  args: ['-c', 'x'],
  cols: 100,
  rows: 40,
  cwd: '/tmp',
  env: { A: '1' },
});

describe('createPtyHost', () => {
  it('spawns, relays write, resize and kill, and posts data and exit', () => {
    const { pty, ptys } = fake();
    const out: FromHost[] = [];
    const handle = createPtyHost(pty, (m) => out.push(m));
    handle(spawnMsg(1));
    expect(ptys[0]).toMatchObject({ file: 'sh', args: ['-c', 'x'] });
    expect(ptys[0].options).toMatchObject({
      name: 'xterm-256color',
      cols: 100,
      rows: 40,
      cwd: '/tmp',
      env: { A: '1' },
    });
    expect(ptys[0].options.useConptyDll).toBe(
      process.platform === 'win32' ? true : undefined,
    );
    handle({ t: 'write', n: 1, data: 'ls\r' });
    handle({ t: 'resize', n: 1, cols: 80, rows: 24 });
    handle({ t: 'kill', n: 1 });
    expect(ptys[0].written).toEqual(['ls\r']);
    expect(ptys[0].sizes).toEqual([[80, 24]]);
    expect(ptys[0].killed).toBe(1);
    ptys[0].data('hi');
    ptys[0].exit(3);
    // Late output after the exit still goes out.
    ptys[0].data('late');
    expect(out).toEqual([
      { t: 'spawned', n: 1, pid: 41 },
      { t: 'data', n: 1, data: 'hi' },
      { t: 'exit', n: 1, exitCode: 3 },
      { t: 'data', n: 1, data: 'late' },
    ]);
    // An exited or unknown pty takes nothing more.
    handle({ t: 'write', n: 1, data: 'x' });
    handle({ t: 'kill', n: 9 });
    expect(ptys[0].written).toEqual(['ls\r']);
  });

  it("posts node-pty's spawn error", () => {
    const { pty } = fake(new Error('posix_spawnp failed.'));
    const out: FromHost[] = [];
    createPtyHost(pty, (m) => out.push(m))(spawnMsg(2));
    expect(out).toEqual([
      { t: 'spawnError', n: 2, message: 'posix_spawnp failed.' },
    ]);
  });

  it('runs a headless command and posts its stdout or its error', async () => {
    const { pty } = fake();
    const out: FromHost[] = [];
    const runs: unknown[] = [];
    const results = [
      Promise.resolve('{"result":"ok"}'),
      Promise.reject(new ExitError('bad', 2, 'partial')),
      Promise.reject(
        Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
      ),
    ];
    const handle = createPtyHost(
      pty,
      (m) => out.push(m),
      (cmd, o) => {
        runs.push({ cmd, o });
        return results[runs.length - 1];
      },
    );
    for (const n of [1, 2, 3])
      handle({
        t: 'run',
        n,
        command: 'claude',
        args: ['-p'],
        cwd: '/b',
        input: 'go',
        timeoutMs: 5000,
        env: { K: 'v' },
      });
    await new Promise((r) => setImmediate(r));
    expect(runs[0]).toEqual({
      cmd: { command: 'claude', args: ['-p'] },
      o: {
        cwd: '/b',
        input: 'go',
        timeoutMs: 5000,
        env: { K: 'v' },
        signal: expect.any(AbortSignal),
      },
    });
    expect(out).toEqual([
      { t: 'ran', n: 1, stdout: '{"result":"ok"}' },
      {
        t: 'runError',
        n: 2,
        message: 'bad',
        exit: { exitCode: 2, stdout: 'partial' },
      },
      { t: 'runError', n: 3, message: 'spawn claude ENOENT', code: 'ENOENT' },
    ]);
  });

  it('cancels a run: its process is killed and the run fails as stopped', async () => {
    const { pty } = fake();
    const out: FromHost[] = [];
    const handle = createPtyHost(pty, (m) => out.push(m));
    const run = (n: number) =>
      handle({
        t: 'run',
        n,
        command: process.execPath,
        // Would wait 30 s.
        args: ['-e', 'setTimeout(() => {}, 30000)'],
        cwd: process.cwd(),
        input: '',
        timeoutMs: 60_000,
        env: { ...(process.env as Record<string, string>) },
      });
    run(1);
    run(2);
    // A cancel for a run that is not there (or done) is ignored.
    handle({ t: 'cancelRun', n: 9 });
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    handle({ t: 'cancelRun', n: 1 });
    await expect
      .poll(() => out.find((m) => m.n === 1), { timeout: 5000 })
      .toEqual({ t: 'runError', n: 1, message: 'stopped' });
    expect(Date.now() - started).toBeLessThan(5000);
    // The other run is untouched.
    expect(out.find((m) => m.n === 2)).toBeUndefined();
    handle({ t: 'cancelRun', n: 2 });
    await expect
      .poll(() => out.find((m) => m.n === 2), { timeout: 5000 })
      .toMatchObject({ message: 'stopped' });
  });
  it('ends a timed-out run as timed out, also when a child of it keeps the pipes open', async () => {
    const { pty } = fake();
    const out: FromHost[] = [];
    const handle = createPtyHost(pty, (m) => out.push(m));
    const started = Date.now();
    handle({
      t: 'run',
      n: 1,
      command: process.execPath,
      args: [
        '-e',
        `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'inherit' }); setTimeout(() => {}, 8000)`,
      ],
      cwd: process.cwd(),
      input: '',
      timeoutMs: 300,
      env: { ...(process.env as Record<string, string>) },
    });
    await expect
      .poll(() => out.find((m) => m.n === 1), { timeout: 6000 })
      .toEqual({ t: 'runError', n: 1, message: 'timed out after 0 s' });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);
});
