import type { TaskTime } from '../../shared/time';
import type { TaskUsage } from '../../shared/usage';
import type { Channels, Events, ShellieApi } from '../../shared/ipc';
import type { RendererTelemetry } from '../../shared/telemetry';

type AnyFn = (...args: never[]) => unknown;
export type FakeHandlers = Partial<{
  [K in keyof Channels]: (
    ...args: Channels[K]['args']
  ) => Channels[K]['result'] | Promise<Channels[K]['result']>;
}>;

export const emptyUsage = (taskId: string): TaskUsage => ({
  taskId,
  sessions: [],
  recent: [],
  byModel: [],
  unpricedRequests: 0,
  usdToEur: 0.92,
  billable: { costUsd: 0, costEur: 0, tokens: 0 },
  byTool: {
    'claude-code': { costUsd: 0, costEur: 0, sessions: 0, tokens: 0 },
    'copilot-cli': { costUsd: 0, costEur: 0, sessions: 0, tokens: 0 },
    opencode: { costUsd: 0, costEur: 0, sessions: 0, tokens: 0 },
  },
});

export const emptyTime = (taskId: string): TaskTime => ({
  taskId,
  activeSeconds: 0,
  agentSeconds: { 'claude-code': 0, 'copilot-cli': 0, opencode: 0 },
  realisticSeconds: 0,
  wallClockSeconds: 0,
  measuredSinceReopenSeconds: 0,
  booking: null,
  estimate: null,
});

const defaults: FakeHandlers = {
  'budget:get': (_vendor, monthOffset) => ({
    monthOffset,
    startDay: '2026-10-01',
    endDay: '2026-10-31',
    budgetEur: null,
    spentEur: 0,
    daysElapsed: 1,
    daysInMonth: 31,
    forecastEur: null,
    status: 'none',
    cumulative: [],
    days: [],
    models: [],
    todayEur: 0,
    todayAllowanceEur: null,
    weekEur: 0,
    outsideShare: 0,
    notCounted: [],
    unpriced: [],
    sources: { claudeCode: false, openCode: false },
    scanned: true,
    alertsDue: [],
  }),
  'home:get': () => null,
  'costServer:status': () => ({
    connected: false,
    url: null,
    email: null,
    lastSentAt: null,
    waiting: 0,
    error: null,
    budgets: null,
  }),
  // Finish asks for a PR description when a PR is ticked; tests that care give their own.
  'tasks:prSummary': () => ({ text: null, error: 'not in tests' }),
  'home:refresh': () => ({
    version: 1,
    builtAt: '2026-10-17T09:00:00.000Z',
    connections: [],
  }),
  'home:stats': (period) => ({
    period,
    from: '2026-10-12T00:00:00.000Z',
    to: '2026-10-17T09:00:00.000Z',
    costEur: 0,
    costByTool: { 'claude-code': 0, 'copilot-cli': 0, opencode: 0 },
    costByConnection: [],
    activeSeconds: 0,
    agentSeconds: 0,
    accuracy: null,
    accuracyTasks: 0,
    tasksFinished: 0,
    prsOpened: 0,
  }),
  'time:focus': () => undefined,
  'attention:view': () => undefined,
  'attention:get': () => ({}),
  'time:task': (taskId) => emptyTime(taskId),
  'time:sprint': () => ({}),
  'docs:list': () => ({ files: [] }),
  'docs:session': () => ({ files: [] }),
  'docs:watch': () => ({ live: true }),
  'review:files': () => ({ repos: [] }),
  'review:state': () => ({ version: 1, viewed: {}, comments: [] }),
  'review:summary': () => ({ files: 0, notViewed: 0, unresolved: 0 }),
  'review:watch': () => ({ live: true }),
  'docs:resolve': () => null,
  'settings:get': () => ({
    version: 1,
    receiverPort: 4319,
    writeTimeToAdo: false,
    idleMinutes: 5,
    workHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
    showSplash: true,
    notifyOnDone: true,
    theme: 'system',
    claudeBudget: {
      monthlyEur: null,
      monthStartDay: 1,
      alerts: { at80: true, forecastOver: true, at100: true },
    },
    copilotBudget: {
      monthlyEur: null,
      monthStartDay: 1,
      alerts: { at80: true, forecastOver: true, at100: true },
    },
    sendTelemetry: true,
    editor: { default: null, repos: {} },
    secrets: { productionMinutes: 60 },
    onboarding: {
      dismissedAt: null,
      agentsCheckedAt: '2026-10-22T09:00:00.000Z',
      tracker: null,
      migrated: false,
    },
    defaultTerminals: {
      claude: true,
      copilot: false,
      opencode: false,
      shell: true,
    },
  }),
  'agents:detect': () => ({
    checkedAt: '2026-10-22T10:00:00.000Z',
    agents: {
      claude: {
        found: true,
        version: '2.1.307',
        path: '/usr/local/bin/claude',
      },
      copilot: { found: false, version: null, path: null },
      opencode: { found: false, version: null, path: null },
    },
    shell: { label: 'zsh' },
  }),
  'editor:options': () => ({
    editors: [{ id: 'vscode', label: 'VS Code' }],
    chosen: 'vscode',
    solutions: [],
    solution: null,
  }),
  'editor:installed': () => [{ id: 'vscode', label: 'VS Code' }],
  'editor:openFolder': () => undefined,
  'editor:openFile': () => undefined,
  'app:info': () => ({ version: '1.0.0', windowsBuild: null }),
  'update:status': () => null,
  'app:whatsNew': () => null,
  'rates:list': () => ({ rates: [], officialAsOf: '2026-10-14' }),
  'usage:task': (taskId) => emptyUsage(taskId),
  'repos:list': () => [],
  'repos:inspect': (folder) => ({
    folder,
    remote: null,
    baseBranch: 'main',
    facts: {
      lockfile: null,
      dotnet: [],
      devScript: null,
      apm: false,
      envFiles: [],
      existing: null,
    },
    proposal: 'base: main\n',
  }),
  'workItems:types': () => [],
  'workItems:iterations': () => [],
  'connections:list': () => [],
  'secrets:list': () => [],
  'secrets:forget': () => undefined,
  'secrets:repoDefault': () => 'development',
  'secrets:status': () => ({
    state: 'empty',
    reasons: [],
    given: [],
    secrets: 0,
  }),
  'connections:probe': () => ({
    user: 'Dries Hoebeke',
    uniqueName: null,
    projects: [],
    canListProjects: true,
  }),
  'connections:saveMany': () => [],
  'tasks:list': () => [],
  'tasks:scanWorkspaces': () => [],
  'tasks:setupState': () => null,
  'tasks:prAvailability': () => ({
    available: false,
    reason: 'origin is not an Azure Repos URL',
    target: null,
  }),
  'tasks:prStatus': () => null,
  'repos:setWorkItemOnStart': (repoId, settings) => ({
    id: repoId,
    name: 'repo',
    path: '/src/repo',
    baseBranch: 'main',
    connectionId: null,
    configFound: false,
    discovered: false,
    workItemOnStart: settings,
  }),
  'terminals:buffer': () => '',
  'terminals:isRunning': () => false,
  'terminals:failure': () => null,
  'terminals:leak': () => null,
  'runs:pending': () => [],
  'terminals:reportScheme': () => undefined,
  'terminals:write': () => undefined,
  'terminals:resize': () => undefined,
  'usage:receiverStatus': () => ({
    listening: true,
    port: 4319,
    error: null,
    copilot: { records: 0, unreadable: 0 },
  }),
};

/** Installs `window.shellie` backed by plain functions. Returns the call log and an `emit` to push events. */
export function installFakeApi(overrides: FakeHandlers = {}) {
  const calls: { channel: keyof Channels; args: unknown[] }[] = [];
  const tracked: RendererTelemetry[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const handlers = { ...defaults, ...overrides };
  const fake: ShellieApi = {
    invoke: async (channel, ...args) => {
      calls.push({ channel, args });
      const fn = handlers[channel] as AnyFn | undefined;
      if (!fn) throw new Error(`No fake handler for ${channel}`);
      return (await fn(...(args as never[]))) as never;
    },
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (p: unknown) => void);
      listeners.set(event, set);
      return () => set.delete(listener as (p: unknown) => void);
    },
    track: (message) => {
      tracked.push(message);
    },
    titleBar: 'native',
  };
  window.shellie = fake;
  const emit = <K extends keyof Events>(event: K, payload: Events[K]) =>
    listeners.get(event)?.forEach((l) => l(payload));
  return { calls, emit, tracked };
}
