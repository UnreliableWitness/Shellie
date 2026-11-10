import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  net,
  powerMonitor,
  protocol,
  safeStorage,
  shell,
} from 'electron';
import started from 'electron-squirrel-startup';
import iconUrl from '../assets/icon/png/256.png?inline';
import { EVENT_PREFIX, type Events, type PendingUpdate } from './shared/ipc';
import type { UsageEvent } from './shared/usage';
import type { Task } from './shared/types';
import { brainTaskId, opencodeReady, type Brain } from './shared/brain';
import { createBrainTerminals } from './main/brain/brainTerminal';
import { capturedSessionIds } from './main/brain/state';
import { BrainStore } from './main/brain/BrainStore';
import { BrainJobRunner, brainJobEnv } from './main/brain/jobs';
import { ledgerToday } from './main/brain/health';
import { jobTelemetry } from './main/brain/brainTelemetry';
import { createRasterizer } from './main/brain/convert/raster';
import { createBookHooks } from './main/brain/bookPass';
import { createPictureHooks } from './main/brain/pictures';
import { startBrainScheduler } from './main/brain/scheduler';
import {
  commitJobOutput,
  OUTSIDE_EDIT_MESSAGE,
} from './main/brain/brainHandlers';
import { telemetryEnv } from './main/usage/telemetryEnv';
import { colorFgBg } from './main/services/claudeTheme';
import { runWithInput } from './main/services/prSummary';
import {
  claudeProjectsDir,
  claudeSessionExists,
} from './main/services/claudeSessions';
import {
  createHandlers,
  pruneDanglingConnectionLinks,
  recoverInterruptedTasks,
} from './main/ipc/handlers';
import { AttentionHub } from './main/attention/AttentionHub';
import {
  lostConfig,
  OPENCODE_PLUGIN_SOURCE,
  opencodeConfigContent,
} from './main/attention/opencodePlugin';
import { RunHub } from './main/secrets/RunHub';
import { agentRunEnv, writeShims } from './main/secrets/shim';
import { shellieRunInstruction } from './shared/naming';
import { DocsWatcher } from './main/docs/DocsWatcher';
import { GitDirWatcher } from './main/review/GitDirWatcher';
import { registerIpc } from './main/ipc/register';
import { migrateDataFolder } from './main/migrate/dataFolder';
import {
  migrateTokens,
  readMiacKeychainPassword,
  readMiacWindowsKey,
  type TokenMigration,
} from './main/migrate/tokens';
import { budgetMonth, VENDORS, type Vendor } from './shared/budget';
import { sleep } from './main/async';
import { BudgetService, inShellieFor } from './main/budget/BudgetService';
import { effectiveBudget } from './main/budget/serverBudgets';
import { BudgetStore } from './main/budget/BudgetStore';
import { budgetRecordsFromUsage } from './main/budget/usageRecords';
import { ClaudeTranscriptReader } from './main/budget/claudeTranscripts';
import { OpenCodeReader, openCodeDbPath } from './main/budget/openCode';
import { CostSender } from './main/costServer/CostSender';
import { CostServerStore } from './main/costServer/CostServerStore';
import { attributionContext } from './main/ledger/attribute';
import { LedgerService } from './main/ledger/LedgerService';
import { LedgerStore } from './main/ledger/LedgerStore';
import { createPlatform } from './main/platform';
import { TrackerRegistry } from './main/trackers/TrackerRegistry';
import {
  claudeThemeFor,
  fixedScheme,
  claudeSettingsFile,
  readClaudeTheme,
} from './main/services/claudeTheme';
import { ConnectionStore } from './main/services/ConnectionStore';
import { SecretStore, secretsLoadNotice } from './main/secrets/SecretStore';
import { GitClient } from './main/services/GitClient';
import { connectionIdForPath, createGitAuth } from './main/services/gitAuth';
import { loadEffectiveConfig } from './main/services/effectiveConfig';
import { RETRY_EVERY_MS as CLEANUP_RETRY_EVERY_MS } from './main/services/worktreeCleanup';
import { RepoRegistry } from './main/services/RepoRegistry';
import { taskWorkspaces } from './shared/workspaces';
import { migrateTaskFolders } from './main/migrate/taskFolders';
import { SetupRunner, ensureExcluded } from './main/services/SetupRunner';
import { TaskStore } from './main/services/TaskStore';
import { ClaudeRetheme } from './main/services/ClaudeRetheme';
import { TerminalManager } from './main/services/TerminalManager';
import { TerminalFailures } from './main/services/TerminalFailures';
import { CopilotFileTailer } from './main/usage/CopilotFileTailer';
import { ActivityTracker } from './main/time/ActivityTracker';
import { TerminalAgentTimer } from './main/time/TerminalAgentTimer';
import { TimeStore } from './main/time/TimeStore';
import { SettingsStore } from './main/usage/SettingsStore';
import { UsageReceiver } from './main/usage/UsageReceiver';
import { OFFICIAL_RATES } from './main/pricing/officialRates';
import { UsageStore } from './main/usage/UsageStore';
import { runSmoke } from './main/smoke';
import { createSplashWindow, SplashReporter } from './main/splash';
import { appMenu } from './main/appMenu';
import {
  AppInsightsClient,
  NoopTelemetry,
  type Telemetry,
} from './main/telemetry/AppInsightsClient';
import {
  forwardRendererTelemetry,
  installId,
  pathOperation,
  sensitiveValues,
  telemetryOptedOut,
  timedFetch,
  trackHandlerFailures,
} from './main/telemetry/helpers';
import {
  inspectorProfiler,
  StallWatchdog,
} from './main/diagnostics/stallWatchdog';
import { startHealthReports } from './main/telemetry/health';
import { reportLoggedErrors } from './main/telemetry/loggedErrors';
import { hello, sendRecords } from './main/costServer/client';
import { TELEMETRY_CHANNEL } from './shared/telemetry';
import {
  type AutoUpdate,
  fetchFeedState,
  needsMoveToApplications,
  startAutoUpdate,
} from './main/autoUpdate';
import { appUrlMatcher, guardWindow, trustedSender } from './main/windowGuards';
import {
  chromeColors,
  titleBarOptions,
  windowBackground,
} from './main/windowChrome';
import { schemeOf } from './shared/theme';
import { TITLE_BAR_HEIGHT, titleBarKind } from './shared/titleBar';
import { errorMessage } from './shared/errors';
import { HtmlViews, serveView, VIEW_SCHEME } from './main/htmlView';
import { applyProjectScopeMigration } from './main/migrate/projectScope';
import { migrateOnboarding } from './main/onboardingMigration';
import { createWhatsNew, seenAtBoot } from './main/releaseNotes';
import { folderPaths, userDataOverride } from './main/paths';

if (started) app.quit();

// Dev only (ignored when packaged): SHELLIE_USER_DATA points the app at a separate data folder (a fresh profile);
// set before anything reads it.
const userDataDir = userDataOverride(process.env, app.isPackaged);
if (userDataDir) app.setPath('userData', userDataDir);

// HTML files opened in a tab load from shellie-view: (registered before ready, as Electron requires).
// Not CORS-enabled and no CSP bypass: the pages run in a sandboxed iframe with an opaque origin.
protocol.registerSchemesAsPrivileged([
  { scheme: VIEW_SCHEME, privileges: { standard: true, secure: true } },
]);
const htmlViews = new HtmlViews();

/** Replaced by the real client in boot when the build has a connection string (CI release builds). */
let telemetry: Telemetry = NoopTelemetry;
const sessionStart = Date.now();
// What main logs as an error or warning is a failure it recovered from: report it too.
reportLoggedErrors(() => telemetry);
/** Timing summaries and the `app.health` snapshot, every 10 minutes from the end of boot and on quit. */
let health: ReturnType<typeof startHealthReports> | null = null;
let stallWatchdog: StallWatchdog | null = null;

// Monitor only: Electron's own handling of an uncaught exception (the error dialog) stays as it is.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  telemetry.exception(error, { source: 'main', origin }, 'critical');
  void telemetry.flush();
});
process.on('unhandledRejection', (reason) => {
  // Reported before it is logged, so the logged copy is not sent again.
  telemetry.exception(reason, { source: 'main', origin: 'unhandledRejection' });
  console.error('Unhandled rejection in main:', reason);
});
app.on('render-process-gone', (_e, _wc, details) => {
  if (details.reason === 'clean-exit') return;
  telemetry.event('process.gone', {
    process: 'renderer',
    reason: details.reason,
    exitCode: details.exitCode,
  });
  void telemetry.flush();
});
app.on('child-process-gone', (_e, details) => {
  if (details.reason === 'clean-exit') return;
  telemetry.event('process.gone', {
    process: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
  });
});

const icon = nativeImage.createFromDataURL(iconUrl);
// macOS takes the icon from the app bundle; only Windows and Linux windows need it passed in.
const windowIcon = process.platform === 'darwin' ? undefined : icon;

let mainWindow: BrowserWindow | null = null;
let splashWin: BrowserWindow | null = null;
/** True until the main window is revealed (stays true after a boot failure). */
let booting = true;
const terminals = new TerminalManager();
/** How long after a terminal's exit its output is read for a diagnosis (late ConPTY output, #109). */
const EXIT_SETTLE_MS = 150;
const DOT = String.fromCharCode(0xb7);
let stopUsage: () => void = () => {};
/** Ends the time tracking timers and closes the open intervals (on quit). */
let stopTime: () => void = () => {};
let stopBudget: () => void = () => {};
let stopLedger: () => void = () => {};
/** Stops the brains' scheduler and job queue (on quit). */
let stopBrains: () => void = () => {};
/** The brain's own Claude terminal; set where the brains are wired. Its terminal counts as a Claude tab. */
let brainTerminals: ReturnType<typeof createBrainTerminals> | undefined =
  undefined;
/** Time writes still in flight; the quit waits for them. */
const timeWrites = new Set<Promise<void>>();
/** Window focus, for active time (set once the tracker exists). */
let onWindowFocus: (focused: boolean) => void = () => {};
let updates: AutoUpdate | null = null;
const inApplicationsFolder = () =>
  process.platform === 'darwin' && app.isInApplicationsFolder();
/** Set when an update has downloaded; the renderer offers Restart and update. */
let pendingUpdate: PendingUpdate | null = null;

const gitDirWatcher = new GitDirWatcher(
  (wt) => new GitClient().gitDir(wt),
  (target) => broadcast('review:changed', { taskId: target }),
  undefined,
  (target) => docsWatcher.stopTarget(target),
);
const docsWatcher = new DocsWatcher(
  (taskId, paths) => broadcast('docs:changed', { taskId, paths }),
  undefined,
  (taskId) => {
    gitDirWatcher.stopTarget(taskId);
    broadcast('docs:watchStopped', { taskId });
  },
);

// The app's own pages, from the same values the windows are loaded with (dev server or renderer folder).
const isMainPage = appUrlMatcher({
  devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
  dir: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`),
});
const isSplashPage = appUrlMatcher({
  devServerUrl: SPLASH_WINDOW_VITE_DEV_SERVER_URL,
  dir: path.join(__dirname, `../renderer/${SPLASH_WINDOW_VITE_NAME}`),
});
const openLink = (url: string) => shell.openExternal(url);

function broadcast<K extends keyof Events>(event: K, payload: Events[K]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(`${EVENT_PREFIX}${event}`, payload);
}

const scheme = () => schemeOf(nativeTheme.shouldUseDarkColors);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: windowBackground(scheme()),
    // The title stays for the taskbar, Alt+Tab and the Window menu; the header shows the app instead of a title bar.
    title: 'Shellie',
    ...titleBarOptions(process.platform, scheme()),
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  guardWindow(win.webContents, isMainPage, openLink);
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
    // Surface renderer errors in the Forge terminal (dev only).
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') {
        console.error(`[renderer] ${event.message}`);
      }
    });
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  // Full screen hides the traffic lights, so the header drops the room it keeps for them (macOS).
  const sendFullScreen = () => {
    const payload: Events['window:fullScreen'] = win.isFullScreen();
    win.webContents.send(`${EVENT_PREFIX}window:fullScreen`, payload);
  };
  win.on('enter-full-screen', sendFullScreen);
  win.on('leave-full-screen', sendFullScreen);
  win.webContents.on('did-finish-load', sendFullScreen);
  win.on('focus', () => onWindowFocus(true));
  win.on('blur', () => onWindowFocus(false));
  win.on('minimize', () => onWindowFocus(false));
  win.on('closed', () => {
    onWindowFocus(false);
    if (mainWindow === win) mainWindow = null;
  });
  // A hung renderer (or a main process too busy to answer it): sent at once, in case the user kills the app.
  let hungAt: number | null = null;
  win.on('unresponsive', () => {
    hungAt = performance.now();
    telemetry.event('window.unresponsive');
    void telemetry.flush();
  });
  win.on('responsive', () => {
    if (hungAt === null) return;
    telemetry.event('window.responsive', undefined, {
      ms: performance.now() - hungAt,
    });
    hungAt = null;
  });
  return win;
}

/** Fades the main window in over 200 ms where window opacity is supported; Linux gets a plain show. */
function revealMain(win: BrowserWindow): void {
  if (process.platform === 'linux') {
    win.show();
    return;
  }
  win.setOpacity(0);
  win.show();
  const t0 = Date.now();
  const timer = setInterval(() => {
    const p = Math.min(1, (Date.now() - t0) / 200);
    if (win.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    win.setOpacity(p);
    if (p === 1) clearInterval(timer);
  }, 16);
}

async function boot(): Promise<void> {
  const bootStart = performance.now();
  const userData = app.getPath('userData');
  // First on purpose: before settings load and before any window, copy MIAC's data folder.
  const migrationStart = performance.now();
  // A SHELLIE_USER_DATA profile stays fresh: no copy of MIAC's data into it.
  const migration = userDataDir
    ? null
    : await migrateDataFolder({
        from: path.join(app.getPath('appData'), 'miac'),
        to: userData,
        platform: process.platform,
      }).catch((err) => {
        console.error(
          'Data migration from MIAC failed; it runs again on the next start.',
          err,
        );
        return null;
      });
  const migrationMs = performance.now() - migrationStart;
  const settings = new SettingsStore(path.join(userData, 'settings.json'));
  const settingsLoaded = await settings.load();
  // Before any window: the splash, the first frame and prefers-color-scheme all follow it.
  nativeTheme.themeSource = settings.get().theme;
  splashWin = settings.get().showSplash
    ? createSplashWindow(windowIcon, scheme())
    : null;
  if (splashWin) guardWindow(splashWin.webContents, isSplashPage, openLink);
  const reporter = new SplashReporter(splashWin);
  ipcMain.on('splash:skip', (e) => {
    if (trustedSender(e, isSplashPage)) reporter.skip();
  });
  ipcMain.on('splash:quit', (e) => {
    if (trustedSender(e, isSplashPage)) app.quit();
  });
  // Right after the copy, once, before ConnectionStore.load: the copied tokens are under MIAC's key (Local State is not copied); move them to Shellie's.
  // After the splash exists, as its own step, so the Keychain prompt does not appear with no window.
  let tokenResult: TokenMigration = 'none';
  const readOldKey =
    process.platform === 'darwin'
      ? () => readMiacKeychainPassword()
      : process.platform === 'win32'
        ? () =>
            readMiacWindowsKey(
              path.join(app.getPath('appData'), 'miac', 'Local State'),
            )
        : null;
  if (migration?.connections && !migration.failed && readOldKey) {
    reporter.step('Moving connection tokens');
    // Without encryption the tokens cannot be re-encrypted: keep the connections, marked unauthorized ('refused').
    const canEncrypt = safeStorage.isEncryptionAvailable();
    tokenResult = await migrateTokens({
      file: path.join(userData, 'connections.json'),
      readOldKey: canEncrypt
        ? readOldKey
        : () => Promise.reject(new Error('safeStorage unavailable')),
      encrypt: (plain) => safeStorage.encryptString(plain),
    }).catch((): TokenMigration => {
      console.error('Moving MIAC connection tokens failed; enter them again.');
      return 'refused';
    });
  }
  // Boot step timings (ms), measured around the real work, not the splash pacing.
  const timings: Record<string, number> = {
    settingsMs: performance.now() - bootStart,
  };
  let mark = performance.now();
  const lap = (key: string) => {
    const now = performance.now();
    timings[key] = now - mark;
    mark = now;
  };
  let sensitive: () => string[] = () => [];
  if (__APPINSIGHTS_CONNECTION_STRING__ && !telemetryOptedOut(process.env)) {
    try {
      telemetry = new AppInsightsClient({
        connectionString: __APPINSIGHTS_CONNECTION_STRING__,
        enabled: () => settings.get().sendTelemetry,
        home: app.getPath('home'),
        sensitive: () => sensitive(),
        context: {
          appVersion: app.getVersion(),
          os: process.platform,
          osVersion: os.release(),
          arch: process.arch,
          electronVersion: process.versions.electron,
          packaged: app.isPackaged,
          installId: await installId(userData),
          sessionId: randomUUID(),
        },
      });
    } catch (e) {
      console.error('[telemetry] disabled:', e);
    }
  }
  ipcMain.on(TELEMETRY_CHANNEL, (e, payload: unknown) => {
    if (trustedSender(e, isMainPage))
      forwardRendererTelemetry(payload, telemetry);
  });
  if (migration)
    telemetry.event(
      'migration.miac',
      { tokens: tokenResult, result: migration.failed ? 'failed' : 'ok' },
      { copied: migration.copied.length, ms: migrationMs },
    );
  lap('telemetryMs');
  try {
    reporter.step('Loading tasks');
    const store = new TaskStore(path.join(userData, 'state.json'));
    /** Secrets at rest (tokens, the cost server key) go through Electron's safeStorage. */
    const safeCrypto = {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain: string) => safeStorage.encryptString(plain),
      decrypt: (cipher: Buffer) => safeStorage.decryptString(cipher),
    };
    const connections = new ConnectionStore(
      path.join(userData, 'connections.json'),
      safeCrypto,
    );
    const secrets = new SecretStore(
      path.join(userData, 'secrets.json'),
      safeCrypto,
    );
    // The brains load before the ledger's first pass, so their records are attributed to them.
    const brains = new BrainStore(path.join(userData, 'brains.json'));
    const [loaded, connectionsLoaded, secretsLoaded] = await Promise.all([
      store.load(),
      connections.load(),
      secrets.load(),
      brains.load(),
    ]);
    // Once per install: installs that already have repositories skip the first-run page and keep their tabs.
    const migrated = migrateOnboarding(
      settings.get(),
      store.state.repos.length,
      new Date().toISOString(),
    );
    if (migrated)
      await settings
        .save(migrated)
        .catch((err) => console.error('Onboarding migration failed', err));
    // Once: the global write-time flag moves onto every project, and repo copies of a project's start options go.
    await applyProjectScopeMigration({
      settings,
      connections,
      store,
      log: (msg, err) => console.error(msg, err),
    });
    // A fresh install has seen the version it was installed with: What's new shows only after an update.
    const seen = seenAtBoot(settings.get(), app.getVersion());
    if (seen)
      await settings
        .save({ ...settings.get(), whatsNewSeen: seen })
        .catch((err) => console.error('Saving whatsNewSeen failed', err));
    const recovered = await recoverInterruptedTasks(store);
    // Fetch and push to Azure Repos sign in with the connection's token, not a credential helper that may not start.
    const git = new GitClient(undefined, {
      auth: createGitAuth({
        connections: () => connections.list(),
        token: (id) => connections.token(id),
        connectionIdFor: (cwd) => connectionIdForPath(store.state, cwd),
      }),
    });
    const platform = createPlatform();
    const repos = new RepoRegistry(store, git);
    // Worktrees made before the rename keep their task file in .miac/; move it in the background.
    void (async () => {
      const pending: { worktreePath: string; repoPath: string }[] = [];
      for (const task of store.state.tasks) {
        for (const w of taskWorkspaces(task)) {
          const repo = store.state.repos.find((r) => r.id === w.repoId);
          if (w.worktreePath && repo)
            pending.push({ worktreePath: w.worktreePath, repoPath: repo.path });
        }
      }
      await migrateTaskFolders(pending, (repoPath) =>
        ensureExcluded(git, repoPath, '.shellie/'),
      );
    })().catch(() => {});
    await pruneDanglingConnectionLinks(repos, connections);
    const username = (() => {
      try {
        return os.userInfo().username;
      } catch {
        return undefined;
      }
    })();
    // Learned at run time: an Azure Repos remote's project and repo can differ from anything stored.
    const learned = new Set<string>();
    sensitive = () =>
      sensitiveValues({
        repos: repos.list(),
        brains: brains.list(),
        tasks: store.state.tasks,
        connections: connections.list(),
        username,
        extra: learned,
      });
    lap('tasksMs');
    const usageDir = path.join(userData, 'usage');
    const copilotDirMade = fs.mkdir(path.join(usageDir, 'copilot'), {
      recursive: true,
    });
    // Per-run secret for the attention route, so other local programs cannot raise notifications.
    const attentionToken = randomBytes(24).toString('hex');
    const opencodePlugin = path.join(
      userData,
      'opencode',
      'shellie-attention.js',
    );
    let opencodePluginReady = false;
    const opencodePluginWritten = fs
      .mkdir(path.dirname(opencodePlugin), { recursive: true })
      .then(() => fs.writeFile(opencodePlugin, OPENCODE_PLUGIN_SOURCE))
      .then(() => {
        opencodePluginReady = true;
      })
      .catch((err) =>
        console.error('[attention] could not write the OpenCode plugin', err),
      );
    // `shellie run` for agents: a token per task per launch, and the shim first on agent tabs' PATH.
    const runs = new RunHub();
    const shimDir = path.join(userData, 'bin');
    let shimsReady = false;
    const shimsWritten = writeShims(shimDir)
      .then(() => {
        shimsReady = true;
      })
      .catch((err) =>
        console.error('[secrets] could not write the shellie run shim', err),
      );
    /** OpenCode reads instructions from a file: the `shellie run` line, per task. */
    const opencodeRunInstructions = (taskId: string, names: string[]) => {
      try {
        const file = path.join(
          userData,
          'opencode',
          `shellie-run-${taskId.replace(/[^\w-]/g, '_')}.md`,
        );
        writeFileSync(file, `${shellieRunInstruction(names)}\n`);
        return file;
      } catch (err) {
        console.error(
          '[secrets] could not write the OpenCode instructions',
          err,
        );
        return undefined;
      }
    };
    const usage = new UsageStore(usageDir, () => OFFICIAL_RATES);
    const time = new TimeStore(path.join(usageDir, 'time.json'));
    // usageMs covers both stores and the folders and shims above, none of which needs another: loaded together.
    const [usageLoaded, timeLoaded] = await Promise.all([
      usage.load(),
      time.load(),
      copilotDirMade,
      opencodePluginWritten,
      shimsWritten,
    ]);
    lap('usageMs');
    const ingest = (events: UsageEvent[]) => {
      usage
        .addMany(events)
        .catch((err) => console.error('[usage] could not store records', err));
    };
    const keep = (write: Promise<void>) => {
      const p = write.catch((err: unknown) =>
        console.error('[time] could not store an interval', err),
      );
      timeWrites.add(p);
      void p.finally(() => timeWrites.delete(p));
    };
    const tracker = new ActivityTracker({
      now: Date.now,
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
      idleLimitSeconds: () => settings.get().idleMinutes * 60,
      onInterval: (taskId, iv) => keep(time.addActive(taskId, iv)),
    });
    // OpenCode has no telemetry: its agent time is estimated from the terminal (output after Enter).
    const agentTimer = new TerminalAgentTimer({
      now: Date.now,
      watch: (terminalId) => {
        for (const t of store.state.tasks)
          if (
            t.terminals.some(
              (d) => d.id === terminalId && d.kind === 'opencode',
            )
          )
            return { taskId: t.id };
        return null;
      },
      onInterval: (taskId, iv) => keep(time.addAgent(taskId, 'opencode', iv)),
    });
    time.on('changed', (taskId) => broadcast('time:changed', { taskId }));
    /** Brings the main window to the front for a notification click; false when there is no window to show. */
    const focusMain = (): boolean => {
      const w = mainWindow;
      if (!w || w.isDestroyed()) return false;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      return true;
    };
    const taskTitle = (t: Task) =>
      t.workItem ? `${t.workItem.id} ${t.workItem.title}` : t.name;
    // Claude Code tabs with a colour-blind or ANSI-only theme start again in the new variant after a scheme change.
    const retheme = new ClaudeRetheme({
      now: Date.now,
      scheme,
      alive: (id) => terminals.isRunning(id),
      // Told once the new process exists (its output comes in a later tick), so the view clears and sizes it.
      restart: (id) =>
        void handlers['terminals:restart'](id).then(
          () => broadcast('terminal:reset', { id }),
          (err) =>
            console.error('[terminals] could not resume Claude Code', err),
        ),
    });
    const attention = new AttentionHub({
      now: Date.now,
      write: (id, data) => terminals.write(id, data),
      terminal: (id) => {
        for (const t of store.state.tasks) {
          const def = t.terminals.find((d) => d.id === id);
          if (def)
            return {
              taskId: t.id,
              taskTitle: taskTitle(t),
              label: def.label,
              kind: def.kind,
            };
        }
        const brain = brainTerminals?.ownerOf(id);
        if (brain)
          return {
            taskId: brainTaskId(brain.id),
            taskTitle: brain.name,
            label: brain.terminal?.label ?? brain.name,
            kind: brain.terminal?.kind ?? 'claude',
          };
        return null;
      },
      notifyOnDone: () => settings.get().notifyOnDone,
      show: ({ title, body, onClick }) => {
        try {
          const n = new Notification({ title, body });
          n.on('click', onClick);
          n.show();
          return n;
        } catch (err) {
          console.error('[attention] could not show a notification', err);
          return { close: () => undefined };
        }
      },
      setBadgeCount: (n) => app.setBadgeCount(n),
      changed: (snapshot) => broadcast('attention:changed', snapshot),
      status: (id, state) => retheme.status(id, state),
      open: (taskId, terminalId) => {
        if (focusMain()) broadcast('attention:open', { taskId, terminalId });
      },
    });
    const receiver = new UsageReceiver(
      ingest,
      (points) => {
        for (const p of points) keep(time.addClaudeActive(p));
      },
      { token: attentionToken, onSignal: (id, s) => attention.signal(id, s) },
      runs,
    );
    const copilot = new CopilotFileTailer(
      path.join(usageDir, 'copilot'),
      ingest,
      (taskId, ivs) => {
        for (const iv of ivs) keep(time.addAgent(taskId, 'copilot-cli', iv));
      },
    );
    const budgetStore = new BudgetStore(
      path.join(usageDir, 'budget.json'),
      () => OFFICIAL_RATES,
    );
    // The cost server's address, key and last `hello` answer; a changed answer moves the budgets.
    const costServer = new CostServerStore(
      path.join(userData, 'cost-server.json'),
      safeCrypto,
      () => {
        void budget.pass().catch(() => undefined);
        broadcast('budget:changed', {});
      },
    );
    await Promise.all([budgetStore.load(), costServer.load()]);
    // With a cost server, its tier for the developer sets each budget's amount and start day.
    const budgetSettings = (v: Vendor) =>
      effectiveBudget(
        v === 'claude'
          ? settings.get().claudeBudget
          : settings.get().copilotBudget,
        costServer.budgets?.[v] ?? null,
      );
    // First reads go back to the start of the earlier of the two budgets' previous months.
    const budgetSince = Math.min(
      ...VENDORS.map((v) =>
        budgetMonth(
          new Date(),
          budgetSettings(v).monthStartDay,
          -1,
        ).start.getTime(),
      ),
    );
    const budget = new BudgetService({
      store: budgetStore,
      claude: new ClaudeTranscriptReader(claudeProjectsDir(), {
        since: budgetSince,
      }),
      openCode: new OpenCodeReader(openCodeDbPath(), { since: budgetSince }),
      settings: budgetSettings,
      extra: () => budgetRecordsFromUsage(usage.allRecords()),
      inShellie: inShellieFor(
        () => store.state.tasks,
        () =>
          new Set(
            store.state.tasks.flatMap((t) =>
              usage.records(t.id).map((r) => r.sessionId),
            ),
          ),
      ),
      changed: () => broadcast('budget:changed', {}),
      notify: ({ title, body }) => {
        try {
          const n = new Notification({ title, body });
          n.on('click', () => {
            if (focusMain()) broadcast('budget:open', {});
          });
          n.show();
        } catch (err) {
          console.error('[budget] could not show a notification', err);
        }
      },
      telemetry: (vendor, kind) =>
        telemetry.event('budget.alert', { vendor, kind }),
    });
    stopBudget = () => {
      budget.stop();
      // will-quit holds the quit for this write.
      const p = budgetStore.flush().catch((err) => {
        console.warn('[budget] could not save on quit', err);
      });
      timeWrites.add(p);
      void p.finally(() => timeWrites.delete(p));
    };
    // The cost ledger: every AI request priced and attributed to a task, a repo or nothing. Its readers
    // have no `since`, so the first run backfills all the transcripts and OpenCode still have.
    const ledgerStore = new LedgerStore(path.join(usageDir, 'ledger'));
    // Sends the ledger's dirty records to the cost server in the background (nothing without a connection).
    // Its requests are dependencies named by path only: the server's address is the company's.
    const costServerFetch = timedFetch(
      telemetry,
      fetch,
      pathOperation('cost-server'),
    );
    const sender = new CostSender({
      ledger: ledgerStore,
      server: costServer,
      status: (st) => broadcast('costServer:changed', st),
      notice: (message) => broadcast('notice', { level: 'warn', message }),
      telemetry: (event, props) => telemetry.event(event, props),
      send: (c, records) => sendRecords(c, records, costServerFetch),
      hello: (c) => hello(c, costServerFetch),
    });
    const ledger = new LedgerService({
      store: ledgerStore,
      claude: new ClaudeTranscriptReader(claudeProjectsDir()),
      openCode: new OpenCodeReader(openCodeDbPath()),
      usageRecords: () => usage.allRecords(),
      context: () =>
        attributionContext(
          store.state.tasks,
          store.state.repos,
          connections.list(),
          (id) =>
            usage
              .records(id)
              .filter((r) => r.tool === 'claude-code')
              .map((r) => r.sessionId),
          brains.list().map((b) => ({
            id: b.id,
            organization:
              connections.list().find((c) => c.id === b.connectionId)
                ?.organizationUrl ?? '',
            project: b.project,
            path: b.path,
          })),
        ),
      isBillable: (taskId, sessionId) => usage.isBillable(taskId, sessionId),
      billableVersion: () => usage.billableVersion(),
      // The email saved in Settings › Cost server; null when not connected.
      developer: () => costServer.get()?.email ?? null,
      version: app.getVersion(),
      toUsage: ingest,
      changed: () => sender.kick(),
      telemetry: (event, props) => telemetry.event(event, props),
    });
    stopLedger = () => {
      ledger.stop();
      sender.stop();
      // will-quit holds the quit for this write.
      const p = ledgerStore.flushSent().catch((err) => {
        console.warn('[ledger] could not save sent marks on quit', err);
      });
      timeWrites.add(p);
      void p.finally(() => timeWrites.delete(p));
    };
    // Brains: headless skill runs per brain, the brain's Claude terminal, and the daily refresh and weekly digest.
    const brainEnv = (id: string) =>
      telemetryEnv(
        brainTaskId(id),
        settings.get().receiverPort,
        usageDir,
        'brain',
      );
    const brainToday = (id: string) => ledgerToday(ledgerStore.all(), id);
    const brainOf = (id: string): Brain => {
      const b = brains.get(id);
      if (!b) throw new Error(`Unknown brain ${id}`);
      return b;
    };
    const brainJobEvents = jobTelemetry((name, props) =>
      telemetry.event(name, props),
    );
    // Pictures jobs' prompts, the job after a capture, and the one-time pass over earlier sources.
    const pictureHooks = createPictureHooks({
      brains,
      runner: () => brainRunner,
      git,
      rasterize: createRasterizer({ platform, run: runWithInput }),
    });
    // The first arrangement of the book: a background sync with the `book` argument, counted when it ends.
    const bookHooks = createBookHooks({ brains, runner: () => brainRunner });
    const brainRunner = new BrainJobRunner({
      platform,
      run: runWithInput,
      env: (id) => brainJobEnv(id, brainEnv(id)),
      tokensToday: (id) => brainToday(id).tokens,
      cap: (id) => brainOf(id).options.dailyTokenCap,
      brainDir: (id) => brainOf(id).path,
      model: (id) => brains.get(id)?.options.model ?? 'sonnet',
      agent: (id) => brains.get(id)?.options.agent ?? 'claude',
      opencodeModel: (id) => brains.get(id)?.options.opencodeModel ?? null,
      // A brain that is gone is ready: its job fails on the folder, as before.
      ready: (id) => {
        const b = brains.get(id);
        return !b || b.options.agent !== 'opencode' || opencodeReady(b);
      },
      commit: async (id, message) => {
        const b = brainOf(id);
        await commitJobOutput(git, b.path, message, b.name);
      },
      beforeJob: async (id) => {
        const b = brainOf(id);
        await commitJobOutput(git, b.path, OUTSIDE_EDIT_MESSAGE, b.name);
      },
      promptFor: pictureHooks.promptFor,
      afterJob: (j) => {
        pictureHooks.afterJob(j);
        bookHooks.afterJob(j);
      },
      onChange: (brainId, jobs) => {
        brainJobEvents(jobs);
        broadcast('brain:changed', { brainId });
      },
    });
    // The scheduler starts with the window; the runner stops on quit either way.
    let stopBrainScheduler = () => {};
    stopBrains = () => {
      stopBrainScheduler();
      brainRunner.stop();
    };
    /** The settings file Claude Code tabs start with (the theme, and a tab's deny rules); null when it could not be written. */
    const claudeSettings = (deny?: string[]): string | null => {
      try {
        return claudeSettingsFile(path.join(userData, 'claude'), {
          theme: claudeThemeFor(readClaudeTheme(), scheme()),
          deny,
        });
      } catch (e) {
        console.error('[terminals] could not write the Claude theme file', e);
        return null;
      }
    };
    // OpenCode's sessions: the brain terminal's, and a task's for its lessons at Finish.
    const openCodeSessions = new OpenCodeReader(openCodeDbPath());
    /** The attention route for agent tabs and the brain terminal; the port is read at each spawn. */
    const attentionEnv = (): Record<string, string> => ({
      SHELLIE_ATTENTION_URL: `http://127.0.0.1:${settings.get().receiverPort}/v1/attention`,
      SHELLIE_ATTENTION_TOKEN: attentionToken,
    });
    brainTerminals = createBrainTerminals({
      brains,
      terminals,
      platform,
      env: (id) => ({ ...brainEnv(id), COLORFGBG: colorFgBg(scheme()) }),
      themeFile: () => claudeSettings(),
      sessionExists: claudeSessionExists,
      // Never a job's session: the runner's jobs and the captured sources' sessions are left out.
      opencodeSession: (brain, since) =>
        openCodeSessions.terminalSession(
          folderPaths(brain.path),
          since,
          new Set([
            ...brainRunner
              .jobs(brain.id)
              .flatMap((j) => (j.sessionId ? [j.sessionId] : [])),
            ...capturedSessionIds(brain.path),
          ]),
        ),
      opencodeSessionExists: (id) => openCodeSessions.sessionExists(id),
      opencodeAttention: () => ({
        env: attentionEnv(),
        plugin: opencodePluginReady ? opencodePlugin : null,
      }),
    });
    protocol.handle(VIEW_SCHEME, (req) => serveView(htmlViews, req.url));
    // Agent tabs that stop right after starting (a missing CLI, an invalid OpenCode config) say why (#109).
    const terminalFailures = new TerminalFailures({
      buffer: (id) => terminals.buffer(id) ?? '',
      runMs: (id) => terminals.runMs(id),
      kindOf: (id) => {
        for (const t of store.state.tasks)
          for (const d of t.terminals) if (d.id === id) return d.kind;
        return brainTerminals?.ownerOf(id)?.terminal?.kind;
      },
      // Read at each call: telemetry is replaced once its client is set up.
      telemetry: {
        event: (...a) => telemetry.event(...a),
        exception: (...a) => telemetry.exception(...a),
      },
    });
    const handlers = createHandlers({
      brainTerminals,
      brain: {
        store: brains,
        runner: brainRunner,
        ledgerToday: brainToday,
        userData,
      },
      terminalFailures,
      budget,
      costServer: {
        store: costServer,
        sender,
        ledgerPass: () => ledger.freshPass(),
      },
      applyTheme: (theme) => {
        nativeTheme.themeSource = theme;
      },
      colorScheme: scheme,
      claudeThemeSettings: claudeSettings,
      opencodeSessionTexts: (dirs, since) =>
        openCodeSessions.sessionTexts(dirs, since),
      claudeSpawned: (id) =>
        retheme.spawned(
          id,
          fixedScheme(claudeThemeFor(readClaudeTheme(), scheme())),
        ),
      update: {
        pending: () => pendingUpdate,
        install: () => updates?.install() ?? false,
        needsMove: () =>
          needsMoveToApplications({
            isPackaged: app.isPackaged,
            platform: process.platform,
            enabled: settings.get().autoUpdate,
            inApplicationsFolder: inApplicationsFolder(),
          }),
        moveToApplications: () => {
          try {
            return app.moveToApplicationsFolder();
          } catch (e) {
            console.error('[update] could not move to Applications', e);
            return false;
          }
        },
      },
      // Dev builds keep package.json's fixed version, which has no release.
      whatsNew: app.isPackaged
        ? createWhatsNew({
            version: app.getVersion(),
            settings: () => settings.get(),
            fetch: timedFetch(
              telemetry,
              fetch,
              pathOperation('api.github.com'),
            ),
          })
        : undefined,
      appVersion: app.getVersion(),
      windowsBuild:
        process.platform === 'win32'
          ? Number(os.release().split('.')[2]) || null
          : null,
      usage,
      time,
      tracker,
      onTerminalInput: (id, data) => {
        agentTimer.input(id, data);
        retheme.input(id, data);
      },
      settings,
      receiver,
      copilot,
      usageDir,
      // Production ends at its bound: checked every 30 s and when the machine wakes.
      expiryTimers: {
        every: (fn, ms) => {
          const timer = setInterval(fn, ms);
          return () => clearInterval(timer);
        },
        onResume: (fn) => {
          powerMonitor.on('resume', fn);
          return () => powerMonitor.off('resume', fn);
        },
      },
      // Leftover worktree folders of finished tasks (#115): once soon after launch, then every few minutes.
      onCleanupRetry: (retryAll) => {
        const run = () => void retryAll().catch(() => undefined);
        setTimeout(run, 20_000).unref();
        setInterval(run, CLEANUP_RETRY_EVERY_MS).unref();
      },
      finishFlushMs: 2500,
      connections,
      secrets,
      trackers: new TrackerRegistry(connections, timedFetch(telemetry)),
      telemetry,
      rememberSensitive: (values) => {
        for (const v of values) learned.add(v);
      },
      openExternal: openLink,
      revealFile: (p) => shell.showItemInFolder(p),
      openPath: (p) => shell.openPath(p),
      grantView: (f) => htmlViews.grant(f),
      docsWatcher,
      gitDirWatcher,
      reviewDir: path.join(userData, 'review'),
      store,
      git,
      platform,
      terminals,
      repos,
      // Copied env files leave out every name stored for the repo, in any environment.
      runner: new SetupRunner(git, platform, (repoId) => [
        ...new Set(secrets.list({ repoId }).map((v) => v.name)),
      ]),
      loadConfig: (p, opts) =>
        loadEffectiveConfig(
          p,
          { repos: () => repos.list(), tasks: () => store.state.tasks },
          opts,
        ),
      pickFolder: async () => {
        const r = await dialog.showOpenDialog({
          properties: ['openDirectory'],
        });
        return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
      },
      pickFile: async (defaultPath) => {
        const r = await dialog.showOpenDialog({
          defaultPath,
          properties: ['openFile', 'showHiddenFiles'],
        });
        return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
      },
      launch: (cmd) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(cmd.command, cmd.args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, ...cmd.env },
          });
          child.on('error', (e) =>
            reject(new Error(`Could not start ${cmd.command}: ${e.message}`)),
          );
          child.on('spawn', () => {
            child.unref();
            resolve();
          });
        }),
      attention,
      runs,
      stopRuns: (taskId, reason) => runs.stopForTask(taskId, reason),
      terminalEnv: (def, ctx) => {
        const port = settings.get().receiverPort;
        const env: Record<string, string> = {
          ...attentionEnv(),
          // Agent tabs only: their task's `shellie run` link and the shim on PATH.
          ...(shimsReady
            ? agentRunEnv(def.kind, {
                url: `http://127.0.0.1:${port}/v1/run`,
                token: runs.tokenFor(ctx.taskId),
                shimDir,
                env: process.env,
              })
            : {}),
        };
        if (def.kind === 'opencode') {
          // The deny entries do not depend on the plugin loading.
          const content = opencodeConfigContent(
            process.env.OPENCODE_CONFIG_CONTENT,
            opencodePluginReady ? opencodePlugin : null,
            opencodePluginReady && ctx.runNames
              ? opencodeRunInstructions(ctx.taskId, ctx.runNames)
              : undefined,
            ctx.denyPaths,
            ctx.brainDir,
            ctx.worktrees,
          );
          if (content) env.OPENCODE_CONFIG_CONTENT = content;
          else if (
            process.env.OPENCODE_CONFIG_CONTENT &&
            (ctx.denyPaths?.length || ctx.brainDir || opencodePluginReady)
          )
            console.warn(
              `[terminals] OPENCODE_CONFIG_CONTENT is not a JSON object; OpenCode starts without Shellie's config (${lostConfig(ctx.denyPaths?.length ?? 0, Boolean(ctx.brainDir))})`,
            );
        }
        return env;
      },
      broadcast: (event, payload) => {
        if (event === 'tasks:changed')
          attention.retain(new Set(terminals.ids()));
        broadcast(event, payload);
      },
    });
    registerIpc(ipcMain, trackHandlerFailures(handlers, telemetry), isMainPage);
    reporter.step(
      `Starting usage receiver 127.0.0.1:${settings.get().receiverPort}`,
    );
    lap('handlersMs');
    const receiverStarted = await receiver.start(settings.get().receiverPort);
    copilot.start();
    lap('receiverMs');
    stopUsage = () => {
      copilot.stop();
      void receiver.stop();
    };
    terminals.on('data', (id, data) =>
      broadcast('terminal:data', { id, data }),
    );
    // A moment after the exit, so output that arrives just after it (ConPTY) is in the buffer that is diagnosed.
    terminals.on('exit', (id, exitCode) =>
      setTimeout(() => {
        if (terminals.isRunning(id)) return; // restarted meanwhile
        const failure = terminalFailures.exit(id, exitCode);
        broadcast('terminal:exit', {
          id,
          exitCode,
          ...(failure ? { failure } : {}),
        });
      }, EXIT_SETTLE_MS),
    );
    terminals.on('exit', () => void copilot.poll());
    terminals.on('data', (id) => agentTimer.output(id));
    terminals.on('exit', (id) => agentTimer.close(id));
    terminals.on('data', (id, data) => attention.data(id, data));
    terminals.on('exit', (id) => attention.exit(id));
    terminals.on('data', (id) => retheme.output(id));
    terminals.on('exit', (id) => retheme.exit(id));
    nativeTheme.on('updated', () => retheme.tick());
    const retick = setInterval(() => retheme.tick(), 1000);
    const timeTick = setInterval(() => {
      tracker.tick();
      agentTimer.tick();
    }, 15_000);
    const timeFlush = setInterval(() => tracker.flush(), 60_000);
    powerMonitor.on('lock-screen', () => tracker.suspend());
    powerMonitor.on('suspend', () => tracker.suspend());
    powerMonitor.on('unlock-screen', () => tracker.resume());
    powerMonitor.on('resume', () => tracker.resume());
    stopTime = () => {
      clearInterval(timeTick);
      clearInterval(timeFlush);
      clearInterval(retick);
      // Closes the open intervals at now; will-quit waits for their writes.
      tracker.setFocused(false);
      for (const id of terminals.ids()) agentTimer.close(id);
    };
    onWindowFocus = (focused) => {
      tracker.setFocused(focused);
      attention.setFocused(focused);
      if (focused) {
        void budget.pass();
        void ledger.pass();
      }
    };

    reporter.step(
      `Checking Azure DevOps ${DOT} ${connections.list().length} connection(s)`,
    );
    mainWindow = createWindow();
    // System mode follows the OS live; a Settings change lands here too.
    nativeTheme.on('updated', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.setBackgroundColor(windowBackground(scheme()));
      if (titleBarKind(process.platform) === 'overlay')
        mainWindow.setTitleBarOverlay({
          ...chromeColors(scheme()),
          height: TITLE_BAR_HEIGHT,
        });
    });
    const win = mainWindow;
    win.webContents.once('did-finish-load', () => {
      budget.start();
      ledger.start();
      sender.start();
      stopBrainScheduler = startBrainScheduler({
        brains: () => brains.list(),
        refresh: (id) => handlers['brain:refresh'](id),
        digest: (id) => {
          brainRunner.enqueue(id, 'digest');
          void brains
            .patch(id, { lastDigestAt: new Date().toISOString() })
            .catch((err) => console.error('[brain] lastDigestAt', err));
        },
        running: (id) => brainRunner.running(id),
        picturePass: pictureHooks.picturePass,
        passRunning: pictureHooks.passRunning,
        bookPass: bookHooks.bookPass,
        bookPassRunning: bookHooks.passRunning,
      });
      const warnings = [
        loaded.recovered &&
          `state.json was unreadable and was moved to ${path.basename(loaded.backup ?? '')}. Starting empty.`,
        connectionsLoaded.recovered &&
          `connections.json was unreadable and was moved to ${path.basename(connectionsLoaded.backup ?? '')}; add your connections again.`,
        secretsLoadNotice(secretsLoaded),
        !receiverStarted.listening &&
          `AI usage capture is off: ${receiverStarted.error}. Pick another port in Settings > AI cost and invoicing.`,
        usageLoaded.damagedLines > 0 &&
          `${usageLoaded.damagedLines} damaged line(s) in the usage files were skipped.`,
        usageLoaded.billableBackup &&
          `billable.json was unreadable and was moved to ${path.basename(usageLoaded.billableBackup)}; all sessions are billable again. Review them on the Usage screen.`,
        timeLoaded.recovered &&
          `time.json was unreadable and was moved to ${path.basename(timeLoaded.backup ?? '')}; measured time starts empty.`,
        settingsLoaded.recovered &&
          `settings.json was unreadable and was moved to ${path.basename(settingsLoaded.backup ?? '')}; defaults are used.`,
        recovered > 0 &&
          `${recovered} task(s) were interrupted by a previous exit and need attention.`,
      ];
      for (const message of warnings)
        if (message) broadcast('notice', { level: 'warn', message });
    });
    await Promise.all([
      new Promise<void>((r) =>
        win.once('ready-to-show', () => {
          lap('windowMs');
          timings.readyMs = performance.now() - bootStart;
          r();
        }),
      ),
      reporter.done(),
    ]);
    reporter.step('Ready');
    await reporter.fadeOut();
    revealMain(win);
    booting = false;
    reporter.close();
    splashWin = null;
    telemetry.event(
      'app.started',
      {
        splash: settings.get().showSplash,
        repos: repos.list().length,
        openTasks: store.state.tasks.filter((t) => t.status !== 'done').length,
        connections: connections.list().length,
        receiverListening: receiverStarted.listening,
      },
      {
        ...timings,
        // From process start to the main window shown (includes splash pacing).
        visibleMs: process.uptime() * 1000,
      },
    );
    telemetry.metric('app.startup.readyMs', timings.readyMs ?? 0);
    health = startHealthReports({
      telemetry: () => telemetry,
      appMetrics: () => app.getAppMetrics(),
      terminals: () => terminals.ids().length,
    });
    if (process.env.SHELLIE_STALL_WATCHDOG !== '0') {
      const watchdog = new StallWatchdog({
        profiler: inspectorProfiler(),
        dir: path.join(app.getPath('userData'), 'diagnostics', 'stalls'),
      });
      stallWatchdog = watchdog;
      void watchdog.start();
      powerMonitor.on('suspend', () => watchdog.suspend());
      powerMonitor.on('resume', () => watchdog.resume());
    }
    updates = startAutoUpdate({
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      argv: process.argv,
      enabled: settings.get().autoUpdate,
      inApplicationsFolder: inApplicationsFolder(),
      updater: autoUpdater,
      probeFeed:
        process.platform === 'win32'
          ? (url) =>
              fetchFeedState(
                (u) => net.fetch(u, { signal: AbortSignal.timeout(20_000) }),
                url,
              )
          : undefined,
      onReady: (version) => {
        pendingUpdate = { version };
        telemetry.event('update.ready');
        broadcast('update:ready', pendingUpdate);
      },
      onCheckFailed: () => telemetry.event('update.checkFailed'),
      log: (message, error) => console.error(message, error ?? ''),
    });
    // A laptop that slept past a check, or a screen locked overnight, checks as soon as it is back (#126).
    powerMonitor.on('resume', () => updates?.wake());
    powerMonitor.on('unlock-screen', () => updates?.wake());
  } catch (e) {
    const message = errorMessage(e);
    telemetry.exception(e, { source: 'boot' }, 'critical');
    console.error(e);
    void telemetry.flush();
    if (reporter.active) {
      reporter.fail(message);
      // Closing the failed splash (Cmd+W) must not leave a windowless, half-booted app on macOS.
      splashWin?.once('closed', () => app.quit());
    } else {
      dialog.showErrorBox('Shellie could not start', message);
      app.quit();
    }
  }
}

if (process.env.SHELLIE_SMOKE === '1') {
  // Packaged-app smoke check for CI: one pty, then exit. No window, no stores, no single-instance lock.
  app
    .whenReady()
    .then(() =>
      runSmoke({
        terminals,
        platform: createPlatform(),
        log: (line) => console.error(line),
      }),
    )
    .then((ok) => {
      if (ok) console.log('SHELLIE_SMOKE_OK');
      app.exit(ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      app.exit(1);
    });
} else if (!started && !app.requestSingleInstanceLock()) {
  // A second Shellie (a double launch, or a stray relaunch of Shellie.exe) hands over to the first one.
  app.quit();
} else if (!started) {
  app.on('second-instance', () => {
    // The splash while booting (nothing when it is off: the main window is still hidden), else the main window.
    const win = booting ? splashWin : mainWindow;
    const target = win && !win.isDestroyed() ? win : null;
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.focus();
  });
  app
    .whenReady()
    .then(() => {
      // Packaged macOS builds get the icon from the bundle; in dev the Dock shows Electron's.
      if (process.platform === 'darwin' && !app.isPackaged)
        app.dock?.setIcon(icon);
      const menu = appMenu(process.platform, app.isPackaged);
      if (menu.kind === 'template')
        Menu.setApplicationMenu(Menu.buildFromTemplate(menu.template));
      else if (menu.kind === 'none') Menu.setApplicationMenu(null);
      return boot();
    })
    // boot reports its own failures on the splash; this catches the ones before it exists (settings load).
    .catch((e) => {
      console.error(e);
      app.quit();
    });
}

app.on('activate', () => {
  // During boot the main window is created (with its handlers) by boot itself.
  if (booting || BrowserWindow.getAllWindows().length > 0) return;
  const w = createWindow();
  w.once('ready-to-show', () => w.show());
  mainWindow = w;
});

app.on('window-all-closed', () => {
  // A splash that closes or dies before the main window exists must not end the boot.
  if (booting) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopTime();
  docsWatcher.stopAll();
  gitDirWatcher.stopAll();
  for (const id of terminals.ids()) terminals.kill(id);
  stopUsage();
  stopBudget();
  stopLedger();
  stopBrains();
  updates?.stop();
  stallWatchdog?.stop();
});

let quitHeld = false;
app.on('will-quit', (e) => {
  // Hold the quit for the last time writes and one best-effort telemetry send (at most 2 s), then exit.
  const sendTelemetry = telemetry !== NoopTelemetry;
  if (quitHeld || (!sendTelemetry && timeWrites.size === 0)) return;
  quitHeld = true;
  e.preventDefault();
  if (sendTelemetry) health?.report();
  if (sendTelemetry)
    telemetry.event('app.quit', undefined, {
      sessionMinutes: (Date.now() - sessionStart) / 60_000,
    });
  void Promise.race([
    Promise.allSettled([
      ...timeWrites,
      ...(sendTelemetry ? [telemetry.flush()] : []),
    ]),
    sleep(2000),
  ]).finally(() => app.exit(0));
});
