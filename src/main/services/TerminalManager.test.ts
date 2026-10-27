import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  echoCmd,
  failCmd,
  isWindows,
  sleepCmd,
  testPlatform,
} from '../test-helpers/shell';
import { LeakMatcher } from '../secrets/LeakMatcher';
import {
  mergeEnv,
  normaliseExitCode,
  type OutputFilter,
  schemeReport,
  schemeReportsAfter,
  TerminalManager,
  UNKNOWN_EXIT,
} from './TerminalManager';

/** command and args that run one command line in this OS's shell, as a `run` terminal does. */
const sh = (cmd: string) => testPlatform().runCommand(cmd);

const managers: TerminalManager[] = [];
const create = (o?: {
  killWaitMs?: number;
  now?: () => number;
  flushMs?: number;
}) => {
  const m = new TerminalManager(o);
  managers.push(m);
  return m;
};

const waitFor = (m: TerminalManager, id: string) =>
  new Promise<number>((resolve) => {
    const listener = (exitedId: string, code: number) => {
      if (exitedId !== id) return;
      m.off('exit', listener);
      resolve(code);
    };
    m.on('exit', listener);
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const m of managers) for (const id of m.ids()) m.kill(id);
  managers.length = 0;
});

describe('TerminalManager', () => {
  it('spawns a process, streams its output and reports exit', async () => {
    const m = create();
    const chunks: string[] = [];
    m.on('data', (_id, d) => chunks.push(d));
    const exited = waitFor(m, 't1');
    m.spawn({
      id: 't1',
      taskId: 'task',
      cwd: os.tmpdir(),
      ...sh(echoCmd('hello-shellie')),
    });
    expect(await exited).toBe(0);
    expect(chunks.join('')).toContain('hello-shellie');
    expect(m.buffer('t1')).toContain('hello-shellie');
    expect(m.isRunning('t1')).toBe(false);
  });

  it('sets the task id under the new and the pre-rename name', async () => {
    const m = create();
    const exited = waitFor(m, 'env1');
    m.spawn({
      id: 'env1',
      taskId: 'task-env',
      cwd: os.tmpdir(),
      ...sh(
        isWindows
          ? 'Write-Output "ids:$env:SHELLIE_TASK_ID,$env:MIAC_TASK_ID,$env:SHELLIE_TERMINAL_ID"'
          : 'echo ids:$SHELLIE_TASK_ID,$MIAC_TASK_ID,$SHELLIE_TERMINAL_ID',
      ),
    });
    await exited;
    expect(m.buffer('env1')).toContain('ids:task-env,task-env,env1');
  });

  it('tells programs that xterm draws 24-bit colour', async () => {
    const m = create();
    const exited = waitFor(m, 'ct');
    m.spawn({
      id: 'ct',
      taskId: 't',
      cwd: os.tmpdir(),
      env: { COLORTERM: '' },
      ...sh(
        isWindows ? 'Write-Output "ct:$env:COLORTERM"' : 'echo ct:$COLORTERM',
      ),
    });
    await exited;
    expect(m.buffer('ct')).toContain('ct:truecolor');
  });

  it('writes to stdin and counts running terminals per task', async () => {
    const m = create();
    const exited = waitFor(m, 't2');
    m.spawn({
      id: 't2',
      taskId: 'task',
      cwd: os.tmpdir(),
      ...sh(
        isWindows
          ? '$x = [Console]::In.ReadLine(); Write-Output "got:$x"'
          : 'read x; echo got:$x',
      ),
    });
    expect(m.runningCount('task')).toBe(1);
    // ConPTY needs a carriage return for Enter; a POSIX pty accepts a line feed.
    m.write('t2', isWindows ? 'abc\r' : 'abc\n');
    expect(await exited).toBe(0);
    expect(m.buffer('t2')).toContain('got:abc');
    expect(m.runningCount('task')).toBe(0);
  });

  it('kills everything for a task and forgets the ids', async () => {
    const m = create();
    m.spawn({
      id: 'a',
      taskId: 'x',
      cwd: os.tmpdir(),
      ...sh(sleepCmd(30)),
    });
    m.spawn({
      id: 'b',
      taskId: 'x',
      cwd: os.tmpdir(),
      ...sh(sleepCmd(30)),
    });
    m.spawn({
      id: 'c',
      taskId: 'y',
      cwd: os.tmpdir(),
      ...sh(sleepCmd(30)),
    });
    m.killAllForTask('x');
    expect(m.runningCount('x')).toBe(0);
    expect(m.runningCount('y')).toBe(1);
    expect(() => m.write('a', 'x')).toThrow(/Unknown terminal/);
    m.kill('c');
  });

  it('restarts with the same options and clears the buffer', async () => {
    const m = create();
    const first = waitFor(m, 'r');
    m.spawn({
      id: 'r',
      taskId: 'task',
      cwd: os.tmpdir(),
      ...sh(echoCmd('run')),
    });
    await first;
    const second = waitFor(m, 'r');
    m.restart('r');
    await second;
    expect(m.buffer('r').split('run').length - 1).toBe(1);
  });

  it('restarts at the size the view last gave, not the default (#162)', async () => {
    const m = create();
    const sizeCmd = isWindows
      ? 'Write-Output "size:$($Host.UI.RawUI.WindowSize.Width)x$($Host.UI.RawUI.WindowSize.Height)"'
      : 'set -- $(stty size); echo "size:$2x$1"';
    const first = waitFor(m, 'sz');
    m.spawn({ id: 'sz', taskId: 'task', cwd: os.tmpdir(), ...sh(sizeCmd) });
    await first;
    m.resize('sz', 200, 50);
    const second = waitFor(m, 'sz');
    m.restart('sz');
    await second;
    expect(m.buffer('sz')).toContain('size:200x50');
  });

  it('refuses a duplicate id', () => {
    const m = create();
    m.spawn({
      id: 'd',
      taskId: 't',
      cwd: os.tmpdir(),
      ...sh(sleepCmd(30)),
    });
    expect(() =>
      m.spawn({
        id: 'd',
        taskId: 't',
        cwd: os.tmpdir(),
        ...sh(sleepCmd(30)),
      }),
    ).toThrow(/already/);
    expect(m.ids()).toEqual(['d']);
    m.kill('d');
  });

  it('restarting a running terminal does not surface the old process exit', async () => {
    const m = create();
    m.spawn({
      id: 'live',
      taskId: 't',
      cwd: os.tmpdir(),
      ...sh(sleepCmd(30)),
    });
    await sleep(100);
    const exits: number[] = [];
    m.on('exit', (id, code) => {
      if (id === 'live') exits.push(code);
    });
    m.restart('live');
    await sleep(300);
    expect(exits).toEqual([]);
    expect(m.isRunning('live')).toBe(true);
    m.kill('live');
  });

  it('keeps an exited id known until it is killed', async () => {
    const m = create();
    const exited = waitFor(m, 'e');
    m.spawn({
      id: 'e',
      taskId: 't',
      cwd: os.tmpdir(),
      ...sh(echoCmd('bye')),
    });
    await exited;
    expect(m.ids()).toEqual(['e']);
    m.kill('e');
    expect(m.ids()).toEqual([]);
  });

  it('ignores write and resize after exit', async () => {
    const m = create();
    const exited = waitFor(m, 'w');
    m.spawn({
      id: 'w',
      taskId: 't',
      cwd: os.tmpdir(),
      ...sh(failCmd(0)),
    });
    await exited;
    expect(() => m.write('w', 'x')).not.toThrow();
    expect(() => m.resize('w', 80, 24)).not.toThrow();
  });

  it('reports a non-zero exit code', async () => {
    const m = create();
    const exited = waitFor(m, 'n');
    m.spawn({
      id: 'n',
      taskId: 't',
      cwd: os.tmpdir(),
      ...sh(failCmd(3)),
    });
    expect(await exited).toBe(3);
  });

  it('keeps the terminal and its buffer when a restart fails to spawn', async () => {
    const m = create();
    const exited = waitFor(m, 'f');
    m.spawn({
      id: 'f',
      taskId: 't',
      cwd: os.tmpdir(),
      ...sh(echoCmd('before')),
    });
    await exited;
    const entry = (
      m as unknown as { entries: Map<string, { options: { args: string[] } }> }
    ).entries.get('f');
    if (!entry) throw new Error('missing entry');
    // node-pty reports a bad cwd asynchronously (exit 1), so force a synchronous spawn error instead.
    entry.options = { ...entry.options, args: [1 as unknown as string] };
    expect(() => m.restart('f')).toThrow();
    expect(m.isRunning('f')).toBe(false);
    expect(m.buffer('f')).toContain('before');
  });

  it('kill resolves once the process has exited', async () => {
    // A long fallback, so resolving in time proves the exit was seen.
    const m = create({ killWaitMs: 60_000 });
    m.spawn({ id: 'k', taskId: 't', cwd: os.tmpdir(), ...sh(sleepCmd(30)) });
    await sleep(200);
    const pid = (
      m as unknown as { entries: Map<string, { proc: { pid: number } }> }
    ).entries.get('k')?.proc.pid;
    const started = Date.now();
    await m.kill('k');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(m.has('k')).toBe(false);
    if (!isWindows && pid) expect(() => process.kill(pid, 0)).toThrow();
  });

  it('killAllForTask resolves once every terminal of the task has exited', async () => {
    const m = create({ killWaitMs: 60_000 });
    for (const id of ['p', 'q'])
      m.spawn({ id, taskId: 'x', cwd: os.tmpdir(), ...sh(sleepCmd(30)) });
    await sleep(200);
    await m.killAllForTask('x');
    expect(m.ids()).toEqual([]);
  });

  it('kill gives up waiting after the fallback when the process does not exit', async () => {
    const m = create({ killWaitMs: 300 });
    m.spawn({ id: 'z', taskId: 't', cwd: os.tmpdir(), ...sh(sleepCmd(30)) });
    await sleep(200);
    const entry = (
      m as unknown as { entries: Map<string, { proc: { kill(): void } }> }
    ).entries.get('z');
    if (!entry) throw new Error('missing entry');
    const realKill = entry.proc.kill.bind(entry.proc);
    entry.proc.kill = () => {};
    const started = Date.now();
    await m.kill('z');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    realKill();
  });

  it('kill of an unknown or exited terminal resolves at once', async () => {
    const m = create({ killWaitMs: 60_000 });
    await m.kill('nope');
    const exited = waitFor(m, 'gone');
    m.spawn({ id: 'gone', taskId: 't', cwd: os.tmpdir(), ...sh(failCmd(0)) });
    await exited;
    await m.kill('gone');
    expect(m.ids()).toEqual([]);
  });

  it('reports an unknown exit code as UNKNOWN_EXIT, never undefined', () => {
    expect(UNKNOWN_EXIT).toBe(-1);
    expect(normaliseExitCode(0)).toBe(0);
    expect(normaliseExitCode(3)).toBe(3);
    expect(normaliseExitCode(undefined)).toBe(UNKNOWN_EXIT);
    expect(normaliseExitCode(null)).toBe(UNKNOWN_EXIT);
    expect(normaliseExitCode(Number.NaN)).toBe(UNKNOWN_EXIT);
  });
});

// The `run` terminal wrapper inside ConPTY: the program must keep the console (no pipe in between).
describe.runIf(isWindows)('run terminals on Windows', () => {
  const node = `& '${process.execPath.replaceAll("'", "''")}'`;

  it('passes non-ASCII output from a native program through intact', async () => {
    const m = create();
    const exited = waitFor(m, 'u');
    // U+279C (the arrow Vite prints before "Local:"), then " ok".
    m.spawn({
      id: 'u',
      taskId: 't',
      cwd: os.tmpdir(),
      ...sh(
        `${node} -e 'process.stdout.write(String.fromCharCode(0x279C,32,111,107,10))'`,
      ),
    });
    expect(await exited).toBe(0);
    expect(m.buffer('u')).toContain(`${String.fromCharCode(0x279c)} ok`);
  });

  it('gives a native program a TTY', async () => {
    const m = create();
    const exited = waitFor(m, 'tty');
    m.spawn({
      id: 'tty',
      taskId: 't',
      cwd: os.tmpdir(),
      ...sh(
        `${node} -e 'process.stdout.write(String(process.stdout.isTTY===true))'`,
      ),
    });
    expect(await exited).toBe(0);
    expect(m.buffer('tty')).toContain('true');
  });

  it('native stderr with exit 0 succeeds', async () => {
    const m = create();
    const exited = waitFor(m, 'se');
    m.spawn({
      id: 'se',
      taskId: 't',
      cwd: os.tmpdir(),
      ...sh('cmd /c "echo warn 1>&2"'),
    });
    expect(await exited).toBe(0);
    expect(m.buffer('se')).toContain('warn');
  });

  it('passes a native exit code on', async () => {
    const m = create();
    const exited = waitFor(m, 'ne');
    m.spawn({
      id: 'ne',
      taskId: 't',
      cwd: os.tmpdir(),
      ...sh('cmd /c exit 5'),
    });
    expect(await exited).toBe(5);
  });

  it('exits 1 on throw', async () => {
    const m = create();
    const exited = waitFor(m, 'th');
    m.spawn({ id: 'th', taskId: 't', cwd: os.tmpdir(), ...sh("throw 'boom'") });
    expect(await exited).toBe(1);
  });
});

describe('colour scheme reports (mode 2031)', () => {
  it('follows the last set or reset of mode 2031, also among other modes', () => {
    expect(schemeReportsAfter(false, 'hi')).toBe(false);
    expect(schemeReportsAfter(false, '\x1b[?2031h')).toBe(true);
    expect(schemeReportsAfter(false, '\x1b[?1004;2031;2004h')).toBe(true);
    expect(schemeReportsAfter(true, 'x\x1b[?2031lx')).toBe(false);
    expect(schemeReportsAfter(true, '\x1b[?2031l\x1b[?2031h')).toBe(true);
    expect(schemeReportsAfter(true, '\x1b[?20310h\x1b[?12031l')).toBe(true);
  });

  it('reports dark as 1 and light as 2', () => {
    expect(schemeReport('dark')).toBe('\x1b[?997;1n');
    expect(schemeReport('light')).toBe('\x1b[?997;2n');
  });

  it.skipIf(isWindows)(
    'writes the report only to a program that turned the mode on, even when split over chunks',
    async () => {
      const m = create();
      const run = (id: string, cmd: string) =>
        m.spawn({ id, taskId: 't', cwd: os.tmpdir(), ...sh(cmd) });
      // The tty echoes what is written, so the report shows up in the output.
      run('on', "printf '\\033[?20'; sleep 0.2; printf '31hREADY'; sleep 5");
      run('off', "printf 'READY'; sleep 5");
      await vi.waitFor(() => {
        expect(m.buffer('on')).toContain('READY');
        expect(m.buffer('off')).toContain('READY');
      });
      m.reportScheme('on', 'light');
      m.reportScheme('off', 'light');
      m.reportScheme('unknown', 'light');
      await vi.waitFor(() => expect(m.buffer('on')).toContain('[?997;2n'));
      await sleep(300);
      expect(m.buffer('off')).not.toContain('997');
    },
  );
});

describe('TerminalManager run time', () => {
  it('tells how long a terminal ran until it exited (#109)', async () => {
    let now = 1_000;
    const m = create({ now: () => now });
    const exited = waitFor(m, 't1');
    m.spawn({ id: 't1', taskId: 'task', cwd: os.tmpdir(), ...sh(failCmd(3)) });
    now = 1_250;
    expect(m.runMs('t1')).toBe(250);
    expect(await exited).toBe(3);
    now = 9_000;
    // Frozen at the exit: the time it ran, not the time since it started.
    expect(m.runMs('t1')).toBe(250);
    expect(m.runMs('unknown')).toBe(0);
  });
});

describe('TerminalManager output filter (leak watch)', () => {
  const KEY = 'sk_test_51HxAbCdEf';
  const matcher = LeakMatcher.from([
    { name: 'STRIPE_SECRET_KEY', value: KEY, env: 'development' },
  ]);
  const filter: OutputFilter = (_o, data, carry, final) =>
    matcher.mask(data, carry, final);
  /** Prints `a`, waits, then prints `b`: two pty chunks. */
  const twoParts = (a: string, b: string, thenSleep = 0) =>
    sh(
      isWindows
        ? `Write-Host -NoNewline '${a}'; Start-Sleep -Milliseconds 300; Write-Host -NoNewline '${b}'; Start-Sleep -Seconds ${thenSleep}`
        : `printf '${a}'; sleep 0.3; printf '${b}'; sleep ${thenSleep}`,
    );

  it('masks a value split over two chunks in the stream and the buffer, for filtered tabs only', async () => {
    const m = create({ flushMs: 2000 });
    m.setOutputFilter(filter);
    const chunks: string[] = [];
    m.on('data', (id, d) => {
      if (id === 'f1') chunks.push(d);
    });
    const exited = waitFor(m, 'f1');
    const plain = waitFor(m, 'p1');
    m.spawn({
      id: 'f1',
      taskId: 'task',
      cwd: os.tmpdir(),
      filtered: true,
      ...twoParts(`key=${KEY.slice(0, 9)}`, `${KEY.slice(9)} done`),
    });
    m.spawn({
      id: 'p1',
      taskId: 'task',
      cwd: os.tmpdir(),
      ...sh(echoCmd(`plain ${KEY}`)),
    });
    await exited;
    await plain;
    const shown = chunks.join('');
    expect(shown).toContain('key=[STRIPE_SECRET_KEY] done');
    expect(shown).not.toContain(KEY.slice(0, 9));
    expect(m.buffer('f1')).toContain('key=[STRIPE_SECRET_KEY] done');
    expect(m.buffer('f1')).not.toContain('sk_test');
    // A tab that is not an agent's is shown as it is.
    expect(m.buffer('p1')).toContain(`plain ${KEY}`);
  });

  it('shows a held-back tail after a short wait, so the terminal does not stall', async () => {
    const m = create({ flushMs: 30 });
    m.setOutputFilter(filter);
    m.spawn({
      id: 'f2',
      taskId: 'task',
      cwd: os.tmpdir(),
      filtered: true,
      ...twoParts('typing sk_', '', 30),
    });
    // A shell takes seconds to start on a Windows runner; the wait after its output is the 30 ms flush.
    await vi.waitFor(() => expect(m.buffer('f2')).toContain('typing sk_'), {
      timeout: 10_000,
    });
    expect(m.isRunning('f2')).toBe(true);
    m.kill('f2');
  });
});

describe('mergeEnv', () => {
  it('puts the given names over the process environment', () => {
    expect(
      mergeEnv({ A: '1', B: '2', U: undefined }, { B: '3' }, false),
    ).toEqual({ A: '1', B: '3' });
  });

  it('keeps names that differ only in case apart where case counts', () => {
    expect(mergeEnv({ Db: 'machine' }, { DB: 'secret' }, false)).toEqual({
      Db: 'machine',
      DB: 'secret',
    });
  });

  it('on Windows replaces the inherited name in any case, so one value is left', () => {
    expect(
      mergeEnv({ Db: 'machine', Path: 'C:\\bin' }, { DB: 'secret' }, true),
    ).toEqual({ DB: 'secret', Path: 'C:\\bin' });
  });
});
