import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector';
import path from 'node:path';

/** How often the event loop proves it is alive. */
export const BEAT_MS = 250;
/** A heartbeat this late is a stall worth a profile. */
export const STALL_MS = 1000;
/** How often the profile so far is thrown away: a restart costs the main process about 100 ms. */
export const ROTATE_MS = 10 * 60 * 1000;
/** How much of what ran before a stall is kept in its profile. */
export const LEAD_IN_MS = 2000;
export const KEEP_FILES = 20;
const SAMPLING_US = 20_000;

/** The fields of a V8 CPU profile this module uses; a saved file is the whole profile, which DevTools opens. */
export type CpuProfile = {
  nodes: {
    id: number;
    hitCount?: number;
    callFrame: { functionName: string };
  }[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
};

export type Profiler = {
  start(): Promise<void>;
  stop(): Promise<CpuProfile>;
  dispose(): void;
};

/** The profile cut to its last `ms`, so a stall is not buried in the minutes of normal work before it. */
export function trimToLast(p: CpuProfile, ms: number): CpuProfile {
  let kept = 0;
  let from = p.timeDeltas.length;
  while (from > 0 && kept + p.timeDeltas[from - 1] <= ms * 1000)
    kept += p.timeDeltas[--from];
  if (from === 0) return p;
  const samples = p.samples.slice(from);
  const hits = new Map<number, number>();
  for (const id of samples) hits.set(id, (hits.get(id) ?? 0) + 1);
  return {
    ...p,
    nodes: p.nodes.map((n) => ({ ...n, hitCount: hits.get(n.id) ?? 0 })),
    startTime: p.endTime - kept,
    samples,
    timeDeltas: p.timeDeltas.slice(from),
  };
}

/** V8's sampling profiler on this process. It samples from its own thread, so it sees what a blocked main thread is stuck in. */
export function inspectorProfiler(): Profiler {
  const session = new Session();
  let connected = false;
  const post = <T>(method: string, params?: object) =>
    new Promise<T>((resolve, reject) => {
      session.post(method, params, (e: Error | null, r?: object) => {
        if (e) reject(e);
        else resolve(r as T);
      });
    });
  return {
    async start() {
      if (!connected) {
        session.connect();
        connected = true;
        await post('Profiler.enable');
        await post('Profiler.setSamplingInterval', { interval: SAMPLING_US });
      }
      await post('Profiler.start');
    },
    async stop() {
      const r = await post<{ profile: CpuProfile }>('Profiler.stop');
      return r.profile;
    },
    dispose() {
      if (connected) session.disconnect();
      connected = false;
    },
  };
}

export type StallWatchdogDeps = {
  profiler: Profiler;
  /** Where the `.cpuprofile` files go. They stay on this machine: nothing here is sent anywhere. */
  dir: string;
  now?: () => number;
  log?: (message: string, error: unknown) => void;
};

/**
 * Keeps a CPU profile of the main process running and saves it when the event loop stalls, because a blocked
 * main process freezes the whole window and leaves no trace of why. Profiling has to be on before the stall:
 * nothing can start it during a blocking native call.
 */
export class StallWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private startedAt = 0;
  private busy = false;
  private suspended = false;
  private readonly now: () => number;
  private readonly log: (message: string, error: unknown) => void;

  constructor(private readonly d: StallWatchdogDeps) {
    this.now = d.now ?? (() => performance.now());
    this.log = d.log ?? ((m, e) => console.warn(`[stall] ${m}`, e));
  }

  /** Does nothing further when the profiler cannot run: the watchdog must never cost the app anything. */
  async start(): Promise<void> {
    try {
      await this.d.profiler.start();
    } catch (e) {
      this.log('could not start the profiler', e);
      return;
    }
    this.last = this.startedAt = this.now();
    this.timer = setInterval(() => this.beat(), BEAT_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.d.profiler.dispose();
  }

  /** The machine is going to sleep: the gap until `resume` is not a stall. */
  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
    this.last = this.now();
  }

  private beat() {
    const t = this.now();
    const late = t - this.last - BEAT_MS;
    this.last = t;
    if (this.busy || this.suspended) return;
    if (late >= STALL_MS) void this.cycle(Math.round(late));
    else if (t - this.startedAt >= ROTATE_MS) void this.cycle(null);
  }

  /** Restarts the profiler before touching the disk, so a slow write leaves no gap in the next profile. */
  private async cycle(stalledMs: number | null) {
    this.busy = true;
    let profile: CpuProfile;
    try {
      profile = await this.d.profiler.stop();
      if (!this.timer) return;
      await this.d.profiler.start();
      this.startedAt = this.now();
    } catch (e) {
      this.log('the profiler failed, stopping the watchdog', e);
      this.stop();
      return;
    } finally {
      this.busy = false;
    }
    if (stalledMs !== null) await this.save(profile, stalledMs);
  }

  private async save(profile: CpuProfile, stalledMs: number) {
    try {
      await mkdir(this.d.dir, { recursive: true });
      const at = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFile(
        path.join(this.d.dir, `stall-${at}-${stalledMs}ms.cpuprofile`),
        JSON.stringify(trimToLast(profile, stalledMs + LEAD_IN_MS)),
      );
      const files = (await readdir(this.d.dir))
        .filter((f) => f.startsWith('stall-') && f.endsWith('.cpuprofile'))
        .sort();
      for (const f of files.slice(0, -KEEP_FILES))
        await rm(path.join(this.d.dir, f), { force: true });
    } catch (e) {
      this.log('could not save a stall profile', e);
    }
  }
}
