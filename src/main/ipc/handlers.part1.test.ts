// handlers tests, part 1 of 6 (split so CI can run them on several machines at once).
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeCrypto } from '../test-helpers/fakeCrypto';
import { GitClient } from '../services/GitClient';
import { NoopTelemetry, type Telemetry } from '../telemetry/AppInsightsClient';
import { CostServerError } from '../costServer/client';
import { CostServerStore } from '../costServer/CostServerStore';
import { DocsWatcher } from '../docs/DocsWatcher';
import type { WorkspaceDetector } from '../workspaces/WorkspaceDetector';
import { commitFile, git, makeRepo } from '../test-helpers/gitRepo';
import { isWindows, sleepCmd, writeLineCmd } from '../test-helpers/shell';
import { createHandlers } from './handlers';
import { connDirs, harness, expectTerminalsKept } from './handlersHarness';

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
