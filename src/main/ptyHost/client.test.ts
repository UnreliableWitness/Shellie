import { describe, expect, it } from 'vitest';
import { ExitError } from '../services/prSummary';
import { TerminalManager, UNKNOWN_EXIT } from '../services/TerminalManager';
import { PtyHostClient } from './client';
import type { FromHost, ToHost } from './protocol';

/** A host that records what main posts; `answer` and `crash` act as the utility process would. */
function fakeHosts() {
  const hosts: {
    posted: ToHost[];
    answer(m: FromHost): void;
    crash(): void;
  }[] = [];
  const client = new PtyHostClient((on) => {
    const posted: ToHost[] = [];
    hosts.push({ posted, answer: on.message, crash: on.exit });
    return { post: (m) => posted.push(m) };
  });
  return { client, hosts };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('TerminalManager over the pty host', () => {
  it('sends spawn, write, resize and kill to the host and gets data and exit back', async () => {
    const { client, hosts } = fakeHosts();
    const m = new TerminalManager(client, { killWaitMs: 60_000 });
    const data: string[] = [];
    const exits: number[] = [];
    m.on('data', (_id, d) => data.push(d));
    m.on('exit', (_id, code) => exits.push(code));
    const started = m.spawn({
      id: 't',
      taskId: 'task',
      cwd: '/w',
      command: 'zsh',
      args: ['-l'],
      env: { X: '1' },
    });
    expect(hosts).toHaveLength(1);
    const [spawn] = hosts[0].posted;
    expect(spawn).toMatchObject({
      t: 'spawn',
      file: 'zsh',
      args: ['-l'],
      cwd: '/w',
      cols: 120,
      rows: 30,
    });
    if (spawn.t !== 'spawn') throw new Error('not a spawn');
    expect(spawn.env).toMatchObject({
      X: '1',
      TERM: 'xterm-256color',
      SHELLIE_TASK_ID: 'task',
      SHELLIE_TERMINAL_ID: 't',
    });
    const n = spawn.n;
    // Known (and writable) before the host answers; the messages follow the spawn in order.
    expect(m.isRunning('t')).toBe(true);
    m.write('t', 'ls\r');
    m.resize('t', 90, 20);
    hosts[0].answer({ t: 'spawned', n, pid: 7 });
    await started;
    hosts[0].answer({ t: 'data', n, data: 'out' });
    const killed = m.kill('t');
    hosts[0].answer({ t: 'exit', n, exitCode: 0 });
    await killed;
    expect(hosts[0].posted.slice(1)).toEqual([
      { t: 'write', n, data: 'ls\r' },
      { t: 'resize', n, cols: 90, rows: 20 },
      { t: 'kill', n },
    ]);
    expect(data).toEqual(['out']);
    // A killed terminal's exit is not reported, as before.
    expect(exits).toEqual([]);
  });

  it('reports exit codes and keeps output that arrives after the exit', async () => {
    const { client, hosts } = fakeHosts();
    const m = new TerminalManager(client);
    const exits: number[] = [];
    m.on('exit', (_id, code) => exits.push(code));
    void m.spawn({ id: 'a', taskId: 't', cwd: '/', command: 'x', args: [] });
    hosts[0].answer({ t: 'spawned', n: 1, pid: 1 });
    hosts[0].answer({ t: 'exit', n: 1, exitCode: 3 });
    hosts[0].answer({ t: 'data', n: 1, data: 'late' });
    expect(exits).toEqual([3]);
    expect(m.buffer('a')).toBe('late');
    expect(m.isRunning('a')).toBe(false);
  });

  it('rejects the spawn and forgets the terminal when the host cannot start it', async () => {
    const { client, hosts } = fakeHosts();
    const m = new TerminalManager(client);
    const started = m.spawn({
      id: 'a',
      taskId: 't',
      cwd: '/',
      command: 'x',
      args: [],
    });
    hosts[0].answer({ t: 'spawnError', n: 1, message: 'File not found: x' });
    await expect(started).rejects.toThrow('File not found: x');
    expect(m.has('a')).toBe(false);
  });

  it('marks every terminal exited when the host crashes, and starts a new host on the next spawn', async () => {
    const { client, hosts } = fakeHosts();
    const m = new TerminalManager(client);
    const exits: [string, number][] = [];
    m.on('exit', (id, code) => exits.push([id, code]));
    void m.spawn({ id: 'a', taskId: 't', cwd: '/', command: 'x', args: [] });
    void m.spawn({ id: 'b', taskId: 't', cwd: '/', command: 'x', args: [] });
    const pending = m.spawn({
      id: 'c',
      taskId: 't',
      cwd: '/',
      command: 'x',
      args: [],
    });
    hosts[0].answer({ t: 'spawned', n: 1, pid: 1 });
    hosts[0].answer({ t: 'spawned', n: 2, pid: 2 });
    await flush();
    hosts[0].crash();
    expect(exits).toEqual([
      ['a', UNKNOWN_EXIT],
      ['b', UNKNOWN_EXIT],
    ]);
    await expect(pending).rejects.toThrow(/host stopped/);
    expect(m.runningCount('t')).toBe(0);
    expect(m.ids()).toEqual(['a', 'b']);
    // Nothing goes to the dead host.
    m.write('a', 'x');
    expect(hosts).toHaveLength(1);
    // A restart starts a new host.
    const restarted = m.restart('a');
    expect(hosts).toHaveLength(2);
    expect(hosts[1].posted[0]).toMatchObject({ t: 'spawn', file: 'x' });
    hosts[1].answer({ t: 'spawned', n: hosts[1].posted[0].n, pid: 3 });
    await restarted;
    expect(m.isRunning('a')).toBe(true);
    // The old host's late messages are ignored.
    hosts[0].answer({ t: 'exit', n: 1, exitCode: 0 });
    expect(m.isRunning('a')).toBe(true);
  });

  it('never loads node-pty in main', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const f of ['../services/TerminalManager.ts', './client.ts']) {
      const src = await readFile(new URL(f, import.meta.url), 'utf8');
      expect(src).not.toMatch(/from 'node-pty'/);
    }
  });
});

describe('PtyHostClient.run', () => {
  it('sends the whole environment and resolves to stdout', async () => {
    const { client, hosts } = fakeHosts();
    const out = client.run(
      { command: 'claude', args: ['-p'], env: { C: 'cmd' } },
      { cwd: '/b', input: 'go', timeoutMs: 1000, env: { O: 'opt', C: 'o' } },
    );
    const [run] = hosts[0].posted;
    expect(run).toMatchObject({
      t: 'run',
      command: 'claude',
      args: ['-p'],
      cwd: '/b',
      input: 'go',
      timeoutMs: 1000,
    });
    if (run.t !== 'run') throw new Error('not a run');
    expect(run.env).toMatchObject({ O: 'opt', C: 'cmd' });
    // main's own environment underneath (its PATH, as main fixed it up).
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && k !== 'O' && k !== 'C') expect(run.env[k]).toBe(v);
    hosts[0].answer({ t: 'ran', n: run.n, stdout: 'done' });
    expect(await out).toBe('done');
  });

  it('gives back an ExitError and the error code as runWithInput does', async () => {
    const { client, hosts } = fakeHosts();
    const cmd = { command: 'opencode', args: [] };
    const o = { cwd: '/', input: '', timeoutMs: 1000 };
    const failed = client.run(cmd, o);
    const missing = client.run(cmd, o);
    hosts[0].answer({
      t: 'runError',
      n: 1,
      message: 'boom',
      exit: { exitCode: 1, stdout: 'so far' },
    });
    hosts[0].answer({
      t: 'runError',
      n: 2,
      message: 'spawn opencode ENOENT',
      code: 'ENOENT',
    });
    const e = await failed.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExitError);
    expect(e).toMatchObject({ message: 'boom', exitCode: 1, stdout: 'so far' });
    await expect(missing).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails a pending run when the host crashes', async () => {
    const { client, hosts } = fakeHosts();
    const out = client.run(
      { command: 'claude', args: [] },
      { cwd: '/', input: '', timeoutMs: 1000 },
    );
    hosts[0].crash();
    await expect(out).rejects.toThrow(/host stopped/);
  });
});
