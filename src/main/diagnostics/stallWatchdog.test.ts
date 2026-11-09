import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BEAT_MS,
  inspectorProfiler,
  KEEP_FILES,
  LEAD_IN_MS,
  ROTATE_MS,
  type CpuProfile,
  StallWatchdog,
  STALL_MS,
  trimToLast,
} from './stallWatchdog';

/** A profile of 10 s in 1 s samples: node 2 runs for 7 s, then node 3 (the stall) for 3 s. */
const profile = (): CpuProfile => ({
  nodes: [
    { id: 1, hitCount: 0, callFrame: { functionName: '(root)' } },
    { id: 2, hitCount: 7, callFrame: { functionName: 'idleWork' } },
    { id: 3, hitCount: 3, callFrame: { functionName: 'blocker' } },
  ],
  startTime: 0,
  endTime: 10_000_000,
  samples: [2, 2, 2, 2, 2, 2, 2, 3, 3, 3],
  timeDeltas: Array<number>(10).fill(1_000_000),
});

describe('trimToLast', () => {
  it('keeps only the samples of the last stretch, with hit counts to match', () => {
    const t = trimToLast(profile(), 3000);
    expect(t.samples).toEqual([3, 3, 3]);
    expect(t.timeDeltas).toEqual([1_000_000, 1_000_000, 1_000_000]);
    expect(t.startTime).toBe(7_000_000);
    expect(t.endTime).toBe(10_000_000);
    expect(t.nodes.map((n) => n.hitCount)).toEqual([0, 0, 3]);
  });

  it('leaves a profile shorter than the stretch whole', () => {
    expect(trimToLast(profile(), 60_000).samples).toHaveLength(10);
  });
});

describe('StallWatchdog', () => {
  let dir: string;
  let clock: number;
  let watchdog: StallWatchdog | null;
  const profiler = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => profile()),
    dispose: vi.fn(),
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'shellie-stall-'));
    clock = 0;
    watchdog = null;
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(async () => {
    watchdog?.stop();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  const launch = async (p: typeof profiler = profiler) => {
    watchdog = new StallWatchdog({
      profiler: p,
      dir,
      now: () => clock,
      log: () => undefined,
    });
    await watchdog.start();
  };
  /** Time passes with the event loop running: the heartbeat keeps up. */
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += BEAT_MS) {
      clock += BEAT_MS;
      vi.advanceTimersByTime(BEAT_MS);
    }
  };
  /** The event loop is blocked for `ms`, then the next heartbeat comes through. */
  const stall = (ms: number) => {
    clock += ms;
    run(BEAT_MS);
  };
  const saved = () =>
    vi.waitFor(async () => {
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      return files[0];
    });

  it('saves a profile named after a stall of the threshold or longer', async () => {
    await launch();
    run(5000);
    stall(STALL_MS + 500);
    expect(await saved()).toMatch(
      new RegExp(`^stall-.*-${STALL_MS + 500}ms\\.cpuprofile$`),
    );
  });

  it('saves only the stall and a short lead-in', async () => {
    await launch();
    run(5000);
    stall(1000);
    const file = await saved();
    const p = JSON.parse(
      await readFile(path.join(dir, file), 'utf8'),
    ) as CpuProfile;
    expect(p.endTime - p.startTime).toBeLessThanOrEqual(
      (1000 + LEAD_IN_MS) * 1000,
    );
  });

  it('profiles again after a stall', async () => {
    await launch();
    stall(STALL_MS);
    await saved();
    await vi.waitFor(() => expect(profiler.start).toHaveBeenCalledTimes(2));
  });

  it('saves nothing for delays under the threshold', async () => {
    await launch();
    stall(STALL_MS - 1);
    run(1000);
    await new Promise((r) => setTimeout(r, 20));
    expect(profiler.stop).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it('restarts the profiler every rotation without saving', async () => {
    await launch();
    run(ROTATE_MS + BEAT_MS);
    await vi.waitFor(() => expect(profiler.start).toHaveBeenCalledTimes(2));
    expect(profiler.stop).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('does not take a suspended machine for a stall', async () => {
    await launch();
    watchdog!.suspend();
    clock += 3_600_000;
    run(BEAT_MS);
    watchdog!.resume();
    run(1000);
    await new Promise((r) => setTimeout(r, 20));
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps only the newest files', async () => {
    for (let i = 0; i < KEEP_FILES + 3; i++)
      await writeFile(
        path.join(
          dir,
          `stall-2020-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z-1000ms.cpuprofile`,
        ),
        '{}',
      );
    await launch();
    stall(STALL_MS);
    await vi.waitFor(async () => {
      const files = (await readdir(dir)).sort();
      expect(files).toHaveLength(KEEP_FILES);
      expect(files).not.toContain(
        'stall-2020-01-01T00-00-00-000Z-1000ms.cpuprofile',
      );
    });
  });

  it('keeps watching when a profile cannot be saved', async () => {
    const file = path.join(dir, 'not-a-folder');
    await writeFile(file, '');
    watchdog = new StallWatchdog({
      profiler,
      dir: file,
      now: () => clock,
      log: () => undefined,
    });
    await watchdog.start();
    stall(STALL_MS);
    await vi.waitFor(() => expect(profiler.start).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    stall(STALL_MS);
    await vi.waitFor(() => expect(profiler.stop).toHaveBeenCalledTimes(2));
  });

  it('stands down when the profiler cannot start', async () => {
    await launch({
      ...profiler,
      start: vi.fn(async () => {
        throw new Error('no inspector');
      }),
    });
    stall(STALL_MS);
    await new Promise((r) => setTimeout(r, 20));
    expect(profiler.stop).not.toHaveBeenCalled();
  });

  it('stops beating and releases the profiler on stop', async () => {
    await launch();
    watchdog!.stop();
    stall(STALL_MS);
    await new Promise((r) => setTimeout(r, 20));
    expect(profiler.stop).not.toHaveBeenCalled();
    expect(profiler.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('inspectorProfiler', () => {
  it('records samples of this process', async () => {
    const p = inspectorProfiler();
    await p.start();
    const end = performance.now() + 150;
    while (performance.now() < end);
    const profile = await p.stop();
    p.dispose();
    expect(profile.samples.length).toBeGreaterThan(0);
    expect(profile.nodes.length).toBeGreaterThan(0);
  });
});
