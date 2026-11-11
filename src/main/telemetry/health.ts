import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Telemetry } from './AppInsightsClient';
import { perf, type PerfStats } from './perf';

/** What Electron's `app.getAppMetrics()` gives per process; only the fields used here. */
export type ProcessMetric = {
  type: string;
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number };
};

export type HealthDeps = {
  /** Read at each report: telemetry is replaced once its client is set up. */
  telemetry: () => Telemetry;
  appMetrics: () => ProcessMetric[];
  terminals: () => number;
  /** The renderer's last known JS heap in bytes; undefined when it has not answered. */
  rendererHeap?: () => number | undefined;
  stats?: PerfStats;
  intervalMs?: number;
};

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
const ms = (ns: number) => Math.round(ns / 1e6);

/** Working set of the given process types (all when null), in MB. */
function memoryMb(metrics: ProcessMetric[], types: string[] | null): number {
  const kb = metrics
    .filter((m) => types === null || types.includes(m.type))
    .reduce((n, m) => n + m.memory.workingSetSize, 0);
  // workingSetSize is in KB.
  return Math.round(kb / 1024);
}

/** Working set of the renderer (`Tab`) processes, in MB. */
export const rendererMemoryMb = (metrics: ProcessMetric[]): number =>
  memoryMb(metrics, ['Tab']);

/**
 * One `app.health` event: memory and CPU of every process, main's event loop delay, open
 * terminals, and the renderer's JS heap when it is known.
 */
export function healthMeasurements(
  metrics: ProcessMetric[],
  loop: { p50: number; p99: number; max: number },
  terminals: number,
  rendererHeapBytes?: number,
): Record<string, number> {
  const mem = process.memoryUsage();
  return {
    mainRssMb: mb(mem.rss),
    mainHeapMb: mb(mem.heapUsed),
    appMemoryMb: memoryMb(metrics, null),
    rendererMemoryMb: rendererMemoryMb(metrics),
    ...(rendererHeapBytes === undefined
      ? {}
      : { rendererHeapMb: mb(rendererHeapBytes) }),
    gpuMemoryMb: memoryMb(metrics, ['GPU']),
    cpuPercent: Math.round(
      metrics.reduce((n, m) => n + m.cpu.percentCPUUsage, 0),
    ),
    processes: metrics.length,
    loopDelayP50Ms: loop.p50,
    loopDelayP99Ms: loop.p99,
    loopDelayMaxMs: loop.max,
    terminals,
    uptimeMin: Math.round(process.uptime() / 60),
  };
}

/**
 * Every `intervalMs` (default 10 minutes) sends the timing summaries (`ipc.ms`, `git.ms`) and one
 * `app.health` event. Returns `report`, which sends the same at once (on quit), and `stop`.
 */
export function startHealthReports(d: HealthDeps): {
  report: () => void;
  stop: () => void;
} {
  const stats = d.stats ?? perf;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const report = () => {
    try {
      const t = d.telemetry();
      stats.report(t);
      t.event(
        'app.health',
        undefined,
        healthMeasurements(
          d.appMetrics(),
          {
            p50: ms(loop.percentile(50)),
            p99: ms(loop.percentile(99)),
            max: ms(loop.max),
          },
          d.terminals(),
          d.rendererHeap?.(),
        ),
      );
    } catch {
      // A failed health report is not worth failing anything else for.
    }
    loop.reset();
  };
  const timer = setInterval(report, d.intervalMs ?? 10 * 60_000);
  timer.unref?.();
  return {
    report,
    stop: () => {
      clearInterval(timer);
      loop.disable();
    },
  };
}
