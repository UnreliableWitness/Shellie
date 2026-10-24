import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  MIN_WAKE_GAP_MS,
  STUCK_CHECK_MS,
  canAutoUpdate,
  needsMoveToApplications,
  releaseVersion,
  startAutoUpdate,
  updateFeedUrl,
  type AutoUpdateDeps,
  type Timers,
} from './autoUpdate';

function fakeTimers() {
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  let seq = 0;
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      timeouts.set(++seq, { fn, ms });
      return seq;
    },
    clearTimeout: (h) => void timeouts.delete(h as number),
    setInterval: (fn, ms) => {
      intervals.set(++seq, { fn, ms });
      return seq;
    },
    clearInterval: (h) => void intervals.delete(h as number),
  };
  return { timers, timeouts, intervals };
}

function setup(over: Partial<AutoUpdateDeps> = {}) {
  const listeners = new Map<string, (...a: unknown[]) => void>();
  const updater = {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, fn: (...a: unknown[]) => void) => {
      listeners.set(event, fn);
    }),
  };
  const t = fakeTimers();
  const clock = { now: 1_000_000 };
  const deps: AutoUpdateDeps = {
    isPackaged: true,
    platform: 'win32',
    arch: 'x64',
    version: '1.2.3',
    argv: ['Shellie.exe'],
    enabled: undefined,
    updater,
    onReady: vi.fn(),
    onCheckFailed: vi.fn(),
    log: vi.fn(),
    timers: t.timers,
    now: () => clock.now,
    ...over,
  };
  const handle = startAutoUpdate(deps);
  const emit = (event: string, ...args: unknown[]) =>
    listeners.get(event)?.(...args);
  const tick = () => [...t.intervals.values()][0].fn();
  return { deps, updater, handle, emit, clock, tick, ...t };
}

describe('updateFeedUrl', () => {
  it('points at update.electronjs.org for this repo, platform-arch and version', () => {
    expect(updateFeedUrl('win32', 'x64', '1.2.3')).toBe(
      'https://update.electronjs.org/UnreliableWitness/Shellie/win32-x64/1.2.3',
    );
  });
});

describe('canAutoUpdate', () => {
  it('is on only for packaged Windows builds that did not turn it off', () => {
    const base = { isPackaged: true, platform: 'win32' as const };
    expect(canAutoUpdate({ ...base, enabled: undefined })).toBe(true);
    expect(canAutoUpdate({ ...base, enabled: true })).toBe(true);
    expect(canAutoUpdate({ ...base, enabled: false })).toBe(false);
    expect(
      canAutoUpdate({ ...base, isPackaged: false, enabled: undefined }),
    ).toBe(false);
  });

  it('is on for packaged Windows builds and packaged macOS builds in Applications', () => {
    expect(canAutoUpdate({ isPackaged: true, platform: 'win32', enabled: undefined })).toBe(true);
    expect(canAutoUpdate({ isPackaged: true, platform: 'darwin', enabled: undefined, inApplicationsFolder: true })).toBe(true);
    expect(canAutoUpdate({ isPackaged: true, platform: 'darwin', enabled: undefined, inApplicationsFolder: false })).toBe(false);
    expect(canAutoUpdate({ isPackaged: true, platform: 'darwin', enabled: undefined })).toBe(false);
    expect(canAutoUpdate({ isPackaged: true, platform: 'darwin', enabled: false, inApplicationsFolder: true })).toBe(false);
    expect(canAutoUpdate({ isPackaged: false, platform: 'darwin', enabled: undefined, inApplicationsFolder: true })).toBe(false);
    expect(canAutoUpdate({ isPackaged: true, platform: 'linux', enabled: undefined, inApplicationsFolder: true })).toBe(false);
  });
});

describe('needsMoveToApplications', () => {
  it('asks to move only packaged macOS builds outside Applications that would update', () => {
    expect(needsMoveToApplications({ isPackaged: true, platform: 'darwin', enabled: undefined, inApplicationsFolder: false })).toBe(true);
    expect(needsMoveToApplications({ isPackaged: true, platform: 'darwin', enabled: undefined, inApplicationsFolder: true })).toBe(false);
    expect(needsMoveToApplications({ isPackaged: true, platform: 'darwin', enabled: false, inApplicationsFolder: false })).toBe(false);
    expect(needsMoveToApplications({ isPackaged: false, platform: 'darwin', enabled: undefined, inApplicationsFolder: false })).toBe(false);
    expect(needsMoveToApplications({ isPackaged: true, platform: 'win32', enabled: undefined, inApplicationsFolder: false })).toBe(false);
  });
});

describe('startAutoUpdate', () => {
  it('does nothing in dev, on macOS outside Applications or when turned off', () => {
    for (const over of [
      { isPackaged: false },
      { platform: 'darwin' as const, arch: 'arm64' },
      { platform: 'darwin' as const, arch: 'arm64', inApplicationsFolder: false },
      { enabled: false },
    ]) {
      const { handle, updater, timeouts, intervals } = setup(over);
      expect(handle).toBeNull();
      expect(updater.setFeedURL).not.toHaveBeenCalled();
      expect(timeouts.size + intervals.size).toBe(0);
    }
  });

  it('on macOS in Applications: sets the darwin-arm64 feed and checks after the first delay', () => {
    const { updater, timeouts } = setup({
      platform: 'darwin',
      arch: 'arm64',
      version: '1.2.0',
      inApplicationsFolder: true,
    });
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      url: updateFeedUrl('darwin', 'arm64', '1.2.0'),
    });
    const [first] = [...timeouts.values()];
    expect(first.ms).toBe(FIRST_CHECK_DELAY_MS);
    first.fn();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('sets the feed, checks after a short delay and then every interval', () => {
    const { updater, timeouts, intervals, emit, tick } = setup();
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      url: 'https://update.electronjs.org/UnreliableWitness/Shellie/win32-x64/1.2.3',
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    const [first] = [...timeouts.values()];
    expect(first.ms).toBe(FIRST_CHECK_DELAY_MS);
    first.fn();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    emit('checking-for-update');
    emit('update-not-available');
    const [every] = [...intervals.values()];
    expect(every.ms).toBe(CHECK_INTERVAL_MS);
    tick();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('checks every 10 minutes, the interval update.electronjs.org documents', () => {
    expect(CHECK_INTERVAL_MS).toBe(10 * 60 * 1000);
  });

  it('skips the start-up check on a Squirrel first run but keeps the periodic one', () => {
    const { timeouts, intervals } = setup({
      argv: ['Shellie.exe', '--squirrel-firstrun'],
    });
    expect(timeouts.size).toBe(0);
    expect(intervals.size).toBe(1);
  });

  it('logs check errors without a notice', () => {
    const { emit, deps, updater, timeouts } = setup();
    emit('error', new Error('offline'));
    updater.checkForUpdates.mockImplementation(() => {
      throw new Error('not installed by Squirrel');
    });
    [...timeouts.values()][0].fn();
    expect(deps.log).toHaveBeenCalledTimes(2);
    expect(deps.onReady).not.toHaveBeenCalled();
  });

  it('reports a failed check once per launch', () => {
    const { emit, deps } = setup();
    emit('error', new Error('offline'));
    emit('error', new Error('offline'));
    expect(deps.onCheckFailed).toHaveBeenCalledTimes(1);
  });

  it('keeps checking after errors', () => {
    const { emit, updater, tick } = setup();
    for (let i = 0; i < 3; i++) {
      tick();
      emit('checking-for-update');
      emit('error', new Error('offline'));
    }
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it('on download: reports it ready once per version and installs only when asked', () => {
    const { emit, deps, updater, handle } = setup();
    expect(handle?.install()).toBe(false);
    emit('update-downloaded', {}, '', '1.3.0');
    emit('update-downloaded', {}, '', '1.3.0');
    expect(deps.onReady).toHaveBeenCalledTimes(1);
    expect(deps.onReady).toHaveBeenCalledWith('1.3.0');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(handle?.install()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('keeps checking after a download, so a newer release replaces the waiting one (#126)', () => {
    const { emit, deps, updater, intervals, tick } = setup();
    tick();
    emit('checking-for-update');
    emit('update-available');
    emit('update-downloaded', {}, '', '1.3.0');
    expect(intervals.size).toBe(1);
    tick();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    emit('checking-for-update');
    emit('update-available');
    emit('update-downloaded', {}, '', '1.4.0');
    expect(deps.onReady).toHaveBeenCalledTimes(2);
    expect(deps.onReady).toHaveBeenLastCalledWith('1.4.0');
  });

  it('does not start a check while one runs (a slow download), until it looks stuck', () => {
    const { emit, deps, updater, clock, tick } = setup();
    tick();
    emit('checking-for-update');
    emit('update-available');
    clock.now += CHECK_INTERVAL_MS;
    tick();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    clock.now += STUCK_CHECK_MS;
    tick();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('no result'));
  });

  it('a check that throws frees the next one', () => {
    const { updater, tick } = setup();
    updater.checkForUpdates.mockImplementationOnce(() => {
      throw new Error('not installed by Squirrel');
    });
    tick();
    tick();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('wake() checks after a resume or unlock, at most once per 5 minutes', () => {
    const { emit, updater, handle, clock } = setup();
    expect(MIN_WAKE_GAP_MS).toBe(5 * 60 * 1000);
    handle?.wake();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    emit('checking-for-update');
    emit('update-not-available');
    clock.now += MIN_WAKE_GAP_MS - 1;
    handle?.wake();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    clock.now += 1;
    handle?.wake();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('stop() cancels the timers and later wakes', () => {
    const { handle, timeouts, intervals, updater } = setup();
    handle?.stop();
    expect(timeouts.size + intervals.size).toBe(0);
    handle?.wake();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
});

describe('releaseVersion', () => {
  it('finds the version in a release name, or gives null', () => {
    expect(releaseVersion('Shellie v1.0.3 (unsigned)')).toBe('1.0.3');
    expect(releaseVersion('1.2.0-beta.1')).toBe('1.2.0-beta.1');
    expect(releaseVersion('')).toBeNull();
    expect(releaseVersion(undefined)).toBeNull();
  });
});
