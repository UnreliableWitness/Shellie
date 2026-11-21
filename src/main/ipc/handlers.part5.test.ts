// handlers tests, part 5 of 6 (split so CI can run them on several machines at once).
import { defaultDreaming, defaultDreamingAll } from '../../shared/dreams';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeCrypto } from '../test-helpers/fakeCrypto';
import { NoopTelemetry } from '../telemetry/AppInsightsClient';
import { TimeStore } from '../time/TimeStore';
import { telemetryEnv } from '../usage/telemetryEnv';
import { echoCmd, testPlatform } from '../test-helpers/shell';
import { commitFile, git } from '../test-helpers/gitRepo';
import { noDreams } from '../dreams/dreamHandlers';
import { createHandlers } from './handlers';
import {
  telemetryEvents,
  harness,
  routeHealthyOrg,
  linkedTask,
} from './handlersHarness';

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
    // The copied .env is untracked: confirmed, as Finish's danger button does (#244).
    confirmDiscardUnsaved: true,
    bookedSeconds,
  });

  async function timeTask(
    hx: Awaited<ReturnType<typeof harness>>,
    writeTime: boolean,
  ) {
    const { t, c } = await linkedTask(hx);
    await hx.h['connections:update'](c.id, { writeTimeToAdo: writeTime });
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
      'Writing time to Azure DevOps is off for this project. Turn it on in Settings > Project > Time.',
    );
  });

  it("time:sync throws when the task's project has write-back off even if another project has it on", async () => {
    const hx = await harness();
    const { t } = await timeTask(hx, false);
    await hx.h['tasks:finish'](t.id, finishOpts(7200));
    routeHealthyOrg(hx.server, 'other');
    const other = await hx.h['connections:save']({
      organizationUrl: `${hx.server.url}/other`,
      project: 'Shellie',
      pat: 'p2',
    });
    await hx.h['connections:update'](other.id, { writeTimeToAdo: true });
    await expect(hx.h['time:sync'](t.id)).rejects.toThrow(
      'Writing time to Azure DevOps is off for this project',
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

describe('handlers: task setup summary', () => {
  it('tasks:create records the summary', async () => {
    const { h, input, setupDone, added, settings, terminals, store } =
      await harness();
    await h['repos:setWorkItemOnStart'](added.id, {
      moveToInProgress: true,
      assignToMe: false,
      stateOverrides: { 'User Story': 'Doing' },
    });
    await h['repos:setOverride'](added.id, 'run', { dev: 'npm run dev' });
    await h['repos:setOverride'](added.id, 'apm', ['claude']);
    await settings.save({
      ...settings.get(),
      editor: { default: 'vscode', repos: {} },
    });
    const done = setupDone();
    const task = await h['tasks:create'](
      input({ commands: ['npm ci'], startClaude: true }),
    );
    await done;
    expect(task.setup.summary).toEqual({
      branch: 'feature/48231-show-estimated-delivery-date',
      base: 'main',
      copy: ['.env'],
      commands: ['npm ci'],
      apm: ['claude'],
      tabs: ['Claude Code', testPlatform().shellLabel],
      run: ['npm run dev'],
      workItem: {
        move: 'Doing',
        assign: false,
        source: 'set on this repo',
      },
      editor: 'VS Code',
      brain: null,
    });
    // Recorded once: a setting changed after creation applies to the next task.
    await h['repos:setOverride'](added.id, 'copy', ['.env.local']);
    expect(
      store.state.tasks.find((t) => t.id === task.id)?.setup.summary?.copy,
    ).toEqual(['.env']);
    await terminals.killAllForTask(task.id);
  });

  it('records no copy and the default In Progress state without a choice', async () => {
    const { h, input, setupDone, terminals } = await harness();
    const done = setupDone();
    const task = await h['tasks:create'](input({ copy: false }));
    await done;
    expect(task.setup.summary).toMatchObject({
      copy: [],
      apm: null,
      tabs: [testPlatform().shellLabel],
      workItem: { move: 'In Progress', assign: true },
      editor: null,
    });
    await terminals.killAllForTask(task.id);
  });
});

describe('handlers: dreams', () => {
  it('the generic settings save never writes dreaming, from a patch or a stale whole object', async () => {
    const hx = await harness();
    const s = await hx.h['settings:get']();
    const on = { ...defaultDreaming(), enabled: true };
    await hx.h['settings:save']({
      ...s,
      dreaming: { projects: { p1: on }, legacy: on },
    });
    expect(hx.settings.get().dreaming).toEqual(defaultDreamingAll());
    // Dreaming on, as `dream:switchOn` leaves it; then a renderer that read the settings before a switch-off.
    await hx.settings.updateDreamingOf('p1', (d) => ({ ...d, enabled: true }));
    const stale = await hx.h['settings:get']();
    await hx.settings.updateDreamingOf('p1', (d) => ({ ...d, enabled: false }));
    await hx.h['settings:save']({ ...stale, showSplash: !stale.showSplash });
    expect(hx.settings.get().dreaming.projects.p1.enabled).toBe(false);
    expect(hx.settings.get().showSplash).toBe(!stale.showSplash);
  });

  it('a switch-off and other settings writes queued together end with dreaming off', async () => {
    const hx = await harness();
    await hx.settings.updateDreamingOf('p1', (d) => ({ ...d, enabled: true }));
    const stale = hx.settings.get();
    // As `dream:switchOff`, then the editor prefs save (`savePrefs`) and the renderer's save, all in flight at once.
    const writes = [
      hx.settings.updateDreamingOf('p1', (d) => ({ ...d, enabled: false })),
      hx.settings.update((cur) => ({
        ...cur,
        editor: { ...cur.editor, default: 'vscode' },
      })),
      hx.h['settings:save']({ ...stale, showSplash: !stale.showSplash }),
      hx.settings.save({ ...stale, notifyOnDone: !stale.notifyOnDone }),
    ];
    await Promise.all(writes);
    expect(hx.settings.get().dreaming.projects.p1.enabled).toBe(false);
  });

  const dreamBranch = 'dream/2026-11-20-1';
  /** A dream branch with one commit, and a link that knows only `d1` → that branch. */
  const withDream = async (o: { failing?: boolean } = {}) => {
    const taskCreated = vi.fn(async () => undefined);
    const hx = await harness(fakeCrypto(), {
      dreams: {
        ...noDreams(),
        taskLink: {
          opened: (id, repoId, branch) =>
            id === 'd1' && branch === dreamBranch && repoId !== '',
          taskCreated,
        },
      },
    });
    // Before the branch, so its apm.yml is on it and the setup's apm step fails.
    if (o.failing) hx.failSetup();
    const base = git(hx.repo, 'rev-parse', 'main').trim();
    git(hx.repo, 'checkout', '-q', '-b', dreamBranch);
    commitFile(hx.repo, 'RULE.md', 'a rule\n', 'dream: A rule');
    git(hx.repo, 'checkout', '-q', 'main');
    return { hx, base, taskCreated };
  };

  it('tasks:create with a wrong fromDream still refuses an existing branch', async () => {
    const { hx } = await withDream();
    await expect(
      hx.h['tasks:create'](hx.input({ branch: dreamBranch, fromDream: 'd2' })),
    ).rejects.toThrow(`Branch ${dreamBranch} already exists`);
    await expect(
      hx.h['tasks:create'](hx.input({ branch: dreamBranch })),
    ).rejects.toThrow(`Branch ${dreamBranch} already exists`);
    expect(hx.store.state.tasks).toEqual([]);
  });

  // A shell tab gives the setup an apm step, which `failSetup` makes fail.
  const dreamTask = (hx: Awaited<ReturnType<typeof harness>>) =>
    hx.h['tasks:create'](
      hx.input({
        branch: dreamBranch,
        fromDream: 'd1',
        workItem: null,
        name: 'Rules from a dream',
      }),
    );

  it('a failed and then cancelled setup of a dream task keeps the dream branch and its commits', async () => {
    const { hx } = await withDream({ failing: true });
    const tip = git(hx.repo, 'rev-parse', dreamBranch).trim();
    const done = hx.setupDone();
    const t = await dreamTask(hx);
    expect((await done).ok).toBe(false);
    expect(hx.store.state.tasks[0].existingBranch).toBe(true);
    await hx.h['tasks:cancelSetup'](t.id);
    expect(hx.store.state.tasks).toEqual([]);
    expect(git(hx.repo, 'rev-parse', dreamBranch).trim()).toBe(tip);
    expect(git(hx.repo, 'log', '--format=%s', '-1', dreamBranch).trim()).toBe(
      'dream: A rule',
    );
  });

  it('the setup of a dream task checks its branch out again after a restart', async () => {
    const { hx } = await withDream({ failing: true });
    const done = hx.setupDone();
    const t = await dreamTask(hx);
    expect((await done).ok).toBe(false);
    // As after a crash during the worktree step: no worktree, and a fresh Shellie that knows nothing in memory.
    git(hx.repo, 'worktree', 'remove', '--force', t.worktreePath);
    hx.fixSetup();
    const restarted = createHandlers(hx.services);
    const retry = hx.setupDone();
    await restarted['tasks:retrySetup'](t.id);
    expect((await retry).ok).toBe(true);
    expect(git(t.worktreePath, 'branch', '--show-current').trim()).toBe(
      dreamBranch,
    );
    expect(git(t.worktreePath, 'log', '--format=%s', '-1').trim()).toBe(
      'dream: A rule',
    );
    await hx.terminals.killAllForTask(t.id);
  });

  it('tasks:create from a dream makes the task on the dream branch; Changes shows its commits', async () => {
    const { hx, taskCreated } = await withDream();
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({
        branch: dreamBranch,
        fromDream: 'd1',
        workItem: null,
        name: 'Rules from a dream',
        openShell: false,
      }),
    );
    expect((await done).ok).toBe(true);
    expect(taskCreated).toHaveBeenCalledWith(
      'd1',
      hx.added.id,
      'Rules from a dream',
    );
    expect(git(t.worktreePath, 'branch', '--show-current').trim()).toBe(
      dreamBranch,
    );
    const files = await hx.h['review:files'](t.id, { kind: 'all' });
    expect(files.repos[0].files.map((f) => f.path)).toContain('RULE.md');
  });
});
