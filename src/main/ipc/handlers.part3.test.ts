// handlers tests, part 3 of 6 (split so CI can run them on several machines at once).
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderTaskMd } from '../../shared/naming';
import type { CreateTaskInput, Task } from '../../shared/types';
import { fakeCrypto } from '../test-helpers/fakeCrypto';
import { type AdoServer } from '../test-helpers/adoServer';
import { OFFICIAL_RATES } from '../pricing/officialRates';
import { TaskStore } from '../services/TaskStore';
import { NoopTelemetry, type Telemetry } from '../telemetry/AppInsightsClient';
import { TerminalManager } from '../services/TerminalManager';
import { makeRepo } from '../test-helpers/gitRepo';
import {
  echoCmd,
  envRef,
  isWindows,
  sleepCmd,
  testPlatform,
} from '../test-helpers/shell';
import {
  createHandlers,
  pruneDanglingConnectionLinks,
  recoverInterruptedTasks,
} from './handlers';
import {
  allTerminals,
  harness,
  routeHealthyOrg,
  linkedTask,
} from './handlersHarness';

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
      timeframe: 'current',
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
  it('lists the iterations and returns the rows of a chosen one', async () => {
    const hx = await harness();
    const c = await save(hx);
    hx.server.route(
      'GET',
      '/unreliablewitness/Shellie/_apis/work/teamsettings/iterations',
      {
        body: {
          value: [
            {
              id: 'it-1',
              name: 'Sprint 1',
              path: 'Shellie\\Sprint 1',
              attributes: { timeFrame: 'current' },
            },
            {
              id: 'it-2',
              name: 'Sprint 2',
              path: 'Shellie\\Sprint 2',
              attributes: { timeFrame: 'future' },
            },
          ],
        },
      },
    );
    hx.server.route(
      'GET',
      '/unreliablewitness/Shellie/_apis/work/teamsettings/iterations/it-2/workitems',
      {
        body: {
          workItemRelations: [{ rel: null, source: null, target: { id: 5 } }],
        },
      },
    );
    const list = await hx.h['workItems:iterations'](c.id);
    expect(list.map((i) => [i.id, i.timeframe])).toEqual([
      ['it-1', 'current'],
      ['it-2', 'future'],
    ]);
    expect(hx.server.requests.at(-1)?.path).not.toContain('$timeframe');
    const sprint = await hx.h['workItems:sprint'](c.id, 'it-2');
    expect(sprint.iteration?.name).toBe('Sprint 2');
    expect(sprint.rows.map((r) => r.item.id)).toEqual(['5']);
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

  it("opens Shellie's GitHub release pages and no other GitHub url (#132)", async () => {
    const { h, opened } = await harness();
    await h['shell:openExternal'](
      'https://github.com/UnreliableWitness/Shellie/releases',
    );
    await h['shell:openExternal'](
      'https://github.com/UnreliableWitness/Shellie/releases/tag/v1.2.3',
    );
    for (const bad of [
      'https://github.com/other/repo/releases',
      'https://github.com/UnreliableWitness/Shellie-evil/releases',
      'https://github.com/UnreliableWitness/Shellie/releases-evil',
      'https://github.com/UnreliableWitness/Shellie/releases/../../../other/repo',
      'https://github.com/UnreliableWitness/Shellie',
      'http://github.com/UnreliableWitness/Shellie/releases',
      'https://github.com.evil.example/UnreliableWitness/Shellie/releases',
      'https://evil@github.com/UnreliableWitness/Shellie/releases',
      'https://github.com:8443/UnreliableWitness/Shellie/releases',
    ])
      await expect(h['shell:openExternal'](bad)).rejects.toThrow(/not allowed/);
    expect(opened).toEqual([
      'https://github.com/UnreliableWitness/Shellie/releases',
      'https://github.com/UnreliableWitness/Shellie/releases/tag/v1.2.3',
    ]);
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

  const taskMdOf = (t: Task) =>
    readFileSync(path.join(t.worktreePath, '.shellie', 'task.md'), 'utf8');

  it('writes the whole work item and its comments into task.md', async () => {
    const hx = await harness();
    const { client } = await connected(hx);
    const details = vi.spyOn(client, 'workItemDetails').mockResolvedValue({
      fields: {
        'System.Title': 'Show estimated delivery date',
        'System.Description': '<p>Customers want a <b>date</b>.</p>',
      },
      url: null,
      links: [],
      comments: [
        {
          author: 'Ann',
          createdDate: '2026-10-01T10:00:00Z',
          text: 'Use the carrier API',
          html: false,
        },
      ],
    });
    const { t, finished } = await createAndWait(hx);
    expect(finished.ok).toBe(true);
    expect(details).toHaveBeenCalledWith(48231);
    const md = taskMdOf(t);
    expect(md).toContain('### Description\n\nCustomers want a date.');
    expect(md).toContain(
      '### Ann, 2026-10-01T10:00:00Z\n\nUse the carrier API',
    );
  });

  it('keeps the old task.md when the work item cannot be read', async () => {
    const hx = await harness();
    const { client } = await connected(hx);
    vi.spyOn(client, 'workItemDetails').mockRejectedValue(new Error('offline'));
    const { t, finished } = await createAndWait(hx);
    expect(finished.ok).toBe(true);
    const task = hx.store.state.tasks.find((x) => x.id === t.id)!;
    expect(taskMdOf(t)).toBe(
      renderTaskMd(task, { [hx.added.id]: hx.added.path }),
    );
  });
});
