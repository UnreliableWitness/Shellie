// Shared by the handlers.part*.test.ts files: the services harness, cleanup and helpers. Not a test file.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect } from 'vitest';
import type { Events } from '../../shared/ipc';
import type { CreateTaskInput, SetupEvent } from '../../shared/types';
import { TrackerRegistry } from '../trackers/TrackerRegistry';
import { ConnectionStore, type TokenCrypto } from '../services/ConnectionStore';
import { SecretStore } from '../secrets/SecretStore';
import { fakeCrypto } from '../test-helpers/fakeCrypto';
import { startAdoServer, type AdoServer } from '../test-helpers/adoServer';
import { OFFICIAL_RATES } from '../pricing/officialRates';
import { SettingsStore } from '../usage/SettingsStore';
import { UsageStore } from '../usage/UsageStore';
import { GitClient } from '../services/GitClient';
import { loadShellieConfig } from '../services/ShellieConfig';
import { RepoRegistry } from '../services/RepoRegistry';
import { SetupRunner } from '../services/SetupRunner';
import { TaskStore } from '../services/TaskStore';
import { NoopTelemetry, type Telemetry } from '../telemetry/AppInsightsClient';
import { TerminalManager } from '../services/TerminalManager';
import { TimeStore } from '../time/TimeStore';
import {
  cleanupTempRepos,
  commitFile,
  makeRepo,
} from '../test-helpers/gitRepo';
import { echoCmd, failCmd, testPlatform } from '../test-helpers/shell';
import { createHandlers, type Services } from './handlers';

export type Finished = Extract<SetupEvent, { type: 'finished' }>;

export type Broadcast = { event: keyof Events; payload: unknown };

/** Waits on a terminal's spawn, output or exit: a shell takes seconds to start or end on a Windows runner. */
export const PTY_WAIT = { timeout: 10_000 };

export const allTerminals: TerminalManager[] = [];

export const servers: AdoServer[] = [];

export const connDirs: string[] = [];

afterAll(async () => {
  await Promise.all(servers.map((v) => v.close()));
  await Promise.all(
    allTerminals.flatMap((t) => t.ids().map((id) => t.kill(id))),
  );
  for (const d of connDirs) rmSync(d, { recursive: true, force: true });
  cleanupTempRepos();
});

/** Records telemetry events (name, properties, measurements). */
export function telemetryEvents() {
  const events: [string, unknown, unknown][] = [];
  const telemetry: Telemetry = {
    ...NoopTelemetry,
    event: (name, props, m) => events.push([name, props, m]),
  };
  const named = (name: string) => events.filter((e) => e[0] === name);
  return { events, telemetry, named };
}

export async function harness(
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

/**
 * Shellie left the task's terminals alone: each is still listed on the task and still known to the TerminalManager,
 * which forgets a terminal when Shellie kills it. Whether the OS process is still alive is not asserted: on a loaded
 * Windows runner an idle interactive PowerShell has been seen to exit by itself during a long test.
 */
export function expectTerminalsKept(
  store: TaskStore,
  terminals: TerminalManager,
  taskId: string,
  count: number,
) {
  const listed = store.state.tasks.find((t) => t.id === taskId)?.terminals;
  expect(listed).toHaveLength(count);
  for (const def of listed ?? []) expect(terminals.has(def.id)).toBe(true);
}

export function routeHealthyOrg(server: AdoServer, org = 'unreliablewitness') {
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

export async function linkedTask(hx: Awaited<ReturnType<typeof harness>>) {
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
