/**
 * Auto-update for packaged Windows builds (Squirrel.Windows) and packaged macOS builds (Squirrel.Mac), fed by
 * update.electronjs.org.
 *
 * update.electronjs.org reads the GitHub Releases of a public repo: the newest non-draft, non-prerelease
 * release with a semver tag. On Windows it needs an `.exe` asset, plus its `RELEASES` file and the `.nupkg`
 * that file names; Electron's autoUpdater fetches `<feed>/RELEASES`, downloads the package in the background
 * and Squirrel runs the new version on the next start. On macOS it needs a `darwin` zip asset (the app,
 * signed with the same identity as the installed one, which Squirrel.Mac checks), and the app must run from
 * /Applications (a translocated or read-only location cannot replace itself). `quitAndInstall` applies it
 * right away. When a download is
 * ready, `onReady` tells the app, which offers Restart and update in a quiet in-app card (no modal dialog).
 *
 * Checks keep running after a download (#126): every merge to main is a release, so a newer one often appears
 * while a downloaded one waits for a restart. Squirrel then downloads the newer package as well, `onReady`
 * reports the newer version and the restart starts that one. Before #126 the checks stopped at the first
 * download, so an app left open (Later) never saw the releases after it.
 *
 * Everything Electron-specific is injected, so this module is testable without Electron.
 */

export const UPDATE_REPO = 'UnreliableWitness/Shellie';
export const UPDATE_SERVER = 'https://update.electronjs.org';
/** First check after start: lets the boot and the first terminals settle. */
export const FIRST_CHECK_DELAY_MS = 30 * 1000;
/**
 * The interval update.electronjs.org's README uses (and update-electron-app's default). The service caches a
 * repo's latest release for 15 minutes (`CACHE_TTL`), so a new release reaches an open app within about 25.
 */
export const CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** A resume or unlock checks at once, but not more often than this (update-electron-app's minimum interval). */
export const MIN_WAKE_GAP_MS = 5 * 60 * 1000;
/**
 * A check (with its download) that gave no result for this long is treated as lost, so a missed event or a
 * hung Update.exe can never stop the checks for good.
 */
export const STUCK_CHECK_MS = 30 * 60 * 1000;
/** Squirrel passes this on the launch right after install, while it still holds its update lock. */
export const SQUIRREL_FIRSTRUN = '--squirrel-firstrun';

/** The subset of Electron's autoUpdater this module uses. */
export type UpdaterLike = {
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): unknown;
  quitAndInstall(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'checking-for-update' | 'update-available' | 'update-not-available',
    listener: () => void,
  ): unknown;
  on(
    event: 'update-downloaded',
    listener: (
      event: unknown,
      releaseNotes: string,
      releaseName: string,
    ) => void,
  ): unknown;
};

export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export type AutoUpdateDeps = {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  version: string;
  argv: readonly string[];
  /** The `autoUpdate` setting; undefined means on. */
  enabled: boolean | undefined;
  /** macOS only: the app runs from /Applications (undefined counts as false). */
  inApplicationsFolder?: boolean;
  updater: UpdaterLike;
  /** A downloaded update is ready; `version` is parsed from the release name, null when it has none. */
  onReady(version: string | null): void;
  /** The first failed check of this launch (later ones are only logged). */
  onCheckFailed?(): void;
  log(message: string, error?: unknown): void;
  timers?: Timers;
  now?: () => number;
};

export type AutoUpdate = {
  stop(): void;
  /** Quits and starts the downloaded update; false (and nothing happens) when none is downloaded. */
  install(): boolean;
  /** The system resumed or the screen unlocked: check now, unless a check ran in the last few minutes. */
  wake(): void;
};

/** "Shellie v1.0.3 (unsigned)" -> "1.0.3"; null when the name holds no version. */
export function releaseVersion(name: string | undefined): string | null {
  return name?.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0] ?? null;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export function updateFeedUrl(
  platform: NodeJS.Platform,
  arch: string,
  version: string,
): string {
  return `${UPDATE_SERVER}/${UPDATE_REPO}/${platform}-${arch}/${version}`;
}

type UpdateGate = Pick<
  AutoUpdateDeps,
  'isPackaged' | 'platform' | 'enabled' | 'inApplicationsFolder'
>;

/** Installed (packaged) Windows builds and packaged macOS builds in /Applications update; dev runs never do. */
export function canAutoUpdate(d: UpdateGate): boolean {
  if (!d.isPackaged || d.enabled === false) return false;
  if (d.platform === 'win32') return true;
  return d.platform === 'darwin' && d.inApplicationsFolder === true;
}

/** A packaged macOS build outside /Applications that would otherwise update: the app should offer to move. */
export function needsMoveToApplications(d: UpdateGate): boolean {
  return (
    d.isPackaged &&
    d.platform === 'darwin' &&
    d.enabled !== false &&
    d.inApplicationsFolder !== true
  );
}

/**
 * Starts the update checks, or returns null when this build does not update.
 * On a Squirrel first run the start-up check is skipped (Squirrel holds a lock); the periodic check still runs.
 */
export function startAutoUpdate(d: AutoUpdateDeps): AutoUpdate | null {
  if (!canAutoUpdate(d)) return null;
  const timers = d.timers ?? realTimers;
  const now = d.now ?? Date.now;
  let readyVersion: string | null | undefined;
  let stopped = false;
  let failedOnce = false;
  /** When the running check started; null when none runs. */
  let runningSince: number | null = null;
  let lastCheckAt = -Infinity;

  try {
    d.updater.setFeedURL({ url: updateFeedUrl(d.platform, d.arch, d.version) });
  } catch (e) {
    d.log('[update] could not set the feed URL', e);
    return null;
  }

  const finished = () => {
    runningSince = null;
  };
  d.updater.on('update-not-available', finished);
  d.updater.on('error', (e) => {
    finished();
    d.log('[update] check failed', e);
    if (!failedOnce) {
      failedOnce = true;
      d.onCheckFailed?.();
    }
  });
  d.updater.on('update-downloaded', (_event, _notes, releaseName) => {
    finished();
    if (stopped) return;
    const version = releaseVersion(releaseName);
    if (readyVersion !== undefined && readyVersion === version) return;
    readyVersion = version;
    d.onReady(version);
  });

  const check = () => {
    if (stopped) return;
    const at = now();
    if (runningSince !== null) {
      if (at - runningSince < STUCK_CHECK_MS) return;
      d.log('[update] the last check gave no result; checking again');
    }
    runningSince = at;
    lastCheckAt = at;
    try {
      // Electron's checkForUpdates is async and reports failures through 'error'.
      d.updater.checkForUpdates();
    } catch (e) {
      finished();
      d.log('[update] check failed', e);
    }
  };

  const firstRun = d.argv.includes(SQUIRREL_FIRSTRUN);
  const first = firstRun
    ? null
    : timers.setTimeout(check, FIRST_CHECK_DELAY_MS);
  const periodic = timers.setInterval(check, CHECK_INTERVAL_MS);

  function stop() {
    stopped = true;
    if (first !== null) timers.clearTimeout(first);
    timers.clearInterval(periodic);
  }
  const install = () => {
    if (readyVersion === undefined) return false;
    d.updater.quitAndInstall();
    return true;
  };
  const wake = () => {
    if (now() - lastCheckAt < MIN_WAKE_GAP_MS) return;
    check();
  };
  return { stop, install, wake };
}
