import type { RendererTelemetry, TelemetryProps } from '../shared/telemetry';

/** Never throws: telemetry must not break the UI (or tests without a preload). */
function send(message: RendererTelemetry): void {
  try {
    window.shellie?.track?.(message);
  } catch {
    // ignore
  }
}

/** A named feature event with small, non-identifying properties. See docs/telemetry.md. */
export function track(name: string, props?: TelemetryProps): void {
  send({ type: 'event', name, props });
}

/** Like `track`, with numbers App Insights can chart (counts, durations). */
export function trackMeasured(
  name: string,
  measurements: Record<string, number>,
  props?: TelemetryProps,
): void {
  send({ type: 'event', name, props, measurements });
}

export function trackScreen(name: string, props?: TelemetryProps): void {
  send({ type: 'pageView', name, props });
}

function trackError(error: unknown, props?: TelemetryProps): void {
  const e =
    error instanceof Error
      ? error
      : new Error(typeof error === 'string' ? error : 'Non-error rejection');
  send({
    type: 'exception',
    errorType: (e.name || 'Error').slice(0, 80),
    message: e.message.slice(0, 2000),
    stack: e.stack?.slice(0, 8000),
    props,
  });
}

/**
 * Chromium's notice that a ResizeObserver callback caused another resize in the same
 * frame ("loop completed with undelivered notifications", formerly "loop limit
 * exceeded"). The remaining notifications arrive next frame; nothing is broken.
 */
export function isBenignResizeObserverError(message: unknown): boolean {
  return (
    typeof message === 'string' && message.startsWith('ResizeObserver loop')
  );
}

/** Reports uncaught renderer errors and unhandled rejections. Call once at startup. */
export function installErrorTracking(target: Window = window): void {
  target.addEventListener('error', (ev) => {
    if (isBenignResizeObserverError(ev.message)) return;
    trackError(ev.error ?? ev.message, { source: 'window.onerror' });
  });
  target.addEventListener('unhandledrejection', (ev) =>
    trackError(ev.reason, { source: 'unhandledrejection' }),
  );
}

/** Long tasks (the main thread busy for 50 ms or more, so clicks and typing wait) summed between reports. */
export class LongTasks {
  private count = 0;
  private totalMs = 0;
  private maxMs = 0;
  private over200 = 0;

  add(ms: number): void {
    this.count++;
    this.totalMs += ms;
    this.maxMs = Math.max(this.maxMs, ms);
    if (ms >= 200) this.over200++;
  }

  /** The sums since the last call, or null when there were none. */
  take(): Record<string, number> | null {
    if (this.count === 0) return null;
    const out = {
      count: this.count,
      totalMs: Math.round(this.totalMs),
      maxMs: Math.round(this.maxMs),
      over200: this.over200,
    };
    this.count = this.totalMs = this.maxMs = this.over200 = 0;
    return out;
  }
}

/**
 * Sends `renderer.longTasks` every 10 minutes, and when the page hides, if the main thread stalled.
 * Call once at startup; does nothing where the browser does not report long tasks (tests).
 */
export function installLongTaskTracking(
  target: Window = window,
  intervalMs = 10 * 60_000,
): void {
  if (
    typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes?.includes('longtask')
  )
    return;
  const tasks = new LongTasks();
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) tasks.add(e.duration);
  }).observe({ type: 'longtask', buffered: true });
  const report = () => {
    const m = tasks.take();
    if (m) trackMeasured('renderer.longTasks', m);
  };
  target.setInterval(report, intervalMs);
  target.addEventListener('pagehide', report);
}
