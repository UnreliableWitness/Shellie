import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainSchema, type Brain } from '../../shared/brain';
import { startBrainScheduler } from './scheduler';

const wiki = {
  wikiId: 'w',
  wikiName: 'w',
  type: 'projectWiki' as const,
  repositoryId: 'r',
  gitUrl: 'https://dev.azure.com/o/p/_git/p.wiki',
  version: 'wikiMaster',
  mappedPath: '/',
  rootPath: '/',
};

const brain = (over: Partial<Brain>): Brain =>
  BrainSchema.parse({
    id: 'b',
    name: 'B',
    connectionId: 'c',
    project: 'p',
    path: '/x',
    createdAt: 't',
    ...over,
  });

describe('startBrainScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refreshes stale mirrors and enqueues a Monday digest once', async () => {
    // Monday 2026-11-02, 09:00 local.
    let now = new Date(2026, 10, 2, 9, 0);
    const brains = [
      brain({
        id: 'stale',
        wiki,
        lastRefreshAt: new Date(2026, 10, 1, 8, 0).toISOString(),
      }),
      brain({
        id: 'fresh',
        wiki,
        lastRefreshAt: new Date(2026, 10, 2, 8, 0).toISOString(),
      }),
      brain({ id: 'never', wiki }),
      brain({ id: 'nowiki' }),
      brain({
        id: 'digest',
        options: { weeklyDigest: true } as Brain['options'],
        lastDigestAt: new Date(2026, 9, 26, 9, 0).toISOString(),
      }),
      brain({
        id: 'busy',
        options: { weeklyDigest: true } as Brain['options'],
      }),
      brain({
        id: 'done',
        options: { weeklyDigest: true } as Brain['options'],
        lastDigestAt: new Date(2026, 10, 2, 0, 30).toISOString(),
      }),
    ];
    const refresh = vi.fn(async (_id: string) => undefined);
    const digest = vi.fn();
    const stop = startBrainScheduler({
      brains: () => brains,
      refresh,
      digest,
      running: (id) => id === 'busy',
      picturePass: async () => undefined,
      passRunning: () => false,
      now: () => now,
      tick: 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh.mock.calls.map((c) => c[0]).sort()).toEqual([
      'never',
      'stale',
    ]);
    expect(digest.mock.calls).toEqual([['digest']]);

    // Next tick: the digest is not enqueued again although lastDigestAt did not change.
    refresh.mockClear();
    now = new Date(2026, 10, 2, 9, 15);
    await vi.advanceTimersByTimeAsync(1000);
    expect(digest).toHaveBeenCalledTimes(1);

    // Tuesday, same week: enqueued already this week, nothing again.
    digest.mockClear();
    now = new Date(2026, 10, 3, 9, 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(digest).not.toHaveBeenCalled();

    stop();
    refresh.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('catches up a missed Monday digest on a later day of the week', async () => {
    // Tuesday 2026-11-03, 09:00 local; Monday was 2026-11-02.
    const now = new Date(2026, 10, 3, 9, 0);
    const digest = vi.fn();
    const stop = startBrainScheduler({
      brains: () => [
        brain({
          id: 'missed',
          options: { weeklyDigest: true } as Brain['options'],
          lastDigestAt: new Date(2026, 9, 27, 9, 0).toISOString(),
        }),
        brain({
          id: 'never',
          options: { weeklyDigest: true } as Brain['options'],
        }),
        brain({
          id: 'had',
          options: { weeklyDigest: true } as Brain['options'],
          lastDigestAt: new Date(2026, 10, 2, 10, 0).toISOString(),
        }),
        brain({ id: 'off', lastDigestAt: null }),
      ],
      refresh: vi.fn(async () => undefined),
      digest,
      running: () => false,
      picturePass: async () => undefined,
      passRunning: () => false,
      now: () => now,
      tick: 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(digest.mock.calls.map((c) => c[0]).sort()).toEqual([
      'missed',
      'never',
    ]);
    stop();
  });

  it('does not refresh a brain again while its refresh is in flight', async () => {
    const now = new Date(2026, 10, 3, 9, 0);
    let finish: () => void = () => undefined;
    const refresh = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const stop = startBrainScheduler({
      brains: () => [brain({ id: 'a', wiki })],
      refresh,
      digest: vi.fn(),
      running: () => false,
      picturePass: async () => undefined,
      passRunning: () => false,
      now: () => now,
      tick: 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it('backs off a failed refresh for an hour, rejected or ok: false', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let now = new Date(2026, 10, 3, 9, 0);
    const refresh = vi.fn(async (id: string) => {
      if (id === 'a') throw new Error('offline');
      return { ok: false, message: 'unauthorized' };
    });
    const stop = startBrainScheduler({
      brains: () => [brain({ id: 'a', wiki }), brain({ id: 'b', wiki })],
      refresh,
      digest: vi.fn(),
      running: () => false,
      picturePass: async () => undefined,
      passRunning: () => false,
      now: () => now,
      tick: 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    now = new Date(2026, 10, 3, 9, 59);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    now = new Date(2026, 10, 3, 10, 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'a', 'b']);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    stop();
  });
});

describe('archived brains', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('get no scheduled refresh or digest', async () => {
    vi.setSystemTime(new Date(2026, 10, 2, 9, 0));
    const refreshed: string[] = [];
    const digested: string[] = [];
    const stop = startBrainScheduler({
      brains: () => [
        brain({
          id: 'archived',
          wiki,
          archived: true,
          options: { weeklyDigest: true } as Brain['options'],
        }),
        brain({
          id: 'live',
          wiki,
          options: { weeklyDigest: true } as Brain['options'],
        }),
      ],
      refresh: async (id) => {
        refreshed.push(id);
        return { ok: true };
      },
      digest: (id) => digested.push(id),
      running: () => false,
      picturePass: async () => undefined,
      passRunning: () => false,
    });
    await vi.advanceTimersByTimeAsync(10);
    stop();
    expect(refreshed).toEqual(['live']);
    expect(digested).toEqual(['live']);
  });
});

describe('the one-time picture pass', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const started = {
    startedAt: 's',
    total: 2,
    done: [],
    finishedAt: null,
  };

  it('starts or resumes it only for live brains on templates v6 with no pass job pending', async () => {
    const picturePass = vi.fn(async (_id: string) => undefined);
    const stop = startBrainScheduler({
      brains: () => [
        brain({ id: 'new', templatesVersion: 6 }),
        brain({ id: 'resume', templatesVersion: 6, picturePass: started }),
        brain({ id: 'v5', templatesVersion: 5 }),
        brain({ id: 'archived', templatesVersion: 6, archived: true }),
        brain({
          id: 'finished',
          templatesVersion: 6,
          picturePass: { ...started, finishedAt: 'f' },
        }),
        brain({ id: 'pending', templatesVersion: 6, picturePass: started }),
      ],
      refresh: vi.fn(async () => undefined),
      digest: vi.fn(),
      running: () => false,
      picturePass,
      passRunning: (id) => id === 'pending',
      tick: 1000,
    });
    // Not on the launch check: from the next tick on.
    await vi.advanceTimersByTimeAsync(0);
    expect(picturePass).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(picturePass.mock.calls.map((c) => c[0])).toEqual(['new', 'resume']);
    stop();
  });

  it('does not start it twice while a call is in flight, and logs a failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail: (e: Error) => void = () => undefined;
    const picturePass = vi.fn(
      () => new Promise<void>((_r, rej) => (fail = rej)),
    );
    const stop = startBrainScheduler({
      brains: () => [brain({ id: 'a', templatesVersion: 6 })],
      refresh: vi.fn(async () => undefined),
      digest: vi.fn(),
      running: () => false,
      picturePass,
      passRunning: () => false,
      tick: 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(picturePass).toHaveBeenCalledTimes(1);
    fail(new Error('git'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(picturePass).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
    stop();
  });
});
