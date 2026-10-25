import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Events } from '../../shared/ipc';
import { LEAK_IN_BRANCH, LEAK_UNCHECKED } from '../../shared/secrets';
import { LeakWatch } from '../secrets/LeakWatch';
import type { CreateTaskInput, SetupEvent, Task } from '../../shared/types';
import { TrackerRegistry } from '../trackers/TrackerRegistry';
import {
  spawnFailure,
  type TerminalFailure,
  type TerminalKind,
} from '../../shared/terminalFailure';
import { ConnectionStore, type TokenCrypto } from '../services/ConnectionStore';
import { RunHub, type RunBackend } from '../secrets/RunHub';
import { SecretStore } from '../secrets/SecretStore';
import { fakeCrypto } from '../test-helpers/fakeCrypto';
import { startAdoServer, type AdoServer } from '../test-helpers/adoServer';
import { OFFICIAL_RATES } from '../pricing/officialRates';
import { SettingsStore } from '../usage/SettingsStore';
import { UsageStore } from '../usage/UsageStore';
import { GitAuthError, GitClient } from '../services/GitClient';
import { loadShellieConfig } from '../services/ShellieConfig';
import { RepoRegistry } from '../services/RepoRegistry';
import { SetupRunner } from '../services/SetupRunner';
import { TaskStore } from '../services/TaskStore';
import { NoopTelemetry, type Telemetry } from '../telemetry/AppInsightsClient';
import { CostServerError } from '../costServer/client';
import { CostServerStore } from '../costServer/CostServerStore';
import { TerminalManager } from '../services/TerminalManager';
import { DocsWatcher } from '../docs/DocsWatcher';
import { TimeStore } from '../time/TimeStore';
import { telemetryEnv } from '../usage/telemetryEnv';
import type { WorkspaceDetector } from '../workspaces/WorkspaceDetector';
import {
  addOrigin,
  cleanupTempRepos,
  commitFile,
  git,
  makeRepo,
} from '../test-helpers/gitRepo';
import { AdoError, CODE_WRITE_DENIED } from '../services/AdoClient';
import { prTitle } from '../services/azureRepos';
import {
  echoCmd,
  envRef,
  failCmd,
  isWindows,
  normaliseEol,
  sleepCmd,
  testPlatform,
  writeLineCmd,
} from '../test-helpers/shell';
import {
  createHandlers,
  pruneDanglingConnectionLinks,
  recoverInterruptedTasks,
  type Services,
} from './handlers';

type Finished = Extract<SetupEvent, { type: 'finished' }>;
type Broadcast = { event: keyof Events; payload: unknown };

/** Waits on a terminal's spawn, output or exit: a shell takes seconds to start or end on a Windows runner. */
const PTY_WAIT = { timeout: 10_000 };
const allTerminals: TerminalManager[] = [];
const servers: AdoServer[] = [];
const connDirs: string[] = [];
afterAll(async () => {
  await Promise.all(servers.map((v) => v.close()));
  await Promise.all(
    allTerminals.flatMap((t) => t.ids().map((id) => t.kill(id))),
  );
  for (const d of connDirs) rmSync(d, { recursive: true, force: true });
  cleanupTempRepos();
});

/** Records telemetry events (name, properties, measurements). */
function telemetryEvents() {
  const events: [string, unknown, unknown][] = [];
  const telemetry: Telemetry = {
    ...NoopTelemetry,
    event: (name, props, m) => events.push([name, props, m]),
  };
  const named = (name: string) => events.filter((e) => e[0] === name);
  return { events, telemetry, named };
}

async function harness(
  crypto: TokenCrypto = fakeCrypto(),
  over: Partial<Services> = {},
) {
  const store = new TaskStore(
    path.join(
      mkdtempSync(path.join(os.tmpdir(), 'shellie-ipc-')),
      'state.json',
    ),
  );
  await store.load();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-conn-'));
  connDirs.push(dir);
  const connections = new ConnectionStore(
    path.join(dir, 'connections.json'),
    crypto,
    { allowLoopbackHttp: true },
  );
  await connections.load();
  const secrets = new SecretStore(path.join(dir, 'secrets.json'), crypto);
  await secrets.load();
  const server = await startAdoServer();
  servers.push(server);
  const opened: string[] = [];
  const git = new GitClient();
  // `apm` is stubbed so tests can make the setup fail at the apm step (see failSetup).
  const apm = { fail: false };
  const base = testPlatform();
  const platform = {
    ...base,
    // The real lookup of `code` on PATH differs per platform and machine.
    editorCommand: (p: string) => ({ command: 'code', args: [p] }),
    shellCommand: (c: string) =>
      c === 'apm --version'
        ? base.shellCommand(echoCmd('apm 1.0.0'))
        : c.startsWith('apm install')
          ? base.shellCommand(apm.fail ? failCmd(7) : echoCmd(c))
          : base.shellCommand(c),
  };
  const terminals = new TerminalManager();
  allTerminals.push(terminals);
  const usageDir = mkdtempSync(path.join(os.tmpdir(), 'shellie-usage-'));
  connDirs.push(usageDir);
  const settings = new SettingsStore(path.join(usageDir, 'settings.json'));
  await settings.load();
  const usage = new UsageStore(usageDir, () => OFFICIAL_RATES);
  await usage.load();
  const time = new TimeStore(path.join(usageDir, 'time.json'));
  await time.load();
  const receiverStarts: number[] = [];
  let receiverStatus = {
    listening: true,
    port: 4319,
    error: null as string | null,
  };
  const receiver = {
    get status() {
      return receiverStatus;
    },
    start: async (port: number) => {
      receiverStarts.push(port);
      receiverStatus =
        port === 1999
          ? {
              listening: false,
              port,
              error: `Port ${port} is in use by another program`,
            }
          : { listening: true, port, error: null };
      return receiverStatus;
    },
  };
  const broadcasts: Broadcast[] = [];
  const waiters: ((e: Events['setup']) => void)[] = [];
  const services: Services = {
    store,
    git,
    platform,
    terminals,
    repos: new RepoRegistry(store, git),
    connections,
    secrets,
    trackers: new TrackerRegistry(connections),
    openExternal: async (url) => {
      opened.push(url);
    },
    runner: new SetupRunner(git, platform),
    loadConfig: loadShellieConfig,
    pickFolder: async () => '/picked',
    launch: async () => {},
    usage,
    time,
    settings,
    receiver,
    copilot: { stats: { records: 0, unreadable: 0 }, poll: async () => {} },
    usageDir,
    finishFlushMs: 0,
    appVersion: '9.9.9',
    ...over,
    broadcast: (event, payload) => {
      broadcasts.push({ event, payload });
      if (event === 'setup')
        waiters.splice(0).forEach((w) => w(payload as Events['setup']));
    },
  };
  const h = createHandlers(services);
  const repo = makeRepo('webshop');
  writeFileSync(path.join(repo, '.env'), 'X=1');
  writeFileSync(path.join(repo, '.shellie.yml'), 'copy: [.env]\n');
  const added = await h['repos:add'](repo);
  const setupDone = () =>
    new Promise<Finished>((resolve) => {
      const check = (e: Events['setup']) =>
        e.type === 'finished' ? resolve(e) : waiters.push(check);
      waiters.push(check);
    });
  const input = (over: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
    repoId: added.id,
    baseRef: 'main',
    name: '',
    workItem: {
      id: '48231',
      type: 'User Story',
      title: 'Show estimated delivery date',
      url: null,
    },
    branch: 'feature/48231-show-estimated-delivery-date',
    copy: true,
    commands: [],
    startClaude: false,
    openShell: true,
    ...over,
  });
  /** The repo gets an apm.yml and `apm: [claude]`, so setup has an apm step at index 4, which fails until fixSetup. */
  const prepareApm = () => {
    if (!existsSync(path.join(repo, 'apm.yml')))
      commitFile(repo, 'apm.yml', 'name: webshop\n');
    writeFileSync(
      path.join(repo, '.shellie.yml'),
      'copy: [.env]\napm: [claude]\n',
    );
  };
  const failSetup = () => {
    prepareApm();
    apm.fail = true;
  };
  const fixSetup = () => {
    apm.fail = false;
  };
  return {
    prepareApm,
    failSetup,
    fixSetup,
    h,
    store,
    terminals,
    broadcasts,
    repo,
    added,
    setupDone,
    input,
    services,
    server,
    connections,
    opened,
    usage,
    settings,
    receiverStarts,
    usageDir,
  };
}

describe('handlers: cost server', () => {
  const budgets = {
    claude: { monthlyEur: 200, monthStartDay: 1 },
    copilot: null,
  };
  async function costServer(hello: () => Promise<unknown>) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-cost-'));
    connDirs.push(dir);
    const store = new CostServerStore(
      path.join(dir, 'cost-server.json'),
      fakeCrypto(),
    );
    await store.load();
    const sender = {
      onConnected: vi.fn(async () => {}),
      onDisconnected: vi.fn(),
      status: () => {
        const c = store.get();
        return {
          connected: c !== null,
          url: c?.url ?? null,
          email: c?.email ?? null,
          lastSentAt: null,
          waiting: 0,
          error: null,
          budgets: store.budgets,
        };
      },
    };
    const helloFn = vi.fn(hello);
    const order: string[] = [];
    sender.onConnected.mockImplementation(async () => {
      order.push('sender');
    });
    const ledgerPass = vi.fn(async () => {
      order.push(`ledger ${store.get()?.email ?? 'none'}`);
    });
    const hx = await harness(undefined, {
      costServer: { store, sender, hello: helloFn as never, ledgerPass },
    });
    return { hx, store, sender, hello: helloFn, order };
  }
  const conn = {
    url: 'https://cost.example',
    email: 'dev@example.com',
    key: 'sk-company',
  };

  it('connect saves only after hello succeeds', async () => {
    const failing = await costServer(() =>
      Promise.reject(new CostServerError('auth', 401)),
    );
    const refused = await failing.hx.h['costServer:connect'](conn);
    expect(refused.error).toBe('The server refused the key.');
    expect(refused.connected).toBe(false);
    expect(failing.store.get()).toBeNull();
    expect(failing.sender.onConnected).not.toHaveBeenCalled();

    const cs = await costServer(async () => ({
      email: conn.email,
      budgets,
    }));
    const st = await cs.hx.h['costServer:connect'](conn);
    expect(cs.hello).toHaveBeenCalledWith(conn);
    expect(cs.store.get()).toEqual(conn);
    expect(cs.store.budgets).toEqual(budgets);
    expect(cs.sender.onConnected).toHaveBeenCalledTimes(1);
    // The ledger stamps the saved email on its records before the sender starts over.
    expect(cs.order).toEqual([`ledger ${conn.email}`, 'sender']);
    expect(st).toMatchObject({
      connected: true,
      email: conn.email,
      error: null,
    });
    expect(JSON.stringify(st)).not.toContain(conn.key);
    expect(cs.hx.broadcasts.map((b) => b.event)).toContain(
      'costServer:changed',
    );
    expect(await cs.hx.h['costServer:status']()).toMatchObject({
      connected: true,
    });
  });

  it('connect with an empty key reuses the saved key for the same server', async () => {
    const cs = await costServer(async () => ({ email: conn.email, budgets }));
    expect(
      (await cs.hx.h['costServer:connect']({ ...conn, key: '' })).error,
    ).toBe('Enter the company key.');
    await cs.hx.h['costServer:connect'](conn);
    const st = await cs.hx.h['costServer:connect']({
      ...conn,
      email: 'other@example.com',
      key: '',
    });
    expect(st.error).toBeNull();
    expect(cs.hello).toHaveBeenLastCalledWith({
      ...conn,
      email: 'other@example.com',
    });
    expect(cs.store.get()).toEqual({ ...conn, email: 'other@example.com' });
    // The saved key never goes to another address.
    const moved = await cs.hx.h['costServer:connect']({
      ...conn,
      url: 'https://elsewhere.example',
      key: '',
    });
    expect(moved.error).toBe('Enter the company key.');
    expect(cs.hello).toHaveBeenCalledTimes(2);
  });

  it('a failed reconnect shows its error without saying the old connection is fine', async () => {
    const cs = await costServer(async () => ({ email: conn.email, budgets }));
    await cs.hx.h['costServer:connect'](conn);
    cs.hello.mockRejectedValueOnce(new CostServerError('network'));
    const st = await cs.hx.h['costServer:connect']({
      ...conn,
      url: 'https://new.example',
    });
    expect(st).toMatchObject({
      connected: false,
      error: "Can't reach the server.",
    });
    // The old connection stays saved.
    expect(cs.store.get()).toEqual(conn);
  });

  it('connect refuses plain http to a remote host', async () => {
    const cs = await costServer(async () => ({ email: conn.email, budgets }));
    const st = await cs.hx.h['costServer:connect']({
      ...conn,
      url: 'http://cost.example',
    });
    expect(st.error).toBe('Use an https:// address.');
    expect(cs.hello).not.toHaveBeenCalled();
    expect(cs.store.get()).toBeNull();
    const net = await costServer(() =>
      Promise.reject(new CostServerError('network')),
    );
    expect((await net.hx.h['costServer:connect'](conn)).error).toBe(
      "Can't reach the server.",
    );
    const other = await costServer(() =>
      Promise.reject(new CostServerError('rejected', 404)),
    );
    expect((await other.hx.h['costServer:connect'](conn)).error).toBe(
      "That address isn't a Shellie cost server.",
    );
  });

  it('disconnect clears the key and stops sending', async () => {
    const cs = await costServer(async () => ({ email: conn.email, budgets }));
    await cs.hx.h['costServer:connect'](conn);
    const st = await cs.hx.h['costServer:disconnect']();
    expect(cs.store.get()).toBeNull();
    expect(cs.store.budgets).toBeNull();
    expect(cs.sender.onDisconnected).toHaveBeenCalledTimes(1);
    expect(st.connected).toBe(false);
  });
});

describe('handlers: attention', () => {
  it('attention handlers pass the view to main and return the snapshot', async () => {
    const { services } = await harness();
    const views: unknown[] = [];
    const h = createHandlers({
      ...services,
      attention: {
        setView: (v) => views.push(v),
        snapshot: () => ({ t1: { reason: 'done', since: 1 } }),
      },
    });
    await h['attention:view']({ taskId: 'a', tabId: 't1' });
    expect(views).toEqual([{ taskId: 'a', tabId: 't1' }]);
    expect(await h['attention:get']()).toEqual({
      t1: { reason: 'done', since: 1 },
    });
  });

  it('adds the per-terminal env from terminalEnv to the spawned terminal', async () => {
    const { services, terminals, setupDone, input } = await harness();
    const spawn = vi.spyOn(terminals, 'spawn');
    const h = createHandlers({
      ...services,
      terminalEnv: (def) => ({ X_KIND: def.kind }),
    });
    const done = setupDone();
    const task = await h['tasks:create'](input());
    await done;
    expect(spawn).toHaveBeenCalled();
    expect(spawn.mock.calls[0][0].env?.X_KIND).toBe('shell');
    await terminals.killAllForTask(task.id);
  });
});

describe('handlers: agents', () => {
  it('detects once per launch and again with force', async () => {
    let runs = 0;
    const { h } = await harness(undefined, {
      runProbe: async () => {
        runs += 1;
        return { code: 1, stdout: '' };
      },
    });
    const first = await h['agents:detect']();
    expect(first.agents.claude.found).toBe(false);
    expect(runs).toBe(3);
    expect(await h['agents:detect']()).toBe(first);
    expect(runs).toBe(3);
    await h['agents:detect'](true);
    expect(runs).toBe(6);
  });
});

describe('handlers: repos', () => {
  it('lists, picks and removes repos', async () => {
    const { h, added } = await harness();
    expect(await h['repos:list']()).toEqual([added]);
    expect(await h['repos:pickFolder']()).toBe('/picked');
    const cfg = await h['repos:config'](added.id);
    expect(cfg.worktreeRoot).toBe(`${added.path}.worktrees`);
    expect(cfg.config).toMatchObject({
      found: true,
      copy: ['.env'],
      setup: [],
    });
    await h['repos:remove'](added.id);
    expect(await h['repos:list']()).toEqual([]);
  });

  it('repos:config gives a repo kept in Shellie only the base branch it was added with', async () => {
    const { h } = await harness();
    const dir = makeRepo('kept-in-shellie');
    git(dir, 'branch', 'develop');
    const repo = await h['repos:add'](dir, {
      baseBranch: 'develop',
    });
    const cfg = await h['repos:config'](repo.id);
    expect(cfg.config).toMatchObject({ found: false, base: 'develop' });
  });
});

describe('handlers: repos:add / repos:inspect telemetry', () => {
  it('reports wroteConfig and the inspected facts without paths', async () => {
    const events: [string, unknown][] = [];
    const { h } = await harness(fakeCrypto(), {
      telemetry: {
        ...NoopTelemetry,
        event: (name, props) => events.push([name, props]),
      },
    });
    const repo = makeRepo('fresh');
    const inspected = await h['repos:inspect'](repo);
    expect(inspected.proposal).toContain('base: "main"');
    expect(events).toContainEqual([
      'repo.inspected',
      {
        remote: 'none',
        linked: false,
        lockfile: 'none',
        dotnet: false,
        devScript: false,
        apm: false,
        existingConfig: false,
        secrets: false,
      },
    ]);
    expect(inspected.secretsFound).toBe(0);
    const added = await h['repos:add'](repo, {
      writeConfig: inspected.proposal ?? undefined,
    });
    expect(added.configFound).toBe(true);
    expect(events).toContainEqual([
      'repo.added',
      { repos: 2, wroteConfig: true },
    ]);
    const other = makeRepo('plain');
    await h['repos:add'](other);
    expect(events).toContainEqual([
      'repo.added',
      { repos: 3, wroteConfig: false },
    ]);
  });
});

describe('handlers: repos:inspect secrets', () => {
  it('counts the secrets one discovery finds, never their names or values in telemetry', async () => {
    const events: [string, unknown][] = [];
    const { h } = await harness(fakeCrypto(), {
      telemetry: {
        ...NoopTelemetry,
        event: (name, props) => events.push([name, props]),
      },
    });
    const repo = makeRepo('with-secrets');
    writeFileSync(
      path.join(repo, '.env'),
      'PORT=5000\nSTRIPE_SECRET_KEY=sk_live_abcdefghijkl0b3d\nDB_PASSWORD=hunter2hunter2\n',
    );
    const inspected = await h['repos:inspect'](repo);
    expect(inspected.secretsFound).toBe(2);
    const event = events.find(([n]) => n === 'repo.inspected');
    expect(event?.[1]).toMatchObject({ secrets: true });
    expect(JSON.stringify(events)).not.toMatch(/STRIPE|DB_PASSWORD|sk_live/);
  });
});

describe('handlers: workspaces', () => {
  it('scans, joins, removes and marks repos, broadcasting each change', async () => {
    const { h, setupDone, input, broadcasts } = await harness();
    const finished = setupDone();
    const task = await h['tasks:create'](input());
    await finished;
    const api = makeRepo('api');
    const apiRepo = await h['repos:add'](api);
    const apiWt = path.join(path.dirname(api), 'api-wt');
    git(api, 'worktree', 'add', '-q', '-b', task.branch, apiWt);
    broadcasts.length = 0;

    const added = await h['tasks:scanWorkspaces'](task.id);

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ repoId: apiRepo.id, source: 'detected' });
    expect(broadcasts.map((b) => b.event)).toEqual(
      expect.arrayContaining(['notice', 'repos:changed', 'tasks:changed']),
    );
    expect(broadcasts).toContainEqual({
      event: 'notice',
      payload: { level: 'info', message: 'Added api to this task' },
    });
    broadcasts.length = 0;
    expect(await h['tasks:scanWorkspaces'](task.id)).toEqual([]);
    expect(broadcasts).toEqual([]);

    await h['tasks:removeWorkspace'](task.id, added[0].id);
    const [view] = (await h['tasks:list']()).filter((t) => t.id === task.id);
    expect(view.extraWorkspaces).toEqual([]);
    expect(view.detachedPaths).toHaveLength(1);
    expect(broadcasts.some((b) => b.event === 'tasks:changed')).toBe(true);
    await expect(h['tasks:removeWorkspace'](task.id, 'home')).rejects.toThrow(
      /home workspace/,
    );

    expect((await h['repos:setDiscovered'](apiRepo.id, true)).discovered).toBe(
      true,
    );
    expect(broadcasts.at(-1)?.event).toBe('repos:changed');
  });
});

describe('handlers: scans only a ready task', () => {
  it('a scan during finishing or setup joins nothing and does not reach the detector', async () => {
    const scan = vi.fn(async () => ({ added: [] }));
    const hx = await harness(fakeCrypto(), {
      workspaces: { scan } as unknown as WorkspaceDetector,
    });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input());
    await done;
    for (const status of ['finishing', 'setting-up'] as const) {
      await hx.store.update((st) => {
        st.tasks[0].status = status;
      });
      expect(await hx.h['tasks:scanWorkspaces'](t.id)).toEqual([]);
    }
    expect(scan).not.toHaveBeenCalled();
    await hx.store.update((st) => {
      st.tasks[0].status = 'ready';
    });
    await hx.h['tasks:scanWorkspaces'](t.id);
    expect(scan).toHaveBeenCalledTimes(1);
  });
});

describe('handlers: open in editor', () => {
  it('opens the home worktree, or the chosen workspace', async () => {
    const launched: { command: string; args: string[] }[] = [];
    const { h, setupDone, input } = await harness(undefined, {
      launch: async (c) => {
        launched.push(c);
      },
    });
    const finished = setupDone();
    const task = await h['tasks:create'](input());
    await finished;
    const api = makeRepo('api');
    await h['repos:add'](api);
    const apiWt = path.join(path.dirname(api), 'api-wt');
    git(api, 'worktree', 'add', '-q', '-b', task.branch, apiWt);
    const [ws] = await h['tasks:scanWorkspaces'](task.id);

    await h['tasks:openInEditor'](task.id);
    await h['tasks:openInEditor'](task.id, ws.id);

    expect(launched.map((c) => c.args[0])).toEqual([
      task.worktreePath,
      ws.worktreePath,
    ]);
  });
});

describe('handlers: create task', () => {
  it('creates the task, runs setup, starts a shell and ends ready', async () => {
    const { h, terminals, setupDone, input, added, broadcasts } =
      await harness();
    const finished = setupDone();
    const task = await h['tasks:create'](input());
    expect(task.status).toBe('setting-up');
    expect(task.slug).toBe('48231-show-estimated-delivery-date');
    expect(task.worktreePath).toBe(
      path.join(
        `${added.path}.worktrees`,
        '48231-show-estimated-delivery-date',
      ),
    );
    expect((await finished).ok).toBe(true);
    const [view] = await h['tasks:list']();
    expect(view.status).toBe('ready');
    expect(view.worktreeMissing).toBe(false);
    expect(view.terminals).toHaveLength(1);
    expect(view.terminals[0].kind).toBe('shell');
    expect(terminals.runningCount(task.id)).toBe(1);
    expect(existsSync(path.join(task.worktreePath, '.env'))).toBe(true);
    const state = await h['tasks:setupState'](task.id);
    expect(state?.finished).toBe(true);
    expect(state?.steps.map((s) => s.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(broadcasts.some((b) => b.event === 'tasks:changed')).toBe(true);
    terminals.killAllForTask(task.id);
  });

  it('stores an open period from creation and no booking', async () => {
    const { h, store, setupDone, input, terminals } = await harness();
    const done = setupDone();
    const task = await h['tasks:create'](input({ openShell: false }));
    await done;
    expect(store.state.tasks[0].openPeriods).toEqual([
      { start: task.createdAt, end: null },
    ]);
    expect(store.state.tasks[0].time).toBeNull();
    await terminals.killAllForTask(task.id);
  });

  it('runs the setup commands in a Setup tab after the other tabs, without waiting for them', async () => {
    const { h, terminals, setupDone, input } = await harness();
    const finished = setupDone();
    const task = await h['tasks:create'](
      input({
        commands: [
          writeLineCmd('one', 'ok.txt', true),
          writeLineCmd('two', 'ok.txt', true),
        ],
      }),
    );
    expect((await finished).ok).toBe(true);
    const [view] = await h['tasks:list']();
    expect(view.status).toBe('ready');
    expect(view.terminals.map((d) => [d.kind, d.label])).toEqual([
      ['shell', isWindows ? 'PowerShell' : 'sh'],
      ['run', 'Setup'],
    ]);
    const setupTab = view.terminals[1];
    expect(setupTab.setupCommands).toHaveLength(2);
    await vi.waitFor(
      () =>
        expect(
          readFileSync(
            path.join(task.worktreePath, 'ok.txt'),
            'utf8',
          ).replaceAll('\r\n', '\n'),
        ).toBe('one\ntwo\n'),
      { timeout: 10_000 },
    );
    const state = await h['tasks:setupState'](task.id);
    expect(state?.steps.at(-1)).toMatchObject({
      def: { kind: 'terminals' },
      status: 'done',
      detail: expect.stringContaining('Setup ('),
    });
    await terminals.killAllForTask(task.id);
  });

  it('installs apm packages for the harnesses of the tabs setup opens', async () => {
    const { h, terminals, setupDone, input, repo } = await harness();
    commitFile(repo, 'apm.yml', 'name: webshop\n');
    const finished = setupDone();
    const task = await h['tasks:create'](
      input({ startClaude: true, openCopilot: true, openShell: true }),
    );
    expect((await finished).ok).toBe(true);
    const state = await h['tasks:setupState'](task.id);
    const step = state?.steps.find((s) => s.def.kind === 'apm');
    expect(step).toMatchObject({
      def: { detail: 'apm install --target claude, copilot' },
      status: 'done',
    });
    expect(state?.log).toContain('apm install --target copilot');
    await terminals.killAllForTask(task.id);
  });

  it('installs apm packages for OpenCode when setup opens an OpenCode tab', async () => {
    const { h, terminals, setupDone, input, repo } = await harness();
    commitFile(repo, 'apm.yml', 'name: webshop\n');
    const finished = setupDone();
    const task = await h['tasks:create'](
      input({ startClaude: false, openOpencode: true, openShell: false }),
    );
    expect((await finished).ok).toBe(true);
    const state = await h['tasks:setupState'](task.id);
    expect(state?.steps.find((s) => s.def.kind === 'apm')).toMatchObject({
      def: { detail: 'apm install --target opencode' },
      status: 'done',
    });
    expect(task.setup.openOpencode).toBe(true);
    await terminals.killAllForTask(task.id);
  });

  it('has no apm step without apm.yml or with apm: false', async () => {
    const { h, terminals, setupDone, input, repo } = await harness();
    const first = setupDone();
    const a = await h['tasks:create'](input({ startClaude: true }));
    await first;
    expect(
      (await h['tasks:setupState'](a.id))?.steps.map((s) => s.def.kind),
    ).not.toContain('apm');
    await terminals.killAllForTask(a.id);
    commitFile(repo, 'apm.yml', 'name: webshop\n');
    writeFileSync(
      path.join(repo, '.shellie.yml'),
      'copy: [.env]\napm: false\n',
    );
    const second = setupDone();
    const b = await h['tasks:create'](
      input({
        startClaude: true,
        workItem: { id: '2', type: 'Bug', title: 'other', url: null },
        branch: 'bug/2-other',
      }),
    );
    await second;
    expect(
      (await h['tasks:setupState'](b.id))?.steps.map((s) => s.def.kind),
    ).not.toContain('apm');
    await terminals.killAllForTask(b.id);
  });

  it('rejects an invalid branch name', async () => {
    const { h, input } = await harness();
    await expect(
      h['tasks:create'](input({ branch: 'feature/bad name' })),
    ).rejects.toThrow(/not a valid branch name/);
  });

  it('rejects an existing branch and an existing worktree folder', async () => {
    const { h, input, setupDone, terminals } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input());
    await done;
    terminals.killAllForTask(t.id);
    await expect(
      h['tasks:create'](
        input({
          workItem: { id: '1', type: 'Bug', title: 'other', url: null },
        }),
      ),
    ).rejects.toThrow(/already exists/);
    await expect(
      h['tasks:create'](input({ branch: 'feature/other' })),
    ).rejects.toThrow(/already exists/);
  });

  it('marks the task setup-failed when a step fails, then retries from that step', async () => {
    const { h, input, setupDone, terminals, store, failSetup, fixSetup } =
      await harness();
    failSetup();
    const done = setupDone();
    const t = await h['tasks:create'](input());
    expect((await done).ok).toBe(false);
    expect(store.state.tasks[0].status).toBe('setup-failed');
    const state = await h['tasks:setupState'](t.id);
    expect(state?.failedStep).toBe(4);
    expect(state?.steps[4].def.kind).toBe('apm');
    fixSetup();
    const retry = setupDone();
    await h['tasks:retrySetup'](t.id);
    expect((await retry).ok).toBe(true);
    expect(store.state.tasks[0].status).toBe('ready');
    terminals.killAllForTask(t.id);
  });

  it('cancels a failed setup: removes worktree, branch and task', async () => {
    const { h, input, setupDone, store, repo, failSetup } = await harness();
    failSetup();
    const done = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await done;
    await h['tasks:cancelSetup'](t.id);
    expect(store.state.tasks).toHaveLength(0);
    expect(existsSync(t.worktreePath)).toBe(false);
    expect(await new GitClient().branchExists(repo, t.branch)).toBe(false);
  });
});

describe('handlers: missing worktree folder', () => {
  it('cancelSetup succeeds on a setup-failed task whose folder was deleted', async () => {
    const { h, input, setupDone, store, repo, failSetup } = await harness();
    failSetup();
    const done = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await done;
    rmSync(t.worktreePath, { recursive: true, force: true });
    await h['tasks:cancelSetup'](t.id);
    expect(store.state.tasks).toHaveLength(0);
    expect(await new GitClient().branchExists(repo, t.branch)).toBe(false);
  });

  it('finish cleans up a task whose folder was deleted', async () => {
    const { h, input, setupDone, terminals, repo } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await done;
    rmSync(t.worktreePath, { recursive: true, force: true });
    await h['tasks:finish'](t.id, {
      closeTerminals: true,
      removeWorktree: true,
      deleteBranch: true,
    });
    const [view] = await h['tasks:list']();
    expect(view.status).toBe('done');
    expect(await new GitClient().branchExists(repo, t.branch)).toBe(false);
    terminals.killAllForTask(t.id);
  });
});

describe('handlers: finish', () => {
  it('finish cleans up a worktree an earlier failed removal left without its .git file (#87)', async () => {
    const { h, input, setupDone, services, store } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input());
    await done;
    const wt = store.state.tasks[0].worktreePath;
    rmSync(path.join(wt, '.git'));
    await h['tasks:finish'](t.id, {
      closeTerminals: true,
      removeWorktree: true,
      deleteBranch: true,
    });
    expect(store.state.tasks[0].status).toBe('done');
    expect(existsSync(wt)).toBe(false);
    const repo = services.repos.list()[0].path;
    expect(await services.git.worktreeList(repo)).toHaveLength(1);
  });

  /** Finish with a worktree a process holds: the removal fails with EPERM and the folder stays. */
  const finishWithHeldFolder = async () => {
    const telemetry: Telemetry = { ...NoopTelemetry };
    const event = vi.spyOn(telemetry, 'event');
    let retryAll: (() => Promise<void>) | null = null;
    const hx = await harness(fakeCrypto(), {
      telemetry,
      onCleanupRetry: (fn) => {
        retryAll = fn;
      },
    });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input());
    await done;
    const remove = vi
      .spyOn(hx.services.git, 'worktreeRemove')
      .mockRejectedValue(
        Object.assign(
          new Error(`Could not delete ${t.worktreePath}: EPERM, unlink`),
          { code: 'EPERM' },
        ),
      );
    await hx.h['tasks:finish'](t.id, {
      closeTerminals: true,
      removeWorktree: true,
      deleteBranch: true,
    });
    return { ...hx, t, event, remove, retryAll: () => retryAll!() };
  };

  it('Finish checks pass on a folder an earlier failed cleanup left without its .git file (#115)', async () => {
    const { h, input, setupDone, store, terminals } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await done;
    rmSync(path.join(store.state.tasks[0].worktreePath, '.git'));
    const checks = await h['tasks:finishChecks'](t.id);
    expect(checks).toMatchObject({ uncommitted: [], unpushed: 0 });
    await terminals.killAllForTask(t.id);
  });

  it('a worktree a process still holds does not fail Finish: the task is done and the cleanup waits (#115)', async () => {
    const hx = await finishWithHeldFolder();
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('done');
    expect(task.pendingCleanup).toEqual([
      expect.objectContaining({
        workspaceId: 'home',
        worktreePath: hx.t.worktreePath,
        branch: hx.t.branch,
        attempts: 1,
        code: 'EPERM',
      }),
    ]);
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    // Still checked out there, so the branch waits for the folder.
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(true);
    expect(hx.event).toHaveBeenCalledWith('cleanup.deferred', {
      code: 'EPERM',
    });
  });

  it('retries the leftover in the background until it is gone (#115)', async () => {
    const hx = await finishWithHeldFolder();
    await hx.retryAll();
    expect(hx.store.state.tasks[0].pendingCleanup[0].attempts).toBe(2);
    hx.remove.mockRestore();
    await hx.retryAll();
    expect(hx.store.state.tasks[0].pendingCleanup).toEqual([]);
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(
      false,
    );
  });

  it('Retry now on the Done page retries at once and says whether anything is left (#115)', async () => {
    const hx = await finishWithHeldFolder();
    expect(await hx.h['tasks:retryCleanup'](hx.t.id)).toBe(false);
    hx.remove.mockRestore();
    expect(await hx.h['tasks:retryCleanup'](hx.t.id)).toBe(true);
    expect(existsSync(hx.t.worktreePath)).toBe(false);
  });

  it('a reopen takes the folder back, so the background cleanup leaves it alone (#115)', async () => {
    const hx = await finishWithHeldFolder();
    hx.remove.mockRestore();
    await hx.h['tasks:reopen'](hx.t.id);
    expect(hx.store.state.tasks[0].pendingCleanup).toEqual([]);
    await hx.retryAll();
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('finish waits for the terminals to exit before removing the worktree', async () => {
    const { h, input, setupDone, terminals, services } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input());
    await done;
    const order: string[] = [];
    const realKill = terminals.killAllForTask.bind(terminals);
    vi.spyOn(terminals, 'killAllForTask').mockImplementation(async (id) => {
      await realKill(id);
      await new Promise((r) => setTimeout(r, 50));
      order.push('terminals exited');
    });
    const realRemove = services.git.worktreeRemove.bind(services.git);
    vi.spyOn(services.git, 'worktreeRemove').mockImplementation(
      async (...a) => {
        order.push('remove');
        return realRemove(...a);
      },
    );
    await h['tasks:finish'](t.id, {
      closeTerminals: true,
      removeWorktree: true,
      deleteBranch: true,
    });
    expect(order).toEqual(['terminals exited', 'remove']);
  });

  it('removing the worktree closes the terminals first, even when Close terminals is unticked', async () => {
    const { h, input, setupDone, terminals, services, store } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input());
    await done;
    expect(terminals.runningCount(t.id)).toBe(1);
    const order: string[] = [];
    const realKill = terminals.killAllForTask.bind(terminals);
    vi.spyOn(terminals, 'killAllForTask').mockImplementation(async (id) => {
      await realKill(id);
      await new Promise((r) => setTimeout(r, 50));
      order.push('terminals exited');
    });
    const realRemove = services.git.worktreeRemove.bind(services.git);
    vi.spyOn(services.git, 'worktreeRemove').mockImplementation(
      async (...a) => {
        order.push('remove');
        return realRemove(...a);
      },
    );
    await h['tasks:finish'](t.id, {
      closeTerminals: false,
      removeWorktree: true,
      deleteBranch: true,
    });
    expect(order).toEqual(['terminals exited', 'remove']);
    expect(terminals.runningCount(t.id)).toBe(0);
    expect(store.state.tasks[0].terminals).toEqual([]);
    expect(existsSync(t.worktreePath)).toBe(false);
  });

  it('keeps the terminals when neither Close terminals nor Remove worktree is ticked', async () => {
    const { h, input, setupDone, terminals, store } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input());
    await done;
    const kill = vi.spyOn(terminals, 'kill');
    await h['tasks:finish'](t.id, {
      closeTerminals: false,
      removeWorktree: false,
      deleteBranch: false,
    });
    expect(kill).not.toHaveBeenCalled();
    expectTerminalsKept(store, terminals, t.id, 1);
    kill.mockRestore();
    await terminals.killAllForTask(t.id);
  });

  it('cancelSetup waits for the terminals to exit before removing the worktree', async () => {
    const { h, input, setupDone, terminals, services, failSetup } =
      await harness();
    failSetup();
    const done = setupDone();
    const t = await h['tasks:create'](input());
    await done;
    const order: string[] = [];
    vi.spyOn(terminals, 'killAllForTask').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push('terminals exited');
    });
    const realRemove = services.git.worktreeRemove.bind(services.git);
    vi.spyOn(services.git, 'worktreeRemove').mockImplementation(
      async (...a) => {
        order.push('remove');
        return realRemove(...a);
      },
    );
    await h['tasks:cancelSetup'](t.id);
    expect(order).toEqual(['terminals exited', 'remove']);
  });

  it('stops the docs watcher before Finish removes the worktree', async () => {
    const docsWatcher = new DocsWatcher(() => undefined);
    const { h, input, setupDone, services } = await harness(fakeCrypto(), {
      docsWatcher,
    });
    const done = setupDone();
    const t = await h['tasks:create'](input());
    await done;
    await h['docs:watch'](t.id, true);
    expect(docsWatcher.active(t.id)).toBe(true);
    const order: string[] = [];
    const realRemove = services.git.worktreeRemove.bind(services.git);
    vi.spyOn(services.git, 'worktreeRemove').mockImplementation(
      async (...a) => {
        order.push(`remove:${docsWatcher.active(t.id)}`);
        return realRemove(...a);
      },
    );
    await h['tasks:finish'](t.id, {
      closeTerminals: true,
      removeWorktree: true,
      deleteBranch: true,
    });
    expect(order).toEqual(['remove:false']);
  });

  it('finish does not delete an unticked worktree folder', async () => {
    const { h, input, setupDone, store, terminals, repo } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await done;
    await expect(
      h['tasks:finish'](t.id, {
        closeTerminals: true,
        removeWorktree: false,
        deleteBranch: true,
      }),
    ).rejects.toThrow();
    expect(existsSync(t.worktreePath)).toBe(true);
    expect(await new GitClient().branchExists(repo, t.branch)).toBe(true);
    expect(store.state.tasks[0].status).toBe('ready');
    terminals.killAllForTask(t.id);
  });

  it('reports checks, then removes worktree and branch and marks done', async () => {
    const { h, input, setupDone, terminals, repo, store } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input());
    await done;
    const checks = await h['tasks:finishChecks'](t.id);
    expect(checks.uncommitted).toEqual([{ status: '?', path: '.env' }]);
    expect(checks.unpushed).toBe(0);
    expect(checks.runningTerminals).toBe(1);
    await h['tasks:finish'](t.id, {
      closeTerminals: true,
      removeWorktree: true,
      deleteBranch: true,
    });
    const [view] = await h['tasks:list']();
    expect(view.status).toBe('done');
    expect(view.finishedAt).not.toBeNull();
    expect(store.state.tasks[0].openPeriods).toEqual([
      { start: t.createdAt, end: view.finishedAt },
    ]);
    expect(view.terminals).toEqual([]);
    expect(terminals.runningCount(t.id)).toBe(0);
    expect(existsSync(t.worktreePath)).toBe(false);
    expect(await new GitClient().branchExists(repo, t.branch)).toBe(false);
  });

  it('records what the branch did before the worktree goes', async () => {
    const { h, input, setupDone } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await done;
    commitFile(t.worktreePath, 'feature.txt', 'a\nb\n', 'Add the feature');
    await h['tasks:finish'](t.id, {
      closeTerminals: true,
      removeWorktree: true,
      deleteBranch: true,
    });
    const [view] = await h['tasks:list']();
    expect(view.summary).toMatchObject({
      commitCount: 1,
      commits: [{ subject: 'Add the feature' }],
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
      pushed: false,
      upstream: null,
    });
  });

  it('records the base commit at setup and measures the summary from it after a merged PR', async () => {
    const { h, input, setupDone, store, repo } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await done;
    const baseSha = store.state.tasks[0].baseSha;
    expect(baseSha).toMatch(/^[0-9a-f]{40}$/);
    commitFile(t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge PR', t.branch);
    await h['tasks:finish'](t.id, {
      closeTerminals: true,
      removeWorktree: true,
      deleteBranch: false,
    });
    const [view] = await h['tasks:list']();
    expect(view.summary).toMatchObject({
      commitCount: 1,
      commits: [{ subject: 'Add the feature' }],
    });
  });

  it('finishes even when the summary fails', async () => {
    const { h, input, setupDone, services } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await done;
    services.git.finishSummary = async () => {
      throw new Error('boom');
    };
    await h['tasks:finish'](t.id, {
      closeTerminals: true,
      removeWorktree: true,
      deleteBranch: true,
    });
    const [view] = await h['tasks:list']();
    expect(view.status).toBe('done');
    expect(view.summary).toBeNull();
  });

  it('keeps the task ready when cleanup fails', async () => {
    const { h, input, setupDone, store, terminals, services } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await done;
    services.git.deleteBranch = async () => {
      throw new Error('boom');
    };
    await expect(
      h['tasks:finish'](t.id, {
        closeTerminals: true,
        removeWorktree: false,
        deleteBranch: true,
      }),
    ).rejects.toThrow(/boom/);
    expect(store.state.tasks[0].status).toBe('ready');
    terminals.killAllForTask(t.id);
  });
});

describe('handlers: concurrency guards', () => {
  const finishedCount = (b: { event: string; payload: unknown }[]) =>
    b.filter(
      (x) =>
        x.event === 'setup' &&
        (x.payload as { type: string }).type === 'finished',
    ).length;

  it('retrySetup twice at once runs setup once', async () => {
    const { h, input, setupDone, broadcasts, failSetup } = await harness();
    failSetup();
    const first = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await first;
    expect(finishedCount(broadcasts)).toBe(1);
    const retry = setupDone();
    const results = await Promise.allSettled([
      h['tasks:retrySetup'](t.id),
      h['tasks:retrySetup'](t.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/busy|already/);
    await retry;
    await new Promise((r) => setTimeout(r, 200));
    expect(finishedCount(broadcasts)).toBe(2);
  });

  it('finish is rejected while setup runs', async () => {
    const { h, input, setupDone, terminals } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input({ commands: [sleepCmd(1)] }));
    await expect(
      h['tasks:finish'](t.id, {
        closeTerminals: true,
        removeWorktree: true,
        deleteBranch: true,
      }),
    ).rejects.toThrow(/setting-up/);
    await done;
    terminals.killAllForTask(t.id);
  });

  it('cancelSetup is rejected on a ready task', async () => {
    const { h, input, setupDone, terminals } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await done;
    await expect(h['tasks:cancelSetup'](t.id)).rejects.toThrow(/ready/);
    terminals.killAllForTask(t.id);
  });

  it('two concurrent creates for the same branch: one is rejected', async () => {
    const { h, input, setupDone, terminals } = await harness();
    const done = setupDone();
    const results = await Promise.allSettled([
      h['tasks:create'](input({ openShell: false })),
      h['tasks:create'](input({ openShell: false })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already being created/);
    await done;
    for (const id of terminals.ids()) terminals.kill(id);
  });

  it('two concurrent terminals:open calls keep both terminals', async () => {
    const { h, input, setupDone, terminals, store } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await done;
    const [a, b] = await Promise.all([
      h['terminals:open'](t.id, { kind: 'shell', label: 'a' }),
      h['terminals:open'](t.id, { kind: 'shell', label: 'b' }),
    ]);
    const ids = store.state.tasks[0].terminals.map((x) => x.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    terminals.killAllForTask(t.id);
  });
});

/**
 * Shellie left the task's terminals alone: each is still listed on the task and still known to the TerminalManager,
 * which forgets a terminal when Shellie kills it. Whether the OS process is still alive is not asserted: on a loaded
 * Windows runner an idle interactive PowerShell has been seen to exit by itself during a long test.
 */
function expectTerminalsKept(
  store: TaskStore,
  terminals: TerminalManager,
  taskId: string,
  count: number,
) {
  const listed = store.state.tasks.find((t) => t.id === taskId)?.terminals;
  expect(listed).toHaveLength(count);
  for (const def of listed ?? []) expect(terminals.has(def.id)).toBe(true);
}

describe('handlers: update', () => {
  it('reports no update in dev and refuses to install one', async () => {
    const { h } = await harness();
    expect(await h['update:status']()).toBeNull();
    await expect(h['update:install']()).rejects.toThrow(
      'No update is ready to install',
    );
  });

  it('reports a downloaded update and installs it when asked', async () => {
    const install = vi.fn(() => true);
    let pending: { version: string | null } | null = null;
    const { h } = await harness(fakeCrypto(), {
      update: {
        pending: () => pending,
        install,
        needsMove: () => false,
        moveToApplications: () => false,
      },
    });
    await expect(h['update:install']()).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
    pending = { version: '1.0.3' };
    expect(await h['update:status']()).toEqual({ version: '1.0.3' });
    await h['update:install']();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('reports whether Shellie must move to Applications and starts the move', async () => {
    const { h: dev } = await harness();
    expect(await dev['update:needsMove']()).toBe(false);
    expect(await dev['update:moveToApplications']()).toBe(false);
    const moveToApplications = vi.fn(() => true);
    const { h } = await harness(fakeCrypto(), {
      update: {
        pending: () => null,
        install: () => false,
        needsMove: () => true,
        moveToApplications,
      },
    });
    expect(await h['update:needsMove']()).toBe(true);
    expect(await h['update:moveToApplications']()).toBe(true);
    expect(moveToApplications).toHaveBeenCalledTimes(1);
  });

  it("gives no What's new card in dev, and the service's card in packaged builds", async () => {
    const { h: dev } = await harness();
    expect(await dev['app:whatsNew']()).toBeNull();
    const card = {
      version: '1.46.0',
      url: 'https://github.com/UnreliableWitness/Shellie/releases/tag/v1.46.0',
      fetched: true,
      releases: [],
    };
    const { h } = await harness(fakeCrypto(), {
      whatsNew: { get: async () => card },
    });
    expect(await h['app:whatsNew']()).toEqual(card);
  });
});

describe('handlers: terminals', () => {
  it('opens a run terminal, exposes its buffer, restarts and kills it', async () => {
    const { h, input, setupDone, terminals, store } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await done;
    const def = await h['terminals:open'](t.id, {
      kind: 'run',
      label: 'dev',
      command: `${echoCmd('dev-server-up')}; ${sleepCmd(30)}`,
    });
    expect(store.state.tasks[0].terminals.map((x) => x.id)).toContain(def.id);
    await vi.waitFor(
      async () =>
        expect(await h['terminals:buffer'](def.id)).toContain('dev-server-up'),
      { timeout: 10_000 },
    );
    expect(await h['terminals:isRunning'](def.id)).toBe(true);
    await h['terminals:restart'](def.id);
    expect(await h['terminals:isRunning'](def.id)).toBe(true);
    await h['terminals:kill'](def.id);
    expect(store.state.tasks[0].terminals.map((x) => x.id)).not.toContain(
      def.id,
    );
    expect(terminals.runningCount(t.id)).toBe(0);
  });
});

describe('handlers: Claude Code sessions', () => {
  const recording = () => {
    const base = testPlatform();
    const calls: { prompt: string | null; flags: string[] }[] = [];
    const platform = {
      ...base,
      // A shell that exits at once stands in for claude.
      claudeCommand: (prompt: string | null, flags: string[] = []) => {
        calls.push({ prompt, flags });
        return base.runCommand(echoCmd('claude'));
      },
    };
    return { platform, calls };
  };

  it('starts Claude Code with the task as context and its own session id, and resumes it on restart', async () => {
    const { platform, calls } = recording();
    const hx = await harness(fakeCrypto(), {
      platform,
      claudeSessionExists: () => true,
    });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({ openShell: false, startClaude: true }),
    );
    await done;
    const def = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'claude',
    );
    expect(def?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toEqual([
      {
        prompt: expect.stringMatching(
          /\.shellie\/task\.md\. Do not start on the task by yourself/,
        ),
        flags: ['--session-id', def?.sessionId],
      },
    ]);
    await hx.h['terminals:restart'](def!.id);
    expect(calls[1]).toEqual({
      prompt: null,
      flags: ['--resume', def?.sessionId],
    });
    // After a relaunch the new manager does not know the terminal; it still resumes.
    await hx.terminals.killAllForTask(t.id);
    const fresh = new TerminalManager();
    allTerminals.push(fresh);
    const h2 = createHandlers({ ...hx.services, terminals: fresh });
    await h2['terminals:restart'](def!.id);
    expect(calls[2]).toEqual({
      prompt: null,
      flags: ['--resume', def?.sessionId],
    });
  });

  it('denies agent tabs the untracked secret files of the task, never the tracked ones', async () => {
    const { platform } = recording();
    const denies: string[][] = [];
    const envCtx: { kind: string; denyPaths?: string[] }[] = [];
    const hx = await harness(fakeCrypto(), {
      platform,
      claudeThemeSettings: (deny) => {
        denies.push(deny ?? []);
        return null;
      },
      terminalEnv: (def, ctx) => {
        envCtx.push({ kind: def.kind, ...ctx });
        return {};
      },
    });
    const done = hx.setupDone();
    await hx.h['tasks:create'](
      hx.input({ openShell: true, startClaude: true, openOpencode: true }),
    );
    await done;
    const wt = hx.store.state.tasks[0].worktreePath;
    // A tracked config file with a secret-looking value stays readable.
    writeFileSync(
      path.join(wt, 'appsettings.json'),
      '{"Db":"Server=h;Password=pw1"}',
    );
    git(wt, 'add', 'appsettings.json');
    const claude = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'claude',
    )!;
    await hx.h['terminals:restart'](claude.id);
    expect(denies.at(-1)).toEqual([
      'Read(./.env)',
      'Bash(cat .env:*)',
      'Bash(type .env:*)',
      'Bash(Get-Content .env:*)',
    ]);
    const forKind = (k: string) => envCtx.filter((c) => c.kind === k).at(-1);
    expect(forKind('opencode')?.denyPaths).toEqual(['.env']);
    expect(forKind('claude')?.denyPaths).toEqual(['.env']);
    expect(forKind('shell')?.denyPaths).toBeUndefined();
  });

  it('starts and resumes Claude Code with the theme settings file and every terminal with COLORFGBG', async () => {
    const { platform, calls } = recording();
    let scheme: 'light' | 'dark' = 'light';
    const spawned: string[] = [];
    const hx = await harness(fakeCrypto(), {
      platform,
      claudeSessionExists: () => true,
      colorScheme: () => scheme,
      claudeThemeSettings: () => `/cfg/claude-theme-${scheme}.json`,
      claudeSpawned: (id) => spawned.push(id),
    });
    const spawn = vi.spyOn(hx.terminals, 'spawn');
    const done = hx.setupDone();
    await hx.h['tasks:create'](
      hx.input({ openShell: true, startClaude: true }),
    );
    await done;
    const def = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'claude',
    );
    expect(calls[0].flags).toEqual([
      '--session-id',
      def?.sessionId,
      '--settings',
      '/cfg/claude-theme-light.json',
    ]);
    expect(spawn.mock.calls.map((c) => c[0].env?.COLORFGBG)).toEqual([
      '0;15',
      '0;15',
    ]);
    scheme = 'dark';
    await hx.h['terminals:restart'](def!.id);
    expect(calls[1].flags).toEqual([
      '--resume',
      def?.sessionId,
      '--settings',
      '/cfg/claude-theme-dark.json',
    ]);
    expect(spawn.mock.calls.at(-1)?.[0].env?.COLORFGBG).toBe('15;0');
    // Only the Claude Code tab, at its start and its resume.
    expect(spawned).toEqual([def!.id, def!.id]);
  });

  it('continues the latest conversation for a Claude Code tab without a session id', async () => {
    const { platform, calls } = recording();
    const hx = await harness(fakeCrypto(), { platform });
    const done = hx.setupDone();
    await hx.h['tasks:create'](
      hx.input({ openShell: false, startClaude: true }),
    );
    await done;
    await hx.store.update((st) => {
      for (const d of st.tasks[0].terminals) delete d.sessionId;
    });
    const id = hx.store.state.tasks[0].terminals[0].id;
    await hx.h['terminals:restart'](id);
    expect(calls.at(-1)).toEqual({ prompt: null, flags: ['--continue'] });
  });

  it('starts a never-used session again instead of resuming it', async () => {
    const { platform, calls } = recording();
    const hx = await harness(fakeCrypto(), {
      platform,
      claudeSessionExists: () => false,
    });
    const done = hx.setupDone();
    await hx.h['tasks:create'](
      hx.input({ openShell: false, startClaude: true }),
    );
    await done;
    const def = hx.store.state.tasks[0].terminals[0];
    await hx.h['terminals:restart'](def.id);
    expect(calls.at(-1)).toEqual({
      prompt: expect.stringContaining('.shellie/task.md'),
      flags: ['--session-id', def.sessionId],
    });
  });

  it('gives a Claude Code tab opened by hand a session id', async () => {
    const { platform, calls } = recording();
    const hx = await harness(fakeCrypto(), { platform });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    const def = await hx.h['terminals:open'](t.id, {
      kind: 'claude',
      label: 'Claude Code',
    });
    expect(def.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.at(-1)?.flags).toEqual(['--session-id', def.sessionId]);
  });
});

describe('handlers: terminals opened from the + menu', () => {
  it('names a shell tab after the platform shell and starts OpenCode with its command', async () => {
    const base = testPlatform();
    const platform = {
      ...base,
      shellLabel: 'PowerShell',
      opencodeCommand: () =>
        base.runCommand(`${echoCmd('opencode-started')}; ${sleepCmd(5)}`),
    };
    const hx = await harness(fakeCrypto(), { platform });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    const shell = await hx.h['terminals:open'](t.id, {
      kind: 'shell',
      label: 'shell',
    });
    expect(shell.label).toBe('PowerShell');
    const oc = await hx.h['terminals:open'](t.id, {
      kind: 'opencode',
      label: 'OpenCode',
    });
    await vi.waitFor(
      async () =>
        expect(await hx.h['terminals:buffer'](oc.id)).toContain(
          'opencode-started',
        ),
      { timeout: 10_000 },
    );
    await hx.h['terminals:kill'](oc.id);
    expect(hx.store.state.tasks[0].terminals.map((x) => x.kind)).toEqual([
      'shell',
    ]);
    await hx.terminals.killAllForTask(t.id);
  });
});

describe('handlers: agent tabs that fail to start (#109)', () => {
  const failures = () => {
    const cleared: string[] = [];
    const spawnFailed: { id: string; kind: string }[] = [];
    const kept = new Map<string, TerminalFailure>();
    const service = {
      get: (id: string) => kept.get(id) ?? null,
      clear: (id: string) => {
        cleared.push(id);
        kept.delete(id);
      },
      spawnFailed: (id: string, kind: TerminalKind, e: unknown) => {
        spawnFailed.push({ id, kind });
        const f = spawnFailure(kind, String(e));
        kept.set(id, f);
        return f;
      },
    };
    return { service, cleared, spawnFailed, kept };
  };

  it('restarts OpenCode without the project config when asked, and with it again on a plain Restart', async () => {
    const base = testPlatform();
    const platform = {
      ...base,
      opencodeCommand: () =>
        base.runCommand(`${echoCmd('opencode-started')}; ${sleepCmd(5)}`),
    };
    const f = failures();
    const hx = await harness(fakeCrypto(), {
      platform,
      terminalFailures: f.service,
    });
    const spawn = vi.spyOn(hx.terminals, 'spawn');
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({ openShell: false, openOpencode: true }),
    );
    await done;
    const def = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'opencode',
    )!;
    f.kept.set(def.id, {
      reason: 'invalid-config',
      title: 'x',
      hint: 'y',
      canSkipProjectConfig: true,
    });
    expect((await hx.h['terminals:failure'](def.id))?.reason).toBe(
      'invalid-config',
    );
    await hx.h['terminals:restart'](def.id, { withoutProjectConfig: true });
    expect(
      spawn.mock.calls.at(-1)?.[0].env?.OPENCODE_DISABLE_PROJECT_CONFIG,
    ).toBe('1');
    expect(f.cleared).toContain(def.id);
    expect(await hx.h['terminals:failure'](def.id)).toBeNull();
    expect(await hx.h['terminals:isRunning'](def.id)).toBe(true);
    await hx.h['terminals:restart'](def.id);
    expect(
      spawn.mock.calls.at(-1)?.[0].env?.OPENCODE_DISABLE_PROJECT_CONFIG,
    ).toBeUndefined();
    await hx.terminals.killAllForTask(t.id);
  });

  it('records a tab whose program cannot be spawned', async () => {
    const f = failures();
    const hx = await harness(fakeCrypto(), { terminalFailures: f.service });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    vi.spyOn(hx.terminals, 'spawn').mockImplementationOnce(() => {
      throw new Error('posix_spawnp failed.');
    });
    await expect(
      hx.h['terminals:open'](t.id, { kind: 'copilot', label: 'Copilot CLI' }),
    ).rejects.toThrow(/posix_spawnp/);
    expect(f.spawnFailed).toEqual([
      { id: expect.any(String), kind: 'copilot' },
    ]);
  });
});

describe('handlers: reopen a finished task', () => {
  const finishWith = (o: {
    removeWorktree: boolean;
    deleteBranch: boolean;
  }) => ({
    closeTerminals: true,
    ...o,
  });
  const recording = () => {
    const base = testPlatform();
    const calls: { context: string | null; flags: string[] }[] = [];
    const platform = {
      ...base,
      claudeCommand: (context: string | null, flags: string[] = []) => {
        calls.push({ context, flags });
        return base.runCommand(`${echoCmd('claude')}; ${sleepCmd(5)}`);
      },
    };
    return { platform, calls };
  };
  async function finished(
    o: { removeWorktree: boolean; deleteBranch: boolean },
    over: Partial<Services> = {},
    opts: { commands?: string[]; beforeFinish?: (t: Task) => void } = {},
  ) {
    const rec = recording();
    const hx = await harness(fakeCrypto(), {
      platform: rec.platform,
      claudeSessionExists: () => true,
      ...over,
    });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({ startClaude: true, commands: opts.commands ?? [] }),
    );
    await done;
    commitFile(t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    opts.beforeFinish?.(t);
    const before = hx.store.state.tasks[0].terminals;
    await hx.h['tasks:finish'](t.id, finishWith(o));
    return { ...hx, ...rec, t, before };
  }
  const reopenSetup = async (hx: Awaited<ReturnType<typeof finished>>) => {
    const done = hx.setupDone();
    expect(await hx.h['tasks:reopen'](hx.t.id)).toEqual({ setup: true });
    return done;
  };

  it('a folder an earlier cleanup left behind is replaced by the restored worktree (#91)', async () => {
    const hx = await finished({ removeWorktree: true, deleteBranch: true });
    const wt = hx.t.worktreePath;
    // What a removal that git could not finish left on Windows (#87): files, no .git, no branch.
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, 'stray.txt'), 'left over');
    await reopenSetup(hx);
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('ready');
    expect(existsSync(path.join(wt, '.git'))).toBe(true);
    expect(existsSync(path.join(wt, 'stray.txt'))).toBe(false);
    expect(readFileSync(path.join(wt, 'feature.txt'), 'utf8')).toBe('a\n');
    expect(git(wt, 'branch', '--show-current').trim()).toBe(task.branch);
    await hx.terminals.killAllForTask(task.id);
  });

  it('a left-over folder stays when the branch cannot be restored (#91)', async () => {
    const hx = await finished({ removeWorktree: true, deleteBranch: true });
    const wt = hx.t.worktreePath;
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, 'stray.txt'), 'left over');
    await hx.store.update((st) => {
      st.tasks[0].summary = null;
    });
    await expect(hx.h['tasks:reopen'](hx.t.id)).rejects.toThrow(
      /cannot be restored/,
    );
    expect(existsSync(path.join(wt, 'stray.txt'))).toBe(true);
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  it('Finish keeps the tabs it closed, so Reopen can bring them back', async () => {
    const hx = await finished({ removeWorktree: true, deleteBranch: false });
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'done',
      terminals: [],
      closedTerminals: hx.before,
    });
    expect(hx.before.map((d) => d.kind)).toEqual(['claude', 'shell']);
  });

  const withExtra = async (hx: Awaited<ReturnType<typeof finished>>) => {
    const extraPath = mkdtempSync(path.join(os.tmpdir(), 'shellie-extra-'));
    git(extraPath, 'init', '-q');
    git(extraPath, 'config', 'user.email', 'tests@shellie.local');
    git(extraPath, 'config', 'user.name', 'Shellie tests');
    git(extraPath, 'config', 'core.autocrlf', 'false');
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces.push({
        id: 'w2',
        repoId: 'other',
        branch: 'b',
        worktreePath: extraPath,
        baseRef: 'HEAD',
        baseSha: null,
        source: 'detected',
        summary: null,
        pullRequest: null,
        reopen: null,
        dropped: false,
      });
    });
    return extraPath;
  };

  it('Claude gets --add-dir for the extra worktree, on resume and on start; dropped ones are left out', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    const extra = await withExtra(hx);
    const id = hx.t.id;
    const claude = hx.before.find((d) => d.kind === 'claude')!;
    await hx.h['tasks:reopen'](id);
    expect(hx.calls.at(-1)?.flags).toEqual([
      '--resume',
      claude.sessionId,
      '--add-dir',
      extra,
    ]);
    await hx.h['terminals:open'](id, { kind: 'claude', label: 'Claude Code' });
    expect(hx.calls.at(-1)?.flags).toEqual([
      '--session-id',
      expect.any(String),
      '--add-dir',
      extra,
    ]);
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces[0].dropped = true;
    });
    await hx.h['terminals:open'](id, { kind: 'claude', label: 'Claude Code' });
    expect(hx.calls.at(-1)?.flags).not.toContain('--add-dir');
    await hx.terminals.killAllForTask(id);
  });

  it("denies another repo's secret files by absolute path, and user secrets too", async () => {
    const denies: string[][] = [];
    const hx = await finished(
      { removeWorktree: false, deleteBranch: false },
      {
        claudeThemeSettings: (deny) => {
          denies.push(deny ?? []);
          return null;
        },
      },
    );
    const extra = await withExtra(hx);
    const us = mkdtempSync(path.join(os.tmpdir(), 'shellie-us-'));
    mkdirSync(path.join(us, 'abc'));
    writeFileSync(path.join(us, 'abc', 'secrets.json'), '{"K":"v1"}');
    (
      hx.services.platform as { userSecretsDir: (id: string) => string | null }
    ).userSecretsDir = (id) => path.join(us, id);
    writeFileSync(
      path.join(extra, 'Api.csproj'),
      '<Project><PropertyGroup><UserSecretsId>abc</UserSecretsId></PropertyGroup></Project>',
    );
    writeFileSync(path.join(extra, '.env'), 'A=1\n');
    mkdirSync(path.join(extra, 'secrets'));
    writeFileSync(path.join(extra, 'secrets', 'k.json'), '{"x":"1"}');
    await hx.h['tasks:reopen'](hx.t.id);
    await hx.h['terminals:open'](hx.t.id, {
      kind: 'claude',
      label: 'Claude Code',
    });
    const rules = denies.at(-1)!;
    expect(rules).toContain('Read(./.env)');
    // Claude Code matches a Windows path in POSIX form (`C:\\x` is `/c/x`); an absolute rule starts with `//`.
    const claudePath = (p: string) =>
      p
        .split(path.sep)
        .join('/')
        .replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
    const abs = (f: string) => claudePath(path.join(extra, f));
    expect(rules).toContain(`Read(/${abs('.env')})`);
    expect(rules).toContain(`Read(/${abs('secrets')}/**)`);
    expect(rules).toContain(
      `Read(/${claudePath(path.join(us, 'abc', 'secrets.json'))})`,
    );
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('a discovery that throws means no rules and a tab that still starts', async () => {
    const denies: string[][] = [];
    const rec = recording();
    const hx = await harness(fakeCrypto(), {
      platform: {
        ...rec.platform,
        userSecretsDir: () => {
          throw new Error('boom');
        },
      },
      claudeThemeSettings: (deny) => {
        denies.push(deny ?? []);
        return null;
      },
    });
    writeFileSync(
      path.join(hx.repo, 'Api.csproj'),
      '<Project><PropertyGroup><UserSecretsId>abc</UserSecretsId></PropertyGroup></Project>',
    );
    writeFileSync(
      path.join(hx.repo, '.shellie.yml'),
      'copy: [.env, Api.csproj]\n',
    );
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ startClaude: true }));
    await done;
    const claude = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'claude',
    )!;
    await hx.h['terminals:restart'](claude.id);
    expect(denies.at(-1)).toEqual([]);
    expect(rec.calls.length).toBeGreaterThan(1);
    await hx.terminals.killAllForTask(t.id);
  });

  it("reuses a worktree's discovery for 30 s, then reads it again, and never keeps a failure", async () => {
    let clock = Date.now();
    let fail = true;
    let asked = 0;
    const denies: string[][] = [];
    const rec = recording();
    const hx = await harness(fakeCrypto(), {
      now: () => clock,
      platform: {
        ...rec.platform,
        userSecretsDir: () => {
          asked++;
          if (fail) throw new Error('boom');
          return '/nonexistent/none';
        },
      },
      claudeThemeSettings: (deny) => {
        denies.push(deny ?? []);
        return null;
      },
    });
    writeFileSync(
      path.join(hx.repo, 'Api.csproj'),
      '<Project><PropertyGroup><UserSecretsId>abc</UserSecretsId></PropertyGroup></Project>',
    );
    writeFileSync(
      path.join(hx.repo, '.shellie.yml'),
      'copy: [.env, Api.csproj]\n',
    );
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ startClaude: true }));
    await done;
    const claude = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'claude',
    )!;
    const restart = async () => {
      const before = asked;
      await hx.h['terminals:restart'](claude.id);
      return asked - before;
    };
    // The failure from the start is not kept: the next tab reads again, and finds the file.
    expect(await restart()).toBe(1);
    expect(denies.at(-1)).toEqual([]);
    fail = false;
    expect(await restart()).toBe(1);
    expect(denies.at(-1)).toContain('Read(./.env)');
    clock += 29_000;
    expect(await restart()).toBe(0);
    clock += 2_000;
    expect(await restart()).toBe(1);
    await hx.terminals.killAllForTask(t.id);
  });

  it('Claude gets no --add-dir for a workspace whose folder is gone', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    const extra = await withExtra(hx);
    await hx.h['tasks:reopen'](hx.t.id);
    rmSync(extra, { recursive: true, force: true });
    await hx.h['terminals:open'](hx.t.id, {
      kind: 'claude',
      label: 'Claude Code',
    });
    expect(hx.calls.at(-1)?.flags).toEqual([
      '--session-id',
      expect.any(String),
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('opens a shell in the workspace asked for, else in the active home', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    const extra = await withExtra(hx);
    await hx.terminals.killAllForTask(hx.t.id);
    await hx.store.update((st) => {
      st.tasks[0].status = 'ready';
    });
    const spy = vi.spyOn(hx.terminals, 'spawn');
    await hx.h['terminals:open'](hx.t.id, {
      kind: 'shell',
      label: 'sh',
      workspaceId: 'w2',
    });
    await hx.h['terminals:open'](hx.t.id, { kind: 'shell', label: 'sh' });
    expect(spy.mock.calls.map((c) => c[0].cwd)).toEqual([
      extra,
      hx.t.worktreePath,
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('summarises an extra worktree against its own baseRef', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    const extra = await withExtra(hx);
    commitFile(extra, 'a.txt', 'a\n', 'first');
    commitFile(extra, 'b.txt', 'b\n', 'second');
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces[0].baseRef = 'HEAD~1';
    });
    writeFileSync(path.join(extra, 'c.txt'), 'c\n');
    const sum = await hx.h['tasks:gitSummary'](hx.t.id, 'w2');
    expect(sum.files.map((f) => f.path)).toEqual(['c.txt']);
    expect(sum.ahead).toBe(1);
    const home = await hx.h['tasks:gitSummary'](hx.t.id);
    expect(home.files.map((f) => f.path)).not.toContain('c.txt');
  });

  it('a terminal of a removed or dropped workspace runs in the active home', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    await withExtra(hx);
    await hx.terminals.killAllForTask(hx.t.id);
    await hx.store.update((st) => {
      st.tasks[0].status = 'ready';
      st.tasks[0].extraWorkspaces[0].dropped = true;
    });
    const spy = vi.spyOn(hx.terminals, 'spawn');
    for (const workspaceId of ['w2', 'gone'])
      await hx.h['terminals:open'](hx.t.id, {
        kind: 'shell',
        label: 'sh',
        workspaceId,
      });
    expect(spy.mock.calls.map((c) => c[0].cwd)).toEqual([
      hx.t.worktreePath,
      hx.t.worktreePath,
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('reopens a task whose worktree was kept, without setup, resuming Claude', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    expect(await hx.h['tasks:reopen'](hx.t.id)).toEqual({ setup: false });
    const task = hx.store.state.tasks[0];
    expect(task).toMatchObject({
      status: 'ready',
      finishedAt: null,
      closedTerminals: [],
    });
    expect(task.openPeriods).toHaveLength(2);
    expect(task.openPeriods[0].end).not.toBeNull();
    expect(task.openPeriods[1].end).toBeNull();
    expect(task.terminals.map((d) => d.id)).toEqual(hx.before.map((d) => d.id));
    const claude = hx.before.find((d) => d.kind === 'claude')!;
    expect(hx.calls.at(-1)).toEqual({
      context: null,
      flags: ['--resume', claude.sessionId],
    });
    expect(hx.terminals.runningCount(hx.t.id)).toBe(2);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('reopening a task from before time tracking keeps creation to finish as its first period', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    await hx.store.update((st) => {
      st.tasks[0].openPeriods = [];
    });
    const { createdAt, finishedAt } = hx.store.state.tasks[0];
    await hx.h['tasks:reopen'](hx.t.id);
    const periods = hx.store.state.tasks[0].openPeriods;
    expect(periods[0]).toEqual({ start: createdAt, end: finishedAt });
    expect(periods).toHaveLength(2);
    expect(periods[1].end).toBeNull();
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('does not run the Setup tab again when reopening a kept worktree', async () => {
    const hx = await finished(
      { removeWorktree: false, deleteBranch: false },
      {},
      { commands: [echoCmd('setup')] },
    );
    expect(hx.before.some((d) => d.setupCommands)).toBe(true);
    expect(await hx.h['tasks:reopen'](hx.t.id)).toEqual({ setup: false });
    expect(hx.store.state.tasks[0].terminals.map((d) => d.kind)).toEqual([
      'claude',
      'shell',
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('makes the worktree again from the local branch and runs the setup again', async () => {
    const hx = await finished(
      { removeWorktree: true, deleteBranch: false },
      {},
      { commands: [writeLineCmd('ok', 'ok.txt')] },
    );
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    const oldSetupTab = hx.before.find((d) => d.setupCommands)!;
    expect(oldSetupTab).toBeDefined();
    const result = await reopenSetup(hx);
    expect(result.ok).toBe(true);
    expect(
      hx.store.state.tasks[0].openPeriods.map((p) => p.end === null),
    ).toEqual([false, true]);
    expect(existsSync(path.join(hx.t.worktreePath, 'feature.txt'))).toBe(true);
    await vi.waitFor(
      () =>
        expect(existsSync(path.join(hx.t.worktreePath, 'ok.txt'))).toBe(true),
      { timeout: 10_000 },
    );
    const tabs = hx.store.state.tasks[0].terminals;
    // A fresh Setup tab; the one from before Finish is not brought back.
    expect(tabs.filter((d) => d.setupCommands)).toHaveLength(1);
    expect(tabs.map((d) => d.id)).not.toContain(oldSetupTab.id);
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'ready',
      reopen: null,
      extraWorkspaces: [],
      detachedPaths: [],
      homeDropped: false,
      connectionId: null,
      mainCheckoutEdits: [],
      environment: 'development',
      environmentUntil: null,
      pendingCleanup: [],
      finishedAt: null,
      baseSha: hx.t.baseSha ?? hx.store.state.tasks[0].baseSha,
    });
    expect(hx.store.state.tasks[0].terminals.map((d) => d.kind)).toEqual([
      'claude',
      'shell',
      'run',
    ]);
    expect(hx.calls.findLast((c) => c.flags.length > 0)?.flags[0]).toBe(
      '--resume',
    );
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('brings a deleted branch back from origin', async () => {
    const rec = recording();
    const hx = await harness(fakeCrypto(), { platform: rec.platform });
    addOrigin(hx.repo);
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    commitFile(t.worktreePath, 'pushed.txt', 'a\n', 'Pushed work');
    git(t.worktreePath, 'push', '-q', 'origin', t.branch);
    await hx.h['tasks:finish'](
      t.id,
      finishWith({ removeWorktree: true, deleteBranch: true }),
    );
    const finishedDone = hx.setupDone();
    expect(await hx.h['tasks:reopen'](t.id)).toEqual({ setup: true });
    expect(hx.store.state.tasks[0].reopen).toEqual({
      from: `origin/${t.branch}`,
    });
    expect((await finishedDone).ok).toBe(true);
    expect(existsSync(path.join(t.worktreePath, 'pushed.txt'))).toBe(true);
  });

  it('brings a deleted, unpushed branch back from its last commit', async () => {
    const hx = await finished({ removeWorktree: true, deleteBranch: true });
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(
      false,
    );
    const result = await reopenSetup(hx);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(hx.t.worktreePath, 'feature.txt'))).toBe(true);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('refuses when the branch is gone for good, and the task stays done', async () => {
    const hx = await finished({ removeWorktree: true, deleteBranch: true });
    await hx.store.update((st) => {
      st.tasks[0].summary!.commits = [{ sha: 'f'.repeat(40), subject: 'x' }];
    });
    await expect(hx.h['tasks:reopen'](hx.t.id)).rejects.toThrow(
      `Branch ${hx.t.branch} cannot be restored`,
    );
    expect(hx.store.state.tasks[0].status).toBe('done');
    // Not left busy: a second try gives the same answer, not "Task is busy".
    await expect(hx.h['tasks:reopen'](hx.t.id)).rejects.toThrow(
      'cannot be restored',
    );
  });

  it('cancelling a failed reopen puts the task back to done and keeps it', async () => {
    const hx = await finished(
      { removeWorktree: true, deleteBranch: false },
      {},
      {
        beforeFinish: (t) =>
          commitFile(t.worktreePath, 'apm.yml', 'name: webshop\n'),
      },
    );
    hx.failSetup();
    const result = await reopenSetup(hx);
    expect(result.ok).toBe(false);
    expect(hx.store.state.tasks[0].status).toBe('setup-failed');
    await hx.h['tasks:cancelSetup'](hx.t.id);
    expect(hx.store.state.tasks).toHaveLength(1);
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'done',
      reopen: null,
      extraWorkspaces: [],
      detachedPaths: [],
      homeDropped: false,
      connectionId: null,
      mainCheckoutEdits: [],
      environment: 'development',
      environmentUntil: null,
      pendingCleanup: [],
    });
    expect(
      hx.store.state.tasks[0].openPeriods.every((p) => p.end !== null),
    ).toBe(true);
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(true);
  });

  it('continues the latest Claude session in the folder for a task finished before tabs were kept', async () => {
    const hx = await finished(
      { removeWorktree: false, deleteBranch: false },
      { claudeHasSessionsIn: () => true },
    );
    await hx.store.update((st) => {
      st.tasks[0].closedTerminals = [];
    });
    await hx.h['tasks:reopen'](hx.t.id);
    expect(hx.calls.at(-1)).toEqual({ context: null, flags: ['--continue'] });
    await hx.terminals.killAllForTask(hx.t.id);
  });
  /**
   * A task in `webshop` (home, no changes) plus a worktree on its branch in `api` with one commit, finished with
   * its worktrees removed and branches kept. `api`'s .shellie.yml copies .env and writes api.txt.
   */
  async function finishedMulti(
    o: {
      home?: 'keep' | 'drop';
      extra?: 'keep' | 'drop';
      apiSetup?: string[];
      /** Created without tabs; one Claude tab is opened by hand before Finish. */
      noInitialTabs?: boolean;
    } = {},
  ) {
    const rec = recording();
    const api = makeRepo('api');
    writeFileSync(path.join(api, '.env'), 'API=1');
    const apiSetup = o.apiSetup ?? [writeLineCmd('api', 'api.txt')];
    const hx = await harness(fakeCrypto(), {
      platform: rec.platform,
      claudeSessionExists: () => true,
      loadConfig: async (p) =>
        p === api
          ? { ...(await loadShellieConfig(p)), copy: ['.env'], setup: apiSetup }
          : loadShellieConfig(p),
    });
    // The copied .env is ignored, as in a real repo, so a home without commits can be dropped.
    commitFile(hx.repo, '.gitignore', '.env\n');
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({
        startClaude: !o.noInitialTabs,
        openShell: false,
        commands: [],
      }),
    );
    await done;
    if (o.noInitialTabs)
      await hx.h['terminals:open'](t.id, { kind: 'claude', label: 'Claude' });
    const added = await hx.h['repos:add'](api);
    const wt = path.join(path.dirname(api), 'api-wt');
    git(api, 'worktree', 'add', '-q', '-b', t.branch, wt, 'main');
    if (o.extra !== 'drop') commitFile(wt, 'api-work.txt', 'a\n', 'API work');
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces.push({
        id: 'w2',
        repoId: added.id,
        branch: t.branch,
        worktreePath: wt,
        baseRef: 'main',
        baseSha: null,
        source: 'detected',
        summary: null,
        pullRequest: null,
        reopen: null,
        dropped: false,
      });
    });
    const before = hx.store.state.tasks[0].terminals;
    await hx.h['tasks:finish'](t.id, {
      ...finishWith({ removeWorktree: true, deleteBranch: false }),
      workspaces: [
        { workspaceId: 'home', action: o.home ?? 'keep' },
        { workspaceId: 'w2', action: o.extra ?? 'keep' },
      ],
    });
    expect(hx.store.state.tasks[0].status).toBe('done');
    expect(existsSync(t.worktreePath)).toBe(false);
    expect(existsSync(wt)).toBe(false);
    return { ...hx, ...rec, t, before, api, wt };
  }
  const extraOf = (hx: { store: TaskStore }) =>
    hx.store.state.tasks[0].extraWorkspaces[0];

  it('reopens every repo: reopen.from on each, both worktrees made again with their own setup', async () => {
    const hx = await finishedMulti();
    const done = hx.setupDone();
    expect(await hx.h['tasks:reopen'](hx.t.id)).toEqual({ setup: true });
    expect(hx.store.state.tasks[0].reopen).toEqual({ from: null });
    expect(extraOf(hx).reopen).toEqual({ from: null });
    expect((await done).ok).toBe(true);
    const state = await hx.h['tasks:setupState'](hx.t.id);
    expect(state!.steps.map((x) => x.def.label)).toEqual([
      'Restore worktree',
      'Copy local files',
      'Write task file',
      'Restore api worktree',
      'Copy local files (api)',
      writeLineCmd('api', 'api.txt'),
      'Restore terminals',
    ]);
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    expect(existsSync(path.join(hx.wt, 'api-work.txt'))).toBe(true);
    expect(existsSync(path.join(hx.wt, '.env'))).toBe(true);
    expect(existsSync(path.join(hx.wt, 'api.txt'))).toBe(true);
    expect(existsSync(path.join(hx.t.worktreePath, 'api.txt'))).toBe(false);
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'ready',
      reopen: null,
      finishedAt: null,
    });
    expect(extraOf(hx).reopen).toBeNull();
    expect(hx.calls.at(-1)?.flags).toEqual([
      '--resume',
      hx.before[0].sessionId,
      '--add-dir',
      hx.wt,
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('a dropped repo is not restored', async () => {
    const hx = await finishedMulti({ extra: 'drop' });
    expect(extraOf(hx).dropped).toBe(true);
    const done = hx.setupDone();
    await hx.h['tasks:reopen'](hx.t.id);
    expect(extraOf(hx).reopen).toBeNull();
    expect((await done).ok).toBe(true);
    const state = await hx.h['tasks:setupState'](hx.t.id);
    expect(state!.steps.map((x) => x.def.label)).toEqual([
      'Restore worktree',
      'Copy local files',
      'Write task file',
      'Restore terminals',
    ]);
    expect(existsSync(hx.wt)).toBe(false);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('a task whose home was dropped restores only the other repo, and Claude resumes there', async () => {
    const hx = await finishedMulti({ home: 'drop' });
    expect(hx.store.state.tasks[0].homeDropped).toBe(true);
    const spy = vi.spyOn(hx.terminals, 'spawn');
    const done = hx.setupDone();
    await hx.h['tasks:reopen'](hx.t.id);
    expect(hx.store.state.tasks[0].reopen).toBeNull();
    expect(extraOf(hx).reopen).toEqual({ from: null });
    expect((await done).ok).toBe(true);
    const state = await hx.h['tasks:setupState'](hx.t.id);
    expect(state!.steps.map((x) => x.def.label)).toEqual([
      'Restore api worktree',
      'Copy local files (api)',
      writeLineCmd('api', 'api.txt'),
      'Restore terminals',
    ]);
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(existsSync(path.join(hx.wt, 'api-work.txt'))).toBe(true);
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(spy.mock.calls.map((c) => c[0].cwd)).toEqual([hx.wt]);
    expect(hx.calls.at(-1)?.flags).toEqual([
      '--resume',
      hx.before[0].sessionId,
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('a task whose home was dropped is not "folder missing" once reopened', async () => {
    const hx = await finishedMulti({ home: 'drop' });
    const done = hx.setupDone();
    await hx.h['tasks:reopen'](hx.t.id);
    expect((await done).ok).toBe(true);
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    const [view] = await hx.h['tasks:list']();
    expect(view.worktreeMissing).toBe(false);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('a dropped-home reopen of a task created without tabs brings back the tabs it had at Finish', async () => {
    const hx = await finishedMulti({ home: 'drop', noInitialTabs: true });
    expect(hx.before.map((d) => d.kind)).toEqual(['claude']);
    const done = hx.setupDone();
    await hx.h['tasks:reopen'](hx.t.id);
    expect((await done).ok).toBe(true);
    const state = await hx.h['tasks:setupState'](hx.t.id);
    expect(state!.steps.at(-1)!.def).toMatchObject({
      label: 'Restore terminals',
      detail: 'Claude',
    });
    // A reopen never touches the work item.
    expect(state!.steps.map((x) => x.def.kind)).not.toContain('workitem');
    expect(hx.store.state.tasks[0].terminals).toEqual(hx.before);
    expect(hx.calls.at(-1)?.flags).toEqual([
      '--resume',
      hx.before[0].sessionId,
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('names the repo whose branch cannot be restored', async () => {
    const hx = await finishedMulti();
    git(hx.api, 'branch', '-D', hx.t.branch);
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces[0].summary = null;
    });
    await expect(hx.h['tasks:reopen'](hx.t.id)).rejects.toThrow(
      `api: branch ${hx.t.branch} cannot be restored`,
    );
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  it('a failing restore of a repo fails setup at its step, and Retry resumes there', async () => {
    const hx = await finishedMulti({ apiSetup: [failCmd(3)] });
    const failed = hx.setupDone();
    await hx.h['tasks:reopen'](hx.t.id);
    expect(await failed).toMatchObject({ ok: false, failedStep: 5 });
    expect(hx.store.state.tasks[0].status).toBe('setup-failed');
    const state = await hx.h['tasks:setupState'](hx.t.id);
    expect(state!.steps[5].def).toMatchObject({
      kind: 'command',
      detail: 'in api',
      workspaceId: 'w2',
    });
    // The repo's setup command is fixed; the retry starts at the failed step.
    const runSpy = vi.spyOn(hx.services.runner, 'run');
    const retried = hx.setupDone();
    hx.services.loadConfig = async (p) =>
      p === hx.api
        ? {
            ...(await loadShellieConfig(p)),
            copy: ['.env'],
            setup: [writeLineCmd('retried', 'api.txt')],
          }
        : loadShellieConfig(p);
    await hx.h['tasks:retrySetup'](hx.t.id);
    expect((await retried).ok).toBe(true);
    expect(runSpy.mock.calls[0][1].fromStep).toBe(5);
    expect(existsSync(path.join(hx.wt, 'api.txt'))).toBe(true);
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(extraOf(hx).reopen).toBeNull();
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('cancelling a failed reopen removes every remade worktree and the task goes back to done', async () => {
    const hx = await finishedMulti({ apiSetup: [failCmd(3)] });
    const failed = hx.setupDone();
    await hx.h['tasks:reopen'](hx.t.id);
    expect((await failed).ok).toBe(false);
    expect(existsSync(hx.wt)).toBe(true);
    await hx.h['tasks:cancelSetup'](hx.t.id);
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'done',
      reopen: null,
    });
    expect(extraOf(hx).reopen).toBeNull();
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(existsSync(hx.wt)).toBe(false);
    expect(await new GitClient().branchExists(hx.api, hx.t.branch)).toBe(true);
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(true);
  });

  it('a kept home with a removed repo goes through setup for that repo only', async () => {
    const hx = await finishedMulti();
    git(hx.repo, 'worktree', 'add', '-q', hx.t.worktreePath, hx.t.branch);
    writeFileSync(path.join(hx.t.worktreePath, 'mine.txt'), 'x');
    const done = hx.setupDone();
    expect(await hx.h['tasks:reopen'](hx.t.id)).toEqual({ setup: true });
    expect(hx.store.state.tasks[0].reopen).toBeNull();
    expect((await done).ok).toBe(true);
    const state = await hx.h['tasks:setupState'](hx.t.id);
    expect(state!.steps[0].def.label).toBe('Restore api worktree');
    expect(existsSync(path.join(hx.wt, 'api-work.txt'))).toBe(true);
    expect(existsSync(path.join(hx.t.worktreePath, 'mine.txt'))).toBe(true);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('reopens without setup when every repo kept its worktree', async () => {
    const hx = await finishedMulti();
    git(hx.repo, 'worktree', 'add', '-q', hx.t.worktreePath, hx.t.branch);
    git(hx.api, 'worktree', 'add', '-q', hx.wt, hx.t.branch);
    expect(await hx.h['tasks:reopen'](hx.t.id)).toEqual({ setup: false });
    expect(hx.store.state.tasks[0].status).toBe('ready');
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('refuses when every repo was removed without changes', async () => {
    const hx = await finishedMulti({ home: 'drop', extra: 'drop' });
    await expect(hx.h['tasks:reopen'](hx.t.id)).rejects.toThrow(
      'Nothing to reopen: every repo of this task was removed without changes',
    );
    expect(hx.store.state.tasks[0].status).toBe('done');
  });
});

describe('handlers: run terminal command', () => {
  it('starts a run terminal with runCommand, not the setup wrapper', async () => {
    const base = testPlatform();
    const ran: string[] = [];
    const platform = {
      ...base,
      runCommand: (cmd: string) => {
        ran.push(cmd);
        return base.runCommand(cmd);
      },
    };
    const hx = await harness(fakeCrypto(), { platform });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    const command = `${echoCmd('via-run')}; ${sleepCmd(5)}`;
    const def = await hx.h['terminals:open'](t.id, {
      kind: 'run',
      label: 'dev',
      command,
    });
    expect(ran).toEqual([command]);
    await vi.waitFor(
      async () =>
        expect(await hx.h['terminals:buffer'](def.id)).toContain('via-run'),
      { timeout: 10_000 },
    );
    await hx.terminals.killAllForTask(t.id);
  });
});

describe('handlers: after a relaunch', () => {
  it('restarts a persisted terminal that the new TerminalManager does not know', async () => {
    const { h, input, setupDone, terminals, store, services } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input());
    await done;
    const shellId = store.state.tasks[0].terminals[0].id;
    terminals.killAllForTask(t.id);
    const fresh = new TerminalManager();
    allTerminals.push(fresh);
    const h2 = createHandlers({ ...services, terminals: fresh });
    expect(fresh.runningCount(t.id)).toBe(0);
    await h2['terminals:restart'](shellId);
    expect(fresh.runningCount(t.id)).toBe(1);
    expect(typeof (await h2['terminals:buffer'](shellId))).toBe('string');
    await expect(h2['terminals:restart']('nope')).rejects.toThrow();
  });
});

describe('recoverInterruptedTasks', () => {
  it('turns setting-up into setup-failed and finishing into ready', async () => {
    const store = new TaskStore(
      path.join(
        mkdtempSync(path.join(os.tmpdir(), 'shellie-rec-')),
        'state.json',
      ),
    );
    await store.load();
    const base: Omit<Task, 'id' | 'branch' | 'status'> = {
      repoId: 'r',
      name: 'x',
      workItem: null,
      slug: 'x',
      worktreePath: '/w',
      baseRef: 'main',
      baseSha: null,
      openPeriods: [],
      time: null,
      setup: {
        copy: false,
        commands: [],
        startClaude: false,
        openShell: false,
        openCopilot: false,
      },
      terminals: [],
      createdAt: 'now',
      finishedAt: null,
      usageSyncedAt: null,
      usageSyncError: null,
      usageCommentId: null,
      summary: null,
      pullRequest: null,
      closedTerminals: [],
      reopen: null,
      extraWorkspaces: [],
      detachedPaths: [],
      homeDropped: false,
      connectionId: null,
      mainCheckoutEdits: [],
      environment: 'development',
      environmentUntil: null,
      pendingCleanup: [],
    };
    await store.update((s) => {
      s.tasks.push(
        { ...base, id: 'a', branch: 'a', status: 'setting-up' },
        { ...base, id: 'b', branch: 'b', status: 'finishing' },
        { ...base, id: 'c', branch: 'c', status: 'ready' },
      );
    });
    expect(await recoverInterruptedTasks(store)).toBe(2);
    expect(store.state.tasks.map((t) => t.status)).toEqual([
      'setup-failed',
      'ready',
      'ready',
    ]);
  });
});

function routeHealthyOrg(server: AdoServer, org = 'unreliablewitness') {
  server.route('GET', `/${org}/_apis/connectionData`, {
    body: { authenticatedUser: { providerDisplayName: 'Dries Hoebeke' } },
  });
  server.route('GET', `/${org}/_apis/projects/Shellie`, {
    body: { name: 'Shellie' },
  });
  server.route('GET', `/${org}/Shellie/_apis/work/teamsettings/iterations`, {
    body: {
      value: [
        {
          id: 'it-1',
          name: 'Sprint 1',
          path: 'Shellie\\Sprint 1',
          attributes: { timeFrame: 'current' },
        },
      ],
    },
  });
  server.route(
    'GET',
    `/${org}/Shellie/_apis/work/teamsettings/iterations/it-1/workitems`,
    {
      body: {
        workItemRelations: [{ rel: null, source: null, target: { id: 5 } }],
      },
    },
  );
  server.route('POST', `/${org}/Shellie/_apis/wit/wiql`, {
    body: { workItems: [{ id: 5 }] },
  });
  server.route('GET', `/${org}/_apis/wit/workitems`, {
    body: {
      value: [
        {
          id: 5,
          fields: {
            'System.WorkItemType': 'Issue',
            'System.Title': 'Five',
            'System.State': 'To Do',
            'System.AreaPath': 'Shellie',
            'System.IterationPath': 'Shellie\\Sprint 1',
          },
        },
      ],
    },
  });
}

async function linkedTask(hx: Awaited<ReturnType<typeof harness>>) {
  routeHealthyOrg(hx.server);
  const c = await hx.h['connections:save']({
    organizationUrl: `${hx.server.url}/unreliablewitness`,
    project: 'Shellie',
    pat: 'secret-pat',
  });
  await hx.h['repos:setConnection'](hx.added.id, c.id);
  const done = hx.setupDone();
  const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
  await done;
  await hx.usage.add({
    id: 'req-1',
    taskId: t.id,
    tool: 'claude-code',
    sessionId: 's1',
    model: 'claude-opus-5-5',
    at: '2026-10-14T10:00:00.000Z',
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    fast: false,
  });
  hx.server.route('GET', '/unreliablewitness/Shellie/_apis/wit/workitemtypes', {
    body: {
      value: [
        {
          name: 'User Story',
          fields: [{ referenceName: 'System.Title' }],
        },
      ],
    },
  });
  hx.server.route('PATCH', '/unreliablewitness/_apis/wit/workitems/48231', {
    body: { id: 48231 },
  });
  hx.server.route(
    'POST',
    '/unreliablewitness/Shellie/_apis/wit/workItems/48231/comments',
    { body: { id: 501 } },
  );
  return { t, c };
}

describe('handlers: connections', () => {
  it('saves after verifying, lists without the token, and broadcasts', async () => {
    const { h, server, broadcasts } = await harness();
    routeHealthyOrg(server);
    const c = await h['connections:save']({
      organizationUrl: `${server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'secret-pat',
    });
    expect(c).toMatchObject({
      project: 'Shellie',
      status: 'ok',
      user: 'Dries Hoebeke',
    });
    expect(JSON.stringify(await h['connections:list']())).not.toContain(
      'secret-pat',
    );
    expect(broadcasts.some((b) => b.event === 'connections:changed')).toBe(
      true,
    );
  });
  it('keeps the unique name from verification, so a new connection can assign work items', async () => {
    const { h, server } = await harness();
    routeHealthyOrg(server);
    server.route('GET', '/unreliablewitness/_apis/connectionData', {
      body: {
        authenticatedUser: {
          providerDisplayName: 'Dries Hoebeke',
          properties: { Account: { $value: 'dries@example.com' } },
        },
      },
    });
    const c = await h['connections:save']({
      organizationUrl: `${server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'p',
    });
    expect(c.userUniqueName).toBe('dries@example.com');
  });
  it('does not save when verification fails', async () => {
    const { h, server } = await harness();
    server.route('GET', '/unreliablewitness/_apis/connectionData', {
      status: 401,
      body: {},
    });
    await expect(
      h['connections:save']({
        organizationUrl: `${server.url}/unreliablewitness`,
        project: 'Shellie',
        pat: 'bad',
      }),
    ).rejects.toThrow(/rejected the token/);
    expect(await h['connections:list']()).toEqual([]);
  });
  it('verify flips status to unauthorized on 401 and back to ok', async () => {
    const { h, server } = await harness();
    routeHealthyOrg(server);
    const c = await h['connections:save']({
      organizationUrl: `${server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'p',
    });
    server.route('GET', '/unreliablewitness/_apis/connectionData', {
      status: 401,
      body: {},
    });
    await expect(h['connections:verify'](c.id)).rejects.toThrow();
    expect((await h['connections:list']())[0].status).toBe('unauthorized');
    routeHealthyOrg(server);
    expect((await h['connections:verify'](c.id)).status).toBe('ok');
  });
  it('removing a connection unlinks its repos', async () => {
    const { h, server, added } = await harness();
    routeHealthyOrg(server);
    const c = await h['connections:save']({
      organizationUrl: `${server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'p',
    });
    expect((await h['repos:setConnection'](added.id, c.id)).connectionId).toBe(
      c.id,
    );
    await h['connections:remove'](c.id);
    expect((await h['repos:list']())[0].connectionId).toBeNull();
    await expect(h['repos:setConnection'](added.id, 'ghost')).rejects.toThrow(
      /Unknown connection/,
    );
  });
});

describe('handlers: connections:probe and connections:saveMany', () => {
  const authFor = (pat: string) =>
    `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  const routeOrg = (server: AdoServer, org = 'uw') => {
    server.route('GET', `/${org}/_apis/connectionData`, {
      body: {
        authenticatedUser: {
          providerDisplayName: 'Dries Hoebeke',
          properties: { Account: { $value: 'dries@example.com' } },
        },
      },
    });
    server.route('GET', `/${org}/_apis/projects`, {
      body: {
        value: [
          { id: 'p1', name: 'Shellie' },
          { id: 'p2', name: 'Webshop' },
          { id: 'p3', name: 'Infra' },
        ],
      },
    });
  };
  const onStart = {
    moveToInProgress: false,
    assignToMe: true,
    stateOverrides: {},
  };

  it('probe returns the user and the projects for a new token', async () => {
    const { h, server } = await harness();
    routeOrg(server);
    expect(
      await h['connections:probe']({
        organizationUrl: `${server.url}/uw/`,
        pat: ' secret-pat ',
      }),
    ).toEqual({
      user: 'Dries Hoebeke',
      uniqueName: 'dries@example.com',
      projects: [
        { id: 'p1', name: 'Shellie' },
        { id: 'p2', name: 'Webshop' },
        { id: 'p3', name: 'Infra' },
      ],
      canListProjects: true,
    });
    expect(server.requests.every((r) => r.auth === authFor('secret-pat'))).toBe(
      true,
    );
    expect(await h['connections:list']()).toEqual([]);
  });

  it('probe signs in but cannot list projects on a 403 for projects alone', async () => {
    const { h, server } = await harness();
    routeOrg(server);
    server.route('GET', '/uw/_apis/projects', { status: 403, body: {} });
    expect(
      await h['connections:probe']({
        organizationUrl: `${server.url}/uw`,
        pat: 'p',
      }),
    ).toMatchObject({
      user: 'Dries Hoebeke',
      projects: [],
      canListProjects: false,
    });
  });

  it('probe reports a refused token with its status only, never the URL or token', async () => {
    const events: [string, unknown][] = [];
    const { h, server } = await harness(fakeCrypto(), {
      telemetry: {
        ...NoopTelemetry,
        event: (name, props) => events.push([name, props]),
      },
    });
    server.route('GET', '/uw/_apis/connectionData', { status: 401, body: {} });
    await expect(
      h['connections:probe']({
        organizationUrl: `${server.url}/uw`,
        pat: 'bad',
      }),
    ).rejects.toThrow(/rejected the token/);
    expect(events).toContainEqual(['connection.probeFailed', { status: 401 }]);
  });

  it("probe reuses a connection's stored token and organization when given its id", async () => {
    const { h, server } = await harness();
    routeHealthyOrg(server, 'uw');
    routeOrg(server);
    const c = await h['connections:save']({
      organizationUrl: `${server.url}/uw`,
      project: 'Shellie',
      pat: 'stored-pat',
    });
    server.requests.length = 0;
    const result = await h['connections:probe']({
      organizationUrl: 'https://dev.azure.com/elsewhere',
      connectionId: c.id,
    });
    expect(result.projects).toHaveLength(3);
    expect(server.requests.length).toBeGreaterThan(0);
    expect(server.requests.every((r) => r.auth === authFor('stored-pat'))).toBe(
      true,
    );
  });

  it('saveMany saves one connection per new project with the on-start options and skips existing ones', async () => {
    const { h, server } = await harness();
    routeOrg(server);
    for (const p of ['Shellie', 'Webshop', 'Infra'])
      server.route('GET', `/uw/_apis/projects/${p}`, { body: { name: p } });
    const first = await h['connections:saveMany']({
      organizationUrl: `${server.url}/uw`,
      pat: 'secret-pat',
      projects: ['Shellie', 'Webshop'],
      workItemOnStart: onStart,
      provider: 'azure-devops',
    });
    // The name is the organization; every screen shows the project next to it.
    expect(first.map((c) => [c.name, c.project])).toEqual([
      ['uw', 'Shellie'],
      ['uw', 'Webshop'],
    ]);
    expect(first[0]).toMatchObject({
      project: 'Shellie',
      status: 'ok',
      user: 'Dries Hoebeke',
      userUniqueName: 'dries@example.com',
      provider: 'azure-devops',
      workItemOnStart: onStart,
    });
    server.requests.length = 0;
    const again = await h['connections:saveMany']({
      organizationUrl: `${server.url}/uw`,
      connectionId: first[0].id,
      projects: ['Shellie', 'Infra'],
      workItemOnStart: onStart,
      provider: 'azure-devops',
    });
    expect(again.map((c) => [c.name, c.project])).toEqual([['uw', 'Infra']]);
    expect(server.requests.every((r) => r.auth === authFor('secret-pat'))).toBe(
      true,
    );
    expect((await h['connections:list']()).map((c) => c.project)).toEqual([
      'Shellie',
      'Webshop',
      'Infra',
    ]);
  });

  it('clears a No-tracker choice once a connection is saved, and keeps it when nothing was saved', async () => {
    const { h, server, settings } = await harness();
    routeOrg(server);
    server.route('GET', '/uw/_apis/projects/Shellie', {
      body: { name: 'Shellie' },
    });
    const none = {
      ...settings.get(),
      onboarding: { ...settings.get().onboarding, tracker: 'none' as const },
    };
    await settings.save(none);
    expect(
      await h['connections:saveMany']({
        organizationUrl: `${server.url}/uw`,
        pat: 'p',
        projects: [],
        workItemOnStart: onStart,
        provider: 'azure-devops',
      }),
    ).toEqual([]);
    expect(settings.get().onboarding.tracker).toBe('none');
    await h['connections:saveMany']({
      organizationUrl: `${server.url}/uw`,
      pat: 'p',
      projects: ['Shellie'],
      workItemOnStart: onStart,
      provider: 'azure-devops',
    });
    expect(settings.get().onboarding.tracker).toBeNull();
    expect(settings.get().onboarding.agentsCheckedAt).toBe(
      none.onboarding.agentsCheckedAt,
    );
    await settings.save(none);
    await h['connections:save']({
      organizationUrl: `${server.url}/uw`,
      project: 'Shellie',
      pat: 'p',
    });
    expect(settings.get().onboarding.tracker).toBeNull();
  });

  it("repos:add copies the linked connection's on-start options into the repo", async () => {
    const { h, server } = await harness();
    routeOrg(server);
    server.route('GET', '/uw/_apis/projects/Shellie', {
      body: { name: 'Shellie' },
    });
    const [c] = await h['connections:saveMany']({
      organizationUrl: `${server.url}/uw`,
      pat: 'p',
      projects: ['Shellie'],
      workItemOnStart: onStart,
      provider: 'azure-devops',
    });
    const repo = await h['repos:add'](makeRepo('onstart'), {
      connectionId: c.id,
    });
    expect(repo.workItemOnStart).toEqual(onStart);
    const unlinked = await h['repos:add'](makeRepo('onstart-none'));
    expect(unlinked.workItemOnStart).toEqual({
      moveToInProgress: true,
      assignToMe: true,
      stateOverrides: {},
    });
  });
});

describe('handlers: connection robustness', () => {
  it('validates before any network call', async () => {
    const { h, server } = await harness();
    await expect(
      h['connections:save']({
        organizationUrl: `${server.url}/unreliablewitness`,
        project: ' ',
        pat: 'secret',
      }),
    ).rejects.toThrow(/project/);
    expect(server.requests).toHaveLength(0);
  });
  it('keeps the original error when the connection disappears mid-call', async () => {
    const { h, server, connections } = await harness();
    routeHealthyOrg(server);
    const c = await h['connections:save']({
      organizationUrl: `${server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'p',
    });
    server.route('POST', '/unreliablewitness/Shellie/_apis/wit/wiql', () => {
      void connections.remove(c.id);
      return { status: 401, body: {} };
    });
    await expect(
      h['workItems:search'](c.id, { scope: 'mine', text: '' }),
    ).rejects.toThrow(/rejected the token/);
  });
  it('an undecryptable stored token flips the status without a network call', async () => {
    let broken = false;
    const base = fakeCrypto();
    const { h, server, connections } = await harness({
      ...base,
      decrypt: (b) => {
        if (broken) throw new Error('decrypt failed');
        return base.decrypt(b);
      },
    });
    const c = await connections.save({
      organizationUrl: `${server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'p',
    });
    broken = true;
    await expect(
      h['workItems:search'](c.id, { scope: 'mine', text: '' }),
    ).rejects.toThrow(/could not be decrypted/);
    expect((await h['connections:list']())[0].status).toBe('unauthorized');
    expect(server.requests).toHaveLength(0);
  });
});

describe('handlers: work items', () => {
  it('returns the current iteration and search results through the connection', async () => {
    const { h, server } = await harness();
    routeHealthyOrg(server);
    const c = await h['connections:save']({
      organizationUrl: `${server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'p',
    });
    expect(await h['workItems:currentIteration'](c.id)).toEqual({
      id: 'it-1',
      path: 'Shellie\\Sprint 1',
      name: 'Sprint 1',
      startDate: null,
      finishDate: null,
    });
    const items = await h['workItems:search'](c.id, {
      scope: 'sprint',
      text: '',
    });
    expect(items.map((i) => i.id)).toEqual(['5']);
    const wiql = server.requests.find((r) => r.method === 'POST');
    expect(JSON.parse(wiql!.body).query).toContain(
      "[System.IterationPath] = 'Shellie\\Sprint 1'",
    );
  });
  it('a 401 during search marks the connection unauthorized and broadcasts', async () => {
    const { h, server, broadcasts } = await harness();
    routeHealthyOrg(server);
    const c = await h['connections:save']({
      organizationUrl: `${server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'p',
    });
    broadcasts.length = 0;
    server.route('POST', '/unreliablewitness/Shellie/_apis/wit/wiql', {
      status: 401,
      body: {},
    });
    await expect(
      h['workItems:search'](c.id, { scope: 'mine', text: '' }),
    ).rejects.toThrow(/rejected the token/);
    expect((await h['connections:list']())[0].status).toBe('unauthorized');
    expect(broadcasts.some((b) => b.event === 'connections:changed')).toBe(
      true,
    );
  });
});

describe('handlers: sprint, types and live work items', () => {
  const save = async (hx: Awaited<ReturnType<typeof harness>>) => {
    routeHealthyOrg(hx.server);
    return hx.h['connections:save']({
      organizationUrl: `${hx.server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'p',
    });
  };
  it('returns the sprint rows through the connection', async () => {
    const hx = await harness();
    const c = await save(hx);
    const sprint = await hx.h['workItems:sprint'](c.id);
    expect(sprint.iteration?.name).toBe('Sprint 1');
    expect(sprint.rows.map((r) => [r.item.id, r.item.title, r.depth])).toEqual([
      ['5', 'Five', 0],
    ]);
  });
  it('a 401 on the sprint marks the connection unauthorized', async () => {
    const hx = await harness();
    const c = await save(hx);
    hx.server.route(
      'GET',
      '/unreliablewitness/Shellie/_apis/work/teamsettings/iterations',
      { status: 401, body: {} },
    );
    await expect(hx.h['workItems:sprint'](c.id)).rejects.toThrow(
      /rejected the token/,
    );
    expect((await hx.h['connections:list']())[0].status).toBe('unauthorized');
  });
  it('loads the types with icons as data URLs once per connection, and retries after a failure', async () => {
    const hx = await harness();
    const c = await save(hx);
    hx.server.route(
      'GET',
      '/unreliablewitness/Shellie/_apis/wit/workitemtypes',
      {
        status: 500,
        body: {},
      },
    );
    await expect(hx.h['workItems:types'](c.id)).rejects.toThrow();
    hx.server.route(
      'GET',
      '/unreliablewitness/Shellie/_apis/wit/workitemtypes',
      {
        body: {
          value: [
            {
              name: 'Task',
              color: 'A4880A',
              icon: {
                url: `${hx.server.url}/unreliablewitness/_apis/wit/workItemIcons/icon_check_box`,
              },
              states: [
                { name: 'Done', color: '339933', category: 'Completed' },
              ],
            },
          ],
        },
      },
    );
    hx.server.route('GET', '/unreliablewitness/_apis/wit/workItemIcons/', {
      raw: '<svg/>',
      headers: { 'content-type': 'image/svg+xml' },
    });
    const types = await hx.h['workItems:types'](c.id);
    expect(types).toEqual([
      {
        name: 'Task',
        color: '#a4880a',
        icon: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
        states: [{ name: 'Done', color: '#339933', category: 'Completed' }],
      },
    ]);
    // The icon came from under the organization itself, so it carried the PAT.
    const icon = hx.server.requests.find((r) =>
      r.path.startsWith('/unreliablewitness/_apis/wit/workItemIcons/'),
    );
    expect(icon!.auth).toBe(`Basic ${Buffer.from(':p').toString('base64')}`);
    const before = hx.server.requests.length;
    expect(await hx.h['workItems:types'](c.id)).toEqual(types);
    expect(hx.server.requests.length).toBe(before);
  });
  it('gets one work item live, or null when it is gone', async () => {
    const hx = await harness();
    const c = await save(hx);
    expect(await hx.h['workItems:get'](c.id, '5')).toMatchObject({
      id: '5',
      state: 'To Do',
    });
    expect(await hx.h['workItems:get'](c.id, '5')).toHaveProperty(
      'remainingWork',
    );
    hx.server.route('GET', '/unreliablewitness/_apis/wit/workitems', {
      body: { value: [null] },
    });
    expect(await hx.h['workItems:get'](c.id, '5')).toBeNull();
    expect(await hx.h['workItems:get'](c.id, 'x')).toBeNull();
  });
});

describe('handlers: work item robustness', () => {
  it('a successful call heals a stale unreachable status and broadcasts', async () => {
    const { h, server, broadcasts, connections } = await harness();
    routeHealthyOrg(server);
    const c = await h['connections:save']({
      organizationUrl: `${server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'p',
    });
    await connections.setStatus(c.id, 'unreachable');
    broadcasts.length = 0;
    await h['workItems:search'](c.id, { scope: 'mine', text: '' });
    expect(connections.get(c.id)).toMatchObject({
      status: 'ok',
      user: 'Dries Hoebeke',
    });
    expect(broadcasts.some((b) => b.event === 'connections:changed')).toBe(
      true,
    );
  });
  it('sprint scope without a current iteration returns nothing and skips wiql', async () => {
    const { h, server } = await harness();
    routeHealthyOrg(server);
    const c = await h['connections:save']({
      organizationUrl: `${server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'p',
    });
    server.route(
      'GET',
      '/unreliablewitness/Shellie/_apis/work/teamsettings/iterations',
      { body: { value: [] } },
    );
    server.requests.length = 0;
    expect(
      await h['workItems:search'](c.id, { scope: 'sprint', text: '' }),
    ).toEqual([]);
    expect(server.requests.some((r) => r.path.includes('/wiql'))).toBe(false);
  });
  it('prunes repo links to connections that no longer exist', async () => {
    const { h, services, added, connections } = await harness();
    await services.repos.setConnection(added.id, 'gone');
    expect(
      await pruneDanglingConnectionLinks(services.repos, connections),
    ).toBe(1);
    expect(services.repos.get(added.id).connectionId).toBeNull();
    expect(
      await pruneDanglingConnectionLinks(services.repos, connections),
    ).toBe(0);
    expect(await h['repos:list']()).toHaveLength(1);
  });
});

describe('handlers: shell', () => {
  it('opens only Azure DevOps urls', async () => {
    const { h, opened } = await harness();
    await h['shell:openExternal'](
      'https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/5',
    );
    await h['shell:openExternal'](
      'https://contoso.visualstudio.com/P/_workitems/edit/1',
    );
    await expect(
      h['shell:openExternal']('https://evil.example/x'),
    ).rejects.toThrow(/not allowed/);
    await expect(
      h['shell:openExternal']('javascript:alert(1)'),
    ).rejects.toThrow(/not allowed/);
    for (const bad of [
      'http://dev.azure.com/o/x',
      'https://dev.azure.com.evil.com/x',
      'https://evil@dev.azure.com/x',
      'https://dev.azure.com:8443/x',
    ])
      await expect(h['shell:openExternal'](bad)).rejects.toThrow(/not allowed/);
    expect(opened).toHaveLength(2);
  });
});

describe('handlers: usage', () => {
  it('starts every task terminal with the telemetry env', async () => {
    const hx = await harness();
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    const def = await hx.h['terminals:open'](t.id, {
      kind: 'run',
      label: 'env',
      command: `${isWindows ? 'Write-Output' : 'echo'} "T=${envRef('OTEL_RESOURCE_ATTRIBUTES')} E=${envRef('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')} C=${envRef('CLAUDE_CODE_ENABLE_TELEMETRY')}"; ${sleepCmd(5)}`,
    });
    await vi.waitFor(
      async () =>
        expect(await hx.h['terminals:buffer'](def.id)).toContain(
          `T=shellie.task.id=${t.id} E=http://127.0.0.1:4319/v1/logs C=1`,
        ),
      { timeout: 10_000 },
    );
    hx.terminals.killAllForTask(t.id);
  });

  it('opens a Copilot CLI terminal with the platform command', async () => {
    const base = testPlatform();
    const platform = {
      ...base,
      copilotCommand: () =>
        base.shellCommand(`${echoCmd('copilot-started')}; ${sleepCmd(5)}`),
    };
    const hx = await harness(fakeCrypto(), { platform });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({ openShell: false, openCopilot: true }),
    );
    await done;
    const def = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'copilot',
    );
    expect(def?.label).toBe('Copilot CLI');
    await vi.waitFor(
      async () =>
        expect(await hx.h['terminals:buffer'](def!.id)).toContain(
          'copilot-started',
        ),
      { timeout: 10_000 },
    );
    hx.terminals.killAllForTask(t.id);
  });

  it('opens an OpenCode tab at setup when asked', async () => {
    const base = testPlatform();
    const platform = {
      ...base,
      opencodeCommand: () =>
        base.shellCommand(`${echoCmd('opencode-started')}; ${sleepCmd(5)}`),
    };
    const hx = await harness(fakeCrypto(), { platform });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({ openShell: false, openOpencode: true }),
    );
    await done;
    const def = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'opencode',
    );
    expect(def?.label).toBe('OpenCode');
    await vi.waitFor(
      async () =>
        expect(await hx.h['terminals:buffer'](def!.id)).toContain(
          'opencode-started',
        ),
      { timeout: 10_000 },
    );
    hx.terminals.killAllForTask(t.id);
  });

  it('summarises, toggles billable, exports CSV and broadcasts changes', async () => {
    const hx = await harness();
    await hx.usage.add({
      id: 'a',
      taskId: 'tx',
      tool: 'claude-code',
      sessionId: 's1',
      model: 'claude-opus-5-5',
      at: '2026-10-14T10:00:00.000Z',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      fast: false,
    });
    expect(hx.broadcasts).toContainEqual({
      event: 'usage:changed',
      payload: { taskId: 'tx' },
    });
    expect((await hx.h['usage:task']('tx')).billable.costUsd).toBe(4);
    const after = await hx.h['usage:setBillable']('tx', 's1', false);
    expect(after.billable.costUsd).toBe(0);
    expect(await hx.h['usage:exportCsv']('tx')).toContain(
      ',s1,claude-opus-5-5,1000000,0,0,0,false,4,3.68,false,',
    );
  });

  it('gets the budget view for the asked vendor and month', async () => {
    const view = vi.fn((vendor: string, offset: number) => ({
      vendor,
      offset,
    }));
    const hx = await harness(undefined, { budget: { view } as never });
    expect(await hx.h['budget:get']('copilot', -1)).toEqual({
      vendor: 'copilot',
      offset: -1,
    });
    expect(view).toHaveBeenCalledWith('copilot', -1);
  });

  it('reports the app version', async () => {
    const hx = await harness();
    expect(await hx.h['app:info']()).toEqual({
      version: '9.9.9',
      windowsBuild: null,
    });
  });

  it('saves settings, moves the receiver and reports a busy port', async () => {
    const hx = await harness();
    const s = await hx.h['settings:get']();
    await hx.h['settings:save']({ ...s, showSplash: !s.showSplash });
    expect(hx.broadcasts).toContainEqual({
      event: 'budget:changed',
      payload: {},
    });
    expect(hx.receiverStarts).toEqual([]);
    await hx.h['settings:save']({ ...s, receiverPort: 1999 });
    expect(hx.receiverStarts).toEqual([1999]);
    expect(await hx.h['usage:receiverStatus']()).toEqual({
      listening: false,
      port: 1999,
      error: 'Port 1999 is in use by another program',
      copilot: { records: 0, unreadable: 0 },
    });
    expect(
      hx.broadcasts.some(
        (b) =>
          b.event === 'notice' &&
          String((b.payload as { message: string }).message).includes('in use'),
      ),
    ).toBe(true);
    expect(hx.broadcasts).toContainEqual({
      event: 'usage:changed',
      payload: { taskId: '*' },
    });
    await expect(
      hx.h['settings:save']({ ...s, receiverPort: 80 }),
    ).rejects.toThrow();
  });

  it('lists the official rates read-only', async () => {
    const hx = await harness();
    const { rates, officialAsOf } = await hx.h['rates:list']();
    expect(officialAsOf).toBe('2026-10-14');
    expect(rates).toEqual(OFFICIAL_RATES);
  });

  it('Finish writes no AI cost fields and posts no usage comment', async () => {
    const hx = await harness();
    const { t } = await linkedTask(hx);
    await hx.h['tasks:finish'](t.id, {
      closeTerminals: true,
      removeWorktree: true,
      deleteBranch: true,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(
      hx.server.requests.filter(
        (r) => r.method === 'PATCH' || r.path.includes('/comments'),
      ),
    ).toEqual([]);
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'done',
      usageSyncedAt: null,
      usageCommentId: null,
    });
  });
});

describe('handlers: telemetry', () => {
  function recorder() {
    const items: {
      kind: string;
      name: string;
      props?: unknown;
      m?: unknown;
    }[] = [];
    const telemetry: Telemetry = {
      event: (name, props, m) => items.push({ kind: 'event', name, props, m }),
      pageView: (name) => items.push({ kind: 'pageView', name }),
      metric: (name, value, props) =>
        items.push({ kind: 'metric', name, props, m: value }),
      exception: (e, props) =>
        items.push({ kind: 'exception', name: String(e), props }),
      exceptionParts: (p) => items.push({ kind: 'exception', name: p.message }),
      dependency: (d) => items.push({ kind: 'dependency', name: d.name }),
      flush: async () => {},
    };
    return { items, telemetry };
  }

  it('reports task creation, setup timing and terminals without names', async () => {
    const { items, telemetry } = recorder();
    const hx = await harness(fakeCrypto(), { telemetry });
    const done = hx.setupDone();
    const task = await hx.h['tasks:create'](hx.input());
    await done;
    const names = items.map((i) => `${i.kind}:${i.name}`);
    expect(names).toContain('event:repo.added');
    expect(names).toContain('event:task.created');
    expect(names).toContain('metric:setup.step.worktree');
    expect(names).toContain('event:terminal.opened');
    const finished = items.find((i) => i.name === 'setup.finished');
    expect(finished?.props).toMatchObject({ ok: true, failedStep: 'none' });
    expect(finished?.m).toMatchObject({ durationMs: expect.any(Number) });
    // No title, branch or repo name in any property.
    const all = JSON.stringify(items);
    expect(all).not.toContain('delivery');
    expect(all).not.toContain('webshop');
    hx.terminals.killAllForTask(task.id);
  });

  it('applies the theme when it changes, and only then', async () => {
    const applied: string[] = [];
    const hx = await harness(fakeCrypto(), {
      applyTheme: (t: string) => applied.push(t),
    });
    const s = await hx.h['settings:get']();
    await hx.h['settings:save']({ ...s, theme: 'light' });
    await hx.h['settings:save']({ ...s, theme: 'light', showSplash: false });
    await hx.h['settings:save']({ ...s, theme: 'dark', showSplash: false });
    expect(applied).toEqual(['light', 'dark']);
  });

  it('reports which settings changed, but not turning telemetry off', async () => {
    const { items, telemetry } = recorder();
    const hx = await harness(fakeCrypto(), { telemetry });
    const s = await hx.h['settings:get']();
    await hx.h['settings:save']({ ...s, showSplash: false });
    await hx.h['settings:save']({
      ...s,
      showSplash: false,
      sendTelemetry: false,
    });
    expect(items.filter((i) => i.name === 'settings.changed')).toEqual([
      {
        kind: 'event',
        name: 'settings.changed',
        props: { keys: 'showSplash' },
        m: undefined,
      },
    ]);
  });
});

describe('handlers: work item on start', () => {
  async function connected(hx: Awaited<ReturnType<typeof harness>>) {
    routeHealthyOrg(hx.server);
    const c = await hx.h['connections:save']({
      organizationUrl: `${hx.server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'p',
    });
    await hx.connections.setStatus(c.id, 'ok', 'Dries Hoebeke', 'me@x.com');
    await hx.h['repos:setConnection'](hx.added.id, c.id);
    const client = hx.services.trackers.client(c.id);
    vi.spyOn(client, 'workItemForStart').mockResolvedValue({
      type: 'Task',
      state: 'To Do',
      assignedTo: null,
    });
    vi.spyOn(client, 'typeStates').mockResolvedValue([
      { name: 'To Do', category: 'Proposed' },
      { name: 'Doing', category: 'InProgress' },
      { name: 'Done', category: 'Completed' },
    ]);
    const update = vi.spyOn(client, 'updateWorkItem').mockResolvedValue();
    return { c, client, update };
  }

  async function createAndWait(
    hx: Awaited<ReturnType<typeof harness>>,
    over: Partial<CreateTaskInput> = {},
  ) {
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({ openShell: false, ...over }),
    );
    const finished = await done;
    const state = await hx.h['tasks:setupState'](t.id);
    return { t, finished, state };
  }

  it('moves the work item to In Progress and assigns it to the user', async () => {
    const hx = await harness();
    const { update } = await connected(hx);
    const { finished, state } = await createAndWait(hx);
    expect(finished.ok).toBe(true);
    expect(update).toHaveBeenCalledWith(48231, {
      state: 'Doing',
      assignedTo: 'me@x.com',
    });
    const step = state?.steps.find((s) => s.def.kind === 'work-item');
    expect(state?.steps.map((s) => s.def.kind).slice(0, 3)).toEqual([
      'fetch',
      'worktree',
      'work-item',
    ]);
    expect(step?.status).toBe('done');
  });

  it('looks up the unique name for a connection saved before it was stored', async () => {
    const hx = await harness();
    const { c, update } = await connected(hx);
    await hx.connections.setStatus(c.id, 'ok', 'Dries Hoebeke', null);
    hx.server.route('GET', '/unreliablewitness/_apis/connectionData', {
      body: {
        authenticatedUser: {
          providerDisplayName: 'Dries Hoebeke',
          properties: { Account: { $value: 'me@x.com' } },
        },
      },
    });
    await createAndWait(hx);
    expect(update).toHaveBeenCalledWith(48231, {
      state: 'Doing',
      assignedTo: 'me@x.com',
    });
    expect(hx.connections.get(c.id).userUniqueName).toBe('me@x.com');
  });

  it('warns but finishes the setup when the update fails', async () => {
    const hx = await harness();
    const { update } = await connected(hx);
    update.mockRejectedValue(new Error('Azure DevOps is unreachable'));
    const { finished, state } = await createAndWait(hx);
    expect(finished.ok).toBe(true);
    expect(state?.steps.find((s) => s.def.kind === 'work-item')).toMatchObject({
      status: 'warn',
      detail: 'Azure DevOps is unreachable',
    });
    expect((await hx.h['tasks:list']())[0].status).toBe('ready');
  });

  it('has no work item step for a blank task', async () => {
    const hx = await harness();
    const { update } = await connected(hx);
    const { state } = await createAndWait(hx, {
      workItem: null,
      name: 'Spike',
      branch: 'spike',
    });
    expect(state?.steps.map((s) => s.def.kind)).not.toContain('work-item');
    expect(update).not.toHaveBeenCalled();
  });

  it('has no work item step on a repo without a connection', async () => {
    const hx = await harness();
    const { state } = await createAndWait(hx);
    expect(state?.steps.map((s) => s.def.kind)).not.toContain('work-item');
  });

  it('has no work item step when both start options are off', async () => {
    const hx = await harness();
    const { update } = await connected(hx);
    await hx.services.repos.setWorkItemOnStart(hx.added.id, {
      moveToInProgress: false,
      assignToMe: false,
      stateOverrides: {},
    });
    const { state } = await createAndWait(hx);
    expect(state?.steps.map((s) => s.def.kind)).not.toContain('work-item');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('handlers: finish with a pull request', () => {
  const PR_URL = 'https://dev.azure.com/contoso/P/_git/R/pullrequest/7';
  const finishWithPr = {
    closeTerminals: true,
    removeWorktree: true,
    deleteBranch: true,
    createPullRequest: true,
  };

  async function prHarness(
    remote = 'https://dev.azure.com/contoso/P/_git/R',
    over: Partial<CreateTaskInput> = {},
    services: Partial<Services> = {},
  ) {
    const hx = await harness(fakeCrypto(), services);
    const bare = addOrigin(hx.repo);
    const c = await hx.connections.save({
      organizationUrl: 'https://dev.azure.com/contoso',
      project: 'P',
      pat: 'p',
    });
    await hx.h['repos:setConnection'](hx.added.id, c.id);
    vi.spyOn(hx.services.git, 'remoteUrl').mockResolvedValue(remote);
    const client = hx.services.trackers.client(c.id);
    const repositoryId = vi
      .spyOn(client, 'repositoryId')
      .mockResolvedValue('repo-1');
    const findActive = vi
      .spyOn(client, 'findActivePullRequest')
      .mockResolvedValue(null);
    const create = vi.spyOn(client, 'createPullRequest').mockResolvedValue({
      pullRequestId: 7,
      status: 'active',
      isDraft: true,
    });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({ baseRef: 'origin/main', openShell: false, ...over }),
    );
    await done;
    return { ...hx, bare, c, client, repositoryId, findActive, create, t };
  }

  it('reports availability with the target branch', async () => {
    const hx = await prHarness();
    expect(await hx.h['tasks:prAvailability'](hx.t.id)).toEqual({
      available: true,
      reason: null,
      target: 'main',
    });
    vi.mocked(hx.services.git.remoteUrl).mockResolvedValue(
      'https://github.com/contoso/R.git',
    );
    expect(await hx.h['tasks:prAvailability'](hx.t.id)).toEqual({
      available: false,
      reason: 'origin is not an Azure Repos URL',
      target: null,
    });
  });

  it('tells telemetry to scrub the project and repo of the Azure Repos remote', async () => {
    const hx = await prHarness(
      'git@ssh.dev.azure.com:v3/contoso/Other%20Project/azure-repo',
    );
    const seen: string[] = [];
    hx.services.rememberSensitive = (values) => seen.push(...values);
    await hx.h['tasks:prAvailability'](hx.t.id);
    expect(seen).toEqual(
      expect.arrayContaining(['Other Project', 'azure-repo']),
    );
  });

  it('pushes, creates a draft PR linked to the work item, opens it, then cleans up', async () => {
    const hx = await prHarness();
    commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    await hx.h['tasks:finish'](hx.t.id, finishWithPr);
    expect(git(hx.bare, 'branch', '--list', hx.t.branch).trim()).toContain(
      hx.t.branch,
    );
    expect(hx.repositoryId).toHaveBeenCalledWith('P', 'R');
    expect(hx.findActive).toHaveBeenCalledWith('P', 'repo-1', hx.t.branch);
    expect(hx.create).toHaveBeenCalledWith(
      'P',
      'repo-1',
      expect.objectContaining({
        source: hx.t.branch,
        target: 'main',
        title: prTitle(hx.t),
        workItemId: 48231,
      }),
    );
    const description = hx.create.mock.calls[0][2].description;
    expect(description).toContain('Add the feature');
    expect(description).not.toContain('AI cost');
    expect(hx.opened).toEqual([PR_URL]);
    const [view] = await hx.h['tasks:list']();
    expect(view.status).toBe('done');
    expect(view.pullRequest).toEqual({
      id: 7,
      url: PR_URL,
      repositoryId: 'repo-1',
      project: 'P',
      repo: 'R',
      status: 'active',
      isDraft: true,
    });
    expect(existsSync(hx.t.worktreePath)).toBe(false);
  });

  it('puts the written summary in the PR description above the commits', async () => {
    const hx = await prHarness();
    commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    await hx.h['tasks:finish'](hx.t.id, {
      ...finishWithPr,
      prSummaries: { home: '## What changed\n- The feature\n\n## Why\nAsked.' },
    });
    const description: string = hx.create.mock.calls[0][2].description;
    expect(description).toMatch(
      /^User Story 48231: Show estimated delivery date\n\n## What changed\n- The feature\n\n## Why\nAsked\.\n\n## Commits\n- [0-9a-f]+ Add the feature/,
    );
  });

  it('refuses to push a branch that adds a stored value unless Finish confirms it', async () => {
    const hx = await prHarness();
    await hx.services.secrets.save({
      scope: 'all',
      name: 'PROD_DB',
      givenTo: ['run'],
      values: { production: { value: 'prod-db-password-9f2c' } },
    });
    commitFile(
      hx.t.worktreePath,
      'config.txt',
      'db=prod-db-password-9f2c\n',
      'Add config',
    );
    const push = vi.spyOn(hx.services.git, 'push');
    const error = await hx.h['tasks:finish'](hx.t.id, finishWithPr).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(error).toContain(LEAK_IN_BRANCH);
    expect(error).not.toMatch(/PROD_DB|prod-db/);
    expect(push).not.toHaveBeenCalled();
    expect(hx.store.state.tasks[0].status).toBe('ready');
    await hx.h['tasks:finish'](hx.t.id, { ...finishWithPr, confirmLeak: true });
    expect(push).toHaveBeenCalledTimes(1);
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  it('reports a push refused for a stored value with its environment (telemetry)', async () => {
    const tel = telemetryEvents();
    const hx = await prHarness(undefined, undefined, {
      telemetry: tel.telemetry,
    });
    await hx.services.secrets.save({
      scope: 'all',
      name: 'PROD_DB',
      givenTo: ['run'],
      values: { production: { value: 'prod-db-password-9f2c' } },
    });
    commitFile(
      hx.t.worktreePath,
      'config.txt',
      'db=prod-db-password-9f2c\n',
      'Add config',
    );
    await hx.h['tasks:finish'](hx.t.id, finishWithPr).catch(() => undefined);
    expect(tel.named('secrets.leakDetected')).toEqual([
      [
        'secrets.leakDetected',
        { where: 'push', environment: 'production' },
        undefined,
      ],
    ]);
  });

  it('refuses a value one commit added and a later one removed: the push sends the history', async () => {
    const hx = await prHarness();
    await hx.services.secrets.save({
      scope: 'all',
      name: 'PROD_DB',
      givenTo: ['run'],
      values: { production: { value: 'prod-db-password-9f2c' } },
    });
    commitFile(
      hx.t.worktreePath,
      'config.txt',
      'db=prod-db-password-9f2c\n',
      'Add',
    );
    commitFile(hx.t.worktreePath, 'config.txt', 'db=from-env\n', 'Remove');
    const push = vi.spyOn(hx.services.git, 'push');
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      LEAK_IN_BRANCH,
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('refuses a branch it cannot check (no base, or git failing) unless confirmed', async () => {
    const hx = await prHarness();
    await hx.services.secrets.save({
      scope: 'all',
      name: 'PROD_DB',
      givenTo: ['run'],
      values: { production: { value: 'prod-db-password-9f2c' } },
    });
    commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    const push = vi.spyOn(hx.services.git, 'push');
    const base = vi.spyOn(hx.services.git, 'resolveBase');
    base.mockResolvedValue(null);
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      LEAK_UNCHECKED,
    );
    // A base git does not know: `git log` fails.
    base.mockResolvedValue('0'.repeat(40));
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      LEAK_UNCHECKED,
    );
    expect(push).not.toHaveBeenCalled();
    await hx.h['tasks:finish'](hx.t.id, { ...finishWithPr, confirmLeak: true });
    expect(push).toHaveBeenCalledTimes(1);
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  describe('tasks:prSummary', () => {
    const result = (text: string) =>
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: text,
      });

    it("asks Claude Code with the branch, the work item and the developer's requests", async () => {
      const events: [string, unknown, unknown][] = [];
      const hx = await prHarness(undefined, undefined, {
        telemetry: {
          ...NoopTelemetry,
          event: (name, props, m) => events.push([name, props, m]),
        },
      });
      commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
      const sessions = mkdtempSync(path.join(os.tmpdir(), 'shellie-sess-'));
      const log = path.join(sessions, 'abc.jsonl');
      writeFileSync(
        log,
        `${JSON.stringify({ type: 'user', message: { content: 'Show the delivery date on the PDP' } })}\n`,
      );
      hx.services.claudeSessionFile = (id) => (id === 'abc' ? log : null);
      await hx.store.update((st) => {
        st.tasks[0].terminals.push({
          id: 'c1',
          kind: 'claude',
          label: 'Claude Code',
          sessionId: 'abc',
        });
      });
      const calls: {
        args: string[];
        cwd: string;
        input: string;
        env?: Record<string, string>;
      }[] = [];
      hx.services.runAgent = async (cmd, o) => {
        calls.push({ args: cmd.args, cwd: o.cwd, input: o.input, env: o.env });
        return result('```markdown\n## What changed\n- Dates\n```');
      };
      const r = await hx.h['tasks:prSummary'](hx.t.id);
      expect(r).toEqual({ text: '## What changed\n- Dates', error: null });
      expect(calls).toHaveLength(1);
      expect(calls[0].cwd).toBe(hx.t.worktreePath);
      expect(calls[0].args.join(' ')).toContain('-p');
      expect(calls[0].input).toContain(
        'User Story 48231: Show estimated delivery date',
      );
      expect(calls[0].input).toContain('Show the delivery date on the PDP');
      expect(calls[0].input).toContain('Add the feature');
      expect(calls[0].input).toContain('+a');
      // The run's usage counts for the task.
      expect(calls[0].env?.OTEL_RESOURCE_ATTRIBUTES).toBe(
        `shellie.task.id=${hx.t.id},shellie.source=pr-summary`,
      );
      expect(calls[0].env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
      expect(events).toContainEqual([
        'pr.summary',
        { ok: true, style: false },
        expect.objectContaining({ chars: 23 }),
      ]);
    });

    it('denies Claude the secret files and masks stored values in the prompt and the text', async () => {
      const deny: string[][] = [];
      const hx = await prHarness(undefined, undefined, {
        claudeThemeSettings: (d) => {
          deny.push(d ?? []);
          return '/settings/claude-deny.json';
        },
      });
      const value = 'sk_live_abcdefghijkl0b3d';
      await hx.services.secrets.save({
        scope: { repoId: hx.added.id },
        name: 'STRIPE_KEY',
        givenTo: ['run'],
        values: { development: { value } },
      });
      commitFile(
        hx.t.worktreePath,
        'feature.txt',
        `key=${value}\n`,
        'Add the feature',
      );
      writeFileSync(
        path.join(hx.t.worktreePath, '.env'),
        `STRIPE_KEY=${value}\n`,
      );
      let call: { args: string[]; input: string } | null = null;
      hx.services.runAgent = async (cmd, o) => {
        call = { args: cmd.args, input: o.input };
        return result(`## What changed\n- Uses ${value}`);
      };
      const r = await hx.h['tasks:prSummary'](hx.t.id);
      expect(call!.input).not.toContain(value);
      expect(call!.input).toContain('[STRIPE_KEY]');
      expect(r.text).not.toContain(value);
      expect(r.text).toContain('[STRIPE_KEY]');
      // Quoted for the platform's shell: only the order is checked.
      expect(call!.args.join(' ')).toMatch(
        /--settings\W+\/settings\/claude-deny\.json/,
      );
      expect(deny.at(-1)).toContain('Read(./.env)');
    });

    it("adds the repo's style file to the prompt", async () => {
      const hx = await prHarness();
      commitFile(
        hx.t.worktreePath,
        '.shellie-pr.md',
        'Always end with a Testing section.\n',
        'Add the style',
      );
      let input = '';
      hx.services.runAgent = async (_cmd, o) => {
        input = o.input;
        return result('ok');
      };
      await hx.h['tasks:prSummary'](hx.t.id);
      expect(input).toContain('Always end with a Testing section.');
    });

    it('gives the reason, never throws, when Claude Code fails', async () => {
      const events: [string, unknown][] = [];
      const hx = await prHarness(undefined, undefined, {
        telemetry: {
          ...NoopTelemetry,
          event: (name, props) => events.push([name, props]),
        },
      });
      commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
      hx.services.runAgent = async () => {
        throw new Error('Claude Code (claude) was not found');
      };
      expect(await hx.h['tasks:prSummary'](hx.t.id)).toEqual({
        text: null,
        error: 'Claude Code (claude) was not found',
      });
      hx.services.runAgent = async () => {
        throw new Error('timed out after 120 s');
      };
      await hx.h['tasks:prSummary'](hx.t.id);
      hx.services.runAgent = async () => result('   ');
      expect((await hx.h['tasks:prSummary'](hx.t.id)).text).toBeNull();
      expect(events.filter((e) => e[0] === 'pr.summary')).toEqual([
        ['pr.summary', { ok: false, reason: 'no-agent', style: false }],
        ['pr.summary', { ok: false, reason: 'timeout', style: false }],
        ['pr.summary', { ok: false, reason: 'empty', style: false }],
      ]);
    });
  });

  it('records the branch as pushed in the Done summary, since the PR pushed it', async () => {
    const hx = await prHarness();
    commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    await hx.h['tasks:finish'](hx.t.id, finishWithPr);
    const [view] = await hx.h['tasks:list']();
    expect(view.summary).toMatchObject({
      pushed: true,
      upstream: `origin/${hx.t.branch}`,
      commitCount: 1,
    });
  });

  it('links an existing active PR instead of creating another', async () => {
    const hx = await prHarness();
    hx.findActive.mockResolvedValue({
      pullRequestId: 3,
      status: 'active',
      isDraft: false,
    });
    await hx.h['tasks:finish'](hx.t.id, finishWithPr);
    expect(hx.create).not.toHaveBeenCalled();
    const [view] = await hx.h['tasks:list']();
    expect(view.pullRequest).toMatchObject({ id: 3, isDraft: false });
    expect(hx.opened).toEqual([
      'https://dev.azure.com/contoso/P/_git/R/pullrequest/3',
    ]);
  });

  it('stops Finish before cleanup when the push is rejected', async () => {
    const hx = await prHarness('https://dev.azure.com/contoso/P/_git/R', {
      openShell: true,
    });
    commitFile(hx.t.worktreePath, 'mine.txt', 'a\n', 'Mine');
    git(hx.t.worktreePath, 'push', '-q', 'origin', hx.t.branch);
    const other = path.join(path.dirname(hx.bare), 'other');
    git(
      path.dirname(hx.bare),
      'clone',
      '-q',
      '-b',
      hx.t.branch,
      hx.bare,
      'other',
    );
    git(other, 'config', 'user.email', 'tests@shellie.local');
    git(other, 'config', 'user.name', 'Shellie tests');
    commitFile(other, 'theirs.txt', 'b\n', 'Theirs');
    git(other, 'push', '-q', 'origin', hx.t.branch);
    git(hx.t.worktreePath, 'commit', '-q', '--amend', '-m', 'Mine again');
    const kill = vi.spyOn(hx.terminals, 'kill');
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      /^Pull request not created: [^]*rejected/,
    );
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(hx.store.state.tasks[0].pullRequest).toBeNull();
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    expectTerminalsKept(hx.store, hx.terminals, hx.t.id, 1);
    expect(hx.create).not.toHaveBeenCalled();
    expect(hx.opened).toEqual([]);
    kill.mockRestore();
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('stops Finish before cleanup when the push hangs past its timeout', async () => {
    const hx = await prHarness();
    commitFile(hx.t.worktreePath, 'mine.txt', 'a\n', 'Mine');
    const hook = path.join(hx.repo, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, '#!/bin/sh\nsleep 10\n');
    chmodSync(hook, 0o755);
    (hx.services.git as { pushTimeoutMs: number }).pushTimeoutMs = 300;
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      'Pull request not created: git push timed out after 0.3 s (a credential prompt may be waiting)',
    );
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    expect(hx.create).not.toHaveBeenCalled();
  });

  it('stops Finish before cleanup when the PR call fails', async () => {
    const hx = await prHarness();
    hx.create.mockRejectedValue(
      new AdoError('unauthorized', '_apis/git', CODE_WRITE_DENIED, 403),
    );
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      'Pull request not created: The token cannot create pull requests (needs Code: Read & write)',
    );
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(existsSync(hx.t.worktreePath)).toBe(true);
  });

  it('refuses a PR when pull requests are unavailable, and cleans up nothing', async () => {
    const hx = await prHarness('https://github.com/contoso/R.git');
    const push = vi.spyOn(hx.services.git, 'push');
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      'Pull request not created: origin is not an Azure Repos URL',
    );
    expect(push).not.toHaveBeenCalled();
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(true);
  });

  it('refreshes the PR status, keeping the stored ref when the refresh fails', async () => {
    const hx = await prHarness();
    expect(await hx.h['tasks:prStatus'](hx.t.id)).toBeNull();
    await hx.h['tasks:finish'](hx.t.id, finishWithPr);
    const refresh = vi.spyOn(hx.client, 'pullRequest').mockResolvedValue({
      pullRequestId: 7,
      status: 'completed',
      isDraft: false,
    });
    const next = await hx.h['tasks:prStatus'](hx.t.id);
    expect(refresh).toHaveBeenCalledWith('P', 'repo-1', 7);
    expect(next).toMatchObject({ id: 7, status: 'completed', isDraft: false });
    expect(hx.store.state.tasks[0].pullRequest).toEqual(next);
    refresh.mockRejectedValue(new Error('offline'));
    expect(await hx.h['tasks:prStatus'](hx.t.id)).toEqual(next);
  });

  it('refreshes and stores an extra workspace PR', async () => {
    const hx = await prHarness();
    const pr = {
      id: 8,
      url: 'u',
      repositoryId: 'rid2',
      project: 'P',
      repo: 'api',
      status: 'active' as const,
      isDraft: true,
    };
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces.push({
        id: 'x1',
        repoId: hx.t.repoId,
        branch: 'feature/x',
        worktreePath: '/w/x',
        baseRef: 'origin/main',
        baseSha: null,
        source: 'detected',
        summary: null,
        pullRequest: pr,
        reopen: null,
        dropped: false,
      });
    });
    const refresh = vi.spyOn(hx.client, 'pullRequest').mockResolvedValue({
      pullRequestId: 8,
      status: 'completed',
      isDraft: false,
    });
    const next = await hx.h['tasks:prStatus'](hx.t.id, 'x1');
    expect(refresh).toHaveBeenCalledWith('P', 'rid2', 8);
    expect(next).toMatchObject({ id: 8, status: 'completed' });
    expect(hx.store.state.tasks[0].extraWorkspaces[0].pullRequest).toEqual(
      next,
    );
    expect(hx.store.state.tasks[0].pullRequest).toBeNull();
  });

  it('refreshes a workspace PR through its own repo connection, not the task one', async () => {
    const hx = await prHarness();
    const other = await hx.connections.save({
      organizationUrl: 'https://dev.azure.com/other',
      project: 'Q',
      pat: 'p',
    });
    const pr = {
      id: 8,
      url: 'u',
      repositoryId: 'rid2',
      project: 'P',
      repo: 'api',
      status: 'active' as const,
      isDraft: true,
    };
    await hx.store.update((st) => {
      st.tasks[0].connectionId = other.id;
      st.tasks[0].extraWorkspaces.push({
        id: 'x1',
        repoId: hx.t.repoId,
        branch: 'feature/x',
        worktreePath: '/w/x',
        baseRef: 'origin/main',
        baseSha: null,
        source: 'detected',
        summary: null,
        pullRequest: pr,
        reopen: null,
        dropped: false,
      });
    });
    const own = vi.spyOn(hx.client, 'pullRequest').mockResolvedValue({
      pullRequestId: 8,
      status: 'completed',
      isDraft: false,
    });
    const taskClient = vi.spyOn(
      hx.services.trackers.client(other.id),
      'pullRequest',
    );
    await hx.h['tasks:prStatus'](hx.t.id, 'x1');
    expect(own).toHaveBeenCalledWith('P', 'rid2', 8);
    expect(taskClient).not.toHaveBeenCalled();
  });

  it('finishChecks still reports unpushed commits as a count', async () => {
    const hx = await prHarness();
    commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    const checks = await hx.h['tasks:finishChecks'](hx.t.id);
    expect(checks.unpushed).toBe(1);
    expect(checks.runningTerminals).toBe(0);
  });
});

describe('handlers: task-level connection', () => {
  it('stores the repo connection on the task when it is created', async () => {
    const hx = await harness();
    const { t } = await linkedTask(hx);
    expect(t.connectionId).toBe(
      hx.services.repos.get(hx.added.id).connectionId,
    );
    expect(t.connectionId).not.toBeNull();
  });

  it('refreshes the PR status through the task connection', async () => {
    const hx = await harness();
    const { t } = await linkedTask(hx);
    const client = hx.services.trackers.client(t.connectionId!);
    const refresh = vi.spyOn(client, 'pullRequest').mockResolvedValue({
      pullRequestId: 7,
      status: 'completed',
      isDraft: false,
    });
    await hx.store.update((st) => {
      st.tasks[0].pullRequest = {
        id: 7,
        url: 'u',
        repositoryId: 'repo-1',
        project: 'P',
        repo: 'R',
        status: 'active',
        isDraft: true,
      };
    });
    await hx.h['repos:setConnection'](hx.added.id, null);
    expect(await hx.h['tasks:prStatus'](t.id)).toMatchObject({
      status: 'completed',
    });
    expect(refresh).toHaveBeenCalled();
  });
});

describe('handlers: finish every workspace of a task', () => {
  const HOME_REMOTE = 'https://dev.azure.com/contoso/P/_git/Web';
  const opts = {
    closeTerminals: true,
    removeWorktree: true,
    deleteBranch: true,
  };

  /** A task in `webshop` (home, origin Web) plus worktrees on its branch in more repos, joined by a scan. */
  async function multiHarness(
    extras: { name: string; org?: string }[],
    over: Partial<CreateTaskInput> = {},
  ) {
    const hx = await harness();
    commitFile(hx.repo, '.gitignore', '.env\n');
    addOrigin(hx.repo);
    const c = await hx.connections.save({
      organizationUrl: 'https://dev.azure.com/contoso',
      project: 'P',
      pat: 'p',
    });
    await hx.h['repos:setConnection'](hx.added.id, c.id);
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({
        baseRef: 'origin/main',
        openShell: false,
        // The copied .env is ignored, as in a real repo; no generated files.
        commands: [],
        ...over,
      }),
    );
    await done;
    const remotes = new Map<string, string>([[hx.repo, HOME_REMOTE]]);
    const repos: {
      name: string;
      path: string;
      wt: string;
      bare: string;
      connectionId: string;
    }[] = [];
    for (const e of extras) {
      const p = makeRepo(e.name);
      const bare = addOrigin(p);
      const org = e.org ?? 'contoso';
      const conn =
        org === 'contoso'
          ? c
          : await hx.connections.save({
              organizationUrl: `https://dev.azure.com/${org}`,
              project: 'P',
              pat: 'p',
            });
      const added = await hx.h['repos:add'](p);
      await hx.h['repos:setConnection'](added.id, conn.id);
      remotes.set(p, `https://dev.azure.com/${org}/P/_git/${e.name}`);
      const wt = path.join(path.dirname(p), `${e.name}-wt`);
      git(p, 'worktree', 'add', '-q', '-b', t.branch, wt, 'origin/main');
      repos.push({ name: e.name, path: p, wt, bare, connectionId: conn.id });
    }
    vi.spyOn(hx.services.git, 'remoteUrl').mockImplementation(
      async (cwd) => remotes.get(cwd) ?? null,
    );
    await hx.h['tasks:scanWorkspaces'](t.id);
    const ids = hx.store.state.tasks[0].extraWorkspaces.map((w) => w.id);
    expect(ids).toHaveLength(extras.length);
    // One fake Azure Repos per connection: PRs it created are found again as active.
    const created: { connectionId: string; repo: string; args: unknown }[] = [];
    const clients = new Map<
      string,
      ReturnType<typeof hx.services.trackers.client>
    >();
    for (const id of new Set([c.id, ...repos.map((r) => r.connectionId)])) {
      const client = hx.services.trackers.client(id);
      clients.set(id, client);
      vi.spyOn(client, 'repositoryId').mockImplementation(
        async (_p, name) => `id-${name}`,
      );
      vi.spyOn(client, 'findActivePullRequest').mockImplementation(
        async (_p, repositoryId) => {
          const n = created.findIndex(
            (x) => x.connectionId === id && `id-${x.repo}` === repositoryId,
          );
          return n < 0
            ? null
            : { pullRequestId: 100 + n, status: 'active', isDraft: true };
        },
      );
      vi.spyOn(client, 'createPullRequest').mockImplementation(
        async (_p, repositoryId, args) => {
          created.push({
            connectionId: id,
            repo: repositoryId.slice(3),
            args,
          });
          return {
            pullRequestId: 100 + created.length - 1,
            status: 'active',
            isDraft: true,
          };
        },
      );
    }
    const push = vi.spyOn(hx.services.git, 'push');
    return { ...hx, c, t, repos, ids, created, clients, push };
  }

  const ws = (hx: { store: TaskStore }, id: string) =>
    hx.store.state.tasks[0].extraWorkspaces.find((w) => w.id === id)!;

  it('checks every workspace: changes, PR target and whether the PR links the work item', async () => {
    const hx = await multiHarness([
      { name: 'api' },
      { name: 'docs', org: 'fabrikam' },
    ]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    const checks = await hx.h['tasks:finishChecks'](hx.t.id);
    expect(checks.workspaces.map((w) => w.workspaceId)).toEqual([
      'home',
      ...hx.ids,
    ]);
    expect(checks.workspaces[0]).toMatchObject({
      repoName: 'webshop',
      branch: hx.t.branch,
      missing: false,
      commits: 0,
      pr: { available: true, target: 'main', linksWorkItem: true },
    });
    expect(checks.workspaces[1]).toMatchObject({
      repoName: 'api',
      commits: 1,
      unpushed: 1,
      pr: { available: true, target: 'main', linksWorkItem: true },
    });
    expect(checks.workspaces[2].pr).toMatchObject({
      available: true,
      linksWorkItem: false,
    });
    expect(await hx.h['tasks:prAvailability'](hx.t.id, hx.ids[0])).toEqual({
      available: true,
      reason: null,
      target: 'main',
    });
  });

  it('books the Time spent once and writes it once for a multi-repo Finish', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    await hx.settings.save({ ...hx.settings.get(), writeTimeToAdo: true });
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    const client = hx.clients.get(hx.c.id)!;
    vi.spyOn(client, 'workItemEstimate').mockResolvedValue({
      type: 'User Story',
      originalEstimate: null,
      remainingWork: 5,
      completedWork: 1,
    });
    vi.spyOn(client, 'workItemTypeFields').mockResolvedValue([
      {
        type: 'User Story',
        fields: [
          'Microsoft.VSTS.Scheduling.RemainingWork',
          'Microsoft.VSTS.Scheduling.CompletedWork',
        ],
      },
    ]);
    const write = vi
      .spyOn(client, 'updateWorkItemFields')
      .mockResolvedValue(undefined as never);
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      bookedSeconds: 7200,
      workspaces: [
        { workspaceId: 'home', action: 'drop' },
        { workspaceId: hx.ids[0], action: 'push' },
      ],
    });
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('done');
    expect(task.time).toMatchObject({
      bookedSeconds: 7200,
      writtenHours: 2,
      syncError: null,
    });
    expect(task.openPeriods.at(-1)?.end).toBe(task.finishedAt);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe(48231);
  });

  it('refuses to push a repo whose branch adds a stored value, per row, unless confirmed', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    await hx.services.secrets.save({
      scope: 'all',
      name: 'UAT_KEY',
      givenTo: ['run'],
      values: { uat: { value: 'uat-api-key-77aa0c' } },
    });
    commitFile(hx.repos[0].wt, 'api.txt', 'key=uat-api-key-77aa0c\n', 'API');
    const finish = (confirmLeak?: boolean) =>
      hx.h['tasks:finish'](hx.t.id, {
        ...opts,
        // The page-wide flag is the single-repo one: a row is confirmed on its own.
        confirmLeak: true,
        workspaces: [
          { workspaceId: 'home', action: 'drop' },
          {
            workspaceId: hx.ids[0],
            action: 'push',
            ...(confirmLeak ? { confirmLeak } : {}),
          },
        ],
      });
    await expect(finish()).rejects.toThrow(LEAK_IN_BRANCH);
    expect(hx.push).not.toHaveBeenCalled();
    const row = (await hx.h['tasks:finishResults'](hx.t.id))!.find(
      (r) => r.workspaceId === hx.ids[0],
    )!;
    expect(row).toMatchObject({ ok: false, leak: 'found', pushed: false });
    expect(row.error).toContain(LEAK_IN_BRANCH);
    expect(JSON.stringify(row)).not.toMatch(/UAT_KEY|uat-api/);
    await finish(true);
    expect(hx.push).toHaveBeenCalledTimes(1);
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  it('books nothing when a multi-repo Finish fails, and once on its retry', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    const push = hx.push.mockRejectedValueOnce(new Error('rejected'));
    const finish = () =>
      hx.h['tasks:finish'](hx.t.id, {
        ...opts,
        bookedSeconds: 3600,
        workspaces: [
          { workspaceId: 'home', action: 'drop' },
          { workspaceId: hx.ids[0], action: 'push' },
        ],
      });
    await expect(finish()).rejects.toThrow('rejected');
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(hx.store.state.tasks[0].time).toBeNull();
    expect(hx.store.state.tasks[0].openPeriods.at(-1)?.end).toBeNull();
    await finish();
    expect(push).toHaveBeenCalledTimes(2);
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'done',
      time: { bookedSeconds: 3600 },
    });
  });

  it('drops the home without a push and opens a PR for the repo with changes', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    // The copied .env is gitignored, so the home still counts as unchanged.
    expect(existsSync(path.join(hx.t.worktreePath, '.env'))).toBe(true);
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      deleteBranch: false,
      removeWorktree: false,
      workspaces: [
        { workspaceId: 'home', action: 'drop' },
        { workspaceId: hx.ids[0], action: 'pr' },
      ],
      prSummaries: { [hx.ids[0]]: '## Why\nThe API needed it.' },
    });
    expect(hx.push.mock.calls.map((c) => c[0])).toEqual([hx.repos[0].wt]);
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('done');
    expect(task.homeDropped).toBe(true);
    // A dropped workspace is always removed, whatever the global options say.
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(
      false,
    );
    expect(existsSync(hx.repos[0].wt)).toBe(true);
    expect(git(hx.repos[0].bare, 'branch', '--list', hx.t.branch)).toContain(
      hx.t.branch,
    );
    expect(hx.created).toHaveLength(1);
    expect(hx.created[0]).toMatchObject({
      repo: 'api',
      args: { source: hx.t.branch, target: 'main', workItemId: 48231 },
    });
    expect(
      (hx.created[0].args as { description: string }).description,
    ).not.toContain('AI cost');
    // The row's own summary heads its PR.
    expect(
      (hx.created[0].args as { description: string }).description,
    ).toContain('\n\n## Why\nThe API needed it.\n\n## Commits\n');
    expect(ws(hx, hx.ids[0]).pullRequest).toMatchObject({
      id: 100,
      repo: 'api',
      url: 'https://dev.azure.com/contoso/P/_git/api/pullrequest/100',
    });
    expect(ws(hx, hx.ids[0]).summary).toMatchObject({
      pushed: true,
      commitCount: 1,
    });
    expect(task.pullRequest).toBeNull();
    expect(hx.opened).toEqual([
      'https://dev.azure.com/contoso/P/_git/api/pullrequest/100',
    ]);
  });

  it("never removes a worktree that is not on the task's branch, nor deletes its branch", async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    const tools = makeRepo('tools');
    const toolsWt = path.join(path.dirname(tools), 'tools-dev');
    git(tools, 'worktree', 'add', '-q', '-b', 'dev', toolsWt);
    const dev = await hx.h['tasks:addWorkspace'](hx.t.id, toolsWt);
    expect(dev.branch).toBe('dev');
    const rows = (action: 'drop' | 'keep') => ({
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'keep' as const },
        { workspaceId: hx.ids[0], action: 'keep' as const },
        { workspaceId: dev.id, action },
      ],
    });
    await expect(hx.h['tasks:finish'](hx.t.id, rows('drop'))).rejects.toThrow(
      "tools is not on this task's branch (dev): it is kept as is",
    );
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(existsSync(toolsWt)).toBe(true);

    // Remove worktrees and delete branches is on: the task's own go, `dev` stays.
    await hx.h['tasks:finish'](hx.t.id, rows('keep'));
    expect(hx.store.state.tasks[0].status).toBe('done');
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(existsSync(hx.repos[0].wt)).toBe(false);
    expect(existsSync(toolsWt)).toBe(true);
    expect(await new GitClient().branchExists(tools, 'dev')).toBe(true);
  });

  it('keeps where a push could not sign in on the failed row', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    const hint = {
      host: 'dev.azure.com',
      connectionId: hx.c.id,
      path: hx.repos[0].wt,
    };
    hx.push.mockImplementation(async () => {
      throw new GitAuthError(
        "fatal: could not read Password for 'https://dev.azure.com/contoso': terminal prompts disabled",
        'fatal: could not read Password',
        hint,
      );
    });
    await expect(
      hx.h['tasks:finish'](hx.t.id, {
        ...opts,
        workspaces: [
          { workspaceId: 'home', action: 'drop' },
          { workspaceId: hx.ids[0], action: 'pr' },
        ],
      }),
    ).rejects.toThrow(/could not read Password/);
    const rows = await hx.h['tasks:finishResults'](hx.t.id);
    expect(rows?.find((r) => r.workspaceId === hx.ids[0])).toMatchObject({
      ok: false,
      auth: hint,
    });
    expect(rows?.find((r) => r.workspaceId === 'home')?.auth).toBeUndefined();
  });

  it('stops before cleanup when one PR fails, and a retry neither pushes again nor duplicates the PR', async () => {
    const hx = await multiHarness([{ name: 'api' }, { name: 'docs' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    commitFile(hx.repos[1].wt, 'docs.txt', 'a\n', 'Docs change');
    const realPush = GitClient.prototype.push;
    let failDocs = true;
    hx.push.mockImplementation(
      async function (this: GitClient, cwd, remote, branch) {
        if (failDocs && cwd === hx.repos[1].wt)
          throw new Error('! [rejected] (fetch first)');
        return realPush.call(this, cwd, remote, branch);
      },
    );
    const finishAll = {
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'drop' as const },
        { workspaceId: hx.ids[0], action: 'pr' as const },
        { workspaceId: hx.ids[1], action: 'pr' as const },
      ],
    };
    await expect(hx.h['tasks:finish'](hx.t.id, finishAll)).rejects.toThrow(
      /^Pull request not created for docs: [^]*rejected/,
    );
    const failed = hx.store.state.tasks[0];
    expect(failed.status).toBe('ready');
    expect(failed.homeDropped).toBe(false);
    expect(ws(hx, hx.ids[0]).pullRequest).toMatchObject({ repo: 'api' });
    expect(ws(hx, hx.ids[1]).pullRequest).toBeNull();
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    expect(existsSync(hx.repos[0].wt)).toBe(true);
    expect(existsSync(hx.repos[1].wt)).toBe(true);
    expect(hx.opened).toEqual([
      'https://dev.azure.com/contoso/P/_git/api/pullrequest/100',
    ]);
    expect(await hx.h['tasks:finishResults'](hx.t.id)).toEqual([
      {
        workspaceId: 'home',
        action: 'drop',
        ok: true,
        pushed: false,
        pullRequest: null,
        error: null,
      },
      {
        workspaceId: hx.ids[0],
        action: 'pr',
        ok: true,
        pushed: true,
        pullRequest: {
          id: 100,
          url: 'https://dev.azure.com/contoso/P/_git/api/pullrequest/100',
          linked: false,
        },
        error: null,
      },
      {
        workspaceId: hx.ids[1],
        action: 'pr',
        ok: false,
        pushed: false,
        pullRequest: null,
        error: '! [rejected] (fetch first)',
      },
    ]);

    failDocs = false;
    hx.push.mockClear();
    // The api PR was completed meanwhile: the retry keeps the stored one instead of making a second.
    const findActive = vi.mocked(
      hx.clients.get(hx.c.id)!.findActivePullRequest,
    );
    findActive.mockClear();
    await hx.h['tasks:finish'](hx.t.id, finishAll);
    expect(findActive.mock.calls.map((c) => c[1])).toEqual(['id-docs']);
    expect(hx.push.mock.calls.map((c) => c[0])).toEqual([hx.repos[1].wt]);
    expect(hx.created.map((x) => x.repo)).toEqual(['api', 'docs']);
    expect(ws(hx, hx.ids[0]).pullRequest).toMatchObject({ id: 100 });
    expect(ws(hx, hx.ids[1]).pullRequest).toMatchObject({ id: 101 });
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('done');
    expect(task.homeDropped).toBe(true);
    expect(existsSync(hx.repos[1].wt)).toBe(false);
  });

  it('finishes without the PR for the failed row only', async () => {
    const hx = await multiHarness([{ name: 'api' }, { name: 'docs' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    commitFile(hx.repos[1].wt, 'docs.txt', 'a\n', 'Docs change');
    vi.mocked(hx.clients.get(hx.c.id)!.createPullRequest).mockRejectedValueOnce(
      new Error('boom'),
    );
    const rows = (api: 'pr' | 'keep') => ({
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'drop' as const },
        { workspaceId: hx.ids[0], action: api },
        { workspaceId: hx.ids[1], action: 'pr' as const },
      ],
    });
    await expect(hx.h['tasks:finish'](hx.t.id, rows('pr'))).rejects.toThrow(
      'Pull request not created for api: boom',
    );
    expect(ws(hx, hx.ids[1]).pullRequest).toMatchObject({ repo: 'docs' });
    // Finish without PR keeps api; docs' PR exists already, so it is linked, not created again.
    await hx.h['tasks:finish'](hx.t.id, rows('keep'));
    expect(hx.created.map((x) => x.repo)).toEqual(['docs']);
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('done');
    expect(ws(hx, hx.ids[0]).pullRequest).toBeNull();
    expect(existsSync(hx.repos[0].wt)).toBe(false);
    expect(existsSync(hx.repos[1].wt)).toBe(false);
  });

  it('refuses to drop a repo that got changes after the checks, and cleans up nothing', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    const checks = await hx.h['tasks:finishChecks'](hx.t.id);
    expect(checks.workspaces[0]).toMatchObject({ commits: 0, uncommitted: [] });
    // Claude keeps working while the Finish page is open.
    commitFile(hx.t.worktreePath, 'late.txt', 'a\n', 'Late change');
    await expect(
      hx.h['tasks:finish'](hx.t.id, {
        ...opts,
        workspaces: [
          { workspaceId: 'home', action: 'drop' },
          { workspaceId: hx.ids[0], action: 'push' },
        ],
      }),
    ).rejects.toThrow('webshop has changes now; reload Finish');
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('ready');
    expect(task.homeDropped).toBe(false);
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    expect(existsSync(hx.repos[0].wt)).toBe(true);
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(true);
    // Uncommitted files count as changes too.
    git(hx.t.worktreePath, 'reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(path.join(hx.t.worktreePath, 'draft.txt'), 'x');
    await expect(
      hx.h['tasks:finish'](hx.t.id, {
        ...opts,
        workspaces: [{ workspaceId: 'home', action: 'drop' }],
      }),
    ).rejects.toThrow('webshop has changes now; reload Finish');
    expect(existsSync(path.join(hx.t.worktreePath, 'draft.txt'))).toBe(true);
  });

  it('a folder that cannot be removed yet waits for the background cleanup; the rest finishes (#115)', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    vi.spyOn(hx.services.git, 'worktreeRemove').mockRejectedValueOnce(
      new Error('folder locked'),
    );
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'keep' },
        { workspaceId: hx.ids[0], action: 'push' },
      ],
    });
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('done');
    expect(task.pendingCleanup).toEqual([
      expect.objectContaining({
        workspaceId: 'home',
        worktreePath: hx.t.worktreePath,
        error: 'folder locked',
        code: 'other',
      }),
    ]);
    expect(existsSync(hx.repos[0].wt)).toBe(false);
    expect(task.summary).toMatchObject({ commitCount: 0 });
    expect(ws(hx, hx.ids[0]).summary).toMatchObject({
      commitCount: 1,
      pushed: true,
    });
  });

  it('a PR stored by an earlier Finish (before a Reopen) is looked up again, not kept', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces[0].pullRequest = {
        id: 3,
        url: 'https://dev.azure.com/contoso/P/_git/api/pullrequest/3',
        repositoryId: 'id-api',
        project: 'P',
        repo: 'api',
        status: 'completed',
        isDraft: false,
      };
    });
    const findActive = vi.mocked(
      hx.clients.get(hx.c.id)!.findActivePullRequest,
    );
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'drop' },
        { workspaceId: hx.ids[0], action: 'pr' },
      ],
    });
    expect(findActive.mock.calls.map((c) => c[1])).toEqual(['id-api']);
    expect(hx.created.map((x) => x.repo)).toEqual(['api']);
    expect(ws(hx, hx.ids[0]).pullRequest).toMatchObject({
      id: 100,
      status: 'active',
    });
  });

  it('a branch whose base cannot be found is never "no changes", and is not dropped', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces[0].baseRef = 'no-such-base';
      st.tasks[0].extraWorkspaces[0].baseSha = null;
    });
    const checks = await hx.h['tasks:finishChecks'](hx.t.id);
    expect(checks.workspaces[0].baseKnown).toBe(true);
    expect(checks.workspaces[1]).toMatchObject({
      baseKnown: false,
      uncommitted: [],
    });
    await expect(
      hx.h['tasks:finish'](hx.t.id, {
        ...opts,
        workspaces: [
          { workspaceId: 'home', action: 'keep' },
          { workspaceId: hx.ids[0], action: 'drop' },
        ],
      }),
    ).rejects.toThrow('api has changes now; reload Finish');
    expect(existsSync(hx.repos[0].wt)).toBe(true);
  });

  it('a scan error does not break the Finish checks', async () => {
    const hx = await harness(fakeCrypto(), {
      workspaces: {
        scan: async () => {
          throw new Error('scan exploded');
        },
      } as unknown as WorkspaceDetector,
    });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    const checks = await hx.h['tasks:finishChecks'](t.id);
    expect(checks.workspaces.map((w) => w.workspaceId)).toEqual(['home']);
  });

  it('a push-only row pushes without a PR, and records it as pushed', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'drop' },
        { workspaceId: hx.ids[0], action: 'push' },
      ],
    });
    expect(hx.created).toEqual([]);
    expect(git(hx.repos[0].bare, 'branch', '--list', hx.t.branch)).toContain(
      hx.t.branch,
    );
    expect(ws(hx, hx.ids[0]).summary).toMatchObject({ pushed: true });
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  it('a worktree removed by hand is reported missing and skipped by Finish', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.t.worktreePath, 'web.txt', 'a\n', 'Web change');
    rmSync(hx.repos[0].wt, { recursive: true, force: true });
    const checks = await hx.h['tasks:finishChecks'](hx.t.id);
    expect(checks.workspaces[1]).toMatchObject({
      workspaceId: hx.ids[0],
      missing: true,
      uncommitted: [],
      commits: 0,
    });
    const view = (await hx.h['tasks:list']())[0];
    expect(view.extraWorkspaces.map((w) => w.id)).toEqual(hx.ids);
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'pr' },
        { workspaceId: hx.ids[0], action: 'pr' },
      ],
    });
    expect(hx.push.mock.calls.map((c) => c[0])).toEqual([hx.t.worktreePath]);
    expect(hx.created.map((x) => x.repo)).toEqual(['Web']);
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  it('a repo in another organization gets a PR without the work item link, naming it instead', async () => {
    const hx = await multiHarness([{ name: 'docs', org: 'fabrikam' }], {
      workItem: {
        id: '48231',
        type: 'User Story',
        title: 'Show estimated delivery date',
        url: 'https://dev.azure.com/contoso/P/_workitems/edit/48231',
      },
    });
    commitFile(hx.repos[0].wt, 'docs.txt', 'a\n', 'Docs change');
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'drop' },
        { workspaceId: hx.ids[0], action: 'pr' },
      ],
    });
    expect(hx.created).toHaveLength(1);
    expect(hx.created[0].connectionId).toBe(hx.repos[0].connectionId);
    const args = hx.created[0].args as {
      workItemId: number | null;
      description: string;
    };
    expect(args.workItemId).toBeNull();
    expect(args.description).toContain(
      'Work item: https://dev.azure.com/contoso/P/_workitems/edit/48231',
    );
    expect(ws(hx, hx.ids[0]).pullRequest).toMatchObject({
      url: 'https://dev.azure.com/fabrikam/P/_git/docs/pullrequest/100',
    });
  });
});

describe('handlers: time', () => {
  it('passes terminal input on for agent time', async () => {
    const seen: [string, string][] = [];
    const { h, input, setupDone, store, terminals } = await harness(
      fakeCrypto(),
      { onTerminalInput: (id, data) => seen.push([id, data]) },
    );
    const done = setupDone();
    const t = await h['tasks:create'](input());
    await done;
    const id = store.state.tasks[0].terminals[0].id;
    await h['terminals:write'](id, 'ls\r');
    expect(seen).toEqual([[id, 'ls\r']]);
    await terminals.killAllForTask(t.id);
  });

  it('has the time handlers', async () => {
    const { h } = await harness();
    expect(await h['time:sprint']('none')).toEqual({});
  });
});

describe('handlers: time booking and write-back', () => {
  const WI = '/unreliablewitness/_apis/wit/workitems/48231';
  const finishOpts = (bookedSeconds?: number) => ({
    closeTerminals: true,
    removeWorktree: true,
    deleteBranch: true,
    bookedSeconds,
  });

  async function timeTask(
    hx: Awaited<ReturnType<typeof harness>>,
    writeTime: boolean,
  ) {
    await hx.settings.save({ ...hx.settings.get(), writeTimeToAdo: writeTime });
    const { t, c } = await linkedTask(hx);
    hx.server.route(
      'GET',
      '/unreliablewitness/Shellie/_apis/wit/workitemtypes',
      {
        body: {
          value: [
            {
              name: 'User Story',
              fields: [
                { referenceName: 'Microsoft.VSTS.Scheduling.RemainingWork' },
                { referenceName: 'Microsoft.VSTS.Scheduling.CompletedWork' },
              ],
            },
          ],
        },
      },
    );
    hx.server.route('GET', WI, {
      body: {
        fields: {
          'System.WorkItemType': 'User Story',
          'Microsoft.VSTS.Scheduling.RemainingWork': 5,
          'Microsoft.VSTS.Scheduling.CompletedWork': 1,
        },
      },
    });
    return { t, c };
  }
  const patches = (hx: Awaited<ReturnType<typeof harness>>) =>
    hx.server.requests.filter((r) => r.method === 'PATCH');

  it('books the time without writing it when time writing is off', async () => {
    const events: [string, unknown][] = [];
    const hx = await harness(fakeCrypto(), {
      telemetry: {
        ...NoopTelemetry,
        event: (name, props) => events.push([name, props]),
      },
    });
    const { t } = await timeTask(hx, false);
    await hx.h['tasks:finish'](t.id, finishOpts(7200));
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('done');
    expect(task.time).toMatchObject({
      bookedSeconds: 7200,
      writtenHours: 0,
      syncError: null,
    });
    expect(typeof task.time?.measuredSeconds).toBe('number');
    expect(patches(hx)).toEqual([]);
    expect(events).toContainEqual(['time.booked', { closest: 'custom' }]);
    await expect(hx.h['time:sync'](t.id)).rejects.toThrow(
      'Writing time to Azure DevOps is off',
    );
  });

  it('keeps no booking when Finish has no time to book', async () => {
    const hx = await harness();
    const { t } = await timeTask(hx, true);
    await hx.h['tasks:finish'](t.id, finishOpts());
    expect(hx.store.state.tasks[0].time).toBeNull();
    expect(patches(hx)).toEqual([]);
  });

  it('writes Completed and Remaining Work when time writing is on', async () => {
    const hx = await harness();
    const { t } = await timeTask(hx, true);
    await hx.h['tasks:finish'](t.id, finishOpts(7200));
    expect(patches(hx)).toHaveLength(1);
    expect(JSON.parse(patches(hx)[0].body)).toEqual([
      {
        op: 'add',
        path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork',
        value: 3,
      },
      {
        op: 'add',
        path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork',
        value: 3,
      },
    ]);
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'done',
      time: { bookedSeconds: 7200, writtenHours: 2, syncError: null },
    });
  });

  it('finishes and warns when the time write fails, then time:sync retries it', async () => {
    const hx = await harness();
    const { t } = await timeTask(hx, true);
    hx.server.route('PATCH', WI, { status: 403, body: {} });
    await hx.h['tasks:finish'](t.id, finishOpts(7200));
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('done');
    expect(task.time?.writtenHours).toBe(0);
    expect(task.time?.syncError).toBe(
      'The token cannot write work items (needs Work Items: Read & write)',
    );
    expect(hx.broadcasts).toContainEqual({
      event: 'notice',
      payload: {
        level: 'warn',
        message:
          'Task finished, but the time could not be written to the work item: The token cannot write work items (needs Work Items: Read & write). Use Retry on the Done page.',
      },
    });
    hx.server.route('PATCH', WI, { body: { id: 48231 } });
    await hx.h['time:sync'](t.id);
    expect(hx.store.state.tasks[0].time).toMatchObject({
      writtenHours: 2,
      syncError: null,
    });
  });

  it('refetches the type fields once when the cached ones lack the work item type', async () => {
    const hx = await harness();
    const { t } = await timeTask(hx, true);
    const TYPES = '/unreliablewitness/Shellie/_apis/wit/workitemtypes';
    let typeCalls = 0;
    hx.server.route('GET', TYPES, () => {
      typeCalls++;
      return {
        body: {
          value: [
            { name: 'Bug', fields: [] },
            ...(typeCalls > 1
              ? [
                  {
                    name: 'User Story',
                    fields: [
                      {
                        referenceName:
                          'Microsoft.VSTS.Scheduling.CompletedWork',
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
      };
    });
    await hx.h['tasks:finish'](t.id, finishOpts(7200));
    expect(typeCalls).toBe(2);
    expect(patches(hx)).toHaveLength(1);
    expect(JSON.parse(patches(hx)[0].body)).toEqual([
      {
        op: 'add',
        path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork',
        value: 3,
      },
    ]);
    expect(hx.store.state.tasks[0].time?.writtenHours).toBe(2);
  });

  it('flushes the open active interval before booking at Finish', async () => {
    let time: TimeStore | undefined;
    const flushed: number[] = [];
    const hx = await harness(fakeCrypto(), {
      tracker: {
        setTask: () => undefined,
        flush: () => {
          const now = Date.now();
          flushed.push(now);
          // Like main: the write is started, not awaited.
          void time?.addActive(hx.store.state.tasks[0].id, [
            now - 1_800_000,
            now,
          ]);
        },
      },
    });
    time = hx.services.time;
    const { t } = await timeTask(hx, false);
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    await hx.store.update((st) => {
      st.tasks[0].createdAt = hourAgo;
      st.tasks[0].openPeriods = st.tasks[0].openPeriods.map((p, k) =>
        k === 0 ? { ...p, start: hourAgo } : p,
      );
    });
    await hx.h['tasks:finish'](t.id, finishOpts(7200));
    expect(flushed).toHaveLength(1);
    expect(hx.store.state.tasks[0].time?.measuredSeconds).toBeGreaterThan(1700);
  });
});

describe('handlers: estimate baseline at create', () => {
  async function connect(hx: Awaited<ReturnType<typeof harness>>) {
    routeHealthyOrg(hx.server);
    const c = await hx.h['connections:save']({
      organizationUrl: `${hx.server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'secret-pat',
    });
    await hx.h['repos:setConnection'](hx.added.id, c.id);
    return c;
  }

  it('records Remaining + Completed Work when the item has no Original Estimate', async () => {
    const hx = await harness();
    const c = await connect(hx);
    hx.server.route('GET', '/unreliablewitness/_apis/wit/workitems/48231', {
      body: {
        fields: {
          'System.WorkItemType': 'User Story',
          'Microsoft.VSTS.Scheduling.RemainingWork': 5,
          'Microsoft.VSTS.Scheduling.CompletedWork': 1,
        },
      },
    });
    const done = hx.setupDone();
    await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    await vi.waitFor(() =>
      expect(hx.services.time.baseline(`${c.id}:48231`)).toBe(6),
    );
  });

  it('still creates the task when Azure DevOps fails', async () => {
    const hx = await harness();
    const c = await connect(hx);
    hx.server.route('GET', '/unreliablewitness/_apis/wit/workitems/48231', {
      status: 500,
      body: {},
    });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    expect(hx.store.state.tasks.map((x) => x.id)).toEqual([t.id]);
    expect(hx.services.time.baseline(`${c.id}:48231`)).toBeNull();
  });
});

describe('home', () => {
  it('builds the snapshot over the connections and broadcasts it', async () => {
    const hx = await harness();
    routeHealthyOrg(hx.server);
    hx.server.route('GET', '/unreliablewitness/_apis/connectionData', {
      body: { authenticatedUser: { id: 'me-1', providerDisplayName: 'Dries' } },
    });
    hx.server.route('GET', '/unreliablewitness/_apis/projects/Shellie/teams', {
      body: { value: [{ id: 't1', name: 'Shellie Team' }] },
    });
    hx.server.route(
      'GET',
      '/unreliablewitness/Shellie/Shellie%20Team/_apis/work/teamsettings/iterations',
      {
        body: {
          value: [{ id: 'it-1', name: 'Sprint 1', path: 'Shellie\\Sprint 1' }],
        },
      },
    );
    hx.server.route(
      'GET',
      '/unreliablewitness/Shellie/_apis/git/pullrequests',
      {
        body: { value: [] },
      },
    );
    await hx.h['connections:save']({
      organizationUrl: `${hx.server.url}/unreliablewitness`,
      project: 'Shellie',
      pat: 'secret-pat',
    });
    expect(await hx.h['home:get']()).toBeNull();
    const s = await hx.h['home:refresh']();
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0].status).toBe('ok');
    expect(s.connections[0].sprints[0].items.map((i) => i.id)).toEqual(['5']);
    expect(hx.broadcasts.some((b) => b.event === 'home:updated')).toBe(true);
    expect(await hx.h['home:get']()).toEqual(s);
  });

  it('stats come from the local stores', async () => {
    const hx = await harness();
    expect(await hx.h['home:stats']('week')).toMatchObject({
      period: 'week',
      costEur: 0,
      tasksFinished: 0,
    });
  });
});

describe('handlers: secrets', () => {
  it('never sends a plaintext value to the renderer, and logs reveals without it', async () => {
    const { h, broadcasts, services } = await harness();
    const saved = await h['secrets:save']({
      scope: 'all',
      name: 'API_KEY',
      givenTo: ['run'],
      values: { development: { value: 'sk_live_plaintext0b3d' } },
    });
    expect(broadcasts.some((b) => b.event === 'secrets:changed')).toBe(true);
    const listed = await h['secrets:list']('all');
    const forRepo = await h['secrets:list']('repo-1');
    for (const payload of [saved, listed, forRepo])
      expect(JSON.stringify(payload)).not.toContain('plaintext');
    expect(forRepo).toHaveLength(1);
    expect(await h['secrets:reveal'](saved.id, 'development')).toBe(
      'sk_live_plaintext0b3d',
    );
    await h['secrets:delete'](saved.id);
    expect(services.secrets.list()).toEqual([]);
  });

  it('reports discovery and import as counts, kinds and environments only', async () => {
    const tel = telemetryEvents();
    const hx = await harness(fakeCrypto(), { telemetry: tel.telemetry });
    writeFileSync(
      path.join(hx.repo, '.env'),
      'X=1\nSTRIPE_SECRET_KEY=sk_test_plaintext91c2\n',
    );
    writeFileSync(
      path.join(hx.repo, '.env.uat'),
      'STRIPE_SECRET_KEY=sk_test_plaintextuat7\n',
    );
    const plan = await hx.h['secrets:importPlan'](hx.added.id);
    expect(tel.named('secrets.discovered')).toEqual([
      [
        'secrets.discovered',
        undefined,
        { values: 3, secretLike: 2, unassigned: 0, skipped: 0, dotenv: 3 },
      ],
    ]);
    const row = plan.rows.find((r) => r.name === 'STRIPE_SECRET_KEY')!;
    await hx.h['secrets:import']({
      repoId: hx.added.id,
      picks: (['development', 'uat'] as const).map((env) => ({
        name: 'STRIPE_SECRET_KEY',
        env,
        key: row.cells[env].candidates[0]!.key,
      })),
      rewriteWorktreeCopies: true,
      removeFromMainCheckout: [],
    });
    expect(tel.named('secrets.imported')).toEqual([
      [
        'secrets.imported',
        { environments: 'development,uat', rewriteWorktreeCopies: true },
        { values: 2, worktreesRewritten: 0, filesChanged: 0 },
      ],
    ]);
    const sent = JSON.stringify(tel.events);
    expect(sent).not.toMatch(/STRIPE|plaintext|\.env/);
  });

  it('plans and imports by key, masks only, and rewrites open worktree copies', async () => {
    const hx = await harness();
    writeFileSync(
      path.join(hx.repo, '.env'),
      'X=1\nSTRIPE_SECRET_KEY=sk_test_plaintext91c2\n',
    );
    const done = hx.setupDone();
    const task = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    const plan = await hx.h['secrets:importPlan'](hx.added.id);
    expect(JSON.stringify(plan)).not.toContain('plaintext');
    const row = plan.rows.find((r) => r.name === 'STRIPE_SECRET_KEY')!;
    expect(row.cells.development.state).toBe('new');
    expect(plan.sources).toContainEqual({
      path: '.env',
      tracked: false,
      removable: true,
    });
    const result = await hx.h['secrets:import']({
      repoId: hx.added.id,
      picks: [
        {
          name: 'STRIPE_SECRET_KEY',
          env: 'development',
          key: row.cells.development.candidates[0]!.key,
        },
      ],
      rewriteWorktreeCopies: true,
      removeFromMainCheckout: [],
    });
    expect(JSON.stringify(result)).not.toContain('plaintext');
    expect(result).toEqual({
      values: 1,
      worktreesRewritten: 1,
      filesChanged: [],
    });
    expect(readFileSync(path.join(task.worktreePath, '.env'), 'utf8')).toBe(
      'X=1\n',
    );
    expect(
      hx.services.secrets.valuesFor(hx.added.id, 'development')
        .STRIPE_SECRET_KEY!.value,
    ).toBe('sk_test_plaintext91c2');
    expect(hx.broadcasts.some((b) => b.event === 'secrets:changed')).toBe(true);
    const again = await hx.h['secrets:importPlan'](hx.added.id);
    expect(
      again.rows.find((r) => r.name === 'STRIPE_SECRET_KEY')!.cells.development
        .state,
    ).toBe('same');
    // Closing the page forgets the held values: their keys no longer resolve.
    await hx.h['secrets:forget'](hx.added.id);
    const key = again.rows.find((r) => r.name === 'STRIPE_SECRET_KEY')!.cells
      .development.candidates[0]!.key;
    await expect(
      hx.h['secrets:import']({
        repoId: hx.added.id,
        picks: [{ name: 'STRIPE_SECRET_KEY', env: 'test', key }],
        rewriteWorktreeCopies: false,
        removeFromMainCheckout: [],
      }),
    ).rejects.toThrow(/look again/);
    await hx.terminals.killAllForTask(task.id);
  });
});

describe('handlers: secrets in tabs', () => {
  const ODD = 'a=b "q" \'s\' #h\nline2 $HOME `x` %PATH%';
  const stubbed = () => {
    const base = testPlatform();
    const ran: string[] = [];
    const quick = () => base.runCommand(echoCmd('agent'));
    return {
      ran,
      platform: {
        ...base,
        claudeCommand: quick,
        copilotCommand: quick,
        opencodeCommand: quick,
        runCommand: (c: string) => {
          ran.push(c);
          return base.runCommand(echoCmd('run'));
        },
      },
    };
  };
  const NAMES = [
    'DB',
    'SETUP_ONLY',
    'MINE',
    'ODD',
    'ASPNETCORE_ENVIRONMENT',
    'DOTNET_ENVIRONMENT',
    'NODE_ENV',
  ];

  async function scenario(environment?: 'development' | 'uat' | 'test') {
    const { platform, ran } = stubbed();
    const hx = await harness(fakeCrypto(), { platform });
    const repoScope = { repoId: hx.added.id };
    await hx.services.secrets.save({
      scope: repoScope,
      name: 'DB',
      givenTo: ['setup', 'run', 'tests'],
      values: {
        development: { value: 'dev-db' },
        uat: { value: 'uat-db' },
      },
    });
    await hx.services.secrets.save({
      scope: repoScope,
      name: 'SETUP_ONLY',
      givenTo: ['setup'],
      values: { development: { value: 'setup-only' } },
    });
    await hx.services.secrets.save({
      scope: 'all',
      name: 'MINE',
      givenTo: ['shell'],
      values: { development: { value: 'mine' }, uat: { value: 'mine' } },
    });
    await hx.services.secrets.save({
      scope: repoScope,
      name: 'ODD',
      givenTo: ['run'],
      values: { development: { value: ODD } },
    });
    const spawn = vi.spyOn(hx.terminals, 'spawn');
    const done = hx.setupDone();
    const task = await hx.h['tasks:create'](
      hx.input({
        startClaude: true,
        openCopilot: true,
        openOpencode: true,
        openShell: true,
        commands: [echoCmd('setup')],
        ...(environment
          ? { environment, environmentConfirmed: environment === 'uat' }
          : {}),
      }),
    );
    await done;
    const envOf = (id: string) =>
      spawn.mock.calls.filter((c) => c[0].id === id).at(-1)![0].env ?? {};
    const tabs = () => hx.store.state.tasks[0].terminals;
    return { hx, task, envOf, tabs, ran };
  }

  it('gives agent tabs no secrets and other tabs only theirs, for the task environment', async () => {
    const { hx, task, envOf, tabs } = await scenario();
    expect(task.environment).toBe('development');
    for (const t of tabs().filter((x) =>
      ['claude', 'copilot', 'opencode'].includes(x.kind),
    ))
      for (const n of NAMES) expect(envOf(t.id)[n]).toBeUndefined();
    const shell = tabs().find((x) => x.kind === 'shell')!;
    expect(envOf(shell.id).MINE).toBe('mine');
    expect(envOf(shell.id).DB).toBeUndefined();
    const setup = tabs().find((x) => x.setupCommands)!;
    expect(envOf(setup.id)).toMatchObject({
      DB: 'dev-db',
      SETUP_ONLY: 'setup-only',
    });
    const dev = await hx.h['terminals:open'](task.id, {
      kind: 'run',
      label: 'dev',
      command: 'npm run dev',
    });
    expect(envOf(dev.id)).toMatchObject({
      DB: 'dev-db',
      ODD,
      ASPNETCORE_ENVIRONMENT: 'Development',
      NODE_ENV: 'development',
    });
    expect(envOf(dev.id).SETUP_ONLY).toBeUndefined();
    expect(envOf(dev.id).MINE).toBeUndefined();
    await hx.terminals.killAllForTask(task.id);
  });

  it('gives no NODE_ENV to the Setup tab', async () => {
    const { tabs, envOf, hx, task } = await scenario();
    const setup = tabs().find((x) => x.setupCommands)!;
    expect(envOf(setup.id).NODE_ENV).toBeUndefined();
    expect(envOf(setup.id).ASPNETCORE_ENVIRONMENT).toBe('Development');
    await hx.terminals.killAllForTask(task.id);
  });

  it('gives agent tabs no secrets when they restart', async () => {
    const { hx, task, envOf, tabs } = await scenario();
    for (const t of tabs().filter((x) =>
      ['claude', 'copilot', 'opencode'].includes(x.kind),
    )) {
      await hx.h['terminals:restart'](t.id);
      for (const n of NAMES) expect(envOf(t.id)[n]).toBeUndefined();
    }
    await hx.terminals.killAllForTask(task.id);
  });

  it('refuses an unknown environment', async () => {
    const hx = await harness();
    await expect(
      hx.h['tasks:create'](hx.input({ environment: 'staging' as 'uat' })),
    ).rejects.toThrow('Unknown environment "staging"');
    expect(hx.store.state.tasks).toEqual([]);
  });

  it('uses the values and framework names of the task environment', async () => {
    const { hx, task, envOf } = await scenario('uat');
    expect(hx.store.state.tasks[0].environment).toBe('uat');
    expect(hx.store.state.tasks[0].environmentUntil).toBeNull();
    const dev = await hx.h['terminals:open'](task.id, {
      kind: 'run',
      label: 'dev',
      command: 'npm run dev',
    });
    expect(envOf(dev.id).DB).toBe('uat-db');
    // No UAT value: left unset, not empty.
    expect('ODD' in envOf(dev.id)).toBe(false);
    expect(envOf(dev.id).ASPNETCORE_ENVIRONMENT).toBe('Uat');
    expect(envOf(dev.id).NODE_ENV).toBeUndefined();
    await hx.terminals.killAllForTask(task.id);
  });

  it('gives a run tab of the test command the tests values', async () => {
    const { hx, task, envOf } = await scenario();
    await hx.services.secrets.save({
      scope: { repoId: hx.added.id },
      name: 'TEST_ONLY',
      givenTo: ['tests'],
      values: { development: { value: 't' } },
    });
    writeFileSync(
      path.join(task.worktreePath, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' } }),
    );
    const tests = await hx.h['terminals:open'](task.id, {
      kind: 'run',
      label: 'test',
      command: 'npm test',
    });
    const dev = await hx.h['terminals:open'](task.id, {
      kind: 'run',
      label: 'dev',
      command: 'npm run dev',
    });
    expect(envOf(tests.id).TEST_ONLY).toBe('t');
    expect(envOf(tests.id).ODD).toBeUndefined();
    expect(envOf(dev.id).TEST_ONLY).toBeUndefined();
    await hx.terminals.killAllForTask(task.id);
  });

  it('runs dotnet run with the launch profile of the task environment', async () => {
    const { hx, task, ran } = await scenario('uat');
    mkdirSync(path.join(task.worktreePath, 'Api', 'Properties'), {
      recursive: true,
    });
    writeFileSync(
      path.join(task.worktreePath, 'Api', 'Properties', 'launchSettings.json'),
      JSON.stringify({
        profiles: { Acc: { commandName: 'Project' }, http: {} },
      }),
    );
    await hx.h['terminals:open'](task.id, {
      kind: 'run',
      label: 'api',
      command: 'dotnet run',
    });
    expect(ran.at(-1)).toBe('dotnet run --launch-profile Acc');
    await hx.terminals.killAllForTask(task.id);
  });

  it('leaves every tab env, command and copied file as today with an empty store', async () => {
    const { platform, ran } = stubbed();
    const hx = await harness(fakeCrypto(), { platform });
    const spawn = vi.spyOn(hx.terminals, 'spawn');
    const done = hx.setupDone();
    const task = await hx.h['tasks:create'](
      hx.input({
        startClaude: true,
        openShell: true,
        commands: [echoCmd('setup')],
        environment: 'uat',
        environmentConfirmed: true,
      }),
    );
    await done;
    mkdirSync(path.join(task.worktreePath, 'Properties'), { recursive: true });
    writeFileSync(
      path.join(task.worktreePath, 'Properties', 'launchSettings.json'),
      JSON.stringify({ profiles: { Acc: { commandName: 'Project' } } }),
    );
    await hx.h['terminals:open'](task.id, {
      kind: 'run',
      label: 'api',
      command: 'dotnet run',
    });
    const today = telemetryEnv(
      task.id,
      hx.settings.get().receiverPort,
      hx.usageDir,
    );
    const shellEnv = platform.interactiveShell().env ?? {};
    for (const [opts] of spawn.mock.calls) {
      const def = hx.store.state.tasks[0].terminals.find(
        (t) => t.id === opts.id,
      );
      expect(opts.env).toEqual({
        ...today,
        ...(def?.kind === 'shell' ? shellEnv : {}),
      });
    }
    expect(spawn.mock.calls).toHaveLength(4);
    expect(ran).toEqual(['dotnet run']);
    expect(readFileSync(path.join(task.worktreePath, '.env'), 'utf8')).toBe(
      'X=1',
    );
    await hx.terminals.killAllForTask(task.id);
  });
});

describe('handlers: environment per task', () => {
  const T0 = Date.parse('2026-10-23T10:00:00Z');
  const AGENTS = ['claude', 'copilot', 'opencode'];

  /**
   * A task with a Claude Code, a Copilot and a shell tab (all kept running) and a long `dev` run tab, on
   * Development, with DB stored for Development, UAT and Production. Time and the expiry timers are the test's.
   */
  async function envScenario(
    over: Partial<CreateTaskInput> = {},
    extra: Partial<Services> = {},
    dbGivenTo: ('run' | 'shell')[] = ['run', 'shell'],
  ) {
    const base = testPlatform();
    const long = () => base.runCommand(sleepCmd(30));
    const platform = {
      ...base,
      claudeCommand: long,
      copilotCommand: long,
      opencodeCommand: long,
    };
    const clock = { now: T0 };
    const ticks: (() => void)[] = [];
    const resumes: (() => void)[] = [];
    const stopRuns = vi.fn();
    const hx = await harness(fakeCrypto(), {
      platform,
      now: () => clock.now,
      expiryTimers: {
        every: (fn) => {
          ticks.push(fn);
          return () => undefined;
        },
        onResume: (fn) => {
          resumes.push(fn);
          return () => undefined;
        },
      },
      stopRuns,
      ...extra,
    });
    await hx.services.secrets.save({
      scope: { repoId: hx.added.id },
      name: 'DB',
      givenTo: dbGivenTo,
      values: {
        development: { value: 'dev-db' },
        uat: { value: 'uat-db' },
        production: { value: 'prd-db' },
      },
    });
    await hx.services.secrets.save({
      scope: { repoId: hx.added.id },
      name: 'STRIPE_SECRET_KEY',
      givenTo: ['run'],
      values: { production: { value: 'sk_live_123456789' } },
    });
    const done = hx.setupDone();
    const task = await hx.h['tasks:create'](
      hx.input({
        startClaude: true,
        openCopilot: true,
        openShell: true,
        ...over,
      }),
    );
    await done;
    const dev = await hx.h['terminals:open'](task.id, {
      kind: 'run',
      label: 'dev',
      command: sleepCmd(30),
    });
    const spawn = vi.spyOn(hx.terminals, 'spawn');
    const kill = vi.spyOn(hx.terminals, 'kill');
    const stored = () => hx.store.state.tasks.find((t) => t.id === task.id)!;
    const tabs = () => stored().terminals;
    const agentIds = () =>
      tabs()
        .filter((t) => AGENTS.includes(t.kind))
        .map((t) => t.id);
    const shellId = () => tabs().find((t) => t.kind === 'shell')!.id;
    const envOf = (id: string) =>
      spawn.mock.calls.filter((c) => c[0].id === id).at(-1)?.[0].env ?? {};
    const spawnedIds = () => spawn.mock.calls.map((c) => c[0].id);
    const killedIds = () => kill.mock.calls.map((c) => c[0]);
    return {
      hx,
      task,
      dev,
      clock,
      ticks,
      resumes,
      stopRuns,
      spawn,
      stored,
      tabs,
      agentIds,
      shellId,
      envOf,
      spawnedIds,
      killedIds,
    };
  }

  it('a Production task discarded leaves nothing in RunHub or leak watch', async () => {
    const e = await envScenario();
    await e.hx.h['tasks:setEnvironment'](e.task.id, 'production', true);
    const ids = e.tabs().map((t) => t.id);
    const forget = vi.spyOn(LeakWatch.prototype, 'forget');
    const dropTask = vi.spyOn(LeakWatch.prototype, 'dropTask');
    await e.hx.h['tasks:discard'](e.task.id);
    expect(e.stopRuns).toHaveBeenCalledWith(
      e.task.id,
      'The task was discarded',
    );
    expect(dropTask).toHaveBeenCalledWith(e.task.id);
    for (const id of ids) expect(forget).toHaveBeenCalledWith(id);
    forget.mockRestore();
    dropTask.mockRestore();
  });

  describe('when your shell gets no secret', () => {
    it('a switch, an expiry and Finish leave the shell running', async () => {
      const e = await envScenario({}, {}, ['run']);
      const shell = e.shellId();
      await e.hx.h['tasks:setEnvironment'](e.task.id, 'production', true);
      expect(e.spawnedIds()).toEqual([e.dev.id]);
      expect(e.killedIds()).not.toContain(shell);
      const info = await e.hx.h['tasks:environmentInfo'](e.task.id);
      expect(info.tabs.map((t) => t.id)).toEqual([e.dev.id]);
      e.clock.now = T0 + 61 * 60_000;
      for (const tick of e.ticks) tick();
      await vi.waitFor(() =>
        expect(e.stored().environment).toBe('development'),
      );
      // The expiry's respawn holds the task until the shell restarted (seconds on Windows); switch once it lets go.
      await vi.waitFor(
        () => e.hx.h['tasks:setEnvironment'](e.task.id, 'production', true),
        PTY_WAIT,
      );
      await e.hx.h['tasks:finish'](e.task.id, {
        closeTerminals: false,
        removeWorktree: false,
        deleteBranch: false,
      });
      expect(e.killedIds()).not.toContain(shell);
      expect(e.spawnedIds()).not.toContain(shell);
      expect(e.hx.terminals.isRunning(shell)).toBe(true);
      await e.hx.terminals.killAllForTask(e.task.id);
    });

    it('a tab holds secrets only when a stored secret is given to it', async () => {
      const e = await envScenario({}, {}, ['run']);
      await e.hx.h['tasks:setEnvironment'](e.task.id, 'uat', true);
      const info = await e.hx.h['tasks:environmentInfo'](e.task.id);
      expect(info.tabs.map((t) => t.kind)).toEqual(['run']);
      await e.hx.terminals.killAllForTask(e.task.id);
    });
  });

  it('Restart of a tab that holds secrets builds its env again, so an edited value applies', async () => {
    const e = await envScenario();
    const db = e.hx.services.secrets
      .list({ repoId: e.hx.added.id })
      .find((v) => v.name === 'DB')!;
    await e.hx.h['secrets:save']({
      id: db.id,
      scope: db.scope,
      name: 'DB',
      givenTo: db.givenTo,
      values: { development: { value: 'dev-db-edited' } },
    });
    await e.hx.h['terminals:restart'](e.dev.id);
    expect(e.envOf(e.dev.id).DB).toBe('dev-db-edited');
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  describe('a tab given secrets stays tracked after the secret changes', () => {
    it('an expiry stops and respawns the shell although DB was deleted meanwhile', async () => {
      const e = await envScenario();
      const shell = e.shellId();
      await e.hx.h['tasks:setEnvironment'](e.task.id, 'production', true);
      expect(e.envOf(shell).DB).toBe('prd-db');
      const db = e.hx.services.secrets
        .list({ repoId: e.hx.added.id })
        .find((v) => v.name === 'DB')!;
      await e.hx.h['secrets:delete'](db.id);
      e.killedIds().length = 0;
      e.clock.now = T0 + 61 * 60_000;
      for (const tick of e.ticks) tick();
      await vi.waitFor(() =>
        expect(e.stored().environment).toBe('development'),
      );
      // The environment is stored first; the shell is killed and spawned again after it.
      await vi.waitFor(
        () =>
          expect(
            e.spawn.mock.calls.filter((c) => c[0].id === shell),
          ).toHaveLength(2),
        PTY_WAIT,
      );
      expect(e.killedIds()).toContain(shell);
      expect(e.envOf(shell).DB).toBeUndefined();
      await e.hx.terminals.killAllForTask(e.task.id);
    });

    it('Restart after DB was deleted builds the env again, without the old value', async () => {
      const e = await envScenario();
      const shell = e.shellId();
      await e.hx.h['tasks:setEnvironment'](e.task.id, 'production', true);
      const db = e.hx.services.secrets
        .list({ repoId: e.hx.added.id })
        .find((v) => v.name === 'DB')!;
      await e.hx.h['secrets:delete'](db.id);
      const restart = vi.spyOn(e.hx.terminals, 'restart');
      await e.hx.h['terminals:restart'](shell);
      expect(restart).not.toHaveBeenCalledWith(shell);
      expect(e.envOf(shell).DB).toBeUndefined();
      await e.hx.terminals.killAllForTask(e.task.id);
    });

    it('a tab opened while the environment switched is respawned with the new values', async () => {
      const e = await envScenario();
      const realSpawn = Object.getPrototypeOf(e.hx.terminals).spawn.bind(
        e.hx.terminals,
      );
      let switched = false;
      e.spawn.mockImplementation((opts: { env?: Record<string, string> }) => {
        const r = realSpawn(opts);
        if (!switched && opts.env?.DB === 'dev-db') {
          switched = true;
          // The switch lands after the spawn, before the tab is listed on the task.
          e.stored().environment = 'production';
        }
        return r;
      });
      const def = await e.hx.h['terminals:open'](e.task.id, {
        kind: 'shell',
        label: 'late',
      });
      expect(switched).toBe(true);
      expect(e.envOf(def.id).DB).toBe('prd-db');
      await e.hx.terminals.killAllForTask(e.task.id);
    });
  });

  it('refuses UAT and Production without a confirm and changes nothing', async () => {
    const e = await envScenario();
    for (const env of ['uat', 'production'] as const) {
      await expect(
        e.hx.h['tasks:setEnvironment'](e.task.id, env),
      ).rejects.toThrow(/confirm/i);
      await expect(
        e.hx.h['tasks:setEnvironment'](e.task.id, env, false),
      ).rejects.toThrow(/confirm/i);
    }
    expect(e.stored().environment).toBe('development');
    expect(e.spawn).not.toHaveBeenCalled();
    expect(e.killedIds()).toEqual([]);
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('switches to Production with a confirm: sets the bound and restarts only the tabs that hold secrets', async () => {
    const e = await envScenario();
    await e.hx.settings.save({
      ...e.hx.settings.get(),
      secrets: { productionMinutes: 45 },
    });
    const agents = e.agentIds();
    expect(agents).toHaveLength(2);
    const result = await e.hx.h['tasks:setEnvironment'](
      e.task.id,
      'production',
      true,
    );
    expect(result.environment).toBe('production');
    expect(result.environmentUntil).toBe(
      new Date(T0 + 45 * 60_000).toISOString(),
    );
    expect(e.stored().environment).toBe('production');
    expect(new Set(e.spawnedIds())).toEqual(new Set([e.dev.id, e.shellId()]));
    for (const id of agents) {
      expect(e.killedIds()).not.toContain(id);
      expect(e.spawnedIds()).not.toContain(id);
      expect(e.hx.terminals.isRunning(id)).toBe(true);
    }
    expect(e.envOf(e.dev.id)).toMatchObject({
      DB: 'prd-db',
      STRIPE_SECRET_KEY: 'sk_live_123456789',
      ASPNETCORE_ENVIRONMENT: 'Production',
    });
    expect(e.envOf(e.shellId()).DB).toBe('prd-db');
    expect(e.envOf(e.shellId()).STRIPE_SECRET_KEY).toBeUndefined();
    expect(e.hx.terminals.isRunning(e.dev.id)).toBe(true);
    expect(
      e.hx.broadcasts.filter((b) => b.event === 'terminal:reset'),
    ).toHaveLength(2);
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('answers concurrent secrets:status calls for a repo with one computation', async () => {
    const e = await envScenario();
    const repoId = e.hx.added.id;
    const spy = vi.spyOn(e.hx.services.secrets, 'allValues');
    const [a, b, c] = await Promise.all([
      e.hx.h['secrets:status'](repoId),
      e.hx.h['secrets:status'](repoId),
      e.hx.h['secrets:status'](repoId),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
    await e.hx.h['secrets:status'](repoId);
    expect(spy).toHaveBeenCalledTimes(2);
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('starts a fresh status after secrets change or a clean finishes', async () => {
    const e = await envScenario();
    const repoId = e.hx.added.id;
    const spy = vi.spyOn(e.hx.services.secrets, 'allValues');
    const first = e.hx.h['secrets:status'](repoId);
    // A secret saved meanwhile broadcasts a change: the pending answer is stale.
    await e.hx.h['secrets:setRepoDefault'](repoId, 'test');
    const second = e.hx.h['secrets:status'](repoId);
    expect(second).not.toBe(first);
    await Promise.all([first, second]);
    expect(spy).toHaveBeenCalledTimes(2);
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('reports an old worktree copy and cleans it, restarting only the secret tabs', async () => {
    const e = await envScenario();
    const envFile = path.join(e.task.worktreePath, '.env');
    writeFileSync(envFile, 'PORT=1\nDB=old-plaintext\n');
    const repoId = e.hx.added.id;
    const before = await e.hx.h['secrets:status'](repoId);
    expect(before.state).toBe('attention');
    expect(before.reasons).toContainEqual({
      kind: 'worktrees',
      taskIds: [e.task.id],
    });
    const spawned = e.spawnedIds().length;
    const cleaned = await e.hx.h['secrets:cleanWorktrees'](repoId);
    expect(cleaned).toEqual([e.task.id]);
    expect(readFileSync(envFile, 'utf8')).toBe('PORT=1\n');
    const again = e.spawnedIds().slice(spawned);
    expect(again.sort()).toEqual([e.dev.id, e.shellId()].sort());
    for (const id of e.agentIds()) expect(e.killedIds()).not.toContain(id);
    expect(
      (await e.hx.h['secrets:status'](repoId)).reasons.some(
        (r) => r.kind === 'worktrees',
      ),
    ).toBe(false);
    // Nothing left to clean: nothing restarts.
    const after = e.spawnedIds().length;
    expect(await e.hx.h['secrets:cleanWorktrees'](repoId)).toEqual([]);
    expect(e.spawnedIds()).toHaveLength(after);
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('switches to Development or Test without a confirm', async () => {
    const e = await envScenario();
    const t = await e.hx.h['tasks:setEnvironment'](e.task.id, 'test');
    expect(t.environment).toBe('test');
    expect(t.environmentUntil).toBeNull();
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('gives a tab that had exited the new environment when it is restarted by hand', async () => {
    const e = await envScenario();
    const once = await e.hx.h['terminals:open'](e.task.id, {
      kind: 'run',
      label: 'once',
      command: echoCmd('once'),
    });
    await vi.waitFor(
      () => expect(e.hx.terminals.isRunning(once.id)).toBe(false),
      PTY_WAIT,
    );
    expect(e.envOf(once.id).DB).toBe('dev-db');
    await e.hx.h['tasks:setEnvironment'](e.task.id, 'uat', true);
    await e.hx.h['terminals:restart'](once.id);
    expect(e.envOf(once.id).DB).toBe('uat-db');
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('describes each environment for the chip and the confirm', async () => {
    const e = await envScenario();
    const info = await e.hx.h['tasks:environmentInfo'](e.task.id);
    expect(info.values).toEqual({
      development: { have: 1, of: 2 },
      test: { have: 0, of: 2 },
      uat: { have: 1, of: 2 },
      production: { have: 2, of: 2 },
    });
    expect(info.keys.production).toEqual(['DB', 'STRIPE_SECRET_KEY']);
    expect(info.tabs.map((t) => t.id).sort()).toEqual(
      [e.dev.id, e.shellId()].sort(),
    );
    expect(info.productionMinutes).toBe(60);
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('lists launch profiles that set a stored key themselves', async () => {
    const e = await envScenario();
    mkdirSync(path.join(e.task.worktreePath, 'Properties'), {
      recursive: true,
    });
    writeFileSync(
      path.join(e.task.worktreePath, 'Properties', 'launchSettings.json'),
      JSON.stringify({
        profiles: {
          Prd: {
            commandName: 'Project',
            environmentVariables: { DB: 'from-profile', OTHER: 'x' },
          },
        },
      }),
    );
    await e.hx.h['terminals:open'](e.task.id, {
      kind: 'run',
      label: 'api',
      command: 'dotnet run',
    });
    const info = await e.hx.h['tasks:environmentInfo'](e.task.id);
    expect(info.overrides.production).toEqual([
      { profile: 'Prd', names: ['DB'] },
    ]);
    expect(info.overrides.development).toEqual([]);
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('expires Production at the bound: Development tabs, runs stopped, a notice', async () => {
    const e = await envScenario();
    await e.hx.h['tasks:setEnvironment'](e.task.id, 'production', true);
    const agents = e.agentIds();
    e.spawn.mockClear();
    e.clock.now = T0 + 60 * 60_000 - 1;
    for (const tick of e.ticks) tick();
    expect(e.stopRuns).not.toHaveBeenCalled();
    e.clock.now = T0 + 60 * 60_000;
    for (const tick of e.ticks) tick();
    await vi.waitFor(() => expect(e.stored().environment).toBe('development'));
    expect(e.stored().environmentUntil).toBeNull();
    await vi.waitFor(() =>
      expect(e.stopRuns).toHaveBeenCalledWith(e.task.id, 'Production ended'),
    );
    await vi.waitFor(
      () => expect(e.envOf(e.shellId()).DB).toBe('dev-db'),
      PTY_WAIT,
    );
    await vi.waitFor(
      () => expect(e.envOf(e.dev.id).DB).toBe('dev-db'),
      PTY_WAIT,
    );
    expect(e.envOf(e.dev.id).STRIPE_SECRET_KEY).toBeUndefined();
    for (const id of agents) {
      expect(e.killedIds()).not.toContain(id);
      expect(e.hx.terminals.isRunning(id)).toBe(true);
    }
    await vi.waitFor(() =>
      expect(e.hx.broadcasts).toContainEqual({
        event: 'notice',
        payload: {
          level: 'info',
          message: 'Production ended for 48231 Show estimated delivery date',
        },
      }),
    );
    expect(
      e.hx.broadcasts.some(
        (b) =>
          b.event === 'tasks:changed' &&
          (b.payload as Task[]).some(
            (t) => t.id === e.task.id && t.environment === 'development',
          ),
      ),
    ).toBe(true);
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('reports switches, a Production expiry and cleaned worktrees without names', async () => {
    const tel = telemetryEvents();
    const e = await envScenario({}, { telemetry: tel.telemetry });
    await e.hx.h['tasks:setEnvironment'](e.task.id, 'test');
    await e.hx.h['tasks:setEnvironment'](e.task.id, 'test');
    await e.hx.h['tasks:setEnvironment'](e.task.id, 'production', true);
    expect(tel.named('secrets.environmentSwitched')).toEqual([
      [
        'secrets.environmentSwitched',
        { from: 'development', to: 'test', confirmed: false },
        undefined,
      ],
      [
        'secrets.environmentSwitched',
        { from: 'test', to: 'production', confirmed: true },
        undefined,
      ],
    ]);
    expect(tel.named('secrets.productionExpired')).toEqual([]);
    e.clock.now = T0 + 60 * 60_000;
    for (const tick of e.ticks) tick();
    await vi.waitFor(() =>
      expect(tel.named('secrets.productionExpired')).toEqual([
        ['secrets.productionExpired', undefined, undefined],
      ]),
    );
    await vi.waitFor(() => expect(e.stored().environment).toBe('development'));
    writeFileSync(
      path.join(e.task.worktreePath, '.env'),
      'PORT=1\nDB=old-plaintext\n',
    );
    await e.hx.h['secrets:cleanWorktrees'](e.hx.added.id);
    expect(tel.named('secrets.worktreesCleaned')).toEqual([
      ['secrets.worktreesCleaned', { from: 'secrets' }, { count: 1 }],
    ]);
    await e.hx.h['secrets:cleanWorktrees'](e.hx.added.id, e.task.id);
    expect(tel.named('secrets.worktreesCleaned').at(-1)).toEqual([
      'secrets.worktreesCleaned',
      { from: 'task' },
      { count: 0 },
    ]);
    expect(JSON.stringify(tel.events)).not.toMatch(/DB|STRIPE|prd-db/);
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('expires Production on resume after the bound passed in sleep', async () => {
    const e = await envScenario();
    await e.hx.h['tasks:setEnvironment'](e.task.id, 'production', true);
    e.clock.now = T0 + 3 * 60 * 60_000;
    for (const resume of e.resumes) resume();
    await vi.waitFor(() => expect(e.stored().environment).toBe('development'));
    expect(e.stopRuns).toHaveBeenCalledWith(e.task.id, 'Production ended');
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('ends Production at Finish: secret tabs stopped, runs stopped, back to Development', async () => {
    const e = await envScenario();
    await e.hx.h['tasks:setEnvironment'](e.task.id, 'production', true);
    const agents = e.agentIds();
    await e.hx.h['tasks:finish'](e.task.id, {
      closeTerminals: false,
      removeWorktree: false,
      deleteBranch: false,
    });
    expect(e.stored().status).toBe('done');
    expect(e.stored().environment).toBe('development');
    expect(e.stored().environmentUntil).toBeNull();
    expect(e.stored().finishedEnvironment).toBe('production');
    expect(e.stopRuns).toHaveBeenCalledWith(
      e.task.id,
      'The task was finished in Shellie',
    );
    expect(e.hx.terminals.isRunning(e.dev.id)).toBe(false);
    expect(e.hx.terminals.isRunning(e.shellId())).toBe(false);
    for (const id of agents) expect(e.killedIds()).not.toContain(id);
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('never spawns Production values when the bound passes during setup', async () => {
    const clock = { now: T0 };
    const ticks: (() => void)[] = [];
    const stopRuns = vi.fn();
    const hx = await harness(fakeCrypto(), {
      now: () => clock.now,
      expiryTimers: {
        every: (fn) => {
          ticks.push(fn);
          return () => undefined;
        },
        onResume: () => () => undefined,
      },
      stopRuns,
    });
    await hx.services.secrets.save({
      scope: { repoId: hx.added.id },
      name: 'DB',
      givenTo: ['setup', 'shell'],
      values: {
        development: { value: 'dev-db' },
        production: { value: 'prd-db' },
      },
    });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const add = hx.services.git.worktreeAdd.bind(hx.services.git);
    vi.spyOn(hx.services.git, 'worktreeAdd').mockImplementation(
      async (...a) => {
        await gate;
        return add(...a);
      },
    );
    const spawn = vi.spyOn(hx.terminals, 'spawn');
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({
        environment: 'production',
        environmentConfirmed: true,
        openShell: true,
        commands: [echoCmd('setup')],
      }),
    );
    clock.now = T0 + 61 * 60_000;
    for (const tick of ticks) tick();
    // Setup holds the task: the expiry waits for it.
    expect(stopRuns).not.toHaveBeenCalled();
    open();
    await done;
    const task = hx.store.state.tasks.find((x) => x.id === t.id)!;
    expect(task.environment).toBe('development');
    expect(task.environmentUntil).toBeNull();
    expect(stopRuns).toHaveBeenCalledWith(t.id, 'Production ended');
    expect(spawn.mock.calls.length).toBeGreaterThan(0);
    for (const [opts] of spawn.mock.calls)
      expect(opts.env?.DB).not.toBe('prd-db');
    expect(
      spawn.mock.calls.find((c) => c[0].id === task.terminals[0]!.id)?.[0].env
        ?.DB,
    ).toBe('dev-db');
    await hx.terminals.killAllForTask(t.id);
  });

  it('leaves a task alone while a switch holds it, so a renewed Production is not expired', async () => {
    const e = await envScenario();
    await e.hx.h['tasks:setEnvironment'](e.task.id, 'production', true);
    e.clock.now = T0 + 61 * 60_000;
    const renewing = e.hx.h['tasks:setEnvironment'](
      e.task.id,
      'production',
      true,
    );
    for (const tick of e.ticks) tick();
    await renewing;
    expect(e.stored().environment).toBe('production');
    expect(e.stored().environmentUntil).toBe(
      new Date(T0 + 121 * 60_000).toISOString(),
    );
    for (const tick of e.ticks) tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(e.stored().environment).toBe('production');
    expect(e.stopRuns).not.toHaveBeenCalled();
    await e.hx.terminals.killAllForTask(e.task.id);
  });

  it('creates a task on UAT or Production only with a confirm, and bounds Production', async () => {
    const hx = await harness(fakeCrypto(), { now: () => T0 });
    await expect(
      hx.h['tasks:create'](hx.input({ environment: 'production' })),
    ).rejects.toThrow(/confirm/i);
    await expect(
      hx.h['tasks:create'](hx.input({ environment: 'uat' })),
    ).rejects.toThrow(/confirm/i);
    expect(hx.store.state.tasks).toEqual([]);
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({
        environment: 'production',
        environmentConfirmed: true,
        openShell: false,
      }),
    );
    await done;
    expect(t.environment).toBe('production');
    expect(t.environmentUntil).toBe(new Date(T0 + 60 * 60_000).toISOString());
  });

  it('never takes UAT or Production from a repo default', async () => {
    const hx = await harness();
    vi.spyOn(hx.services.secrets, 'repoDefault').mockReturnValue('production');
    expect(await hx.h['secrets:repoDefault'](hx.added.id)).toBe('development');
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    expect(t.environment).toBe('development');
  });

  it('says in the draft PR description which environment the task ran against', async () => {
    const hx = await harness(fakeCrypto());
    addOrigin(hx.repo);
    const c = await hx.connections.save({
      organizationUrl: 'https://dev.azure.com/contoso',
      project: 'P',
      pat: 'p',
    });
    await hx.h['repos:setConnection'](hx.added.id, c.id);
    vi.spyOn(hx.services.git, 'remoteUrl').mockResolvedValue(
      'https://dev.azure.com/contoso/P/_git/R',
    );
    const client = hx.services.trackers.client(c.id);
    vi.spyOn(client, 'repositoryId').mockResolvedValue('repo-1');
    vi.spyOn(client, 'findActivePullRequest').mockResolvedValue(null);
    const create = vi.spyOn(client, 'createPullRequest').mockResolvedValue({
      pullRequestId: 7,
      status: 'active',
      isDraft: true,
    });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({
        baseRef: 'origin/main',
        openShell: false,
        environment: 'uat',
        environmentConfirmed: true,
      }),
    );
    await done;
    commitFile(t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    await hx.h['tasks:finish'](t.id, {
      closeTerminals: true,
      removeWorktree: true,
      deleteBranch: true,
      createPullRequest: true,
    });
    expect(create.mock.calls[0][2].description).toContain('Run against UAT');
  });
});

describe('handlers: leak watch', () => {
  const DEV_KEY = 'sk_test_51HxAbCdEf';
  const PROD_KEY = 'prod-db-password-9f2c';
  const UAT_KEY = 'uat-api-key-77aa0c';
  const TRACKED_KEY = 'tracked-in-git-0001';

  /** A task whose Claude Code tab prints `prints` and then waits, with secrets stored for its repo. */
  async function leakHarness(
    prints: string,
    before?: (repo: string) => void,
    /** A raw command line instead of echoing `prints`. */
    line?: string,
    /** A Production value stored as WRAPPED_KEY. */
    wrapped?: string,
    telemetry?: Telemetry,
  ) {
    const base = testPlatform();
    const platform = {
      ...base,
      claudeCommand: () =>
        base.runCommand(`${line ?? echoCmd(prints)}; ${sleepCmd(30)}`),
    };
    const hx = await harness(fakeCrypto(), {
      platform,
      ...(telemetry ? { telemetry } : {}),
    });
    before?.(hx.repo);
    const scope = { repoId: hx.added.id };
    await hx.services.secrets.save({
      scope,
      name: 'STRIPE_SECRET_KEY',
      givenTo: ['run'],
      values: { development: { value: DEV_KEY } },
    });
    await hx.services.secrets.save({
      scope,
      name: 'DB_PASSWORD',
      givenTo: ['run'],
      values: { production: { value: PROD_KEY } },
    });
    await hx.services.secrets.save({
      scope,
      name: 'UAT_KEY',
      givenTo: ['run'],
      values: { uat: { value: UAT_KEY } },
    });
    await hx.services.secrets.save({
      scope,
      name: 'APP_KEY',
      givenTo: ['run'],
      values: { development: { value: TRACKED_KEY } },
    });
    if (wrapped)
      await hx.services.secrets.save({
        scope,
        name: 'WRAPPED_KEY',
        givenTo: ['run'],
        values: { production: { value: wrapped } },
      });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({ startClaude: true, openShell: false }),
    );
    await done;
    const claude = hx.store.state.tasks[0].terminals.find(
      (d) => d.kind === 'claude',
    )!;
    const leaks = () =>
      hx.broadcasts.filter((b) => b.event === 'terminal:leak');
    const noPlaintext = () => {
      const all = JSON.stringify(hx.broadcasts);
      for (const v of [DEV_KEY, PROD_KEY, UAT_KEY])
        expect(all).not.toContain(v);
    };
    return { ...hx, t, claude, leaks, noPlaintext };
  }

  it('hides a stored value in agent output as [NAME] and tells the renderer once', async () => {
    const hx = await leakHarness(`stripeKey=${DEV_KEY} and ${DEV_KEY}`);
    await vi.waitFor(
      () =>
        expect(hx.terminals.buffer(hx.claude.id)).toContain(
          'stripeKey=[STRIPE_SECRET_KEY] and [STRIPE_SECRET_KEY]',
        ),
      PTY_WAIT,
    );
    expect(hx.terminals.buffer(hx.claude.id)).not.toContain(DEV_KEY);
    expect(hx.leaks().map((b) => b.payload)).toEqual([
      { id: hx.claude.id, names: ['STRIPE_SECRET_KEY'], paused: false },
    ]);
    expect(await hx.h['terminals:leak'](hx.claude.id)).toEqual({
      names: ['STRIPE_SECRET_KEY'],
      paused: false,
    });
    hx.noPlaintext();
    await hx.h['terminals:kill'](hx.claude.id);
    expect(await hx.h['terminals:leak'](hx.claude.id)).toBeNull();
  });

  it('pauses input to the tab on a Production value until Resume, and Stop ends it', async () => {
    const hx = await leakHarness(`db=${PROD_KEY}`);
    await vi.waitFor(
      () =>
        expect(hx.leaks().map((b) => b.payload)).toEqual([
          { id: hx.claude.id, names: ['DB_PASSWORD'], paused: true },
        ]),
      PTY_WAIT,
    );
    const write = vi.spyOn(hx.terminals, 'write');
    await hx.h['terminals:write'](hx.claude.id, 'go on\r');
    expect(write).not.toHaveBeenCalled();
    await hx.h['terminals:resume'](hx.claude.id);
    expect(await hx.h['terminals:leak'](hx.claude.id)).toEqual({
      names: ['DB_PASSWORD'],
      paused: false,
    });
    await hx.h['terminals:write'](hx.claude.id, 'x');
    expect(write).toHaveBeenCalledWith(hx.claude.id, 'x');
    hx.noPlaintext();
    // Stop ends the process but keeps the tab, so it can be resumed or closed.
    await hx.h['terminals:stop'](hx.claude.id);
    expect(await hx.h['terminals:isRunning'](hx.claude.id)).toBe(false);
    expect(
      hx.store.state.tasks[0].terminals.some((d) => d.id === hx.claude.id),
    ).toBe(true);
    expect(hx.broadcasts.at(-1)).toEqual({
      event: 'terminal:exit',
      payload: { id: hx.claude.id, exitCode: -1 },
    });
    // The stopped process's notices go with it.
    expect(await hx.h['terminals:leak'](hx.claude.id)).toBeNull();
    expect(hx.leaks().at(-1)?.payload).toEqual({
      id: hx.claude.id,
      names: [],
      paused: false,
    });
  });

  // printf with escapes is the POSIX shell's; the matcher's own tests cover the same on every OS.
  it.skipIf(isWindows)(
    'masks a long value the agent wrapped across lines and pauses on it',
    async () => {
      const LONG = `prod-${'4eC39HqLyjWDarjtT1zdp7dc'.repeat(4)}`;
      const hx = await leakHarness(
        '',
        undefined,
        // printf: the value as Ink draws it wrapped, with a colour reset and an indent inside.
        `printf '${LONG.slice(0, 40)}\\033[39m\\r\\n    ${LONG.slice(40)}\\n'`,
        LONG,
      );
      await vi.waitFor(() =>
        expect(hx.leaks().map((b) => b.payload)).toEqual([
          { id: hx.claude.id, names: ['WRAPPED_KEY'], paused: true },
        ]),
      );
      expect(hx.terminals.buffer(hx.claude.id)).toContain('[WRAPPED_KEY]');
      expect(hx.terminals.buffer(hx.claude.id)).not.toContain(
        LONG.slice(0, 40),
      );
      await hx.terminals.killAllForTask(hx.t.id);
    },
  );

  it('masks a value that is in a file git tracks but raises no notice for it', async () => {
    const hx = await leakHarness(`read appsettings: ${TRACKED_KEY}`, (repo) =>
      commitFile(
        repo,
        'appsettings.json',
        JSON.stringify({ AppKey: TRACKED_KEY }),
      ),
    );
    await vi.waitFor(
      () =>
        expect(hx.terminals.buffer(hx.claude.id)).toContain(
          'read appsettings: [APP_KEY]',
        ),
      PTY_WAIT,
    );
    expect(hx.leaks()).toEqual([]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('reports a leak in agent output and in the Changes diff once, with the environment only', async () => {
    const tel = telemetryEvents();
    const hx = await leakHarness(
      `stripeKey=${DEV_KEY} ${DEV_KEY}`,
      undefined,
      undefined,
      undefined,
      tel.telemetry,
    );
    await vi.waitFor(
      () =>
        expect(tel.named('secrets.leakDetected')).toEqual([
          [
            'secrets.leakDetected',
            { where: 'agent', environment: 'development', paused: false },
            undefined,
          ],
        ]),
      PTY_WAIT,
    );
    commitFile(hx.t.worktreePath, 'a.txt', `key=${UAT_KEY}\n`);
    writeFileSync(path.join(hx.t.worktreePath, 'b.txt'), `x ${PROD_KEY}`);
    await hx.h['review:files'](hx.t.id, { kind: 'all' });
    await hx.h['review:files'](hx.t.id, { kind: 'all' });
    expect(
      tel
        .named('secrets.leakDetected')
        .filter((e) => (e[1] as { where: string }).where === 'diff'),
    ).toEqual([
      [
        'secrets.leakDetected',
        { where: 'diff', environment: 'production' },
        undefined,
      ],
    ]);
    expect(JSON.stringify(tel.events)).not.toMatch(/STRIPE|DB_PASSWORD|sk_/);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('flags Changes rows whose added lines hold a value of any environment', async () => {
    const hx = await leakHarness('hello');
    expect(hx.t.environment).toBe('development');
    commitFile(hx.t.worktreePath, 'committed.txt', `key=${UAT_KEY}\n`);
    commitFile(hx.t.worktreePath, 'clean.txt', 'nothing here\n');
    writeFileSync(path.join(hx.t.worktreePath, 'new.txt'), `x ${UAT_KEY}`);
    const files = await hx.h['review:files'](hx.t.id, { kind: 'all' });
    const flags = Object.fromEntries(
      files.repos[0].files.map((f) => [f.path, f.secret ?? false]),
    );
    expect(flags).toMatchObject({
      'committed.txt': true,
      'new.txt': true,
      'clean.txt': false,
    });
    expect(JSON.stringify(files)).not.toContain(UAT_KEY);
    await hx.terminals.killAllForTask(hx.t.id);
  });
});

describe('handlers: shellie run', () => {
  const DB_VALUE = 'dev-db-value-1234';
  const PROD_VALUE = 'prod-db-value-5678';

  /** A ready task whose repo has `run:` entries and DB stored; agents' context and env are recorded. */
  async function runHarness(
    o: {
      secrets?: boolean;
      /** Wraps RunHub's openTab (handlers' openRunTab). */
      openTab?: (open: RunBackend['openTab']) => RunBackend['openTab'];
      telemetry?: Telemetry;
    } = {},
  ) {
    const base = testPlatform();
    const contexts: (string | null)[] = [];
    const platform = {
      ...base,
      claudeCommand: (context: string | null) => {
        contexts.push(context);
        return base.runCommand(sleepCmd(30));
      },
    };
    const runs = new RunHub();
    if (o.openTab) {
      const wrap = o.openTab;
      const attach = runs.attach.bind(runs);
      runs.attach = (b) => attach({ ...b, openTab: wrap(b.openTab) });
    }
    const envCalls: { kind: string; taskId: string; runNames?: string[] }[] =
      [];
    const hx = await harness(fakeCrypto(), {
      platform,
      runs,
      ...(o.telemetry ? { telemetry: o.telemetry } : {}),
      terminalEnv: (def, ctx) => {
        envCalls.push({ kind: def.kind, ...ctx });
        return {};
      },
    });
    const print = isWindows ? `Write-Output "db=$env:DB"` : `echo "db=$DB"`;
    const list = isWindows ? 'Write-Output' : `printf '%s\\n'`;
    writeFileSync(
      path.join(hx.repo, '.shellie.yml'),
      [
        'copy: [.env]',
        'run:',
        `  show: ${JSON.stringify(print)}`,
        `  list: ${JSON.stringify(list)}`,
        `  fail: ${JSON.stringify(failCmd(3))}`,
        '',
      ].join('\n'),
    );
    if (o.secrets !== false)
      await hx.services.secrets.save({
        scope: { repoId: hx.added.id },
        name: 'DB',
        givenTo: ['run'],
        values: {
          development: { value: DB_VALUE },
          production: { value: PROD_VALUE },
        },
      });
    const done = hx.setupDone();
    const task = await hx.h['tasks:create'](
      hx.input({ startClaude: true, openShell: false, commands: [] }),
    );
    await done;
    const claude = () =>
      hx.store.state.tasks
        .find((t) => t.id === task.id)!
        .terminals.find((d) => d.kind === 'claude')!;
    const run = (name: string, args: string[] = []) => {
      let text = '';
      const code = runs.start(
        task.id,
        name,
        args,
        (c) => {
          text += c;
        },
        { terminal: claude().id },
      );
      return { code, text: () => normaliseEol(text) };
    };
    return { ...hx, runs, task, run, contexts, envCalls, claude };
  }

  it('runs a named command in a visible agent tab with the secrets, and the agent gets it masked', async () => {
    const hx = await runHarness();
    const r = hx.run('show');
    expect(await r.code).toBe(0);
    expect(r.text()).toContain('db=[DB]');
    expect(r.text()).not.toContain(DB_VALUE);
    const tab = hx.store.state.tasks
      .find((t) => t.id === hx.task.id)!
      .terminals.find((d) => d.label === 'agent · show')!;
    expect(tab).toMatchObject({ kind: 'run' });
    // The tab itself is the developer's: it shows what ran.
    expect(hx.terminals.buffer(tab.id)).toContain(`db=${DB_VALUE}`);
    // The agent got [DB], never the value: no "the model read it" notice on the tab that asked, nor on the run tab.
    expect(hx.broadcasts.some((b) => b.event === 'terminal:leak')).toBe(false);
    expect(await hx.h['terminals:leak'](hx.claude().id)).toBeNull();
    expect(JSON.stringify(hx.broadcasts)).not.toContain(DB_VALUE);
    // A second run reuses the tab.
    expect(await hx.run('show').code).toBe(0);
    expect(
      hx.store.state.tasks
        .find((t) => t.id === hx.task.id)!
        .terminals.filter((d) => d.label === 'agent · show'),
    ).toHaveLength(1);
    await hx.terminals.killAllForTask(hx.task.id);
  });

  it('reports a started run by kind and environment, never its name (telemetry)', async () => {
    const tel = telemetryEvents();
    const hx = await runHarness({ telemetry: tel.telemetry });
    expect(await hx.run('show').code).toBe(0);
    expect(await hx.run('printenv').code).toBe(1);
    expect(tel.named('secrets.runStarted')).toEqual([
      [
        'secrets.runStarted',
        { kind: 'run', environment: 'development' },
        undefined,
      ],
    ]);
    await hx.terminals.killAllForTask(hx.task.id);
  });

  it('passes arguments as arguments, never through a shell line', async () => {
    const hx = await runHarness();
    const r = hx.run('list', ['a b', '$(echo pwned)', "it's; echo no"]);
    expect(await r.code).toBe(0);
    expect(r.text()).toContain("a b\n$(echo pwned)\nit's; echo no\n");
    expect(r.text()).not.toContain('pwned\npwned');
    await hx.terminals.killAllForTask(hx.task.id);
  });

  it('returns the exit code and refuses names that are not in the list', async () => {
    const hx = await runHarness();
    expect(await hx.run('fail').code).toBe(3);
    const refused = hx.run('printenv');
    expect(await refused.code).toBe(1);
    expect(refused.text()).toBe(
      'Unknown command "printenv". Commands for shellie run: show, list, fail\n',
    );
    await hx.terminals.killAllForTask(hx.task.id);
  });

  it('waits for an approve on Production; a refuse returns 1 and starts nothing', async () => {
    const hx = await runHarness();
    await hx.h['tasks:setEnvironment'](hx.task.id, 'production', true);
    const r = hx.run('show');
    await vi.waitFor(async () =>
      expect(await hx.h['runs:pending']()).toHaveLength(1),
    );
    const [p] = await hx.h['runs:pending']();
    expect(p).toMatchObject({
      taskId: hx.task.id,
      name: 'show',
      environment: 'production',
    });
    expect(hx.broadcasts.some((b) => b.event === 'runs:pending')).toBe(true);
    await hx.h['runs:approve'](p!.id, false);
    expect(await r.code).toBe(1);
    expect(r.text()).toContain('Not approved in Shellie');
    expect(
      hx.store.state.tasks
        .find((t) => t.id === hx.task.id)!
        .terminals.some((d) => d.label === 'agent · show'),
    ).toBe(false);
    // Approved, it runs with the Production value, masked for the agent.
    const ok = hx.run('show');
    await vi.waitFor(async () =>
      expect(await hx.h['runs:pending']()).toHaveLength(1),
    );
    await hx.h['runs:approve']((await hx.h['runs:pending']())[0]!.id, true);
    expect(await ok.code).toBe(0);
    expect(ok.text()).toContain('db=[DB]');
    expect(ok.text()).not.toContain(PROD_VALUE);
    // Masked for the agent, so its tab is not paused.
    expect(await hx.h['terminals:leak'](hx.claude().id)).toBeNull();
    await hx.terminals.killAllForTask(hx.task.id);
  });

  it('spawns no tab for a run the agent cancelled while its tab was being prepared', async () => {
    const ac = new AbortController();
    const hx = await runHarness({
      // The agent goes away right as the tab is about to spawn (after prepareTab).
      openTab: (open) => (taskId, spec, attach) =>
        open(taskId, spec, (id) => {
          ac.abort();
          return attach(id);
        }),
    });
    const before = hx.terminals.ids().length;
    let text = '';
    const code = await hx.runs.start(
      hx.task.id,
      'show',
      [],
      (c) => {
        text += c;
      },
      { terminal: hx.claude().id, signal: ac.signal },
    );
    expect(code).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    const task = hx.store.state.tasks.find((t) => t.id === hx.task.id)!;
    expect(task.terminals.some((d) => d.label === 'agent · show')).toBe(false);
    expect(hx.terminals.ids()).toHaveLength(before);
    expect(text).not.toContain(DB_VALUE);
    await hx.terminals.killAllForTask(hx.task.id);
  });

  it('ends a run when its tab is stopped in Shellie', async () => {
    const hx = await runHarness();
    writeFileSync(
      path.join(hx.repo, '.shellie.yml'),
      `run:\n  wait: ${JSON.stringify(sleepCmd(30))}\n`,
    );
    const r = hx.run('wait');
    let tab: string | undefined;
    await vi.waitFor(() => {
      tab = hx.store.state.tasks
        .find((t) => t.id === hx.task.id)!
        .terminals.find((d) => d.label === 'agent · wait')?.id;
      expect(tab && hx.terminals.isRunning(tab)).toBe(true);
    });
    await hx.h['terminals:stop'](tab!);
    expect(await r.code).toBe(1);
    expect(r.text()).toContain('Stopped in Shellie');
    await hx.terminals.killAllForTask(hx.task.id);
  });

  it("tells Claude the names when the repo has a stored secret, and gives agent tabs' env the task", async () => {
    const hx = await runHarness();
    expect(hx.contexts.at(-1)).toContain(
      'run through `shellie run <name>`; available: show, list, fail. Plain commands in your shell run without secrets.',
    );
    expect(hx.envCalls.find((c) => c.kind === 'claude')).toEqual({
      kind: 'claude',
      taskId: hx.task.id,
      runNames: ['show', 'list', 'fail'],
      denyPaths: ['.env'],
    });
    await hx.terminals.killAllForTask(hx.task.id);
    const plain = await runHarness({ secrets: false });
    expect(plain.contexts.at(-1)).not.toContain('shellie run');
    expect(plain.envCalls.find((c) => c.kind === 'claude')).toEqual({
      kind: 'claude',
      taskId: plain.task.id,
      // The copied .env is a secret file whether or not a secret is stored.
      denyPaths: ['.env'],
    });
    await plain.terminals.killAllForTask(plain.task.id);
  });
});

describe('handlers: discard a task (#124)', () => {
  async function ready(over: Partial<Services> = {}) {
    const telemetry: Telemetry = { ...NoopTelemetry };
    const event = vi.spyOn(telemetry, 'event');
    let retryAll: (() => Promise<void>) | null = null;
    const hx = await harness(fakeCrypto(), {
      telemetry,
      onCleanupRetry: (fn) => {
        retryAll = fn;
      },
      ...over,
    });
    // The copied .env is ignored, as in a real repo: a task nobody worked in has nothing uncommitted.
    commitFile(hx.repo, '.gitignore', '.env\n');
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ name: 'try' }));
    await done;
    return { ...hx, t, event, retryAll: () => retryAll!() };
  }

  it('a blank task: closes its terminals, removes its worktree and branch, and the task is gone', async () => {
    const hx = await ready();
    expect(hx.terminals.runningCount(hx.t.id)).toBeGreaterThan(0);
    const reviewFile = path.join(hx.usageDir, 'review', `${hx.t.id}.json`);
    mkdirSync(path.dirname(reviewFile), { recursive: true });
    writeFileSync(reviewFile, '{}');
    const checks = await hx.h['tasks:discardChecks'](hx.t.id);
    expect(checks).toMatchObject({ blank: true, commitsLost: 0 });
    await hx.h['tasks:discard'](hx.t.id);
    expect(hx.terminals.runningCount(hx.t.id)).toBe(0);
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(
      false,
    );
    expect(hx.store.state.tasks).toEqual([]);
    expect(hx.store.state.discardedCleanup).toEqual([]);
    expect(await hx.h['tasks:list']()).toEqual([]);
    expect(existsSync(reviewFile)).toBe(false);
    expect(hx.event).toHaveBeenCalledWith(
      'task.discarded',
      { blank: true },
      expect.objectContaining({ commitsLost: 0 }),
    );
    // Nothing else happens: no push, no PR, no booking.
    expect(hx.opened).toEqual([]);
    expect(hx.event).not.toHaveBeenCalledWith(
      'task.finished',
      expect.anything(),
      expect.anything(),
    );
  });

  it('names the commits no remote has and the uncommitted files, which Discard loses', async () => {
    const hx = await ready();
    commitFile(hx.t.worktreePath, 'work.txt', 'work');
    writeFileSync(path.join(hx.t.worktreePath, 'draft.txt'), 'draft');
    const checks = await hx.h['tasks:discardChecks'](hx.t.id);
    expect(checks).toMatchObject({
      blank: false,
      commitsLost: 1,
      uncommitted: 1,
    });
    expect(checks.workspaces[0]).toMatchObject({
      workspaceId: 'home',
      branch: hx.t.branch,
      kept: false,
      missing: false,
      commits: 1,
      unpushed: 1,
      uncommitted: 1,
    });
    await hx.h['tasks:discard'](hx.t.id);
    expect(hx.event).toHaveBeenCalledWith(
      'task.discarded',
      { blank: false },
      expect.objectContaining({ commitsLost: 1 }),
    );
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(
      false,
    );
  });

  it('is refused while the task sets up or finishes', async () => {
    const hx = await harness();
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ commands: [sleepCmd(1)] }));
    await expect(hx.h['tasks:discard'](t.id)).rejects.toThrow(/setting-up/);
    await done;
    await hx.store.update((st) => {
      st.tasks[0].status = 'finishing';
    });
    await expect(hx.h['tasks:discard'](t.id)).rejects.toThrow(/finishing/);
    expect(hx.store.state.tasks).toHaveLength(1);
    await hx.terminals.killAllForTask(t.id);
  });

  it('a folder a process holds does not fail Discard: the task is gone and the cleanup is retried', async () => {
    const hx = await ready();
    const remove = vi
      .spyOn(hx.services.git, 'worktreeRemove')
      .mockRejectedValue(
        Object.assign(new Error('Could not delete: EPERM'), { code: 'EPERM' }),
      );
    await hx.h['tasks:discard'](hx.t.id);
    expect(hx.store.state.tasks).toEqual([]);
    expect(hx.store.state.discardedCleanup).toEqual([
      expect.objectContaining({
        taskId: hx.t.id,
        worktreePath: hx.t.worktreePath,
        branch: hx.t.branch,
        code: 'EPERM',
      }),
    ]);
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    expect(hx.event).toHaveBeenCalledWith('cleanup.deferred', {
      code: 'EPERM',
    });
    remove.mockRestore();
    await hx.retryAll();
    expect(hx.store.state.discardedCleanup).toEqual([]);
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(
      false,
    );
  });

  it('discards every workspace on the task branch, and leaves one on another branch alone', async () => {
    const hx = await ready();
    const other = makeRepo('api');
    const wt = path.join(path.dirname(other), 'api-wt');
    git(other, 'worktree', 'add', '-q', '-b', hx.t.branch, wt);
    const dev = makeRepo('docs');
    const devWt = path.join(path.dirname(dev), 'docs-wt');
    git(dev, 'worktree', 'add', '-q', '-b', 'dev', devWt);
    await hx.h['tasks:addWorkspace'](hx.t.id, wt);
    await hx.h['tasks:addWorkspace'](hx.t.id, devWt);
    const checks = await hx.h['tasks:discardChecks'](hx.t.id);
    expect(checks.workspaces.map((w) => [w.repoName, w.kept])).toEqual([
      ['webshop', false],
      ['api', false],
      ['docs', true],
    ]);
    await hx.h['tasks:discard'](hx.t.id);
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(existsSync(wt)).toBe(false);
    expect(await new GitClient().branchExists(other, hx.t.branch)).toBe(false);
    expect(existsSync(devWt)).toBe(true);
    expect(await new GitClient().branchExists(dev, 'dev')).toBe(true);
    expect(hx.store.state.tasks).toEqual([]);
  });
});
