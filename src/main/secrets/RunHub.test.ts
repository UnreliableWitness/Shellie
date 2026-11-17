import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Environment, PendingRun } from '../../shared/secrets';
import type { ShellieConfig } from '../../shared/types';
import { LeakMatcher } from './LeakMatcher';
import { RUN_EXIT, RunHub, type RunSpec, type RunTask } from './RunHub';

const HOME = path.join(path.sep, 'w', 'app.worktrees', 'fix');
const OTHER = path.join(path.sep, 'w', 'api.worktrees', 'fix');
const SECRET = 'sk_live_9f2c3b1a0d';

const config = (run: Record<string, string>): ShellieConfig => ({
  base: 'main',
  branch: '',
  copy: [],
  setup: [],
  run,
  found: true,
});

function setup(
  o: {
    environment?: Environment;
    run?: Record<string, string>;
    setupCommands?: string[];
    ready?: boolean;
    failOpen?: string;
    /** openTab waits for it before attaching (an abort can come in between). */
    gate?: Promise<void>;
    home?: string;
    platform?: NodeJS.Platform;
  } = {},
) {
  const task: RunTask = {
    id: 'task-1',
    ready: o.ready ?? true,
    environment: o.environment ?? 'development',
    setupCommands: o.setupCommands ?? ['npm ci'],
    workspaces: [
      { id: 'home', repoPath: '/r/app', worktreePath: o.home ?? HOME },
      { id: 'ws-api', repoPath: '/r/api', worktreePath: OTHER },
    ],
    agentTabs: ['claude-1'],
  };
  const tabs: { taskId: string; spec: RunSpec; id: string }[] = [];
  const pending: PendingRun[][] = [];
  const killed: string[] = [];
  const leaks: string[] = [];
  const started: Pick<RunSpec, 'given' | 'environment'>[] = [];
  const matcher = LeakMatcher.from([
    { name: 'STRIPE_KEY', value: SECRET, env: 'production' },
  ]);
  let n = 0;
  const hub = new RunHub({
    random: () => `token-${++n}`,
    platform: o.platform ?? 'darwin',
  });
  hub.attach({
    task: (id) => (id === task.id ? task : null),
    config: async (repoPath) =>
      repoPath === '/r/app'
        ? config(o.run ?? { dev: 'npm run dev' })
        : { ...config({ serve: 'dotnet run' }), setup: ['dotnet restore'] },
    openTab: async (taskId, spec, attach) => {
      if (o.failOpen) throw new Error(o.failOpen);
      if (o.gate) await o.gate;
      const id = `tab-${tabs.length + 1}`;
      // Only a live run gets a tab (no spawn after a cancel).
      if (!attach(id)) throw new Error('The run was cancelled');
      tabs.push({ taskId, spec, id });
    },
    kill: (id) => killed.push(id),
    filter: (o2, data, carry, final) => {
      const r = matcher.mask(data, carry, final);
      if (r.hits.length > 0) leaks.push(o2.id);
      return { text: r.text, carry: r.carry };
    },
    pending: (list) => pending.push(list),
    started: (spec) =>
      started.push({ given: spec.given, environment: spec.environment }),
  });
  const run = (
    name: string,
    args: string[] = [],
    opts: Parameters<RunHub['start']>[4] = {},
  ) => {
    let text = '';
    const done = hub.start(
      task.id,
      name,
      args,
      (chunk) => {
        text += chunk;
      },
      opts,
    );
    return { done, text: () => text };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  /** Until a run waits for its approve (reading the worktree's package.json comes first). */
  const waiting = () =>
    vi.waitFor(() => expect(pending.at(-1)?.length).toBeGreaterThan(0));
  return {
    hub,
    task,
    tabs,
    pending,
    killed,
    leaks,
    started,
    run,
    tick,
    waiting,
  };
}

describe('RunHub tokens', () => {
  it('gives each task its own token for this launch and maps it back', () => {
    const { hub } = setup();
    const a = hub.tokenFor('task-1');
    expect(hub.tokenFor('task-1')).toBe(a);
    const b = hub.tokenFor('task-2');
    expect(b).not.toBe(a);
    expect(hub.taskFor(a)).toBe('task-1');
    expect(hub.taskFor(b)).toBe('task-2');
    expect(hub.taskFor('nope')).toBeNull();
    expect(hub.taskFor('')).toBeNull();
    expect(hub.taskFor(`${a}x`)).toBeNull();
  });
});

describe('RunHub.names', () => {
  it("lists the repo's run: entries and setup, never test (#319)", async () => {
    const { hub } = setup({
      run: { dev: 'npm run dev', lint: 'npm run lint', test: 'npm test' },
    });
    expect(await hub.names('task-1')).toEqual(['dev', 'lint', 'setup']);
  });
  it('leaves out setup without commands', async () => {
    const { hub } = setup({ setupCommands: [] });
    expect(await hub.names('task-1')).toEqual(['dev']);
  });
  it("uses the workspace's own repo for a folder inside another worktree", async () => {
    const { hub } = setup();
    expect(await hub.names('task-1', path.join(OTHER, 'src'))).toEqual([
      'serve',
      'setup',
    ]);
  });
  it('leaves out setup in a workspace whose repo has no setup commands', async () => {
    const { hub } = setup({ setupCommands: [] });
    expect(await hub.names('task-1')).toEqual(['dev']);
    expect(await hub.names('task-1', path.join(OTHER, 'src'))).toEqual([
      'serve',
      'setup',
    ]);
  });
});

describe('RunHub.resolve', () => {
  it('refuses an unknown name with the list', async () => {
    const { hub } = setup();
    expect(await hub.resolve('task-1', 'deploy', [])).toEqual({
      error: 'Unknown command "deploy". Commands for shellie run: dev, setup',
    });
  });
  it('refuses a shell line: only names run', async () => {
    const { hub } = setup();
    for (const line of ['printenv', 'npm run dev; printenv', 'env'])
      expect(await hub.resolve('task-1', line, [])).toMatchObject({
        error: expect.stringContaining('Commands for shellie run: dev, setup'),
      });
  });
  it('never takes a name from the prototype', async () => {
    const { hub } = setup();
    for (const name of ['__proto__', 'constructor', 'toString'])
      expect(await hub.resolve('task-1', name, [])).toHaveProperty('error');
  });
  it('refuses test, also a run: entry named test: tests run in the agent shell (#319)', async () => {
    const { hub } = setup({ run: { dev: 'npm run dev', test: 'npm test' } });
    expect(await hub.resolve('task-1', 'test', [])).toEqual({
      error:
        "Tests do not run through shellie run: run the repo's test command (dotnet test, npm test) directly in your shell, without this project's secrets.",
      code: 2,
    });
  });
  it('resolves run: entries and setup with who they are given to', async () => {
    const { hub } = setup();
    expect(await hub.resolve('task-1', 'dev', ['--port', '5000'])).toEqual({
      name: 'dev',
      given: 'run',
      command: 'npm run dev',
      setupCommands: null,
      // npm run: the arguments go to the script.
      args: ['--', '--port', '5000'],
      workspaceId: 'home',
      environment: 'development',
    });
    expect(await hub.resolve('task-1', 'setup', [])).toMatchObject({
      given: 'setup',
      command: null,
      setupCommands: ['npm ci'],
    });
  });
  it('refuses arguments for setup and arguments with a NUL', async () => {
    const { hub } = setup();
    expect(await hub.resolve('task-1', 'setup', ['x'])).toEqual({
      error: 'setup takes no arguments',
    });
    expect(await hub.resolve('task-1', 'dev', ['a\0b'])).toEqual({
      error: 'An argument holds a NUL character',
    });
  });
  it('runs in the workspace the agent is in, home otherwise', async () => {
    const { hub } = setup();
    expect(
      await hub.resolve('task-1', 'serve', [], path.join(OTHER, 'src')),
    ).toMatchObject({ workspaceId: 'ws-api', command: 'dotnet run' });
    expect(
      await hub.resolve('task-1', 'dev', [], path.join(path.sep, 'elsewhere')),
    ).toMatchObject({ workspaceId: 'home' });
    expect(
      await hub.resolve('task-1', 'dev', [], `${HOME}-evil`),
    ).toMatchObject({ workspaceId: 'home' });
  });
});

describe('RunHub.resolve: arguments', () => {
  it('refuses arguments that would not stay arguments after the command line', async () => {
    for (const dev of ['npm run a;', 'npm run a # x', 'npm run a &&'])
      expect(
        await setup({ run: { dev } }).hub.resolve('task-1', 'dev', ['x']),
      ).toEqual({
        error:
          'dev takes no extra arguments in Shellie: its command line ends in an operator or comment',
        code: 2,
      });
    expect(
      await setup({ run: { dev: 'npm run a' } }).hub.resolve('task-1', 'dev', [
        'x',
      ]),
    ).toMatchObject({ args: ['--', 'x'] });
    // Without arguments the command runs as written.
    expect(
      await setup({ run: { dev: 'npm run a;' } }).hub.resolve(
        'task-1',
        'dev',
        [],
      ),
    ).toMatchObject({ command: 'npm run a;', args: [] });
  });
  it('refuses cmd.exe metacharacters in arguments on Windows only', async () => {
    const win = setup({ platform: 'win32' });
    expect(await win.hub.resolve('task-1', 'dev', ['%DB%'])).toEqual({
      error:
        'On Windows an argument for shellie run cannot hold & | < > ^ % ! " or a line break',
      code: 2,
    });
    expect(await setup().hub.resolve('task-1', 'dev', ['%DB%'])).toMatchObject({
      args: ['--', '%DB%'],
    });
  });
  it('gives npm scripts their arguments after --', async () => {
    const { hub } = setup({ run: { serve: 'dotnet run', check: 'npm test' } });
    expect(await hub.resolve('task-1', 'check', ['--watch'])).toMatchObject({
      command: 'npm test',
      args: ['--', '--watch'],
    });
    expect(
      await hub.resolve('task-1', 'check', ['--', '--watch']),
    ).toMatchObject({ args: ['--', '--watch'] });
    expect(await hub.resolve('task-1', 'serve', ['--x'])).toMatchObject({
      args: ['--x'],
    });
  });
  it('exits 2 with the reason when arguments are refused', async () => {
    const { tabs, run } = setup({ run: { dev: 'npm run a;' } });
    const r = run('dev', ['x']);
    expect(await r.done).toBe(2);
    expect(r.text()).toBe(
      'dev takes no extra arguments in Shellie: its command line ends in an operator or comment\n',
    );
    expect(tabs).toHaveLength(0);
  });
});

describe('RunHub setup in another workspace', () => {
  it("runs that workspace's own setup commands, not the home's", async () => {
    const { hub } = setup();
    expect(
      await hub.resolve('task-1', 'setup', [], path.join(OTHER, 'src')),
    ).toMatchObject({
      workspaceId: 'ws-api',
      given: 'setup',
      setupCommands: ['dotnet restore'],
    });
    expect(await hub.resolve('task-1', 'setup', [])).toMatchObject({
      workspaceId: 'home',
      setupCommands: ['npm ci'],
    });
  });
});

describe('RunHub.start', () => {
  it('runs in a tab, streams masked output and returns the exit code', async () => {
    const { hub, tabs, leaks, run, tick } = setup();
    const r = run('dev', ['--port', '5000'], { terminal: 'claude-1' });
    await tick();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.spec).toMatchObject({
      name: 'dev',
      args: ['--', '--port', '5000'],
    });
    hub.data('tab-1', `key=${SECRET}\r\n`);
    hub.data('other-tab', 'not mine');
    hub.exit('tab-1', 3);
    expect(await r.done).toBe(3);
    expect(r.text()).toBe('key=[STRIPE_KEY]\r\n');
    expect(r.text()).not.toContain(SECRET);
    // The agent tab that asked gets the notice.
    expect(leaks).toEqual(['claude-1']);
  });
  it('masks a value split over two chunks', async () => {
    const { hub, run, tick } = setup();
    const r = run('dev');
    await tick();
    hub.data('tab-1', `a ${SECRET.slice(0, 6)}`);
    hub.data('tab-1', `${SECRET.slice(6)} b\n`);
    hub.exit('tab-1', 0);
    expect(await r.done).toBe(0);
    expect(r.text()).toBe('a [STRIPE_KEY] b\n');
  });
  it('notices go to the run tab when the caller is not an agent tab of the task', async () => {
    const { hub, leaks, run, tick } = setup();
    const r = run('dev', [], { terminal: 'someone-else' });
    await tick();
    hub.data('tab-1', `${SECRET}\n`);
    hub.exit('tab-1', 0);
    await r.done;
    expect(leaks).toEqual(['tab-1']);
  });
  it('drops NUL from output so the exit line stays unambiguous', async () => {
    const { hub, run, tick } = setup();
    const r = run('dev');
    await tick();
    hub.data('tab-1', `a\0${RUN_EXIT}0\n`);
    hub.exit('tab-1', 1);
    expect(await r.done).toBe(1);
    expect(r.text()).not.toContain('\0');
  });
  it('refuses an unknown name with exit 1 and starts nothing', async () => {
    const { tabs, run } = setup();
    const r = run('printenv');
    expect(await r.done).toBe(1);
    expect(r.text()).toBe(
      'Unknown command "printenv". Commands for shellie run: dev, setup\n',
    );
    expect(tabs).toHaveLength(0);
  });
  it('refuses a run on a task that is not ready', async () => {
    const { run } = setup({ ready: false });
    const r = run('dev');
    expect(await r.done).toBe(1);
    expect(r.text()).toBe('This task is not ready in Shellie\n');
  });
  it('refuses a second run of a name that is still running', async () => {
    const { hub, run, tick } = setup();
    const first = run('dev');
    await tick();
    const second = run('dev');
    expect(await second.done).toBe(1);
    expect(second.text()).toBe(
      'agent · dev is already running in Shellie; stop it there first\n',
    );
    hub.exit('tab-1', 0);
    expect(await first.done).toBe(0);
  });
  it('says why when the tab cannot start', async () => {
    const { run } = setup({ failOpen: 'Task is busy' });
    const r = run('dev');
    expect(await r.done).toBe(1);
    expect(r.text()).toBe(
      'Shellie could not start agent · dev: Task is busy\n',
    );
  });
  it('stops the run when the caller goes away', async () => {
    const { hub, killed, run, tick } = setup();
    const ac = new AbortController();
    const r = run('dev', [], { signal: ac.signal });
    await tick();
    ac.abort();
    expect(await r.done).toBe(1);
    expect(killed).toEqual(['tab-1']);
    hub.exit('tab-1', 0); // late: ignored
  });
  it('never spawns a tab for a run cancelled while its tab was being prepared', async () => {
    let open = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const { tabs, run, tick } = setup({ gate });
    const ac = new AbortController();
    const r = run('dev', [], { signal: ac.signal });
    await tick();
    ac.abort();
    expect(await r.done).toBe(1);
    open();
    await tick();
    expect(tabs).toHaveLength(0);
  });
  it('ends the run when its tab is stopped or restarted in Shellie', async () => {
    const { hub, run, tick } = setup();
    const r = run('dev');
    await tick();
    hub.tabGone('tab-1');
    expect(await r.done).toBe(1);
    expect(r.text()).toBe('\nStopped in Shellie\n');
  });
});

describe('RunHub approvals (UAT and Production)', () => {
  it('Development and Test run straight away', async () => {
    for (const environment of ['development', 'test'] as const) {
      const { pending, tabs, run, tick } = setup({ environment });
      void run('dev');
      await tick();
      expect(pending).toEqual([]);
      expect(tabs).toHaveLength(1);
    }
  });
  it('waits for an approve on Production, then runs', async () => {
    const { hub, pending, tabs, run, tick, waiting } = setup({
      environment: 'production',
      run: { check: 'npm test' },
    });
    const r = run('check', ['--watch=false']);
    await waiting();
    expect(tabs).toHaveLength(0);
    expect(pending.at(-1)).toEqual([
      {
        id: expect.any(String),
        taskId: 'task-1',
        name: 'check',
        command: 'npm test',
        args: ['--', '--watch=false'],
        environment: 'production',
      },
    ]);
    expect(r.text()).toBe('Waiting for your approve in Shellie…\n');
    expect(hub.pendingRuns()).toHaveLength(1);
    hub.approve(pending.at(-1)![0]!.id, true);
    await tick();
    expect(pending.at(-1)).toEqual([]);
    expect(tabs).toHaveLength(1);
    hub.exit('tab-1', 0);
    expect(await r.done).toBe(0);
  });
  it('reports a run as started only once it may start (telemetry)', async () => {
    const dev = setup();
    void dev.run('dev');
    await dev.tick();
    expect(dev.started).toEqual([{ given: 'run', environment: 'development' }]);
    const prod = setup({ environment: 'production' });
    void prod.run('dev');
    await prod.waiting();
    expect(prod.started).toEqual([]);
    prod.hub.approve(prod.pending.at(-1)![0]!.id, false);
    await prod.tick();
    expect(prod.started).toEqual([]);
    void prod.run('setup');
    await prod.waiting();
    prod.hub.approve(prod.pending.at(-1)![0]!.id, true);
    await prod.tick();
    expect(prod.started).toEqual([
      { given: 'setup', environment: 'production' },
    ]);
  });
  it('returns 1 with "Not approved in Shellie" when refused', async () => {
    const { hub, pending, tabs, run, waiting } = setup({ environment: 'uat' });
    const r = run('dev');
    await waiting();
    hub.approve(pending.at(-1)![0]!.id, false);
    expect(await r.done).toBe(1);
    expect(r.text()).toContain('Not approved in Shellie\n');
    expect(tabs).toHaveLength(0);
  });
  it('shows the package.json script npm test really runs in the worktree', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-runhub-'));
    try {
      await fs.writeFile(
        path.join(home, 'package.json'),
        JSON.stringify({
          scripts: { pretest: 'node pre.js', test: 'vitest run' },
        }),
      );
      const { pending, run, waiting } = setup({
        environment: 'uat',
        home,
        run: { check: 'npm test' },
      });
      void run('check', ['--watch']);
      await waiting();
      expect(pending.at(-1)![0]).toMatchObject({
        command: 'npm test',
        scripts: [
          { name: 'pretest', text: 'node pre.js' },
          { name: 'test', text: 'vitest run' },
        ],
        args: ['--', '--watch'],
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  it('shows setup as its commands', async () => {
    const { pending, run, waiting } = setup({
      environment: 'production',
      setupCommands: ['npm ci', 'npm run build'],
    });
    void run('setup');
    await waiting();
    expect(pending.at(-1)![0]!.command).toBe('npm ci && npm run build');
  });
  it('drops a pending run when the caller goes away', async () => {
    const { pending, run, waiting } = setup({ environment: 'production' });
    const ac = new AbortController();
    const r = run('dev', [], { signal: ac.signal });
    await waiting();
    ac.abort();
    expect(await r.done).toBe(1);
    expect(pending.at(-1)).toEqual([]);
  });
  it('ignores an approve for an unknown id', () => {
    const { hub } = setup();
    expect(() => hub.approve('nope', true)).not.toThrow();
  });
});

describe('RunHub.stopForTask', () => {
  it('ends running and pending runs with the reason and exit 1', async () => {
    const { hub, killed, pending, run, waiting } = setup({
      environment: 'production',
    });
    const queued = run('dev');
    await waiting();
    hub.stopForTask('task-1', 'Production ended');
    expect(await queued.done).toBe(1);
    expect(queued.text()).toContain('Production ended\n');
    expect(pending.at(-1)).toEqual([]);

    const { hub: hub2, killed: killed2, run: run2, tick: tick2 } = setup();
    const running = run2('dev');
    await tick2();
    hub2.data('tab-1', 'partial');
    hub2.stopForTask('task-1', 'Production ended');
    expect(await running.done).toBe(1);
    expect(running.text()).toBe('partial\nProduction ended\n');
    expect(killed2).toEqual(['tab-1']);
    expect(killed).toEqual([]);
  });
  it('says Stopped in Shellie without a reason, and leaves other tasks alone', async () => {
    const { hub, run, tick } = setup();
    const r = run('dev');
    await tick();
    hub.stopForTask('task-2');
    hub.stopForTask('task-1');
    expect(await r.done).toBe(1);
    expect(r.text()).toBe('\nStopped in Shellie\n');
  });
});

describe('RunHub before main attached it', () => {
  it('says Shellie is still starting', async () => {
    const hub = new RunHub();
    let text = '';
    expect(await hub.start('t', 'dev', [], (c) => (text += c))).toBe(1);
    expect(text).toBe('Shellie is still starting; try again\n');
    expect(await hub.names('t')).toEqual([]);
  });
});
