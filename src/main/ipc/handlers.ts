import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ENVIRONMENT_LABEL,
  ENVIRONMENTS,
  type Environment,
  type EnvironmentInfo,
  isGuarded,
  LEAK_IN_BRANCH,
  LEAK_UNCHECKED,
  type SecretScope,
  type SecretsStatus,
  type SecretView,
} from '../../shared/secrets';
import { LeakMatcher } from '../secrets/LeakMatcher';
import { LeakWatch } from '../secrets/LeakWatch';
import type { RunHub, RunSpec } from '../secrets/RunHub';
import { branchLeaks } from '../secrets/leakScan';
import { discoveredMeasurements } from '../secrets/telemetry';
import { type ExpiryTimers, scheduleExpiry } from '../secrets/expiry';
import { DiscoveryHold, discoverSecrets } from '../secrets/discover';
import {
  cleanAll,
  cleanWorktree,
  computeStatus,
  storedNames,
} from '../secrets/status';
import { denyRulesFor, denyTargets, inWorktree } from '../secrets/deny';
import {
  buildImportPlan,
  importSecrets,
  importSources,
} from '../secrets/importPlan';
import {
  givenToFor,
  holdsSecrets as holdsSecretsFor,
  launchProfileArgs,
  launchProfileFor,
  secretsEnv,
  testCommandFor,
  withLaunchProfile,
} from '../secrets/inject';
import { SecretStore } from '../secrets/SecretStore';
import { isAgentKind } from '../../shared/terminalFailure';
import type {
  Events,
  Handlers,
  PendingUpdate,
  WhatsNew,
} from '../../shared/ipc';
import { claudeContext, renderTaskMd, taskSlug } from '../../shared/naming';
import {
  claudeHasSessionsIn,
  claudeProjectsDir,
  claudeSessionExists,
  claudeSessionFile,
} from '../services/claudeSessions';
import { WorkspaceDetector } from '../workspaces/WorkspaceDetector';
import type {
  Connection,
  ConnectionInput,
  DiscardChecks,
  DiscardedCleanup,
  DiscardWorkspaceCheck,
  FinishOptions,
  FinishRowResult,
  ShellieConfig,
  PendingCleanup,
  PullRequestRef,
  Repo,
  SetupEvent,
  SetupState,
  Task,
  TaskStatus,
  TaskSummary,
  TaskView,
  TerminalDef,
  WorkItemDetails,
  WorkItemTypeMeta,
  WorkspaceAction,
  WorkspaceCheck,
} from '../../shared/types';
import { EnvironmentSchema } from '../../shared/types';
import {
  activeHome,
  activeWorkspaces,
  HOME_ID,
  isReopening,
  taskConnectionId,
  taskWorkspaces,
  workspaceById,
  type WorkspaceView,
  parseDocsTarget,
} from '../../shared/workspaces';
import { UPDATE_REPO } from '../autoUpdate';
import { pathExists } from '../fsRetry';
import { worktreeRoot } from '../paths';
import type { BudgetService } from '../budget/BudgetService';
import {
  CostServerError,
  hello as costServerHello,
} from '../costServer/client';
import type { CostSender } from '../costServer/CostSender';
import type { CostServerStore } from '../costServer/CostServerStore';
import { type CostServerStatus, validServerUrl } from '../../shared/costServer';
import { HomeService } from '../home/HomeService';
import { homeStats } from '../home/homeStats';
import { DocsWatcher } from '../docs/DocsWatcher';
import { GitDirWatcher } from '../review/GitDirWatcher';
import type { AgentsDetected } from '../../shared/agents';
import {
  detectAgents,
  runProbe,
  type ProbeRunner,
} from '../services/agentDetector';
import { createEditorHandlers } from '../editors/editorHandlers';
import {
  detectEditors,
  scanProject,
  systemDetectDeps,
} from '../editors/editors';
import { EditorService } from '../editors/EditorService';
import { createReviewHandlers } from '../review/reviewHandlers';
import { ReviewService } from '../review/ReviewService';
import { ReviewStore } from '../review/ReviewStore';
import { createDocsHandlers } from '../docs/docsHandlers';
import { SessionDocs } from '../docs/sessionDocs';
import type { AttentionHub } from '../attention/AttentionHub';
import type { ActivityTracker } from '../time/ActivityTracker';
import { baselineKey, createTimeHandlers } from '../time/timeHandlers';
import { closestMeasure, planTimeWrite } from '../time/timeWriteBack';
import type { TimeStore } from '../time/TimeStore';
import type { Command, Platform } from '../platform/Platform';
import { OFFICIAL_RATES, OFFICIAL_RATES_AS_OF } from '../pricing/officialRates';
import { AdoClient, AdoError } from '../services/AdoClient';
import { readApmYmlTargets } from '../services/apmYml';
import type { TrackerRegistry } from '../trackers/TrackerRegistry';
import {
  TokenUnavailableError,
  type ConnectionStore,
} from '../services/ConnectionStore';
import {
  organizationOf,
  prAvailability,
  prDescription,
  prTitle,
  prWebUrl,
  targetBranch,
} from '../services/azureRepos';
import { GitAuthError, type GitClient } from '../services/GitClient';
import type { RepoRegistry } from '../services/RepoRegistry';
import { inspectRepo } from '../services/repoInspect';
import {
  planSteps,
  type ExtraRestore,
  type SetupPlan,
  type SetupRunner,
} from '../services/SetupRunner';
import type { TaskStore } from '../services/TaskStore';
import type { TerminalManager } from '../services/TerminalManager';
import { planStartUpdate } from '../services/workItemStart';
import type { CopilotFileTailer } from '../usage/CopilotFileTailer';
import { usageCsv } from '../usage/csv';
import type { SettingsStore } from '../usage/SettingsStore';
import { NoopTelemetry, type Telemetry } from '../telemetry/AppInsightsClient';
import { changedKeys } from '../telemetry/helpers';
import { telemetryEnv } from '../usage/telemetryEnv';
import {
  claudeResult,
  PR_STYLE_FILE,
  PR_SUMMARY_ENV,
  PR_SUMMARY_TIMEOUT_MS,
  prSummaryFlags,
  prSummaryPrompt,
  runWithInput,
  tidySummary,
  userRequests,
} from '../services/prSummary';
import type { UsageReceiver } from '../usage/UsageReceiver';
import type { UsageStore } from '../usage/UsageStore';
import type { ColorScheme, ThemeChoice } from '../../shared/theme';
import { colorFgBg } from '../services/claudeTheme';
import type { TerminalFailures } from '../services/TerminalFailures';
import { removeWorkspace, WorktreeCleanup } from '../services/worktreeCleanup';
import type { TimeBooking } from '../../shared/time';
import { errorMessage } from '../../shared/errors';
import { OFFICIAL_USD_TO_EUR } from '../../shared/usage';

export type Services = {
  /** What needs the developer's attention (main); absent in tests. */
  attention?: Pick<AttentionHub, 'setView' | 'snapshot'>;
  /**
   * Extra env per terminal (main: the attention URL and token, OpenCode's plugin, and for agent tabs the task's
   * `shellie run` link). `runNames`: the names agents are told about, only when the repo has a stored secret. `denyPaths`: the untracked
   * secret files an agent tab must not read (relative to its folder, absolute for another repo's worktree).
   */
  terminalEnv?: (
    def: TerminalDef,
    ctx: { taskId: string; runNames?: string[]; denyPaths?: string[] },
  ) => Record<string, string>;
  /** `shellie run` for agents (main); handlers give it the task's tabs, config and leak watch. Absent in most tests. */
  runs?: Pick<
    RunHub,
    'attach' | 'names' | 'data' | 'exit' | 'tabGone' | 'pendingRuns' | 'approve'
  >;
  store: TaskStore;
  git: GitClient;
  platform: Platform;
  repos: RepoRegistry;
  connections: ConnectionStore;
  secrets: SecretStore;
  trackers: TrackerRegistry;
  openExternal: (url: string) => Promise<void>;
  /** Shows a file in Finder or Explorer (main uses shell.showItemInFolder). */
  revealFile?: (absPath: string) => void;
  /** Opens a folder in Explorer or Finder; resolves to an error message, empty on success (shell.openPath). */
  openPath?: (absPath: string) => Promise<string>;
  /** Serves an HTML file in a Shellie tab (main: HtmlViews.grant); absent in tests, where opening one fails. */
  grantView?: (realFile: string) => string;
  /** Owned by main so it can stop on quit; handlers create their own when absent (tests). */
  docsWatcher?: DocsWatcher;
  /** Watches worktrees' git dirs for the Changes page; owned by main so it stops on quit. */
  gitDirWatcher?: GitDirWatcher;
  /** Where `review/<taskId>.json` files live (main: `<userData>/review`); defaults to `<usageDir>/review`. */
  reviewDir?: string;
  terminals: TerminalManager;
  runner: SetupRunner;
  loadConfig: (repoPath: string) => Promise<ShellieConfig>;
  pickFolder: () => Promise<string | null>;
  launch: (cmd: Command) => Promise<void>;
  /** Runs an agent probe with a timeout; defaults to `execFile` (tests inject a fake). */
  runProbe?: ProbeRunner;
  /** Editor detection and launch; handlers build one from platform, settings and launch when absent (tests). */
  editors?: EditorService;
  broadcast: <K extends keyof Events>(event: K, payload: Events[K]) => void;
  usage: UsageStore;
  /** Measured active and agent time per task. */
  time: TimeStore;
  /** Counts active time for the task on screen (main); absent in tests. */
  tracker?: Pick<ActivityTracker, 'setTask' | 'flush'>;
  /** Sees what is typed into a terminal (main estimates OpenCode agent time from it). */
  onTerminalInput?: (id: string, data: string) => void;
  settings: SettingsStore;
  /** The colour scheme on screen (main: nativeTheme); absent in tests, where terminals get no COLORFGBG. */
  colorScheme?: () => ColorScheme;
  /**
   * The settings file Claude Code tabs pass with --settings to pick a theme that suits the scheme on screen
   * (main: claudeTheme.ts), null to leave the user's theme; absent in tests. `deny`: Claude Code permission rules
   * for the task's untracked secret files, merged into the same file.
   */
  claudeThemeSettings?: (deny?: string[]) => string | null;
  /** A Claude Code tab was started (or resumed) with the theme claudeThemeSettings gave. */
  claudeSpawned?: (terminalId: string) => void;
  /** Explains and logs agent tabs that fail to start (#109); absent in tests that don't care. */
  terminalFailures?: Pick<TerminalFailures, 'get' | 'clear' | 'spawnFailed'>;
  /** Sets nativeTheme.themeSource (main); absent in tests that don't care. */
  applyTheme?: (theme: ThemeChoice) => void;
  appVersion: string;
  /** Windows OS build number (e.g. 22631), null elsewhere. */
  windowsBuild?: number | null;
  receiver: Pick<UsageReceiver, 'start' | 'status'>;
  copilot: Pick<CopilotFileTailer, 'stats' | 'poll'>;
  usageDir: string;
  /** Home's snapshot builder; handlers build one in usageDir when absent (tests). */
  home?: HomeService;
  budget?: BudgetService;
  /** Settings › Cost server: the saved connection and the background sender; absent in tests that don't care. */
  costServer?: {
    store: Pick<CostServerStore, 'get' | 'set' | 'clear' | 'setBudgets'>;
    sender: Pick<CostSender, 'onConnected' | 'onDisconnected' | 'status'>;
    /** Defaults to the real client's `hello`. */
    hello?: typeof costServerHello;
    /** A fresh ledger pass, so stored records carry the saved email before the sender starts over. */
    ledgerPass?: () => Promise<void>;
  };
  /**
   * Registers the retry of finished tasks' leftover worktree folders (#115): main runs it shortly after launch and
   * every few minutes; tests capture it.
   */
  onCleanupRetry?: (retryAll: () => Promise<void>) => void;
  /** How long Finish waits after closing terminals so the last telemetry batch arrives (main 2500, tests 0). */
  finishFlushMs: number;
  /** App telemetry (usage, errors, timings); see docs/telemetry.md. Defaults to sending nothing. */
  telemetry?: Telemetry;
  /** Adds values telemetry must scrub from now on, such as the project and repo of a remote. */
  rememberSensitive?: (values: string[]) => void;
  /** Whether Claude Code saved a session with this id (default: looks in ~/.claude/projects). */
  claudeSessionExists?: (sessionId: string) => boolean;
  /** Where Claude Code saved a session id's transcript (default: looks in ~/.claude/projects). */
  claudeSessionFile?: (sessionId: string) => string | null;
  /** Runs a command with stdin and a time limit (default: runWithInput); tests stub Claude Code's print mode. */
  runAgent?: (
    cmd: Command,
    o: {
      cwd: string;
      input: string;
      timeoutMs: number;
      env?: Record<string, string>;
    },
  ) => Promise<string>;
  /** Whether Claude Code saved any session for this folder (default: looks in ~/.claude/projects). */
  claudeHasSessionsIn?: (cwd: string) => boolean;
  /** Finds and joins other repos' worktrees of a task; handlers build one from these services when absent (tests). */
  workspaces?: WorkspaceDetector;
  /** Windows auto-update: the downloaded update and how to apply it. Absent in dev, on macOS and in tests. */
  /** The clock for Production bounds (default Date.now). */
  now?: () => number;
  /** Checks Production bounds every 30 s and on resume (main: setInterval, powerMonitor); absent: no expiry. */
  expiryTimers?: ExpiryTimers;
  /** Stops the task's `shellie run` processes (RunHub.stopForTask) when Production ends or at Finish; `reason` is what the agent reads. */
  stopRuns?: (taskId: string, reason?: string) => void;
  update?: {
    pending(): PendingUpdate | null;
    /** Quits and starts the update; false when none is downloaded. */
    install(): boolean;
    /** macOS packaged build outside /Applications (it cannot update from there). */
    needsMove(): boolean;
    /** Moves the app to /Applications; false on refusal or error. */
    moveToApplications(): boolean;
  };
  /** Home's What's new card after an update (#126). Absent in dev and in tests. */
  whatsNew?: { get(): Promise<WhatsNew | null> };
};

/** The task's open periods with a new one starting now (reopen). A task from before time tracking keeps creation to finish as its first. */
function withOpenPeriod(task: Task): Task['openPeriods'] {
  const now = new Date().toISOString();
  const before =
    task.openPeriods.length === 0
      ? [{ start: task.createdAt, end: task.finishedAt ?? now }]
      : withPeriodClosed(task, now);
  return [...before, { start: now, end: null }];
}

/** The task's open periods with the last one ended at `end`, when it is still open. */
function withPeriodClosed(task: Task, end: string): Task['openPeriods'] {
  return task.openPeriods.map((p, i, all) =>
    i === all.length - 1 && p.end === null ? { ...p, end } : p,
  );
}

/** After a crash, tasks cannot still be mid-setup or mid-finish. Returns how many were changed. */
export async function recoverInterruptedTasks(
  store: TaskStore,
): Promise<number> {
  let changed = 0;
  await store.update((s) => {
    for (const t of s.tasks) {
      if (t.status === 'setting-up') {
        t.status = 'setup-failed';
        changed++;
      } else if (t.status === 'finishing') {
        t.status = 'ready';
        changed++;
      }
    }
  });
  return changed;
}

/** Finish refused a push: the branch adds a stored value. Names neither the value nor the secret. */
class LeakError extends Error {
  /** `found`: the branch adds a stored value; `unchecked`: Shellie could not look, so it does not push either. */
  constructor(readonly kind: 'found' | 'unchecked') {
    super(`${kind === 'found' ? LEAK_IN_BRANCH : LEAK_UNCHECKED}; not pushed`);
    this.name = 'LeakError';
  }
}

/** The repos a task works in: its home and the ones it joined. */
const taskRepoIds = (t: Task): string[] => [
  t.repoId,
  ...t.extraWorkspaces.map((w) => w.repoId),
];

/** Keys (repo:branch, repo:worktree) of tasks being created right now, across handler bundles. */
const creating = new Set<string>();

/** What Settings › Cost server says when `hello` fails. */
const COST_SERVER_ERRORS: Record<CostServerError['kind'], string> = {
  network: "Can't reach the server.",
  auth: 'The server refused the key.',
  rejected: "That address isn't a Shellie cost server.",
  server: 'The server had a problem. Try again later.',
};

/** Clears connection links that point at connections which no longer exist. Returns how many were cleared. */
export async function pruneDanglingConnectionLinks(
  repos: RepoRegistry,
  connections: ConnectionStore,
): Promise<number> {
  const valid = new Set(connections.list().map((c) => c.id));
  let cleared = 0;
  for (const r of repos.list()) {
    if (r.connectionId !== null && !valid.has(r.connectionId)) {
      await repos.setConnection(r.id, null);
      cleared++;
    }
  }
  return cleared;
}

export function createHandlers(s: Services): Handlers {
  const tel = s.telemetry ?? NoopTelemetry;
  let agentsCache: AgentsDetected | null = null;
  const sessionExists = s.claudeSessionExists ?? claudeSessionExists;
  const hasSessionsIn = s.claudeHasSessionsIn ?? claudeHasSessionsIn;
  const connectionsChanged = () =>
    s.broadcast('connections:changed', s.connections.list());
  const discovery = new DiscoveryHold();
  const statusRuns = new Map<string, Promise<SecretsStatus>>();
  const copyOf = (repoPath: string) =>
    s
      .loadConfig(repoPath)
      .then((c) => c.copy)
      .catch(() => [] as string[]);
  /** Open (not done) tasks' worktrees of a repo that still exist, with the task id. */
  const openWorktrees = (repoId: string) =>
    s.store.state.tasks
      .filter((t) => t.status !== 'done')
      .flatMap((t) =>
        activeWorkspaces(t)
          .filter((w) => w.repoId === repoId && existsSync(w.worktreePath))
          .map((w) => ({ taskId: t.id, worktreePath: w.worktreePath })),
      );
  const now = s.now ?? Date.now;
  /** The environment a new task gets from its repo: Development or Test, whatever the secrets file says. */
  const repoDefaultOf = (repoId: string): Environment => {
    const env = s.secrets.repoDefault(repoId);
    return isGuarded(env) ? 'development' : env;
  };
  /** When Production started now ends (the productionMinutes setting). */
  const productionUntil = () =>
    new Date(
      now() + s.settings.get().secrets.productionMinutes * 60_000,
    ).toISOString();
  const reposChanged = () => s.broadcast('repos:changed', s.repos.list());

  /** The values found in files git tracks in the repo's main checkout (leak watch does not alert on them). */
  const trackedValues = async (repoId: string) => {
    const r = await discoverSecrets(s.repos.get(repoId).path, {
      git: s.git,
      userSecretsDir: (id) => s.platform.userSecretsDir(id),
    });
    return new Set(r.found.filter((f) => f.tracked).map((f) => f.value));
  };
  const leakWatch = new LeakWatch({
    values: (repoIds) => s.secrets.allValues(repoIds),
    tracked: trackedValues,
    repoIdsOf: (taskId) => {
      const t = s.store.state.tasks.find((x) => x.id === taskId);
      return t ? taskRepoIds(t) : null;
    },
    onLeak: (id, state) => s.broadcast('terminal:leak', { id, ...state }),
    detected: (environment, paused) =>
      tel.event('secrets.leakDetected', {
        where: 'agent',
        environment,
        paused,
      }),
  });
  s.terminals.setOutputFilter((o, data, carry, final) =>
    leakWatch.filter(o, data, carry, final),
  );
  /** A `shellie run` tab's extra arguments (passed as arguments, never in its command line); not stored. */
  const runArgs = new Map<string, string[]>();
  /** Task and environment pairs whose leak in Changes was reported (telemetry), so a refresh does not repeat it. */
  const diffLeaksReported = new Set<string>();
  /** Matchers of every stored value per set of repos, for the Changes flags; dropped when secrets change. */
  const diffMatchers = new Map<string, LeakMatcher>();
  const diffMatcher = (task: Task) => {
    const ids = taskRepoIds(task);
    const key = ids.join('\0');
    let m = diffMatchers.get(key);
    if (!m) {
      m = LeakMatcher.from(s.secrets.allValues(ids));
      diffMatchers.set(key, m);
    }
    return m;
  };
  const secretsChanged = () => {
    leakWatch.invalidate();
    diffMatchers.clear();
    // A status being computed now may predate the change: the next call starts again.
    statusRuns.clear();
    s.broadcast('secrets:changed', null);
  };

  /**
   * Before a push: refuses when any commit it would send (`base..HEAD`) adds a stored value of any environment, and
   * when the branch cannot be checked (no base, git failing), unless Finish confirmed the push for this workspace.
   */
  const assertNoLeak = async (
    task: Task,
    w: { worktreePath: string; baseRef: string; baseSha: string | null },
    confirmed: boolean | undefined,
  ) => {
    if (confirmed) return;
    const values = s.secrets.allValues(taskRepoIds(task));
    if (values.length === 0) return;
    const matcher = LeakMatcher.from(values);
    if (matcher.empty) return;
    const base = await s.git.resolveBase(w.worktreePath, w).catch(() => null);
    if (!base) throw new LeakError('unchecked');
    let leak: Environment | null;
    try {
      leak = await branchLeaks(w.worktreePath, base, matcher);
    } catch {
      // Never with the error: git's output could hold the lines it was reading.
      throw new LeakError('unchecked');
    }
    if (leak !== null) {
      tel.event('secrets.leakDetected', { where: 'push', environment: leak });
      throw new LeakError('found');
    }
  };

  /** Work item types per connection, with icons, for the session. A failed load is not kept, so the next call retries. */
  const typesCache = new Map<string, Promise<WorkItemTypeMeta[]>>();
  const dropTypes = (connectionId: string) => typesCache.delete(connectionId);

  /** Runs an Azure DevOps call for a connection; a rejected token flips the status so Settings and the footer turn red. */
  const withConnection = async <T>(
    connectionId: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    let result: T;
    try {
      result = await run();
    } catch (e) {
      const status =
        (e instanceof AdoError && e.kind === 'unauthorized') ||
        e instanceof TokenUnavailableError
          ? 'unauthorized'
          : e instanceof AdoError && e.kind === 'unreachable'
            ? 'unreachable'
            : null;
      if (status) {
        try {
          await s.connections.setStatus(connectionId, status);
          connectionsChanged();
        } catch {
          // The connection may be gone; keep the original error.
        }
      }
      throw e;
    }
    // A working call proves the token is fine again; heal a stale red status.
    try {
      const current = s.connections.get(connectionId);
      if (current.status !== 'ok') {
        await s.connections.setStatus(connectionId, 'ok');
        connectionsChanged();
      }
    } catch {
      // Status bookkeeping must never fail a successful call.
    }
    return result;
  };

  const home =
    s.home ??
    new HomeService({
      file: path.join(s.usageDir, 'home.json'),
      connections: () => s.connections.list(),
      client: (id) => s.trackers.client(id),
      withConnection,
      onBuilt: (snapshot, info) => {
        s.broadcast('home:updated', snapshot);
        tel.event(
          'home.refreshed',
          { connections: info.connections, failed: info.failed },
          { durationMs: info.durationMs },
        );
        for (const f of info.failures)
          tel.event('home.failed', { kind: f.kind });
      },
    });

  const verifyConnection = async (
    connectionId: string,
  ): Promise<Connection> => {
    const c = s.connections.get(connectionId);
    const { user, uniqueName } = await withConnection(connectionId, () =>
      s.trackers.tracker(connectionId).probe(c.project),
    );
    const updated = await s.connections.setStatus(
      connectionId,
      'ok',
      user,
      uniqueName,
    );
    connectionsChanged();
    return updated;
  };

  const saveConnection = async (
    input: ConnectionInput,
  ): Promise<Connection> => {
    // Verify with a throwaway client before anything is written, so a bad token never lands on disk.
    s.connections.assertCanSave(input);
    const organizationUrl = s.connections.normalizeUrl(input.organizationUrl);
    const probe = new AdoClient(organizationUrl, async () => input.pat.trim());
    const { user, uniqueName } = await probe.verify(input.project.trim());
    const saved = await s.connections.save(input);
    s.trackers.invalidate(saved.id);
    dropTypes(saved.id);
    // The unique name is what "assign to me" writes on start; without it a new connection never assigns.
    const verified = await s.connections.setStatus(
      saved.id,
      'ok',
      user,
      uniqueName,
    );
    connectionsChanged();
    tel.event('connection.saved', {
      connections: s.connections.list().length,
    });
    // A tracker after all: the earlier No-tracker choice no longer holds.
    const current = s.settings.get();
    if (current.onboarding.tracker === 'none')
      await s.settings.save({
        ...current,
        onboarding: { ...current.onboarding, tracker: null },
      });
    return verified;
  };

  // Azure DevOps links, and Shellie's own GitHub release pages for the What's new card (#132); not all of GitHub.
  const releasesPath = `/${UPDATE_REPO}/releases`.toLowerCase();
  const allowedExternal = (url: string): boolean => {
    try {
      const u = new URL(url);
      // new URL() has already resolved any '..' segments in the path.
      const path = u.pathname.toLowerCase();
      return (
        u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        u.port === '' &&
        (u.hostname === 'dev.azure.com' ||
          u.hostname.endsWith('.visualstudio.com') ||
          (u.hostname === 'github.com' &&
            (path === releasesPath || path.startsWith(`${releasesPath}/`))))
      );
    } catch {
      return false;
    }
  };

  const setupStates = new Map<string, SetupState>();
  const inFlight = new Set<string>();

  /** Synchronous guard: call before the first await of an operation that changes a task's status. */
  const claim = (taskId: string, allowed: TaskStatus[], action: string) => {
    const status = taskById(taskId).status;
    if (!allowed.includes(status))
      throw new Error(`Cannot ${action} a task that is ${status}`);
    if (inFlight.has(taskId)) throw new Error('Task is busy');
    inFlight.add(taskId);
  };
  const release = (taskId: string) => {
    inFlight.delete(taskId);
  };

  const taskById = (id: string): Task => {
    const t = s.store.state.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`Unknown task ${id}`);
    return t;
  };

  const listTasks = async (): Promise<TaskView[]> =>
    Promise.all(
      s.store.state.tasks.map(async (t) => ({
        ...t,
        worktreeMissing:
          t.status !== 'done' &&
          t.status !== 'setting-up' &&
          // The task's working folder: the home unless Finish dropped it, then the repo that took over.
          !(await pathExists(activeHome(t).worktreePath)),
      })),
    );

  const tasksChanged = async () =>
    s.broadcast('tasks:changed', await listTasks());

  /** Changes one stored task (if it is still there) in a single store write, then tells the windows. */
  const mutateTask = async (id: string, change: (t: Task) => void) => {
    await s.store.update((st) => {
      const t = st.tasks.find((x) => x.id === id);
      if (t) change(t);
    });
    await tasksChanged();
  };

  const patchTask = (id: string, patch: Partial<Task>) =>
    mutateTask(id, (t) => Object.assign(t, patch));

  /** Finished tasks' worktree folders a process still held at Finish, retried until they are gone (#115). */
  const cleanup = new WorktreeCleanup({
    git: s.git,
    tasks: () => s.store.state.tasks,
    claim: (id) => {
      if (inFlight.has(id)) return false;
      inFlight.add(id);
      return true;
    },
    release,
    mutate: mutateTask,
    notice: (message) => s.broadcast('notice', { level: 'warn', message }),
    event: (name, props, m) => tel.event(name, props, m),
    discarded: {
      list: () => s.store.state.discardedCleanup,
      mutate: async (change) => {
        await s.store.update((st) => {
          st.discardedCleanup = change(st.discardedCleanup);
        });
      },
    },
  });
  s.onCleanupRetry?.(() => cleanup.retryAll());

  /**
   * Removes a workspace's worktree folder and, when `deleteBranch`, its branch. A failure does not fail Finish:
   * what is left comes back to be stored on the task and retried in the background (#115).
   */
  const removeForFinish = async (
    w: { id: string; worktreePath: string; branch: string },
    repoPath: string,
    deleteBranch: boolean,
  ): Promise<PendingCleanup | null> => {
    const left = await removeWorkspace(
      s.git,
      {
        workspaceId: w.id,
        repoPath,
        worktreePath: w.worktreePath,
        branch: deleteBranch ? w.branch : null,
      },
      { now: Date.now },
    );
    if (left) tel.event('cleanup.deferred', { code: left.code });
    return left;
  };

  /**
   * Where a workspace's pull request would go (the home's by default): its repo's connection and `origin`
   * parsed as Azure Repos. The PR links the work item only when that connection is in the work item's
   * organization.
   */
  const prContext = async (
    task: Task,
    w: WorkspaceView = taskWorkspaces(task)[0],
  ) => {
    const repo = s.repos.get(w.repoId);
    const connection = repo.connectionId
      ? s.connections.get(repo.connectionId)
      : null;
    const remotes = await s.git.remotes(repo.path).catch(() => [] as string[]);
    const remoteUrl = remotes.includes('origin')
      ? await s.git.remoteUrl(repo.path, 'origin')
      : null;
    const availability = prAvailability({
      remoteUrl,
      connectionOrgUrl: connection?.organizationUrl ?? null,
    });
    // ADO 404 messages and git push errors name them; they may differ from the connection and folder names.
    if (availability.target)
      s.rememberSensitive?.([
        availability.target.project,
        availability.target.repo,
      ]);
    const taskConnId = taskConnectionId(task, s.repos.list());
    let taskOrg: string | null = null;
    try {
      taskOrg = taskConnId
        ? organizationOf(s.connections.get(taskConnId).organizationUrl)
        : null;
    } catch {
      taskOrg = null;
    }
    return {
      connection,
      availability,
      target: targetBranch(w.baseRef, remotes),
      linksWorkItem:
        Boolean(task.workItem) &&
        connection !== null &&
        taskOrg !== null &&
        organizationOf(connection.organizationUrl) === taskOrg,
    };
  };

  /** The connection and project of the task's work item (its own, else its home repo's), null when there is none. */
  const adoTarget = (
    task: Task,
  ): { connectionId: string; project: string } | null => {
    const connectionId = taskConnectionId(task, s.repos.list());
    if (!connectionId) return null;
    try {
      return {
        connectionId,
        project: s.connections.get(connectionId).project,
      };
    } catch {
      return null;
    }
  };

  /** The fields of each work item type per connection, loaded on first use (reloaded with `refresh`). Call inside `withConnection`. */
  const typeFieldsCache = new Map<
    string,
    Awaited<ReturnType<AdoClient['workItemTypeFields']>>
  >();
  const typeFields = async (
    connectionId: string,
    project: string,
    refresh = false,
  ) => {
    const hit = typeFieldsCache.get(connectionId);
    if (hit && !refresh) return hit;
    const types = await s.trackers
      .client(connectionId)
      .workItemTypeFields(project);
    typeFieldsCache.set(connectionId, types);
    return types;
  };
  /** Booked time goes to Azure DevOps (Completed and Remaining Work) only when the user turned it on. */
  const writeTime = () => s.settings.get().writeTimeToAdo;
  const timeWrites = new Map<string, Promise<unknown>>();
  /**
   * Writes the difference between the task's booked hours and what was written before to its work item, one write
   * per task at a time. Records the outcome on the booking; returns the error message, null on success.
   */
  const syncTime = (taskId: string): Promise<string | null> => {
    const run = async (): Promise<string | null> => {
      const task = taskById(taskId);
      const booking = task.time;
      const workItem = task.workItem;
      const target = adoTarget(task);
      if (!booking || !workItem || !target)
        return 'This task has no booked time on a work item in a connected Azure DevOps project';
      const patchBooking = async (patch: Partial<TimeBooking>) => {
        const latest = taskById(taskId).time;
        if (latest) await patchTask(taskId, { time: { ...latest, ...patch } });
      };
      try {
        const hours = await withConnection(target.connectionId, async () => {
          const client = s.trackers.tracker(target.connectionId);
          const id = Number(workItem.id);
          const current = await client.itemEstimate(id);
          const type = (current.type || workItem.type).toLowerCase();
          const fieldsOf = async (refresh: boolean) =>
            (
              await typeFields(target.connectionId, target.project, refresh)
            ).find((t) => t.type.toLowerCase() === type)?.fields;
          // A type missing from the cache (added or renamed since) is looked up again once before writing nothing.
          const fields = (await fieldsOf(false)) ?? (await fieldsOf(true));
          const plan = planTimeWrite({
            bookedSeconds: booking.bookedSeconds,
            writtenHours: booking.writtenHours,
            current,
            fields: fields ?? [],
          });
          if (plan) await client.updateItemFields(id, plan.patch);
          return plan?.hours ?? booking.writtenHours;
        });
        await patchBooking({ writtenHours: hours, syncError: null });
        return null;
      } catch (e) {
        const message = errorMessage(e);
        await patchBooking({ syncError: message }).catch(() => undefined);
        return message;
      }
    };
    const next = (timeWrites.get(taskId) ?? Promise.resolve()).then(run);
    const tail = next.catch(() => undefined);
    timeWrites.set(taskId, tail);
    void tail.then(() => {
      if (timeWrites.get(taskId) === tail) timeWrites.delete(taskId);
    });
    return next;
  };

  /** Books the time chosen at Finish on a done task, then writes it to the work item when that is on. Never throws. */
  const bookTime = async (taskId: string, bookedSeconds: number) => {
    try {
      // The open interval holds up to a minute of unflushed active time: write it before measuring.
      s.tracker?.flush();
      await s.time.settled();
      const task = taskById(taskId);
      const m = s.time.summarize(task, s.settings.get().workHours, Date.now());
      await patchTask(taskId, {
        time: {
          bookedSeconds,
          measuredSeconds: m.activeSeconds,
          realisticSeconds: m.realisticSeconds,
          wallClockSeconds: m.wallClockSeconds,
          agentSeconds: m.agentSeconds,
          bookedAt: new Date().toISOString(),
          writtenHours: task.time?.writtenHours ?? 0,
          syncError: null,
        },
      });
      tel.event('time.booked', {
        closest: closestMeasure(bookedSeconds, {
          measured: m.activeSeconds,
          realistic: m.realisticSeconds,
          wallClock: m.wallClockSeconds,
        }),
      });
      if (!writeTime() || !task.workItem || !adoTarget(task)) return;
      const error = await syncTime(taskId);
      if (error)
        s.broadcast('notice', {
          level: 'warn',
          message: `Task finished, but the time could not be written to the work item: ${error}. Use Retry on the Done page.`,
        });
    } catch (e) {
      console.error('[time] booking on finish failed', e);
    }
  };

  /** The estimate baseline of a work item, from its live fields when a task starts on it. Never throws. */
  const recordBaseline = async (task: Task) => {
    const target = adoTarget(task);
    if (!task.workItem || !target) return;
    try {
      const e = await withConnection(target.connectionId, () =>
        s.trackers
          .tracker(target.connectionId)
          .itemEstimate(Number(task.workItem!.id)),
      );
      if (e.originalEstimate === null && e.remainingWork !== null)
        await s.time.recordBaseline(
          baselineKey(target.connectionId, task.workItem.id),
          e.remainingWork + (e.completedWork ?? 0),
        );
    } catch {
      // A missing baseline falls back to the live fields.
    }
  };

  s.usage.on('changed', (taskId) => s.broadcast('usage:changed', { taskId }));
  const receiverStatus = () => ({
    ...s.receiver.status,
    copilot: s.copilot.stats,
  });
  const costServerStatus = (): CostServerStatus =>
    s.costServer?.sender.status() ?? {
      connected: false,
      url: null,
      email: null,
      lastSentAt: null,
      waiting: 0,
      error: null,
      budgets: null,
    };

  /** Applies a change to the stored terminal list of a task (never from a stale snapshot). */
  const updateTerminals = async (
    id: string,
    change: (list: TerminalDef[]) => TerminalDef[],
  ) =>
    mutateTask(id, (t) => {
      t.terminals = change(t.terminals);
    });

  /** The workspace a terminal runs in; a removed or dropped one falls back to the active home. */
  const terminalWorkspace = (task: Task, def: TerminalDef) => {
    const w = taskWorkspaces(task).find((x) => x.id === def.workspaceId);
    return w && !w.dropped ? w : activeHome(task);
  };

  /**
   * Claude Code starts with the task in its system prompt and waits for the user. Resuming continues the tab's own
   * session, starts it again when the user never sent a message (nothing was saved), or continues the latest
   * session in the worktree for tabs from before session ids.
   */
  const terminalCommand = (
    task: Task,
    def: TerminalDef,
    resume = false,
    runNames?: string[],
    denyPaths: string[] = [],
  ): Command => {
    if (def.kind === 'claude') {
      const cwd = terminalWorkspace(task, def).worktreePath;
      const dirs = activeWorkspaces(task)
        // A folder removed by hand would make Claude refuse to start.
        .filter((w) => w.worktreePath !== cwd && existsSync(w.worktreePath))
        .flatMap((w) => ['--add-dir', w.worktreePath]);
      const themeFile =
        s.claudeThemeSettings?.(denyRulesFor(denyPaths)) ?? null;
      const theme = themeFile ? ['--settings', themeFile] : [];
      if (resume && !def.sessionId)
        return s.platform.claudeCommand(null, [
          '--continue',
          ...dirs,
          ...theme,
        ]);
      if (resume && def.sessionId && sessionExists(def.sessionId))
        return s.platform.claudeCommand(null, [
          '--resume',
          def.sessionId,
          ...dirs,
          ...theme,
        ]);
      return s.platform.claudeCommand(claudeContext(task, runNames), [
        ...(def.sessionId ? ['--session-id', def.sessionId] : []),
        ...dirs,
        ...theme,
      ]);
    }
    if (def.kind === 'run' && def.setupCommands)
      return s.platform.setupCommands(def.setupCommands);
    if (def.kind === 'run' && def.command)
      return s.platform.runCommand(def.command, runArgs.get(def.id));
    if (def.kind === 'copilot') return s.platform.copilotCommand();
    if (def.kind === 'opencode') return s.platform.opencodeCommand();
    return s.platform.interactiveShell();
  };

  /**
   * A non-agent tab's secrets for the task environment, from its own repo's store, and a `dotnet run` command with
   * the environment's launch profile. Nothing while that repo has no stored secrets, so tabs start as before.
   */
  const tabSecrets = async (
    task: Task,
    def: TerminalDef,
  ): Promise<{ env: Record<string, string>; def: TerminalDef }> => {
    const ws = terminalWorkspace(task, def);
    if (
      givenToFor(def, null) === null ||
      s.secrets.list({ repoId: ws.repoId }).length === 0
    )
      return { env: {}, def };
    const command =
      def.kind === 'run' && !def.setupCommands ? def.command : undefined;
    const repoPath =
      s.repos.list().find((r) => r.id === ws.repoId)?.path ?? ws.worktreePath;
    // An unreadable .shellie.yml only means the tab is not known as the tests tab.
    const testCommand = command
      ? await s
          .loadConfig(repoPath)
          .then((c) => testCommandFor(ws.worktreePath, c))
          .catch(() => null)
      : null;
    return {
      env: secretsEnv(
        s.secrets.valuesFor(ws.repoId, task.environment),
        givenToFor(def, testCommand),
        task.environment,
      ),
      def: command
        ? {
            ...def,
            command: withLaunchProfile(
              command,
              launchProfileArgs(command, ws.worktreePath, task.environment),
            ),
          }
        : def,
    };
  };

  /**
   * `runNames`: what an agent tab is told it can `shellie run` (only when its repo has a stored secret).
   * `denyPaths`: the untracked secret files it must not read.
   */
  type TabSecrets = Awaited<ReturnType<typeof tabSecrets>> & {
    runNames?: string[];
    denyPaths?: string[];
  };

  /** A worktree's deny targets, kept briefly so a task opening Claude and OpenCode walks each repo once. */
  const denyCache = new Map<
    string,
    { at: number; targets: Promise<string[]> }
  >();
  const DENY_CACHE_MS = 30_000;
  const worktreeDenyTargets = (worktreePath: string): Promise<string[]> => {
    const hit = denyCache.get(worktreePath);
    if (hit && now() - hit.at < DENY_CACHE_MS) return hit.targets;
    const targets = discoverSecrets(worktreePath, {
      git: s.git,
      userSecretsDir: (id) => s.platform.userSecretsDir(id),
    })
      .then((r) =>
        denyTargets(r).filter(
          // A file that is gone needs no rule; a user-secrets path is absolute already.
          (t) => t.endsWith('/**') || existsSync(path.resolve(worktreePath, t)),
        ),
      )
      // No rules rather than a failed tab, and not remembered: the next tab tries again. Nothing found is logged.
      .catch(() => {
        denyCache.delete(worktreePath);
        console.warn('[secrets] could not look for secret files to deny');
        return [] as string[];
      });
    denyCache.set(worktreePath, { at: now(), targets });
    return targets;
  };

  /**
   * The untracked secret files in the task's worktrees, for an agent tab: relative to the tab's own folder, absolute
   * for another repo's worktree (Claude's --add-dir) and for user secrets. Tracked config stays readable.
   */
  const agentDenyPaths = async (
    task: Task,
    def: TerminalDef,
  ): Promise<string[]> => {
    const own = terminalWorkspace(task, def);
    const lists = await Promise.all(
      activeWorkspaces(task).map(async (w) => {
        if (!existsSync(w.worktreePath)) return [];
        const targets = await worktreeDenyTargets(w.worktreePath);
        return w.id === own.id
          ? targets
          : targets.map((t) => inWorktree(w.worktreePath, t));
      }),
    );
    return [...new Set(lists.flat())];
  };

  /** The `shellie run` names for an agent tab, when its repo has a stored secret; undefined otherwise. */
  const agentRunNames = async (
    task: Task,
    def: TerminalDef,
  ): Promise<string[] | undefined> => {
    const ws = terminalWorkspace(task, def);
    if (!s.runs || s.secrets.list({ repoId: ws.repoId }).length === 0)
      return undefined;
    // An unreadable .shellie.yml only means the agent is not told the names.
    return s.runs.names(task.id, ws.worktreePath).catch(() => undefined);
  };

  /** The tab's secrets; a failure to read them is the tab's start failure. */
  const prepareTab = async (
    task: Task,
    def: TerminalDef,
  ): Promise<TabSecrets> => {
    s.terminalFailures?.clear(def.id);
    // Leak watch knows which values git tracks before the agent's first output.
    if (isAgentKind(def.kind)) {
      await leakWatch.prepare(task.id).catch(() => undefined);
      const runNames = await agentRunNames(task, def);
      const denyPaths = await agentDenyPaths(task, def);
      return {
        env: {},
        def,
        ...(runNames ? { runNames } : {}),
        ...(denyPaths.length > 0 ? { denyPaths } : {}),
      };
    }
    try {
      return await tabSecrets(task, def);
    } catch (e) {
      s.terminalFailures?.spawnFailed(def.id, def.kind, e);
      throw e;
    }
  };

  const spawnTerminal = async (
    task: Task,
    def: TerminalDef,
    resume = false,
    extraEnv: Record<string, string> = {},
  ) => startTerminal(task, def, await prepareTab(task, def), resume, extraEnv);

  /** The environment each tab was last spawned with, so a Restart after a switch builds its env again. */
  const spawnedEnv = new Map<string, Environment>();
  /**
   * Tabs spawned with a stored secret in their env. A tab keeps the value it got until it restarts, so it stays
   * tracked (expiry, switch, Finish, Restart) even after the secret is deleted or no longer given to it.
   */
  const spawnedWithSecrets = new Set<string>();
  const forgetSpawn = (id: string) => {
    spawnedEnv.delete(id);
    spawnedWithSecrets.delete(id);
  };

  /** Spawns at once (no await), so a caller holding a task claim keeps it only for the spawn itself. */
  const startTerminal = (
    task: Task,
    def: TerminalDef,
    secrets: TabSecrets,
    resume = false,
    extraEnv: Record<string, string> = {},
  ) => {
    const spawnEnvironment = task.environment;
    try {
      const cmd = terminalCommand(
        task,
        secrets.def,
        resume,
        secrets.runNames,
        secrets.denyPaths,
      );
      s.terminals.spawn({
        id: def.id,
        taskId: task.id,
        cwd: terminalWorkspace(task, def).worktreePath,
        command: cmd.command,
        args: cmd.args,
        // Agent tabs' output goes through leak watch before it is kept or shown.
        filtered: isAgentKind(def.kind),
        // Values go in as environment variables, never through a shell line, so they arrive as stored.
        env: {
          ...secrets.env,
          ...telemetryEnv(task.id, s.settings.get().receiverPort, s.usageDir),
          ...(s.colorScheme ? { COLORFGBG: colorFgBg(s.colorScheme()) } : {}),
          ...s.terminalEnv?.(def, {
            taskId: task.id,
            ...(secrets.runNames ? { runNames: secrets.runNames } : {}),
            ...(secrets.denyPaths ? { denyPaths: secrets.denyPaths } : {}),
          }),
          ...cmd.env,
          ...extraEnv,
        },
      });
    } catch (e) {
      s.terminalFailures?.spawnFailed(def.id, def.kind, e);
      throw e;
    }
    spawnedEnv.set(def.id, spawnEnvironment);
    const stored = new Set(
      s.secrets
        .list({ repoId: terminalWorkspace(task, def).repoId })
        .map((v) => v.name),
    );
    if (Object.keys(secrets.env).some((k) => stored.has(k)))
      spawnedWithSecrets.add(def.id);
    else spawnedWithSecrets.delete(def.id);
    if (def.kind === 'claude') s.claudeSpawned?.(def.id);
  };

  /** Every tab but an agent's can hold secrets. */
  /** The shared rule (inject.ts): a stored secret of the tab's repo is given to it. */
  const holdsSecrets = (task: Task, def: TerminalDef) =>
    holdsSecretsFor(
      def,
      s.secrets.list({ repoId: terminalWorkspace(task, def).repoId }),
    ) || spawnedWithSecrets.has(def.id);

  /** Stops a tab and tells its view it ended (a kill alone sends no exit). */
  const stopTab = async (id: string) => {
    await s.terminals.kill(id);
    forgetSpawn(id);
    leakWatch.forget(id);
    s.broadcast('terminal:exit', { id, exitCode: -1 });
  };

  /**
   * `shellie run`: the visible `agent · <name>` run tab, reused when it is there and stopped, spawned with the
   * task environment's secrets (tabSecrets picks Tests, Setup or Run from the command). Refused when the tab is
   * running, the task is busy or its environment is no longer the one the run was resolved (and approved) for.
   */
  const openRunTab = async (
    taskId: string,
    spec: RunSpec,
    attach: (terminalId: string) => boolean,
  ) => {
    const label = `agent · ${spec.name}`;
    const old = taskById(taskId).terminals.find(
      (d) =>
        d.kind === 'run' &&
        d.label === label &&
        (d.workspaceId ?? activeHome(taskById(taskId)).id) === spec.workspaceId,
    );
    if (old && s.terminals.isRunning(old.id))
      throw new Error(`${label} is already running`);
    const def: TerminalDef = {
      id: old?.id ?? randomUUID(),
      kind: 'run',
      label,
      workspaceId: spec.workspaceId,
      ...(spec.setupCommands
        ? { setupCommands: spec.setupCommands }
        : { command: spec.command ?? '' }),
    };
    if (old) {
      await s.terminals.kill(old.id);
      forgetSpawn(old.id);
      leakWatch.forget(old.id);
    }
    const prepared = await prepareTab(taskById(taskId), def);
    claim(taskId, ['ready'], 'run a command in');
    try {
      if (taskById(taskId).environment !== spec.environment)
        throw new Error("The task's environment changed; run it again");
      // The agent went away (or the run was stopped) while the tab was prepared: nothing spawns with the secrets.
      if (!attach(def.id)) return;
      runArgs.set(def.id, spec.args);
      startTerminal(taskById(taskId), def, prepared);
    } finally {
      release(taskId);
    }
    await updateTerminals(taskId, (list) =>
      old ? list.map((d) => (d.id === def.id ? def : d)) : [...list, def],
    );
    if (old) s.broadcast('terminal:reset', { id: def.id });
  };

  if (s.runs) {
    const runs = s.runs;
    runs.attach({
      task: (taskId) => {
        const t = s.store.state.tasks.find((x) => x.id === taskId);
        if (!t) return null;
        const home = activeHome(t);
        return {
          id: t.id,
          ready: t.status === 'ready',
          environment: t.environment,
          setupCommands: t.setup.commands,
          workspaces: [
            home,
            ...activeWorkspaces(t).filter((w) => w.id !== home.id),
          ].map((w) => ({
            id: w.id,
            worktreePath: w.worktreePath,
            repoPath:
              s.repos.list().find((r) => r.id === w.repoId)?.path ??
              w.worktreePath,
          })),
          agentTabs: t.terminals
            .filter((d) => isAgentKind(d.kind))
            .map((d) => d.id),
        };
      },
      config: (repoPath) => s.loadConfig(repoPath),
      testCommand: testCommandFor,
      openTab: openRunTab,
      kill: (id) => void stopTab(id),
      // The agent reads what comes back masked: it never sees a value, so no notice and no Production pause.
      filter: (o, data, carry, final) => leakWatch.mask(o, data, carry, final),
      pending: (list) => s.broadcast('runs:pending', list),
      started: (spec) =>
        tel.event('secrets.runStarted', {
          kind: spec.given === 'tests' ? 'test' : spec.given,
          environment: spec.environment,
        }),
    });
    s.terminals.on('data', (id, data) => runs.data(id, data));
    s.terminals.on('exit', (id, code) => runs.exit(id, code));
  }

  /**
   * After an environment change: each running tab that holds secrets is killed and spawned again with the new
   * environment's values (a fresh env, never the old spawn options). Agent tabs are never touched. The Setup tab
   * never runs again by itself: it is only stopped, when it held UAT or Production values.
   */
  const respawnSecretTabs = async (
    task: Task,
    left: Environment,
    why = `The task switched to ${ENVIRONMENT_LABEL[task.environment]}`,
  ) => {
    for (const def of task.terminals) {
      if (!holdsSecrets(task, def) || !s.terminals.isRunning(def.id)) continue;
      // A `shellie run` tab ends with its run: the agent asked for a run with the old environment's values.
      if (runArgs.has(def.id)) {
        s.runs?.tabGone(def.id, why);
        await stopTab(def.id);
        continue;
      }
      if (def.setupCommands) {
        if (isGuarded(left)) await stopTab(def.id);
        continue;
      }
      await s.terminals.kill(def.id);
      try {
        await spawnTerminal(task, def);
        s.broadcast('terminal:reset', { id: def.id });
      } catch (e) {
        // The old process is gone either way; the tab shows why it did not start and offers Restart.
        console.error('[secrets] could not restart a tab', e);
        s.broadcast('terminal:exit', { id: def.id, exitCode: -1 });
      }
    }
  };

  /** A finished task goes back to Development; the Done page and the PR keep the one it finished on. */
  const endEnvironment = (task: Task): Partial<Task> => ({
    environment: 'development',
    environmentUntil: null,
    finishedEnvironment: task.environment,
  });

  const titleOf = (t: Task) =>
    t.workItem ? `${t.workItem.id} ${t.workItem.title}` : t.name;

  /**
   * Production's bound passed: the task goes back to Development, its tabs that hold secrets start again with
   * Development values (the Setup tab stops), its `shellie run` processes stop, and the developer is told. A task
   * that is finishing is left to Finish, which ends it too.
   */
  const productionOver = (t: Task) =>
    t.environment === 'production' &&
    t.environmentUntil !== null &&
    Date.parse(t.environmentUntil) <= now();

  /** Puts the task back on Development, stops its `shellie run` processes and tells the developer. */
  const endProduction = async (task: Task) => {
    await patchTask(task.id, {
      environment: 'development',
      environmentUntil: null,
    });
    s.stopRuns?.(task.id, 'Production ended');
    tel.event('secrets.productionExpired');
    s.broadcast('notice', {
      level: 'info',
      message: `Production ended for ${titleOf(task)}`,
    });
  };

  const expireEnvironment = async (taskId: string) => {
    const task = s.store.state.tasks.find((t) => t.id === taskId);
    // A claimed task (setup, Finish, a switch) is left alone: the 30 s check comes back while it stays past its bound.
    if (!task || !productionOver(task) || inFlight.has(taskId)) return;
    inFlight.add(taskId);
    try {
      await endProduction(task);
      await respawnSecretTabs(taskById(taskId), 'production');
    } finally {
      release(taskId);
    }
  };

  /** Stops the running tabs that hold secrets (Finish on UAT or Production). */
  const stopSecretTabs = async (task: Task) => {
    for (const def of task.terminals)
      if (holdsSecrets(task, def) && s.terminals.isRunning(def.id))
        await stopTab(def.id);
  };

  const initialTerminals = (task: Task): TerminalDef[] => {
    const defs: TerminalDef[] = [];
    if (task.setup.startClaude)
      defs.push({
        id: randomUUID(),
        kind: 'claude',
        label: 'Claude Code',
        sessionId: randomUUID(),
      });
    if (task.setup.openCopilot)
      defs.push({ id: randomUUID(), kind: 'copilot', label: 'Copilot CLI' });
    if (task.setup.openOpencode)
      defs.push({ id: randomUUID(), kind: 'opencode', label: 'OpenCode' });
    if (task.setup.openShell)
      defs.push({
        id: randomUUID(),
        kind: 'shell',
        label: s.platform.shellLabel,
      });
    return defs;
  };

  /** The Setup tab, last in the row, running the task's setup commands. */
  const setupTerminal = (commands: string[]): TerminalDef => ({
    id: randomUUID(),
    kind: 'run',
    label: 'Setup',
    setupCommands: commands,
  });

  /** A task's tabs without its Setup tab: setup commands never run again by themselves. */
  const withoutSetupTab = (defs: TerminalDef[]) =>
    defs.filter((d) => !d.setupCommands);

  /** apm targets: the harness of each tab, in order, once. */
  const apmTargetsFor = (defs: TerminalDef[]): string[] => [
    ...new Set(
      defs.flatMap((d) =>
        d.kind === 'claude' || d.kind === 'copilot' || d.kind === 'opencode'
          ? [d.kind]
          : [],
      ),
    ),
  ];

  /**
   * The tab targets narrowed to those the repo's apm.yml declares (#135): APM writes the packages' agent files
   * unchanged, so a target the package was not written for can leave files its harness refuses to start with.
   */
  const apmTargetsInApmYml = async (repoPath: string, targets: string[]) => {
    const declared = await readApmYmlTargets(repoPath);
    if (!declared) return targets;
    const kept = targets.filter((t) => declared.includes(t));
    const dropped = targets.filter((t) => !declared.includes(t));
    if (dropped.length > 0)
      console.info(
        kept.length > 0
          ? `[apm] skipping ${dropped.join(', ')}: apm.yml targets [${declared.join(', ')}]`
          : `[apm] apm.yml targets [${declared.join(', ')}] match no open tab`,
      );
    return kept;
  };

  /**
   * The tabs a reopened task gets back: those it had at Finish, or for tasks finished before that was kept, the
   * ones setup opens. A Claude tab without a session id continues the folder's latest session when there is one.
   */
  const restoredTerminals = (task: Task): TerminalDef[] => {
    const defs =
      task.closedTerminals.length > 0
        ? withoutSetupTab(task.closedTerminals)
        : initialTerminals(task).map((d): TerminalDef => {
            const { sessionId: _, ...rest } = d as TerminalDef;
            return rest;
          });
    return defs.map((d) =>
      d.kind === 'claude' &&
      !d.sessionId &&
      !hasSessionsIn(activeHome(task).worktreePath)
        ? { ...d, sessionId: randomUUID() }
        : d,
    );
  };

  /** Starts a reopened task's tabs: Claude resumes, the rest start as before; running ones are left alone. */
  const startRestored = async (task: Task, defs: TerminalDef[]) => {
    for (const def of defs) {
      if (s.terminals.isRunning(def.id)) continue;
      if (s.terminals.has(def.id)) void s.terminals.kill(def.id);
      await spawnTerminal({ ...task, terminals: defs }, def, true);
      tel.event('terminal.opened', { kind: def.kind, initial: true });
    }
  };

  const applySetupEvent = (state: SetupState, e: SetupEvent) => {
    if (e.type === 'log') state.log.push(e.line);
    else if (e.type === 'step') {
      const step = state.steps[e.index];
      if (step) {
        step.status = e.status;
        step.detail = e.detail ?? step.detail;
        step.ms = e.ms ?? step.ms;
        if (e.status === 'failed' && e.auth) step.auth = e.auth;
        else delete step.auth;
      }
    } else {
      state.finished = true;
      state.ok = e.ok;
      state.failedStep = e.failedStep ?? null;
    }
  };

  /** The other repos a reopen makes again, each with its own .shellie.yml copies and setup commands. */
  const extraRestores = async (task: Task): Promise<ExtraRestore[]> => {
    const out: ExtraRestore[] = [];
    for (const w of task.extraWorkspaces) {
      if (w.dropped || w.reopen === null) continue;
      const repo = s.repos.get(w.repoId);
      const config = await s.loadConfig(repo.path);
      out.push({
        workspaceId: w.id,
        repoId: repo.id,
        repoName: repo.name,
        repoPath: repo.path,
        worktreePath: w.worktreePath,
        branch: w.branch,
        from: w.reopen.from,
        copy: task.setup.copy ? config.copy : [],
        copyAgentConfig: task.setup.copy && config.copyAgentConfig !== false,
        commands: config.setup,
      });
    }
    return out;
  };

  /** Clears every workspace's reopen mark, in the same store write as `patch`. */
  const endReopen = (taskId: string, patch: Partial<Task>) =>
    mutateTask(taskId, (t) => {
      Object.assign(t, patch, { reopen: null });
      for (const w of t.extraWorkspaces) w.reopen = null;
    });

  /**
   * Where a reopened workspace's branch comes from: the local branch (null), else `origin/<branch>`, else the last
   * commit of its Finish summary, else its base: a branch that is gone for good starts again from there (#178).
   */
  const restoreSource = async (
    repoPath: string,
    ws: Pick<
      WorkspaceView,
      'id' | 'repoId' | 'branch' | 'summary' | 'baseSha' | 'baseRef'
    >,
  ): Promise<{
    from: string | null;
    via: 'branch' | 'origin' | 'commit' | 'base';
  }> => {
    if (await s.git.branchExists(repoPath, ws.branch))
      return { from: null, via: 'branch' };
    const remote = `origin/${ws.branch}`;
    await s.git.fetch(repoPath, remote).catch(() => false);
    const head = ws.summary?.commits[0]?.sha;
    if (await s.git.commitExists(repoPath, `refs/remotes/${remote}`))
      return { from: remote, via: 'origin' };
    if (head && (await s.git.commitExists(repoPath, head)))
      return { from: head, via: 'commit' };
    for (const base of [ws.baseSha, ws.baseRef])
      if (base && (await s.git.commitExists(repoPath, base)))
        return { from: base, via: 'base' };
    // The home keeps the message it had before #48; another repo's names that repo.
    const what =
      ws.id === HOME_ID
        ? `Branch ${ws.branch}`
        : `${s.repos.list().find((r) => r.id === ws.repoId)?.name ?? path.basename(repoPath)}: branch ${ws.branch}`;
    throw new Error(
      `${what} cannot be restored: it was deleted, is not on origin, and its base is gone too`,
    );
  };

  /** The work item for task.md; undefined when there is none or Azure DevOps does not answer in time, so setup goes on. */
  const WORK_ITEM_DETAILS_TIMEOUT_MS = 8_000;
  const workItemDetails = async (
    task: Task,
    repo: Repo,
  ): Promise<WorkItemDetails | undefined> => {
    const connectionId = taskConnectionId(task, [repo]);
    if (!task.workItem || !connectionId) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        s.trackers
          .tracker(s.connections.get(connectionId).id)
          .itemDetails(Number(task.workItem.id))
          .then((d) => (Object.keys(d.fields).length > 0 ? d : undefined)),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(
            () => resolve(undefined),
            WORK_ITEM_DETAILS_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  const buildPlan = async (task: Task): Promise<SetupPlan> => {
    const repo = s.repos.get(task.repoId);
    const config = await s.loadConfig(repo.path);
    const details = await workItemDetails(task, repo);
    const reopening = isReopening(task);
    const defs = reopening ? restoredTerminals(task) : initialTerminals(task);
    const hasApm =
      config.apm !== false &&
      (await pathExists(path.join(repo.path, 'apm.yml')));
    return {
      taskId: task.id,
      repoId: repo.id,
      repoPath: repo.path,
      worktreePath: task.worktreePath,
      branch: task.branch,
      baseRef: task.baseRef,
      copy: task.setup.copy ? config.copy : [],
      copyAgentConfig: task.setup.copy && config.copyAgentConfig !== false,
      commands: task.setup.commands,
      cloneNodeModules:
        Boolean(s.platform.cloneDir) &&
        task.setup.commands.some((c) => c.trim() === 'npm ci'),
      apmTargets: hasApm
        ? config.apm ||
          (await apmTargetsInApmYml(repo.path, apmTargetsFor(defs)))
        : [],
      taskMd: renderTaskMd(
        task,
        Object.fromEntries(
          taskWorkspaces(task).flatMap((w) => {
            try {
              return [[w.repoId, s.repos.get(w.repoId).path]];
            } catch {
              return [];
            }
          }),
        ),
        details,
      ),
      startTerminalsLabel:
        defs.length > 0 ? defs.map((d) => d.label).join(', ') : null,
      // A reopened task leaves its work item alone.
      updateWorkItem:
        !reopening &&
        Boolean(
          task.workItem &&
          taskConnectionId(task, [repo]) &&
          (repo.workItemOnStart.moveToInProgress ||
            repo.workItemOnStart.assignToMe),
        ),
      ...(task.reopen ? { restore: { from: task.reopen.from } } : {}),
      ...(reopening
        ? {
            // Only workspaces Reopen marked are made again; the home's mark is absent when dropped or kept.
            skipHome: task.reopen === null,
            extraRestores: await extraRestores(task),
          }
        : {}),
    };
  };

  /** Runs the setup. The caller must hold the in-flight claim; it is released before the final 'finished' event. */
  const runSetup = async (taskId: string, fromStep?: number): Promise<void> => {
    let state: SetupState | undefined;
    let finishedEvent: SetupEvent | null = null;
    const t0 = Date.now();
    let steps: ReturnType<typeof planSteps> = [];
    const report = (ok: boolean, failedStep: number | null) =>
      tel.event(
        'setup.finished',
        {
          ok,
          retry: fromStep !== undefined,
          failedStep:
            failedStep === null
              ? 'none'
              : (steps[failedStep]?.kind ?? 'unknown'),
        },
        { durationMs: Date.now() - t0, steps: steps.length },
      );
    try {
      const task = taskById(taskId);
      const plan = await buildPlan(task);
      steps = planSteps(plan);
      const current: SetupState = {
        steps: steps.map((def) => ({ def, status: 'todo' })),
        log: [],
        finished: false,
        ok: null,
        failedStep: null,
      };
      state = current;
      setupStates.set(taskId, current);
      const result = await s.runner.run(plan, {
        fromStep,
        onEvent: (e) => {
          applySetupEvent(current, e);
          if (e.type === 'step' && e.ms !== undefined)
            tel.metric(
              `setup.step.${steps[e.index]?.kind ?? 'unknown'}`,
              e.ms,
              {
                status: e.status,
              },
            );
          // Hold back 'finished' until the task status is persisted, so listeners never see a stale status.
          if (e.type === 'finished') finishedEvent = e;
          else s.broadcast('setup', e);
        },
        onBaseSha: async (baseSha) => {
          await patchTask(taskId, { baseSha });
        },
        startTerminals: async (commands) => {
          // The environment as it is now, not as it was when setup began: Production may have ended meanwhile.
          if (productionOver(taskById(taskId)))
            await endProduction(taskById(taskId));
          const live = taskById(taskId);
          const cur: Task = {
            ...task,
            environment: live.environment,
            environmentUntil: live.environmentUntil,
          };
          const setupTab = commands.length > 0 ? [setupTerminal(commands)] : [];
          if (isReopening(cur)) {
            const restored = restoredTerminals(cur);
            await startRestored(cur, restored);
            for (const def of setupTab) {
              await spawnTerminal({ ...cur, terminals: restored }, def);
              tel.event('terminal.opened', { kind: def.kind, initial: true });
            }
            await updateTerminals(taskId, () => [...restored, ...setupTab]);
            return;
          }
          const defs = [...initialTerminals(cur), ...setupTab];
          for (const def of defs) {
            await spawnTerminal({ ...cur, terminals: defs }, def);
            tel.event('terminal.opened', { kind: def.kind, initial: true });
          }
          await updateTerminals(taskId, (list) => [...list, ...defs]);
        },
        updateWorkItem: async () => {
          try {
            const repo = s.repos.get(task.repoId);
            const connection = s.connections.get(
              taskConnectionId(task, [repo])!,
            );
            const client = s.trackers.tracker(connection.id);
            const id = Number(task.workItem!.id);
            const current = await client.itemForStart(id);
            const states = await client.typeStates(
              connection.project,
              current.type,
            );
            // Connections saved before the unique name was stored have none; look it up once.
            let user = connection.userUniqueName;
            if (!user && repo.workItemOnStart.assignToMe)
              user = await verifyConnection(connection.id)
                .then((c) => c.userUniqueName)
                .catch(() => null);
            const plan = planStartUpdate(
              current,
              states,
              repo.workItemOnStart,
              user,
            );
            if (plan.state || plan.assignTo)
              await client.updateItem(id, {
                ...(plan.state ? { state: plan.state } : {}),
                ...(plan.assignTo ? { assignedTo: plan.assignTo } : {}),
              });
            tel.event('workitem.startUpdated', {
              moved: Boolean(plan.state),
              assigned: Boolean(plan.assignTo),
            });
            return { detail: plan.detail, warn: false };
          } catch (e) {
            tel.event('workitem.startUpdated', { failed: true });
            throw e;
          }
        },
      });
      if (result.ok && isReopening(task))
        await endReopen(taskId, {
          status: 'ready',
          finishedAt: null,
          closedTerminals: [],
        });
      else
        await patchTask(taskId, {
          status: result.ok ? 'ready' : 'setup-failed',
        });
      report(result.ok, result.ok ? null : current.failedStep);
    } catch (e) {
      const message = errorMessage(e);
      report(false, null);
      tel.exception(e, { source: 'setup' });
      s.broadcast('notice', {
        level: 'error',
        message: `Setup failed: ${message}`,
      });
      if (state) {
        state.finished = true;
        state.ok = false;
      }
      finishedEvent = { taskId, type: 'finished', ok: false };
      try {
        await patchTask(taskId, { status: 'setup-failed' });
      } catch {
        // the store itself is failing; nothing more we can persist
      }
    } finally {
      release(taskId);
    }
    if (finishedEvent) s.broadcast('setup', finishedEvent);
  };

  const startSetupInBackground = (taskId: string, fromStep?: number) => {
    void runSetup(taskId, fromStep);
  };

  const workspaces =
    s.workspaces ??
    new WorkspaceDetector({
      store: s.store,
      git: s.git,
      repos: s.repos,
      connections: () => s.connections.list(),
      projectsDir: () => claudeProjectsDir(),
      notice: (message) => s.broadcast('notice', { level: 'info', message }),
      event: (n, p) => tel.event(n, p),
    });

  const gitDirWatcher =
    s.gitDirWatcher ??
    new GitDirWatcher(
      (wt) => s.git.gitDir(wt),
      (target) => s.broadcast('review:changed', { taskId: target }),
      undefined,
      (target) => docsWatcher.stopTarget(target),
    );
  const sessionDocs = new SessionDocs({
    git: s.git,
    projectsDir: () => claudeProjectsDir(),
  });
  const docsWatcher =
    s.docsWatcher ??
    new DocsWatcher(
      (taskId, paths) => {
        sessionDocs.invalidate(parseDocsTarget(taskId).taskId);
        s.broadcast('docs:changed', { taskId, paths });
      },
      undefined,
      (taskId) => {
        gitDirWatcher.stopTarget(taskId);
        s.broadcast('docs:watchStopped', { taskId });
      },
    );
  const reviewStore = new ReviewStore(
    s.reviewDir ?? path.join(s.usageDir, 'review'),
    () =>
      s.broadcast('notice', {
        level: 'warn',
        message:
          'The review notes of a task could not be read and were started again',
      }),
  );
  const review = new ReviewService({
    git: s.git,
    store: reviewStore,
    repoName: (id) => s.repos.list().find((r) => r.id === id)?.name ?? id,
    collapseOf: async (wt) => (await s.loadConfig(wt)).reviewCollapse ?? [],
    leakMatcher: diffMatcher,
    onLeak: (task, environment) => {
      // Changes is read again on every file change: once per task and environment per launch.
      const key = `${task.id}\0${environment}`;
      if (diffLeaksReported.has(key)) return;
      diffLeaksReported.add(key);
      tel.event('secrets.leakDetected', { where: 'diff', environment });
    },
  });
  const editors =
    s.editors ??
    new EditorService({
      platform: s.platform,
      detect: () => detectEditors(systemDetectDeps()),
      scan: scanProject,
      prefs: () => s.settings.get().editor,
      savePrefs: async (editor) => {
        await s.settings.save({ ...s.settings.get(), editor });
      },
      launch: s.launch,
      event: (n, p) => tel.event(n, p),
    });

  /** What a workspace's branch did since its base; a summary must never block Finish, so a failure is null. */
  /** What the developer typed in the task's Claude Code sessions, oldest session first (#111). */
  const taskRequests = async (task: Task): Promise<string[]> => {
    const ids = [...task.closedTerminals, ...task.terminals]
      .filter((t) => t.kind === 'claude' && t.sessionId)
      .map((t) => t.sessionId!);
    const out: string[] = [];
    for (const id of new Set(ids)) {
      const file = (s.claudeSessionFile ?? ((x) => claudeSessionFile(x)))(id);
      if (!file) continue;
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      for (const r of userRequests(text.split('\n')))
        if (!out.includes(r)) out.push(r);
    }
    return out;
  };

  const summaryOf = (
    w: Pick<WorkspaceView, 'worktreePath' | 'baseRef' | 'baseSha' | 'branch'>,
  ) =>
    s.git
      .finishSummary(w.worktreePath, {
        baseRef: w.baseRef,
        baseSha: w.baseSha,
        branch: w.branch,
      })
      .catch(() => null);

  /** What the Finish page shows for one workspace; a folder removed by hand is `missing`, never an error. */
  const workspaceCheck = async (
    task: Task,
    w: WorkspaceView,
  ): Promise<WorkspaceCheck> => {
    const repoName =
      s.repos.list().find((r) => r.id === w.repoId)?.name ?? w.repoId;
    const [pr, exists] = await Promise.all([
      prContext(task, w).catch((e: unknown) => ({
        connection: null,
        availability: {
          available: false,
          reason: errorMessage(e),
          target: null,
        },
        target: null,
        linksWorkItem: false,
      })),
      // A folder an earlier failed cleanup left without its .git file counts as gone: git cannot read it (#115).
      pathExists(path.join(w.worktreePath, '.git')),
    ]);
    const base = {
      workspaceId: w.id,
      repoId: w.repoId,
      repoName,
      branch: w.branch,
      pr: {
        available: pr.availability.available,
        reason: pr.availability.reason,
        target: pr.availability.available ? pr.target : null,
        linksWorkItem: pr.linksWorkItem,
      },
    };
    if (!exists)
      return {
        ...base,
        baseKnown: true,
        missing: true,
        uncommitted: [],
        unpushed: 0,
        commits: 0,
      };
    const [summary, since] = await Promise.all([
      s.git.summary(w.worktreePath, w.baseRef),
      summaryOf(w),
    ]);
    const baseKnown = since?.baseKnown ?? false;
    return {
      ...base,
      missing: false,
      uncommitted: summary.files,
      unpushed: summary.ahead,
      commits: since && baseKnown ? since.commitCount : summary.ahead,
      baseKnown,
    };
  };

  /** Whether Finish may clean up a workspace: only one on the task's own branch. */
  const ownBranch = (task: Task, w: WorkspaceView) => w.branch === task.branch;

  /**
   * What Discard would lose in one workspace (#124). Git is asked in the repo, so a folder removed by hand still
   * counts its branch; a git failure counts nothing rather than blocking Discard.
   */
  const discardCheck = async (
    task: Task,
    w: WorkspaceView,
  ): Promise<DiscardWorkspaceCheck> => {
    const repo = s.repos.list().find((r) => r.id === w.repoId);
    const kept = !ownBranch(task, w);
    const missing = !(await pathExists(path.join(w.worktreePath, '.git')));
    const base: DiscardWorkspaceCheck = {
      workspaceId: w.id,
      repoName: repo?.name ?? w.repoId,
      worktreePath: w.worktreePath,
      branch: w.branch,
      kept,
      missing,
      commits: 0,
      unpushed: 0,
      uncommitted: 0,
    };
    if (kept || !repo) return base;
    const start =
      w.baseSha && (await s.git.commitExists(repo.path, w.baseSha))
        ? w.baseSha
        : await s.git.mergeBase(repo.path, w.baseRef, `refs/heads/${w.branch}`);
    const [commits, uncommitted] = await Promise.all([
      s.git
        .branchCommits(repo.path, w.branch, start)
        .catch(() => ({ commits: 0, unpushed: 0 })),
      missing
        ? 0
        : s.git
            .summary(w.worktreePath, w.baseRef)
            .then((x) => x.files.length)
            .catch(() => 0),
    ]);
    return { ...base, ...commits, uncommitted };
  };

  const discardChecks = async (task: Task): Promise<DiscardChecks> => {
    const workspaces = await Promise.all(
      activeWorkspaces(task).map((w) => discardCheck(task, w)),
    );
    const gone = workspaces.filter((w) => !w.kept);
    const sum = (f: (w: DiscardWorkspaceCheck) => number) =>
      gone.reduce((n, w) => n + f(w), 0);
    return {
      workspaces,
      runningTerminals: s.terminals.runningCount(task.id),
      commitsLost: sum((w) => w.unpushed),
      uncommitted: sum((w) => w.uncommitted),
      blank: sum((w) => w.commits + w.uncommitted) === 0,
    };
  };

  /** Each row's outcome of the last Finish with workspaces, so the page can show them after a failure. */
  const finishResults = new Map<string, FinishRowResult[]>();

  /** A summary taken before the push would say "local only" on the Done page. */
  const markPushed = (
    summary: TaskSummary | null,
    branch: string,
  ): TaskSummary | null =>
    summary ? { ...summary, pushed: true, upstream: `origin/${branch}` } : null;

  /** True when `origin/<branch>` already contains HEAD, so a retry does not push again. */
  const onOrigin = (summary: TaskSummary | null, branch: string) =>
    Boolean(summary?.pushed && summary.upstream === `origin/${branch}`);

  /** Pushes a workspace's branch unless `origin` already has it; returns the summary as it is after the push. */
  const pushIfNeeded = async (
    task: Task,
    w: WorkspaceView,
    summary: TaskSummary | null,
    confirmLeak: boolean | undefined,
  ) => {
    if (onOrigin(summary, w.branch)) return summary;
    await assertNoLeak(task, w, confirmLeak);
    await s.git.push(w.worktreePath, 'origin', w.branch);
    return markPushed(summary, w.branch);
  };

  /** Pushes a workspace's branch (unless already there) and finds its active PR, else creates a draft one. */
  const openPullRequest = async (
    task: Task,
    w: WorkspaceView,
    summary: TaskSummary | null,
    /** The "what changed and why" from the Finish page, put above the commits. */
    prSummary: string | undefined,
    confirmLeak: boolean | undefined,
  ): Promise<{
    ref: PullRequestRef;
    existed: boolean;
    summary: TaskSummary | null;
  }> => {
    const c = await prContext(task, w);
    if (!c.availability.available || !c.availability.target || !c.connection)
      throw new Error(
        c.availability.reason ?? 'pull requests are not available',
      );
    const connection = c.connection;
    const { project, repo: repoName } = c.availability.target;
    summary = await pushIfNeeded(task, w, summary, confirmLeak);
    const client = s.trackers.tracker(connection.id);
    const repositoryId = await client.repositoryId(project, repoName);
    const existing = await client.findActivePullRequest(
      project,
      repositoryId,
      w.branch,
    );
    const raw =
      existing ??
      (await client.createPullRequest(project, repositoryId, {
        source: w.branch,
        target: c.target,
        title: prTitle(task),
        description: prDescription({
          heading: task.workItem
            ? `${task.workItem.type} ${task.workItem.id}: ${task.workItem.title}`
            : task.name,
          commits: summary?.commits ?? [],
          commitCount: summary?.commitCount ?? 0,
          workItemUrl: c.linksWorkItem ? null : (task.workItem?.url ?? null),
          summary: prSummary,
          environment: task.environment,
        }),
        workItemId:
          task.workItem && c.linksWorkItem ? Number(task.workItem.id) : null,
      }));
    tel.event(existing ? 'pr.linked' : 'pr.created');
    return {
      existed: existing !== null,
      summary,
      ref: {
        id: raw.pullRequestId,
        url: prWebUrl(
          connection.organizationUrl,
          project,
          repoName,
          raw.pullRequestId,
        ),
        repositoryId,
        project,
        repo: repoName,
        status: raw.status,
        isDraft: raw.isDraft,
      },
    };
  };

  /** Sets a workspace's own fields: the task's flat ones for the home, else its entry in extraWorkspaces. */
  const setWorkspace = (
    t: Task,
    id: string,
    patch: {
      summary?: TaskSummary | null;
      pullRequest?: PullRequestRef;
      dropped?: boolean;
    },
  ) => {
    if (id === HOME_ID) {
      if (patch.summary !== undefined) t.summary = patch.summary;
      if (patch.pullRequest !== undefined) t.pullRequest = patch.pullRequest;
      if (patch.dropped !== undefined) t.homeDropped = patch.dropped;
      return;
    }
    const w = t.extraWorkspaces.find((x) => x.id === id);
    if (w) Object.assign(w, patch);
  };

  const patchWorkspace = (
    taskId: string,
    id: string,
    patch: Parameters<typeof setWorkspace>[2],
  ) => mutateTask(taskId, (t) => setWorkspace(t, id, patch));

  /** Closes the task's terminals (and its Docs watcher), keeping the tabs so Reopen can bring them back. */
  const closeTaskTerminals = async (taskId: string) => {
    docsWatcher.stopTask(taskId);
    gitDirWatcher.stopTask(taskId);
    await s.terminals.killAllForTask(taskId);
    for (const d of taskById(taskId).terminals) {
      forgetSpawn(d.id);
      leakWatch.forget(d.id);
    }
    await patchTask(taskId, {
      closedTerminals: taskById(taskId).terminals,
      terminals: [],
    });
  };

  /** The `task.finished` event of a Finish, single repo or per workspace. */
  const reportFinished = (
    task: Task,
    options: FinishOptions,
    counts: { workspaces: number; prs: number; dropped: number },
  ) =>
    tel.event(
      'task.finished',
      {
        removeWorktree: options.removeWorktree,
        deleteBranch: options.deleteBranch,
        closeTerminals: options.closeTerminals,
        workItem: task.workItem !== null && task.workItem !== undefined,
      },
      {
        ageHours: (Date.now() - Date.parse(task.createdAt)) / 3_600_000,
        ...counts,
      },
    );

  /**
   * What follows a successful Finish, single repo or per workspace, once per Finish: the time chosen on the Time
   * spent step is booked.
   */
  const afterFinish = async (taskId: string, options: FinishOptions) => {
    const booked = options.bookedSeconds;
    if (typeof booked === 'number' && Number.isFinite(booked) && booked >= 0)
      await bookTime(taskId, booked);
  };

  /**
   * Finish for a task with several repos: per workspace (home first) the summary, then its push or PR. Any
   * failure leaves the task ready with every worktree in place, and a retry skips what already succeeded
   * (pushed branches are not pushed again, an existing PR is linked). Then cleanup per workspace, with
   * dropped ones always removed. Workspaces whose folder is gone, or that the request does not name, are
   * left alone.
   */
  const finishWorkspaces = async (
    taskId: string,
    options: FinishOptions,
    wanted: NonNullable<FinishOptions['workspaces']>,
  ) => {
    claim(taskId, ['ready'], 'finish');
    // PRs the previous attempt of this Finish made or linked; a retry keeps those instead of looking again.
    const madeBefore = new Map(
      (finishResults.get(taskId) ?? [])
        .filter((r) => r.ok && r.pullRequest)
        .map((r) => [r.workspaceId, r.pullRequest!.id]),
    );
    finishResults.delete(taskId);
    try {
      const task = taskById(taskId);
      // A worktree on another branch (a long-lived `dev` joined by hand) is not the task's to remove.
      for (const r of wanted) {
        if (r.action !== 'drop') continue;
        const w = taskWorkspaces(task).find((x) => x.id === r.workspaceId);
        if (w && !ownBranch(task, w))
          throw new Error(
            `${s.repos.list().find((x) => x.id === w.repoId)?.name ?? w.repoId} is not on this task's branch (${w.branch}): it is kept as is`,
          );
      }
      await patchTask(taskId, { status: 'finishing' });
      type Row = {
        w: WorkspaceView;
        action: WorkspaceAction;
        repoName: string;
        repoPath: string;
        summary: TaskSummary | null;
        /** The developer confirmed pushing this workspace although its branch holds (or may hold) a secret. */
        confirmLeak: boolean;
      };
      const rows: Row[] = [];
      try {
        const actionOf = new Map(wanted.map((r) => [r.workspaceId, r.action]));
        const confirmed = new Set(
          wanted.filter((r) => r.confirmLeak).map((r) => r.workspaceId),
        );
        for (const w of activeWorkspaces(task)) {
          const action = actionOf.get(w.id);
          if (!action || !(await pathExists(w.worktreePath))) continue;
          const repo = s.repos.get(w.repoId);
          const summary = await summaryOf(w);
          rows.push({
            w,
            action,
            repoName: repo.name,
            repoPath: repo.path,
            summary,
            confirmLeak: confirmed.has(w.id),
          });
        }
        const failures: string[] = [];
        const results: FinishRowResult[] = [];
        for (const r of rows) {
          const result: FinishRowResult = {
            workspaceId: r.w.id,
            action: r.action,
            ok: true,
            pushed: false,
            pullRequest: null,
            error: null,
          };
          results.push(result);
          const fail = (error: string, text: string) => {
            result.ok = false;
            result.error = error;
            failures.push(text);
          };
          if (r.action === 'drop') {
            // The page judged "no changes" when it loaded; Claude may have worked since. Never force-remove work.
            const files = await s.git
              .summary(r.w.worktreePath, r.w.baseRef)
              .then((x) => x.files)
              .catch(() => null);
            const changed =
              !r.summary ||
              !r.summary.baseKnown ||
              r.summary.commitCount > 0 ||
              files === null ||
              files.length > 0;
            if (changed) {
              const error = `${r.repoName} has changes now; reload Finish`;
              fail(error, `Not removed: ${error}`);
            }
          } else if (r.action === 'push') {
            try {
              r.summary = await pushIfNeeded(
                task,
                r.w,
                r.summary,
                r.confirmLeak,
              );
              result.pushed = true;
            } catch (e) {
              const message = errorMessage(e);
              if (e instanceof LeakError) result.leak = e.kind;
              else tel.event('pr.failed', { kind: 'git' });
              if (e instanceof GitAuthError) result.auth = e.hint;
              fail(message, `Branch not pushed for ${r.repoName}: ${message}`);
            }
          } else if (r.action === 'pr') {
            try {
              const stored = r.w.pullRequest;
              if (stored && madeBefore.get(r.w.id) === stored.id) {
                // The attempt just before this retry made or linked it: keep it, even if completed or abandoned since.
                r.summary = await pushIfNeeded(
                  task,
                  r.w,
                  r.summary,
                  r.confirmLeak,
                );
                result.pullRequest = {
                  id: stored.id,
                  url: stored.url,
                  linked: true,
                };
              } else {
                const pr = await openPullRequest(
                  task,
                  r.w,
                  r.summary,
                  options.prSummaries?.[r.w.id],
                  r.confirmLeak,
                );
                r.summary = pr.summary;
                await patchWorkspace(taskId, r.w.id, { pullRequest: pr.ref });
                void s.openExternal(pr.ref.url).catch(() => undefined);
                result.pullRequest = {
                  id: pr.ref.id,
                  url: pr.ref.url,
                  linked: pr.existed,
                };
              }
              result.pushed = true;
            } catch (e) {
              const message = errorMessage(e);
              if (e instanceof LeakError) result.leak = e.kind;
              else
                tel.event('pr.failed', {
                  kind: e instanceof AdoError ? e.kind : 'git',
                });
              if (e instanceof GitAuthError) result.auth = e.hint;
              fail(
                message,
                `Pull request not created for ${r.repoName}: ${message}`,
              );
            }
          }
        }
        finishResults.set(taskId, results);
        if (failures.length > 0) throw new Error(failures.join('; '));

        // Summaries first: a cleanup that fails midway must not lose what the branches did.
        await s.store.update((st) => {
          const t = st.tasks.find((x) => x.id === taskId);
          if (!t) return;
          for (const r of rows)
            if (r.action !== 'drop')
              setWorkspace(t, r.w.id, { summary: r.summary });
        });

        const dropping = rows.some((r) => r.action === 'drop');
        // As for a single repo: removing a worktree closes the terminals, which would block it on Windows.
        const killTerminals =
          options.closeTerminals || options.removeWorktree || dropping;
        if (isGuarded(task.environment) && !killTerminals)
          await stopSecretTabs(taskById(taskId));
        if (killTerminals) await closeTaskTerminals(taskId);
        const pendingCleanup: PendingCleanup[] = [];
        for (const r of rows) {
          // Never cleaned up: neither its worktree nor its branch belongs to this task.
          if (!ownBranch(task, r.w)) continue;
          const drop = r.action === 'drop';
          if (options.removeWorktree || drop) {
            const left = await removeForFinish(
              r.w,
              r.repoPath,
              options.deleteBranch || drop,
            );
            if (left) pendingCleanup.push(left);
          } else if (options.deleteBranch) {
            // The folder stays, so git refuses: that refusal protects uncommitted work.
            await s.git.worktreePrune(r.repoPath);
            await s.git.deleteBranch(r.repoPath, r.w.branch);
          }
          if (drop) await patchWorkspace(taskId, r.w.id, { dropped: true });
        }
        const finishedAt = new Date().toISOString();
        await patchTask(taskId, {
          status: 'done',
          finishedAt,
          openPeriods: withPeriodClosed(taskById(taskId), finishedAt),
          ...endEnvironment(task),
          pendingCleanup,
        });
        s.stopRuns?.(taskId, 'The task was finished in Shellie');
        leakWatch.dropTask(taskId);
        reportFinished(task, options, {
          workspaces: rows.length,
          prs: rows.filter((r) => r.action === 'pr').length,
          dropped: rows.filter((r) => r.action === 'drop').length,
        });
        // A later Finish (after Reopen) is a new one, not a retry of this.
        finishResults.delete(taskId);
        await afterFinish(taskId, options);
      } catch (e) {
        if (taskById(taskId).status === 'finishing')
          await patchTask(taskId, { status: 'ready' });
        throw e;
      }
    } finally {
      release(taskId);
    }
  };

  if (s.expiryTimers)
    scheduleExpiry(
      () => s.store.state.tasks,
      now,
      expireEnvironment,
      s.expiryTimers,
    );

  return {
    ...createDocsHandlers({
      taskById,
      git: s.git,
      openFile: (ws, abs, line, col) =>
        editors.openFile(ws.repoId, ws.worktreePath, abs, line, col),
      openExternal: s.openExternal,
      openPath: s.openPath ?? (async () => ''),
      grantView:
        s.grantView ??
        (() => {
          throw new Error('HTML files cannot be shown here');
        }),
      revealFile: s.revealFile ?? (() => undefined),
      watcher: docsWatcher,
      session: sessionDocs,
      event: (n, p) => tel.event(n, p),
    }),
    ...createEditorHandlers({
      taskById,
      editors,
      showFolder: async (p) => {
        const error = await (s.openPath ?? (async () => ''))(p);
        if (error) throw new Error(`Could not open the folder: ${error}`);
      },
    }),
    ...createReviewHandlers({ taskById, review, docsWatcher, gitDirWatcher }),
    'attention:view': async (view) => s.attention?.setView(view),
    'attention:get': async () => s.attention?.snapshot() ?? {},
    ...createTimeHandlers({
      time: s.time,
      tasks: () => s.store.state.tasks,
      task: taskById,
      settings: () => s.settings.get(),
      connectionOf: (task) => taskConnectionId(task, s.repos.list()),
      tracker: s.tracker,
    }),
    'repos:list': async () => s.repos.list(),
    'repos:inspect': async (folder) => {
      const r = await inspectRepo(folder, {
        git: s.git,
        connections: s.connections.list(),
      });
      // One discovery: the count only (names and values stay here); a failure just shows nothing.
      const secretsFound = await discoverSecrets(folder, {
        git: s.git,
        userSecretsDir: (id) => s.platform.userSecretsDir(id),
      })
        .then(
          (d) =>
            new Set(d.found.filter((f) => f.secretLike).map((f) => f.name))
              .size,
        )
        .catch(() => 0);
      tel.event('repo.inspected', {
        remote: r.remote?.provider ?? 'none',
        linked: r.remote?.connectionId != null,
        lockfile: r.facts.lockfile ?? 'none',
        dotnet: r.facts.dotnet.length > 0,
        devScript: r.facts.devScript !== null,
        apm: r.facts.apm,
        existingConfig: r.facts.existing !== null,
        secrets: secretsFound > 0,
      });
      return { ...r, secretsFound };
    },
    'repos:add': async (folder, options) => {
      const linked = options?.connectionId
        ? s.connections.list().find((c) => c.id === options.connectionId)
        : undefined;
      // A new repo starts with its connection's on-start options; Settings stays the place to change them.
      const repo = await s.repos.add(folder, {
        ...options,
        workItemOnStart: linked?.workItemOnStart,
      });
      reposChanged();
      tel.event('repo.added', {
        repos: s.repos.list().length,
        wroteConfig: options?.writeConfig !== undefined,
      });
      return repo;
    },
    'repos:remove': async (id) => {
      await s.repos.remove(id);
      reposChanged();
      tel.event('repo.removed');
    },
    'repos:refresh': async (id) => {
      const repo = await s.repos.refresh(id);
      reposChanged();
      return repo;
    },
    'repos:pickFolder': () => s.pickFolder(),
    'agents:detect': async (force) => {
      if (!force && agentsCache) return agentsCache;
      const result = await detectAgents(s.platform, s.runProbe ?? runProbe);
      agentsCache = result;
      tel.event('agents.detected', {
        claude: result.agents.claude.found,
        copilot: result.agents.copilot.found,
        opencode: result.agents.opencode.found,
      });
      return result;
    },
    'repos:config': async (repoId) => {
      const config = await s.loadConfig(s.repos.get(repoId).path);
      // A repo kept in Shellie only (no file) starts from the base branch it was added with when that still exists,
      // else the detected default; refresh corrects the stored value.
      const repo = config.found
        ? s.repos.get(repoId)
        : await s.repos.refresh(repoId);
      return {
        config: config.found ? config : { ...config, base: repo.baseBranch },
        worktreeRoot: worktreeRoot(repo.path),
      };
    },

    'tasks:list': listTasks,
    'tasks:create': async (input) => {
      const repo = s.repos.get(input.repoId);
      if (
        input.environment !== undefined &&
        !EnvironmentSchema.safeParse(input.environment).success
      )
        throw new Error(`Unknown environment "${String(input.environment)}"`);
      if (
        input.environment &&
        isGuarded(input.environment) &&
        input.environmentConfirmed !== true
      )
        throw new Error(
          `Starting a task on ${ENVIRONMENT_LABEL[input.environment]} needs your confirm`,
        );
      const environment = input.environment ?? repoDefaultOf(repo.id);
      const branch = input.branch.trim();
      if (!(await s.git.validBranchName(repo.path, branch)))
        throw new Error(`"${branch}" is not a valid branch name`);
      if (await s.git.branchExists(repo.path, branch))
        throw new Error(`Branch ${branch} already exists in ${repo.name}`);
      if (!input.workItem && input.name.trim().length === 0)
        throw new Error('Give the task a name or a work item');
      if (input.workItem && input.workItem.title.trim().length === 0)
        throw new Error('Give the work item a title');
      const slug = taskSlug(input.workItem, input.name);
      const worktreePath = path.join(worktreeRoot(repo.path), slug);
      if (await pathExists(worktreePath))
        throw new Error(`Folder ${worktreePath} already exists`);
      const keys = [`${repo.id}:${branch}`, `${repo.id}:${worktreePath}`];
      if (
        keys.some((k) => creating.has(k)) ||
        s.store.state.tasks.some(
          (t) =>
            t.repoId === repo.id &&
            t.status !== 'done' &&
            (t.branch === branch || t.worktreePath === worktreePath),
        )
      )
        throw new Error(`Branch ${branch} is already being created`);
      for (const k of keys) creating.add(k);
      const createdAt = new Date().toISOString();
      const task: Task = {
        id: randomUUID(),
        repoId: repo.id,
        name: input.name.trim(),
        workItem: input.workItem,
        slug,
        branch,
        worktreePath,
        baseRef: input.baseRef,
        baseSha: null,
        status: 'setting-up',
        setup: {
          copy: input.copy,
          commands: input.commands,
          startClaude: input.startClaude,
          openShell: input.openShell,
          openCopilot: input.openCopilot ?? false,
          openOpencode: input.openOpencode ?? false,
        },
        terminals: [],
        createdAt,
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
        connectionId: repo.connectionId,
        mainCheckoutEdits: [],
        environment,
        environmentUntil:
          environment === 'production' ? productionUntil() : null,
        pendingCleanup: [],
        openPeriods: [{ start: createdAt, end: null }],
        time: null,
      };
      inFlight.add(task.id);
      try {
        await s.store.update((st) => {
          st.tasks.push(task);
        });
      } catch (e) {
        release(task.id);
        throw e;
      } finally {
        for (const k of keys) creating.delete(k);
      }
      startSetupInBackground(task.id);
      void recordBaseline(task);
      tel.event('task.created', {
        workItem: input.workItem !== null && input.workItem !== undefined,
        copy: input.copy,
        startClaude: input.startClaude,
        openShell: input.openShell,
        openCopilot: input.openCopilot ?? false,
        openOpencode: input.openOpencode ?? false,
        commands: input.commands.length,
      });
      await tasksChanged();
      return task;
    },
    'tasks:setupState': async (taskId) => setupStates.get(taskId) ?? null,
    'tasks:retrySetup': async (taskId) => {
      claim(taskId, ['setup-failed'], 'retry the setup of');
      const from = setupStates.get(taskId)?.failedStep ?? 0;
      try {
        await patchTask(taskId, { status: 'setting-up' });
      } catch (e) {
        release(taskId);
        throw e;
      }
      startSetupInBackground(taskId, from);
      tel.event('setup.retried');
    },
    'tasks:cancelSetup': async (taskId) => {
      claim(taskId, ['setup-failed'], 'cancel the setup of');
      try {
        const task = taskById(taskId);
        const repo = s.repos.get(task.repoId);
        // Windows will not remove a folder that a running process has as its cwd.
        docsWatcher.stopTask(taskId);
        gitDirWatcher.stopTask(taskId);
        await s.terminals.killAllForTask(taskId);
        if (isReopening(task)) {
          // A failed reopen goes back to Done; the task, its branches and its history stay. Only the worktrees
          // this reopen made are removed: a kept one stays as it was.
          const remade = [
            ...(task.reopen
              ? [{ repoPath: repo.path, worktreePath: task.worktreePath }]
              : []),
            ...task.extraWorkspaces
              .filter((w) => !w.dropped && w.reopen !== null)
              .map((w) => ({
                repoPath: s.repos.get(w.repoId).path,
                worktreePath: w.worktreePath,
              })),
          ];
          for (const r of remade) {
            if (await pathExists(r.worktreePath))
              await s.git.worktreeRemove(r.repoPath, r.worktreePath, true);
            await s.git.worktreePrune(r.repoPath);
          }
          setupStates.delete(taskId);
          await endReopen(taskId, {
            status: 'done',
            terminals: [],
            openPeriods: withPeriodClosed(task, new Date().toISOString()),
          });
          tel.event('task.reopenCancelled');
          return;
        }
        if (await pathExists(task.worktreePath))
          await s.git.worktreeRemove(repo.path, task.worktreePath, true);
        await s.git.worktreePrune(repo.path);
        if (await s.git.branchExists(repo.path, task.branch))
          await s.git.deleteBranch(repo.path, task.branch);
        setupStates.delete(taskId);
        await s.store.update((st) => {
          st.tasks = st.tasks.filter((t) => t.id !== taskId);
        });
        await tasksChanged();
        tel.event('setup.cancelled');
      } finally {
        release(taskId);
      }
    },
    'tasks:gitSummary': async (taskId, workspaceId) => {
      const w = workspaceById(taskById(taskId), workspaceId);
      return s.git.summary(w.worktreePath, w.baseRef);
    },
    'tasks:finishChecks': async (taskId) => {
      // A scan error must never keep the user from finishing.
      await workspaces.scan(taskId).catch(() => undefined);
      const task = taskById(taskId);
      const homeSummary = s.git
        .summary(task.worktreePath, task.baseRef)
        .catch(async (e: unknown) => {
          // What an earlier failed cleanup left (no .git file) has nothing git can lose; Finish deletes it (#115).
          if (!(await pathExists(path.join(task.worktreePath, '.git'))))
            return { files: [], ahead: 0 };
          throw e;
        });
      const [checks, home] = await Promise.all([
        Promise.all(activeWorkspaces(task).map((w) => workspaceCheck(task, w))),
        // The home's own fields, as before #48; with other repos in the task a missing home must not fail the page.
        task.extraWorkspaces.length === 0
          ? homeSummary
          : homeSummary.catch(() => ({ files: [], ahead: 0 })),
      ]);
      return {
        uncommitted: home.files,
        unpushed: home.ahead,
        runningTerminals: s.terminals.runningCount(taskId),
        workspaces: checks,
      };
    },
    'tasks:finishResults': async (taskId) => finishResults.get(taskId) ?? null,
    'tasks:retryCleanup': async (taskId) => {
      taskById(taskId);
      return cleanup.retryTask(taskId);
    },
    'tasks:prSummary': async (taskId, workspaceId) => {
      const task = taskById(taskId);
      const w = workspaceById(task, workspaceId);
      const started = Date.now();
      let style: string | null = null;
      const failed = (error: string, reason: string) => {
        tel.event(
          'pr.summary',
          { ok: false, reason, style: style !== null },
          { ms: Date.now() - started },
        );
        return { text: null, error };
      };
      try {
        const changes = await s.git.branchChanges(w.worktreePath, w);
        if (!changes)
          return failed('Where the branch started is unknown', 'no-base');
        style = await fs
          .readFile(path.join(w.worktreePath, PR_STYLE_FILE), 'utf8')
          .catch(() => null);
        // Secrets: a stored value in the diff or the requests is sent as [NAME], and Claude's Read is denied the
        // worktree's secret files, as in its tabs.
        const matcher = diffMatcher(task);
        const masked = (t: string) => matcher.mask(t, '', true).text;
        const prompt = masked(
          prSummaryPrompt({
            heading: task.workItem
              ? `${task.workItem.type} ${task.workItem.id}: ${task.workItem.title}`
              : task.name,
            ...changes,
            requests: await taskRequests(task),
            style,
          }),
        );
        const deny = existsSync(w.worktreePath)
          ? await worktreeDenyTargets(w.worktreePath)
          : [];
        const settings =
          deny.length > 0
            ? (s.claudeThemeSettings?.(denyRulesFor(deny)) ?? null)
            : null;
        const out = await (s.runAgent ?? runWithInput)(
          s.platform.claudeCommand(null, [
            ...prSummaryFlags(),
            ...(settings ? ['--settings', settings] : []),
          ]),
          {
            cwd: w.worktreePath,
            input: prompt,
            timeoutMs: PR_SUMMARY_TIMEOUT_MS,
            // The run's cost is the task's, like its Claude Code tabs.
            env: {
              ...telemetryEnv(
                task.id,
                s.settings.get().receiverPort,
                s.usageDir,
                'pr-summary',
              ),
              ...PR_SUMMARY_ENV,
            },
          },
        );
        const tidied = tidySummary(claudeResult(out));
        const text = tidied ? masked(tidied) : tidied;
        if (!text) return failed('Claude Code wrote nothing', 'empty');
        tel.event(
          'pr.summary',
          { ok: true, style: style !== null },
          { ms: Date.now() - started, chars: text.length },
        );
        return { text, error: null };
      } catch (e) {
        const error = errorMessage(e);
        return failed(
          error,
          /not found/.test(error)
            ? 'no-agent'
            : /timed out/.test(error)
              ? 'timeout'
              : 'failed',
        );
      }
    },
    'tasks:reopen': async (taskId) => {
      claim(taskId, ['done'], 'reopen');
      let setup = false;
      try {
        const task = taskById(taskId);
        const active = activeWorkspaces(task);
        if (active.length === 0)
          throw new Error(
            'Nothing to reopen: every repo of this task was removed without changes',
          );
        // Per workspace still in the task: kept (folder there) or to be made again, and from where.
        const restores = new Map<string, { from: string | null }>();
        // Folders an earlier cleanup could not finish (#87): no .git any more, so not a worktree.
        const leftovers: { repoPath: string; path: string }[] = [];
        let via: string | null = null;
        for (const w of active) {
          const repoPath = () => s.repos.get(w.repoId).path;
          if (
            (await pathExists(w.worktreePath)) &&
            !(await pathExists(path.join(w.worktreePath, '.git')))
          )
            leftovers.push({ repoPath: repoPath(), path: w.worktreePath });
          else if (await pathExists(w.worktreePath)) {
            // A kept worktree is used as it is; the home's branch must still be there, as before #48.
            if (
              w.id === HOME_ID &&
              !(await s.git.branchExists(repoPath(), w.branch))
            )
              throw new Error(
                `${w.worktreePath} exists but branch ${w.branch} is gone`,
              );
            continue;
          }
          const source = await restoreSource(repoPath(), w);
          restores.set(w.id, { from: source.from });
          via ??= source.via;
        }
        // Only once every branch can be restored: the leftovers go, so the worktrees can be made again.
        for (const l of leftovers)
          await s.git.worktreeRemove(l.repoPath, l.path, true).catch((e) => {
            throw new Error(
              `${l.path} is left over from an earlier cleanup and could not be deleted (${errorMessage(e)}). Delete it and reopen again.`,
            );
          });
        // The task takes its folders back (#115): the background cleanup must never remove them now.
        if (task.pendingCleanup.length > 0)
          await patchTask(taskId, { pendingCleanup: [] });
        if (restores.size === 0) {
          // Every worktree was kept: back to ready with the tabs it had.
          const defs =
            task.terminals.length > 0
              ? withoutSetupTab(task.terminals)
              : restoredTerminals(task);
          await patchTask(taskId, {
            status: 'ready',
            finishedAt: null,
            terminals: defs,
            closedTerminals: [],
            openPeriods: withOpenPeriod(task),
          });
          await startRestored(taskById(taskId), defs);
          tel.event('task.reopened', { from: 'folder' });
          return { setup: false };
        }
        await mutateTask(taskId, (t) => {
          t.status = 'setting-up';
          t.terminals = [];
          t.openPeriods = withOpenPeriod(task);
          t.reopen = restores.get(HOME_ID) ?? null;
          for (const w of t.extraWorkspaces)
            w.reopen = restores.get(w.id) ?? null;
        });
        setup = true;
        startSetupInBackground(taskId);
        tel.event('task.reopened', { from: via ?? 'branch' });
        return { setup: true };
      } finally {
        // The setup releases the task when it ends.
        if (!setup) release(taskId);
      }
    },
    'tasks:finish': async (taskId, options) => {
      if (options.workspaces)
        return finishWorkspaces(taskId, options, options.workspaces);
      claim(taskId, ['ready'], 'finish');
      try {
        const task = taskById(taskId);
        const repo = s.repos.get(task.repoId);
        await patchTask(taskId, { status: 'finishing' });
        // Record what the branch did while the worktree still exists; a summary must never block Finish.
        let summary: TaskSummary | null = null;
        if (await pathExists(task.worktreePath))
          summary = await summaryOf(task);
        // Push and open the PR before any cleanup: a failure leaves the task ready with its worktree.
        if (options.createPullRequest) {
          let pullRequest: PullRequestRef;
          try {
            const c = await prContext(task);
            if (
              !c.availability.available ||
              !c.availability.target ||
              !c.connection
            )
              throw new Error(
                c.availability.reason ?? 'pull requests are not available',
              );
            const connection = c.connection;
            const { project, repo: repoName } = c.availability.target;
            await assertNoLeak(task, task, options.confirmLeak);
            await s.git.push(task.worktreePath, 'origin', task.branch);
            // The summary was taken before this push; the Done page would otherwise say "local only".
            if (summary)
              summary = {
                ...summary,
                pushed: true,
                upstream: `origin/${task.branch}`,
              };
            const client = s.trackers.tracker(connection.id);
            const repositoryId = await client.repositoryId(project, repoName);
            const existing = await client.findActivePullRequest(
              project,
              repositoryId,
              task.branch,
            );
            const raw =
              existing ??
              (await client.createPullRequest(project, repositoryId, {
                source: task.branch,
                target: c.target,
                title: prTitle(task),
                description: prDescription({
                  heading: task.workItem
                    ? `${task.workItem.type} ${task.workItem.id}: ${task.workItem.title}`
                    : task.name,
                  commits: summary?.commits ?? [],
                  commitCount: summary?.commitCount ?? 0,
                  summary: options.prSummaries?.[HOME_ID],
                  environment: task.environment,
                }),
                workItemId: task.workItem ? Number(task.workItem.id) : null,
              }));
            pullRequest = {
              id: raw.pullRequestId,
              url: prWebUrl(
                connection.organizationUrl,
                project,
                repoName,
                raw.pullRequestId,
              ),
              repositoryId,
              project,
              repo: repoName,
              status: raw.status,
              isDraft: raw.isDraft,
            };
            await patchTask(taskId, { pullRequest });
            tel.event(existing ? 'pr.linked' : 'pr.created');
          } catch (e) {
            await patchTask(taskId, { status: 'ready' });
            const message = errorMessage(e);
            if (!(e instanceof LeakError))
              tel.event('pr.failed', {
                kind: e instanceof AdoError ? e.kind : 'git',
              });
            throw new Error(`Pull request not created: ${message}`);
          }
          void s.openExternal(pullRequest.url).catch(() => undefined);
        }
        // A terminal running in the folder blocks its removal on Windows (and a terminal without its
        // folder is useless), so removing the worktree closes the terminals even when that was unticked.
        const killTerminals = options.closeTerminals || options.removeWorktree;
        const pendingCleanup: PendingCleanup[] = [];
        try {
          // UAT and Production end at Finish: tabs holding those values stop even when terminals are kept.
          if (isGuarded(task.environment) && !killTerminals)
            await stopSecretTabs(taskById(taskId));
          if (killTerminals) await closeTaskTerminals(taskId);
          if (options.removeWorktree) {
            // A folder a process still holds is retried in the background; the task is done anyway (#115).
            const left = await removeForFinish(
              {
                id: HOME_ID,
                worktreePath: task.worktreePath,
                branch: task.branch,
              },
              repo.path,
              options.deleteBranch,
            );
            if (left) pendingCleanup.push(left);
          } else if (options.deleteBranch) {
            // A deleted folder leaves a stale registration that blocks branch deletion.
            // A folder that still exists keeps the refusal, which protects uncommitted work.
            await s.git.worktreePrune(repo.path);
            await s.git.deleteBranch(repo.path, task.branch);
          }
        } catch (e) {
          await patchTask(taskId, { status: 'ready' });
          throw e;
        }
        const finishedAt = new Date().toISOString();
        await patchTask(taskId, {
          status: 'done',
          finishedAt,
          summary,
          openPeriods: withPeriodClosed(taskById(taskId), finishedAt),
          ...endEnvironment(task),
          pendingCleanup,
        });
        s.stopRuns?.(taskId, 'The task was finished in Shellie');
        leakWatch.dropTask(taskId);
        reportFinished(task, options, {
          workspaces: 1,
          prs: options.createPullRequest ? 1 : 0,
          dropped: 0,
        });
        await afterFinish(taskId, options);
      } finally {
        release(taskId);
      }
    },
    'tasks:setEnvironment': async (taskId, env, confirmed) => {
      if (!EnvironmentSchema.safeParse(env).success)
        throw new Error(`Unknown environment "${String(env)}"`);
      if (isGuarded(env) && confirmed !== true)
        throw new Error(
          `Switching to ${ENVIRONMENT_LABEL[env]} needs your confirm`,
        );
      claim(taskId, ['ready'], 'switch the environment of');
      try {
        const left = taskById(taskId).environment;
        await patchTask(taskId, {
          environment: env,
          environmentUntil: env === 'production' ? productionUntil() : null,
        });
        if (left !== env) {
          tel.event('secrets.environmentSwitched', {
            from: left,
            to: env,
            confirmed: confirmed === true,
          });
          await respawnSecretTabs(taskById(taskId), left);
          // `shellie run` processes hold the values they started with.
          if (isGuarded(left))
            s.stopRuns?.(taskId, `${ENVIRONMENT_LABEL[left]} ended`);
        }
        return taskById(taskId);
      } finally {
        release(taskId);
      }
    },
    'tasks:discardChecks': async (taskId) => discardChecks(taskById(taskId)),
    'tasks:discard': async (taskId) => {
      claim(taskId, ['ready'], 'discard');
      try {
        const task = taskById(taskId);
        // For telemetry only: what was lost must never keep the task from going.
        const checks = await discardChecks(task).catch(() => null);
        // Windows will not remove a folder that a running process has as its cwd.
        docsWatcher.stopTask(taskId);
        gitDirWatcher.stopTask(taskId);
        await s.terminals.killAllForTask(taskId);
        // Secrets: `shellie run` processes end, and nothing about the task's tabs (or its plaintext matcher) is kept.
        s.stopRuns?.(taskId, 'The task was discarded');
        for (const d of task.terminals) {
          forgetSpawn(d.id);
          runArgs.delete(d.id);
          leakWatch.forget(d.id);
        }
        leakWatch.dropTask(taskId);
        // Every workspace on the task's branch goes, folder and branch, as at Finish; a held folder is
        // retried in the background (#115). One on another branch was joined by hand and stays.
        const left: DiscardedCleanup[] = [];
        const removed = activeWorkspaces(task).filter((w) =>
          ownBranch(task, w),
        );
        for (const w of removed) {
          const l = await removeForFinish(w, s.repos.get(w.repoId).path, true);
          if (l) left.push({ ...l, taskId });
        }
        await s.store.update((st) => {
          st.tasks = st.tasks.filter((t) => t.id !== taskId);
          st.discardedCleanup.push(...left);
        });
        setupStates.delete(taskId);
        finishResults.delete(taskId);
        // The AI usage stays: it was spent. The review notes have nothing left to point at.
        await reviewStore.remove(taskId).catch(() => undefined);
        await tasksChanged();
        tel.event(
          'task.discarded',
          { blank: checks?.blank ?? false },
          {
            commitsLost: checks?.commitsLost ?? 0,
            workspaces: removed.length,
            deferred: left.length,
            ageHours: (Date.now() - Date.parse(task.createdAt)) / 3_600_000,
          },
        );
      } finally {
        release(taskId);
      }
    },
    'tasks:environmentInfo': async (taskId) => {
      const task = taskById(taskId);
      const repoIds = [...new Set(activeWorkspaces(task).map((w) => w.repoId))];
      // A repo's own secret wins over an All repositories one of the same name.
      const byName = new Map<string, SecretView>();
      for (const repoId of repoIds)
        for (const v of s.secrets.list({ repoId }))
          if (!byName.has(v.name) || v.scope !== 'all') byName.set(v.name, v);
      const secrets = [...byName.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const tabs = task.terminals.filter(
        (d) =>
          holdsSecrets(task, d) &&
          !d.setupCommands &&
          s.terminals.isRunning(d.id),
      );
      const given = new Set(
        tabs.map((d) => givenToFor(d, null)).filter((g) => g !== null),
      );
      // Tests tabs are run tabs here; a secret given to Tests goes into a run tab of the test command.
      if (given.has('run')) given.add('tests');
      const per = <T>(f: (env: Environment) => T) =>
        Object.fromEntries(ENVIRONMENTS.map((e) => [e, f(e)])) as Record<
          Environment,
          T
        >;
      const keys = per((env) =>
        secrets
          .filter((v) => v.values[env] && v.givenTo.some((g) => given.has(g)))
          .map((v) => v.name),
      );
      return {
        values: per((env) => ({
          have: secrets.filter((v) => v.values[env]).length,
          of: secrets.length,
        })),
        tabs: tabs.map((d) => ({
          id: d.id,
          label: d.label,
          kind: d.kind === 'shell' ? ('shell' as const) : ('run' as const),
        })),
        keys,
        overrides: per((env) =>
          tabs.flatMap((d) => {
            if (d.kind !== 'run' || !d.command) return [];
            const profile = launchProfileFor(
              d.command,
              terminalWorkspace(task, d).worktreePath,
              env,
            );
            const names = profile
              ? keys[env].filter((n) => n in profile.vars)
              : [];
            return profile && names.length > 0
              ? [{ profile: profile.name, names }]
              : [];
          }),
        ),
        productionMinutes: s.settings.get().secrets.productionMinutes,
      } satisfies EnvironmentInfo;
    },
    'tasks:openInEditor': async (taskId, workspaceId) => {
      const ws = workspaceById(taskById(taskId), workspaceId);
      await editors.openFolder(ws.repoId, ws.worktreePath);
    },

    'terminals:open': async (taskId, def) => {
      // Claimed first, as before secrets: a task that is not ready (finishing, discarded) refuses at once.
      claim(taskId, ['ready'], 'open a terminal in');
      release(taskId);
      const full: TerminalDef = {
        id: randomUUID(),
        ...def,
        // A shell tab is named after the platform's shell (PowerShell, zsh), like the one setup opens.
        ...(def.kind === 'shell' ? { label: s.platform.shellLabel } : {}),
        ...(def.kind === 'claude' ? { sessionId: randomUUID() } : {}),
      };
      // The secrets env is prepared outside the claim (two opens at once both go through); it is spawned under a
      // second claim, and prepared again when the environment changed meanwhile (a switch, an expiry).
      for (let attempt = 0; ; attempt++) {
        const env = taskById(taskId).environment;
        const secrets = await prepareTab(taskById(taskId), full);
        claim(taskId, ['ready'], 'open a terminal in');
        try {
          if (taskById(taskId).environment === env) {
            startTerminal(taskById(taskId), full, secrets);
            break;
          }
          if (attempt >= 2) throw new Error('Task is busy');
        } finally {
          release(taskId);
        }
      }
      await updateTerminals(taskId, (list) => [...list, full]);
      // A switch, an expiry or Finish in the gap before the tab was listed missed it: it still holds the old
      // environment's values, so it starts again with the current ones (or stops when the task is no longer ready).
      if (
        spawnedWithSecrets.has(full.id) &&
        spawnedEnv.get(full.id) !== taskById(taskId).environment
      ) {
        let claimed = false;
        try {
          claim(taskId, ['ready'], 'open a terminal in');
          claimed = true;
        } catch {
          // Busy or no longer ready: the tab must not keep the old values.
        }
        try {
          if (claimed) {
            await s.terminals.kill(full.id);
            await spawnTerminal(taskById(taskId), full);
          } else await stopTab(full.id);
        } finally {
          if (claimed) release(taskId);
        }
      }
      tel.event('terminal.opened', { kind: full.kind, initial: false });
      return full;
    },
    'terminals:write': async (id, data) => {
      // Paused after a Production value showed up: nothing reaches the agent until Resume.
      if (leakWatch.isPaused(id)) return;
      s.terminals.write(id, data);
      s.onTerminalInput?.(id, data);
    },
    'terminals:resize': async (id, cols, rows) =>
      s.terminals.resize(id, cols, rows),
    'terminals:kill': async (id) => {
      s.terminals.kill(id);
      s.runs?.tabGone(id);
      runArgs.delete(id);
      forgetSpawn(id);
      leakWatch.forget(id);
      const owner = s.store.state.tasks.find((t) =>
        t.terminals.some((x) => x.id === id),
      );
      const def = owner?.terminals.find((x) => x.id === id);
      if (owner)
        await updateTerminals(owner.id, (list) =>
          list.filter((x) => x.id !== id),
        );
      if (def) tel.event('terminal.closed', { kind: def.kind });
    },
    'terminals:restart': async (id, options = {}) => {
      // A new process: what showed up in the old one, and its pause, go.
      leakWatch.forget(id);
      // A `shellie run` it served ends: the agent is not told about a process it did not start.
      s.runs?.tabGone(id);
      const owner = s.store.state.tasks.find((t) =>
        t.terminals.some((x) => x.id === id),
      );
      const def = owner?.terminals.find((x) => x.id === id);
      const known = s.terminals.has(id);
      // Claude Code resumes its conversation instead of starting a new one. OpenCode gets its env built again, so
      // a start without the project config (#109) lasts until the next Restart only.
      // A tab that holds secrets always starts with a fresh env (an edited value, another environment), never the
      // old spawn options.
      const stale =
        def !== undefined && owner !== undefined && holdsSecrets(owner, def);
      if (
        known &&
        !stale &&
        def?.kind !== 'claude' &&
        def?.kind !== 'opencode'
      ) {
        s.terminalFailures?.clear(id);
        s.terminals.restart(id);
        return;
      }
      if (!owner || !def) throw new Error(`Unknown terminal ${id}`);
      // After an app relaunch the manager is empty while the task still lists its terminals.
      if (!known && owner.status !== 'ready')
        throw new Error(
          `Cannot restart a terminal of a task that is ${owner.status}`,
        );
      await s.terminals.kill(id);
      const skipConfig =
        def.kind === 'opencode' && options.withoutProjectConfig === true;
      await spawnTerminal(
        owner,
        def,
        def.kind === 'claude',
        skipConfig ? { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } : {},
      );
      tel.event('terminal.restarted', {
        kind: def.kind,
        afterRelaunch: !known,
        ...(skipConfig ? { withoutProjectConfig: true } : {}),
      });
    },
    'terminals:stop': async (id) => {
      s.runs?.tabGone(id);
      await stopTab(id);
    },
    'runs:pending': async () => s.runs?.pendingRuns() ?? [],
    'runs:approve': async (id, ok) => s.runs?.approve(id, ok === true),
    'terminals:leak': async (id) => leakWatch.state(id),
    'terminals:resume': async (id) => leakWatch.resume(id),
    'terminals:failure': async (id) => s.terminalFailures?.get(id) ?? null,
    'terminals:buffer': async (id) => s.terminals.buffer(id),
    'terminals:isRunning': async (id) => s.terminals.isRunning(id),
    'terminals:reportScheme': async (id, scheme) =>
      s.terminals.reportScheme(id, scheme === 'dark' ? 'dark' : 'light'),
    'secrets:list': async (scope) =>
      s.secrets.list(
        scope === 'all' ? 'all' : ({ repoId: scope } as SecretScope),
      ),
    'secrets:save': async (input) => {
      const saved = await s.secrets.save(input);
      secretsChanged();
      return saved;
    },
    'secrets:delete': async (id) => {
      await s.secrets.delete(id);
      secretsChanged();
    },
    'secrets:reveal': async (id, env) => s.secrets.reveal(id, env),
    'secrets:discover': async (repoId) => {
      const r = await discoverSecrets(s.repos.get(repoId).path, {
        git: s.git,
        userSecretsDir: (id) => s.platform.userSecretsDir(id),
      });
      tel.event(
        'secrets.discovered',
        undefined,
        discoveredMeasurements(r.found, r.skipped),
      );
      return discovery.hold(repoId, r.found, r.skipped);
    },
    'secrets:importPlan': async (repoId) => {
      const r = await discoverSecrets(s.repos.get(repoId).path, {
        git: s.git,
        userSecretsDir: (id) => s.platform.userSecretsDir(id),
      });
      tel.event(
        'secrets.discovered',
        undefined,
        discoveredMeasurements(r.found, r.skipped),
      );
      discovery.hold(repoId, r.found, r.skipped);
      const held = discovery.entries(repoId);
      return {
        rows: buildImportPlan(held, s.secrets.plainValues(repoId)),
        sources: importSources(held),
        skipped: r.skipped,
      };
    },
    'secrets:forget': async (repoId) => discovery.drop(repoId),
    'secrets:import': async (request) => {
      const repo = s.repos.get(request.repoId);
      // Broadcast even after a failure part-way: some secrets may have been saved.
      try {
        const result = await importSecrets(request, {
          hold: discovery,
          store: s.secrets,
          git: s.git,
          repoPath: repo.path,
          worktrees: async () => {
            const copy = await s
              .loadConfig(repo.path)
              .then((c) => c.copy)
              .catch(() => [] as string[]);
            return s.store.state.tasks
              .filter((t) => t.status !== 'done')
              .flatMap((t) => activeWorkspaces(t))
              .filter((w) => w.repoId === repo.id && existsSync(w.worktreePath))
              .map((w) => ({ worktreePath: w.worktreePath, copy }));
          },
        });
        tel.event(
          'secrets.imported',
          {
            environments: ENVIRONMENTS.filter((e) =>
              request.picks.some((p) => p.env === e),
            ).join(','),
            rewriteWorktreeCopies: request.rewriteWorktreeCopies === true,
          },
          {
            values: result.values,
            worktreesRewritten: result.worktreesRewritten,
            filesChanged: result.filesChanged.length,
          },
        );
        return result;
      } finally {
        secretsChanged();
      }
    },
    'secrets:status': (repoId) => {
      // Several screens ask at once (the manager, a task bar per task): one computation answers them all.
      const running = statusRuns.get(repoId);
      if (running) return running;
      const run = (async () => {
        const repo = s.repos.get(repoId);
        return computeStatus({
          repoId,
          repoPath: repo.path,
          copy: await copyOf(repo.path),
          store: s.secrets,
          git: s.git,
          userSecretsDir: (id) => s.platform.userSecretsDir(id),
          worktrees: openWorktrees(repoId),
        });
      })().finally(() => {
        if (statusRuns.get(repoId) === run) statusRuns.delete(repoId);
      });
      statusRuns.set(repoId, run);
      return run;
    },
    'secrets:cleanWorktrees': async (repoId, taskId) => {
      const repo = s.repos.get(repoId);
      const copy = await copyOf(repo.path);
      const names = storedNames(s.secrets, repoId);
      const cleaned = await cleanAll(
        openWorktrees(repoId).filter(
          (w) => taskId === undefined || w.taskId === taskId,
        ),
        (p) => cleanWorktree(p, copy, names, s.git),
      );
      try {
        // Only the cleaned tasks' secret tabs start again, now without the old file next to them.
        for (const id of cleaned) {
          const task = s.store.state.tasks.find((t) => t.id === id);
          if (!task) continue;
          try {
            await respawnSecretTabs(
              task,
              'development',
              'The worktree was cleaned',
            );
          } catch (e) {
            console.error('[secrets] could not restart a cleaned task', e);
          }
        }
      } finally {
        tel.event(
          'secrets.worktreesCleaned',
          { from: taskId === undefined ? 'secrets' : 'task' },
          { count: cleaned.length },
        );
        secretsChanged();
      }
      return cleaned;
    },
    'secrets:repoDefault': async (repoId) => repoDefaultOf(repoId),
    'secrets:setRepoDefault': async (repoId, env) => {
      await s.secrets.setRepoDefault(repoId, env);
      secretsChanged();
    },
    'connections:list': async () => s.connections.list(),
    'connections:save': saveConnection,
    'connections:probe': async (input) => {
      // A stored token only ever goes to its own organization, whatever URL came with it.
      const organizationUrl = input.connectionId
        ? s.connections.get(input.connectionId).organizationUrl
        : s.connections.normalizeUrl(input.organizationUrl);
      const pat = input.connectionId
        ? await s.connections.token(input.connectionId)
        : (input.pat ?? '').trim();
      if (!pat) throw new Error('Enter a personal access token');
      const client = new AdoClient(organizationUrl, async () => pat);
      try {
        const who = await client.whoAmI();
        let projects: { id: string; name: string }[] = [];
        let canListProjects = true;
        try {
          projects = await client.projects();
        } catch (e) {
          if (
            !(e instanceof AdoError && (e.status === 401 || e.status === 403))
          )
            throw e;
          canListProjects = false;
        }
        return { ...who, projects, canListProjects };
      } catch (e) {
        tel.event('connection.probeFailed', {
          status: e instanceof AdoError ? (e.status ?? 0) : 0,
        });
        throw e;
      }
    },
    'connections:saveMany': async (input) => {
      const organizationUrl = input.connectionId
        ? s.connections.get(input.connectionId).organizationUrl
        : s.connections.normalizeUrl(input.organizationUrl);
      const pat = input.connectionId
        ? await s.connections.token(input.connectionId)
        : (input.pat ?? '');
      const known = new Set(
        s.connections
          .list()
          .filter((c) => c.organizationUrl === organizationUrl)
          .map((c) => c.project.toLowerCase()),
      );
      const saved: Connection[] = [];
      for (const raw of input.projects) {
        const project = raw.trim();
        if (!project || known.has(project.toLowerCase())) continue;
        known.add(project.toLowerCase());
        saved.push(
          await saveConnection({
            organizationUrl,
            project,
            pat,
            provider: input.provider,
            workItemOnStart: input.workItemOnStart,
          }),
        );
      }
      return saved;
    },
    'connections:remove': async (id) => {
      s.connections.get(id);
      for (const r of s.repos.list())
        if (r.connectionId === id) await s.repos.setConnection(r.id, null);
      await s.connections.remove(id);
      s.trackers.invalidate(id);
      dropTypes(id);
      connectionsChanged();
      reposChanged();
      tel.event('connection.removed');
    },
    'connections:verify': async (id) => verifyConnection(id),
    'repos:setConnection': async (repoId, connectionId) => {
      if (connectionId !== null) s.connections.get(connectionId);
      const repo = await s.repos.setConnection(repoId, connectionId);
      reposChanged();
      tel.event('repo.connectionLinked', { linked: connectionId !== null });
      return repo;
    },
    'repos:setWorkItemOnStart': async (repoId, settings) => {
      const repo = await s.repos.setWorkItemOnStart(repoId, settings);
      reposChanged();
      return repo;
    },
    'repos:setDiscovered': async (repoId, discovered) => {
      const repo = await s.repos.setDiscovered(repoId, discovered);
      reposChanged();
      return repo;
    },
    'tasks:scanWorkspaces': async (taskId) => {
      // Finish, setup and Reopen work from the task's workspace list; it must not change under them.
      if (taskById(taskId).status !== 'ready') return [];
      const before = JSON.stringify(taskById(taskId).mainCheckoutEdits);
      const { added } = await workspaces.scan(taskId);
      if (added.length > 0) reposChanged();
      if (
        added.length > 0 ||
        JSON.stringify(taskById(taskId).mainCheckoutEdits) !== before
      )
        await tasksChanged();
      return added;
    },
    'tasks:addWorkspace': async (taskId, folder) => {
      const added = await workspaces.add(taskId, folder);
      reposChanged();
      await tasksChanged();
      return added;
    },
    'tasks:removeWorkspace': async (taskId, workspaceId) => {
      await workspaces.remove(taskId, workspaceId);
      await tasksChanged();
    },
    'tasks:prAvailability': async (taskId, workspaceId) => {
      const task = taskById(taskId);
      const c = await prContext(
        task,
        workspaceId === undefined
          ? undefined
          : workspaceById(task, workspaceId),
      );
      return {
        available: c.availability.available,
        reason: c.availability.reason,
        target: c.availability.available ? c.target : null,
      };
    },
    'tasks:prStatus': async (taskId, workspaceId) => {
      const task = taskById(taskId);
      const w = workspaceById(task, workspaceId);
      const pr = w.pullRequest;
      if (!pr) return null;
      // The PR was created through the workspace's own repo connection (maybe another org than the task's).
      const connectionId =
        s.repos.list().find((r) => r.id === w.repoId)?.connectionId ??
        taskConnectionId(task, s.repos.list());
      if (!connectionId) return pr;
      try {
        const raw = await s.trackers
          .tracker(connectionId)
          .pullRequest(pr.project, pr.repositoryId, pr.id);
        const next = { ...pr, status: raw.status, isDraft: raw.isDraft };
        await patchWorkspace(taskId, w.id, { pullRequest: next });
        return next;
      } catch {
        return pr;
      }
    },
    'workItems:currentIteration': async (connectionId) => {
      const c = s.connections.get(connectionId);
      return withConnection(connectionId, () =>
        s.trackers.tracker(connectionId).currentIteration(c.project),
      );
    },
    'workItems:search': async (connectionId, search) => {
      const c = s.connections.get(connectionId);
      tel.event('workItems.search', {
        scope: search.scope,
        hasText: search.text.trim().length > 0,
      });
      return withConnection(connectionId, async () => {
        const client = s.trackers.tracker(connectionId);
        const iteration =
          search.scope === 'sprint'
            ? await client.currentIteration(c.project)
            : null;
        if (search.scope === 'sprint' && !iteration) return [];
        return client.searchItems({
          project: c.project,
          scope: search.scope,
          text: search.text,
          iterationPath: iteration?.path ?? null,
        });
      });
    },
    'workItems:sprint': async (connectionId, iterationId, team) => {
      const c = s.connections.get(connectionId);
      return withConnection(connectionId, () =>
        s.trackers
          .tracker(connectionId)
          .iteration(c.project, iterationId, team),
      );
    },
    'workItems:iterations': async (connectionId) => {
      const c = s.connections.get(connectionId);
      return withConnection(connectionId, () =>
        s.trackers.tracker(connectionId).allIterations(c.project),
      );
    },
    'workItems:types': async (connectionId) => {
      const c = s.connections.get(connectionId);
      let hit = typesCache.get(connectionId);
      if (!hit) {
        const client = s.trackers.tracker(connectionId);
        hit = withConnection(connectionId, () =>
          client.itemTypes(c.project),
        ).then((types) =>
          Promise.all(
            types.map(async ({ iconUrl, ...t }) => ({
              ...t,
              icon: iconUrl ? await client.iconDataUrl(iconUrl) : null,
            })),
          ),
        );
        typesCache.set(connectionId, hit);
        hit.catch(() => {
          if (typesCache.get(connectionId) === hit) dropTypes(connectionId);
        });
      }
      return hit;
    },
    'workItems:get': async (connectionId, id) => {
      const c = s.connections.get(connectionId);
      const n = Number(id);
      if (!Number.isInteger(n) || n < 1) return null;
      const [item] = await withConnection(connectionId, () =>
        s.trackers.tracker(connectionId).items(c.project, [n]),
      );
      return item ?? null;
    },
    'shell:openExternal': async (url) => {
      if (!allowedExternal(url))
        throw new Error(`Opening ${url} is not allowed`);
      await s.openExternal(url);
    },

    'time:sync': async (taskId) => {
      if (!writeTime())
        throw new Error(
          'Writing time to Azure DevOps is off. Turn it on in Settings.',
        );
      const task = taskById(taskId);
      if (task.status !== 'done' || !task.time)
        throw new Error('Only a finished task with booked time can be written');
      const error = await syncTime(taskId);
      if (error) throw new Error(error);
    },
    'budget:get': async (vendor, monthOffset) => {
      if (!s.budget) throw new Error('Budget is not available');
      return s.budget.view(vendor, monthOffset);
    },
    'costServer:status': async () => costServerStatus(),
    'costServer:connect': async (c) => {
      const cs = s.costServer;
      if (!cs) throw new Error('The cost server is not available');
      const conn = {
        url: c.url.trim(),
        email: c.email.trim(),
        key: c.key.trim(),
      };
      // An empty key keeps the saved one (it never goes to the renderer), but only for the same server.
      const saved = conn.key ? null : cs.store.get();
      if (saved && saved.url === conn.url) conn.key = saved.key;
      // The error is the attempt's: the old connection (still saved) is not shown as fine next to it.
      const failed = (error: string): CostServerStatus => ({
        ...cs.sender.status(),
        connected: false,
        error,
      });
      // The client does not check the address, and the key must never go to plain http elsewhere.
      if (!validServerUrl(conn.url)) return failed('Use an https:// address.');
      if (!conn.email) return failed('Enter your email.');
      if (!conn.key) return failed('Enter the company key.');
      let answer: Awaited<ReturnType<typeof costServerHello>>;
      try {
        answer = await (cs.hello ?? costServerHello)(conn);
      } catch (err) {
        const kind = err instanceof CostServerError ? err.kind : 'network';
        tel.event('costServer.connectFailed', { kind });
        return failed(COST_SERVER_ERRORS[kind]);
      }
      try {
        await cs.store.set(conn);
      } catch (err) {
        return failed(err instanceof Error ? err.message : String(err));
      }
      await cs.store.setBudgets(answer.budgets);
      await cs.ledgerPass?.();
      await cs.sender.onConnected();
      tel.event('costServer.connected');
      const st = costServerStatus();
      s.broadcast('costServer:changed', st);
      return st;
    },
    'costServer:disconnect': async () => {
      const cs = s.costServer;
      if (!cs) throw new Error('The cost server is not available');
      await cs.store.clear();
      cs.sender.onDisconnected();
      tel.event('costServer.disconnected');
      const st = costServerStatus();
      s.broadcast('costServer:changed', st);
      return st;
    },
    'home:get': () => home.get(),
    'home:refresh': () => home.refresh(),
    'home:stats': async (period) =>
      homeStats({
        period,
        now: new Date(),
        tasks: s.store.state.tasks,
        repos: s.repos.list(),
        usage: s.usage,
        time: s.time,
      }),
    'usage:task': async (taskId) => s.usage.summarize(taskId),
    'usage:setBillable': async (taskId, sessionId, billable) => {
      await s.usage.setBillable(taskId, sessionId, billable);
      return s.usage.summarize(taskId);
    },
    'usage:exportCsv': async (taskId) => {
      tel.event('usage.exportCsv');
      return usageCsv(
        s.usage.records(taskId),
        (sessionId) => s.usage.isBillable(taskId, sessionId),
        OFFICIAL_USD_TO_EUR,
      );
    },
    'usage:receiverStatus': async () => receiverStatus(),
    'rates:list': async () => ({
      rates: OFFICIAL_RATES,
      officialAsOf: OFFICIAL_RATES_AS_OF,
    }),
    'update:status': async () => s.update?.pending() ?? null,
    'update:needsMove': async () => s.update?.needsMove() ?? false,
    'update:moveToApplications': async () =>
      s.update?.moveToApplications() ?? false,
    'update:install': async () => {
      if (!s.update?.pending())
        throw new Error('No update is ready to install');
      // The quit flushes telemetry (will-quit) while Squirrel's Update.exe waits to start the new version.
      tel.event('update.restart');
      if (!s.update.install()) throw new Error('No update is ready to install');
    },
    'app:whatsNew': async () => (await s.whatsNew?.get()) ?? null,
    'app:info': async () => ({
      version: s.appVersion,
      windowsBuild: s.windowsBuild ?? null,
    }),
    'settings:get': async () => s.settings.get(),
    'settings:save': async (next) => {
      const before = s.settings.get();
      const saved = await s.settings.save(next);
      const changed = changedKeys(before, saved);
      if (saved.theme !== before.theme) s.applyTheme?.(saved.theme);
      // Turning telemetry off is the one change that is not reported.
      if (changed.length > 0 && saved.sendTelemetry)
        tel.event('settings.changed', { keys: changed.join(',') });
      if (
        saved.receiverPort !== before.receiverPort ||
        !s.receiver.status.listening
      ) {
        const st = await s.receiver.start(saved.receiverPort);
        s.broadcast('usage:receiverStatus', receiverStatus());
        if (!st.listening)
          s.broadcast('notice', {
            level: 'warn',
            message: `AI usage capture is off: ${st.error}. Pick another port in Settings.`,
          });
        else if (saved.receiverPort !== before.receiverPort)
          s.broadcast('notice', {
            level: 'info',
            message: `AI usage is now received on port ${saved.receiverPort}. Terminals started before this change keep using the old port until you restart them.`,
          });
      }
      s.broadcast('usage:changed', { taskId: '*' });
      void s.budget?.pass().catch(() => undefined);
      s.broadcast('budget:changed', {});
      return saved;
    },
  };
}
