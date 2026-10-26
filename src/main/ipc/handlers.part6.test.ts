// handlers tests, part 6 of 6 (split so CI can run them on several machines at once).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LeakWatch } from '../secrets/LeakWatch';
import type { CreateTaskInput, Task } from '../../shared/types';
import { RunHub, type RunBackend } from '../secrets/RunHub';
import { fakeCrypto } from '../test-helpers/fakeCrypto';
import { GitClient } from '../services/GitClient';
import { NoopTelemetry, type Telemetry } from '../telemetry/AppInsightsClient';
import { addOrigin, commitFile, git, makeRepo } from '../test-helpers/gitRepo';
import {
  echoCmd,
  failCmd,
  isWindows,
  normaliseEol,
  sleepCmd,
  testPlatform,
} from '../test-helpers/shell';
import { type Services } from './handlers';
import { PTY_WAIT, telemetryEvents, harness } from './handlersHarness';

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
