import { describe, expect, it, vi } from 'vitest';
import { NoopTelemetry, type Telemetry } from './AppInsightsClient';
import { healthMeasurements, startHealthReports } from './health';
import { PerfStats } from './perf';

const metrics = [
  {
    type: 'Browser',
    cpu: { percentCPUUsage: 2.4 },
    memory: { workingSetSize: 200 * 1024 },
  },
  {
    type: 'Tab',
    cpu: { percentCPUUsage: 10.2 },
    memory: { workingSetSize: 300 * 1024 },
  },
  {
    type: 'GPU',
    cpu: { percentCPUUsage: 1 },
    memory: { workingSetSize: 100 * 1024 },
  },
];

describe('healthMeasurements', () => {
  it('sums memory and CPU by process type', () => {
    const m = healthMeasurements(metrics, { p50: 1, p99: 12, max: 40 }, 3);
    expect(m).toMatchObject({
      appMemoryMb: 600,
      rendererMemoryMb: 300,
      gpuMemoryMb: 100,
      cpuPercent: 14,
      processes: 3,
      loopDelayP50Ms: 1,
      loopDelayP99Ms: 12,
      loopDelayMaxMs: 40,
      terminals: 3,
    });
    expect(m.mainRssMb).toBeGreaterThan(0);
  });
});

describe('startHealthReports', () => {
  it('sends the timing summaries and one health event per report', () => {
    const event = vi.fn();
    const metric = vi.fn();
    const t: Telemetry = { ...NoopTelemetry, event, metric };
    const stats = new PerfStats();
    stats.record('ipc.ms', 'tasks:list', 4);
    const h = startHealthReports({
      telemetry: () => t,
      appMetrics: () => metrics,
      terminals: () => 2,
      stats,
      intervalMs: 60_000,
    });
    h.report();
    h.stop();
    expect(metric).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith(
      'app.health',
      undefined,
      expect.objectContaining({ terminals: 2, appMemoryMb: 600 }),
    );
  });
});
