import { scrub } from './scrub';
import type { TelemetryProps } from '../../shared/telemetry';

export type { TelemetryProps };
export type Measurements = Record<string, number>;
/** A summary of several samples of one metric, sent as one aggregated item. */
export type MetricStats = { count: number; min: number; max: number };
/** `warning` is a handled failure the app recovered from (a logged error); `critical` stopped the app. */
export type Severity = 'warning' | 'error' | 'critical';
const SEVERITY_LEVEL: Record<Severity, number> = {
  warning: 2,
  error: 3,
  critical: 4,
};

/** Context sent with every item. Nothing in here identifies a person: the install id is random. */
export type TelemetryContext = {
  appVersion: string;
  os: string;
  osVersion: string;
  arch: string;
  electronVersion: string;
  packaged: boolean;
  installId: string;
  sessionId: string;
};

/** What the rest of main uses. `NoopTelemetry` stands in when there is no connection string (local builds, tests). */
export interface Telemetry {
  event(
    name: string,
    props?: TelemetryProps,
    measurements?: Measurements,
  ): void;
  pageView(name: string, props?: TelemetryProps): void;
  /** One value, or with `stats` a summary of many: `value` is then their sum. */
  metric(
    name: string,
    value: number,
    props?: TelemetryProps,
    stats?: MetricStats,
  ): void;
  exception(error: unknown, props?: TelemetryProps, severity?: Severity): void;
  /** A raw exception (the renderer sends one already split into parts). */
  exceptionParts(
    parts: { errorType: string; message: string; stack?: string },
    props?: TelemetryProps,
    severity?: Severity,
  ): void;
  dependency(d: {
    name: string;
    target: string;
    durationMs: number;
    resultCode: string;
    success: boolean;
    type?: string;
  }): void;
  flush(): Promise<void>;
}

export const NoopTelemetry: Telemetry = {
  event: () => {},
  pageView: () => {},
  metric: () => {},
  exception: () => {},
  exceptionParts: () => {},
  dependency: () => {},
  flush: async () => {},
};

export type Envelope = {
  name: string;
  time: string;
  iKey: string;
  tags: Record<string, string>;
  data: { baseType: string; baseData: Record<string, unknown> };
};

export type ClientOptions = {
  connectionString: string;
  context: TelemetryContext;
  /** Read on every call, so turning the setting off stops sending at once. */
  enabled: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  home?: string;
  /** Values that must never leave the machine (repo names and paths, branches, titles); read at send time. */
  sensitive?: () => Iterable<string>;
  /** Items kept in memory at most; newer items are dropped once it is full. Default 500. */
  maxQueue?: number;
  /** Items per request. Default 100. */
  batchSize?: number;
  /** Flush this long after the first queued item; 0 disables the timer (tests). Default 15 s. */
  flushIntervalMs?: number;
  /** Request timeout. Default 10 s. */
  timeoutMs?: number;
};

/** Parses an Application Insights connection string. Returns null when it has no instrumentation key. */
export function parseConnectionString(
  cs: string,
): { iKey: string; endpoint: string } | null {
  const parts = new Map<string, string>();
  for (const pair of cs.split(';')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    parts.set(pair.slice(0, i).trim().toLowerCase(), pair.slice(i + 1).trim());
  }
  const iKey = parts.get('instrumentationkey');
  if (!iKey) return null;
  const endpoint = (
    parts.get('ingestionendpoint') ?? 'https://dc.services.visualstudio.com/'
  ).replace(/\/+$/, '');
  return { iKey, endpoint };
}

/** TimeSpan as Application Insights expects it: `d.hh:mm:ss.fff`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const days = Math.floor(total / 86_400_000);
  const h = Math.floor(total / 3_600_000) % 24;
  const m = Math.floor(total / 60_000) % 60;
  const s = Math.floor(total / 1000) % 60;
  const f = total % 1000;
  return `${days > 0 ? `${days}.` : ''}${pad(h)}:${pad(m)}:${pad(s)}.${pad(f, 3)}`;
}

/**
 * A tiny Application Insights client: builds envelopes, queues them (capped), and posts them
 * in batches to `<IngestionEndpoint>/v2/track`. Sending is best effort: a failed batch is dropped, never retried.
 */
export class AppInsightsClient implements Telemetry {
  private readonly iKey: string;
  private readonly url: string;
  private queue: Envelope[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly timeoutMs: number;
  /** Items dropped because the queue was full; reported once with the next batch. */
  private dropped = 0;
  private readonly reported = new WeakSet<object>();

  constructor(private readonly opts: ClientOptions) {
    const parsed = parseConnectionString(opts.connectionString);
    if (!parsed)
      throw new Error('Invalid Application Insights connection string');
    this.iKey = parsed.iKey;
    this.url = `${parsed.endpoint}/v2/track`;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.maxQueue = opts.maxQueue ?? 500;
    this.batchSize = opts.batchSize ?? 100;
    this.flushIntervalMs = opts.flushIntervalMs ?? 15_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Number of items waiting to be sent (for tests). */
  get pending(): number {
    return this.queue.length;
  }

  event(name: string, props?: TelemetryProps, measurements?: Measurements) {
    this.push('Event', 'EventData', {
      ver: 2,
      name,
      properties: this.props(props),
      ...(measurements ? { measurements } : {}),
    });
  }

  pageView(name: string, props?: TelemetryProps) {
    this.push('PageView', 'PageviewData', {
      ver: 2,
      name,
      properties: this.props(props),
    });
  }

  metric(
    name: string,
    value: number,
    props?: TelemetryProps,
    stats?: MetricStats,
  ) {
    if (!Number.isFinite(value)) return;
    this.push('Metric', 'MetricData', {
      ver: 2,
      metrics: [
        stats
          ? // kind 1 = Aggregation: App Insights reads value as the sum of `count` samples.
            { name, kind: 1, value, ...stats }
          : { name, kind: 0, value, count: 1 },
      ],
      properties: this.props(props),
    });
  }

  exception(
    error: unknown,
    props?: TelemetryProps,
    severity: Severity = 'error',
  ) {
    // The same error caught, logged and reported in more than one place is sent once.
    if (typeof error === 'object' && error !== null) {
      if (this.reported.has(error)) return;
      this.reported.add(error);
    }
    const e =
      error instanceof Error
        ? error
        : new Error(typeof error === 'string' ? error : 'Non-error thrown');
    this.exceptionParts(
      { errorType: e.name || 'Error', message: e.message, stack: e.stack },
      props,
      severity,
    );
  }

  exceptionParts(
    parts: { errorType: string; message: string; stack?: string },
    props?: TelemetryProps,
    severity: Severity = 'error',
  ) {
    const message = this.clean(parts.message).slice(0, 1000);
    const stack = parts.stack ? this.clean(parts.stack).slice(0, 8000) : '';
    this.push('Exception', 'ExceptionData', {
      ver: 2,
      exceptions: [
        {
          typeName: parts.errorType.slice(0, 80) || 'Error',
          message: message || '(no message)',
          hasFullStack: stack.length > 0,
          ...(stack ? { stack } : {}),
        },
      ],
      severityLevel: SEVERITY_LEVEL[severity],
      properties: this.props(props),
    });
  }

  dependency(d: {
    name: string;
    target: string;
    durationMs: number;
    resultCode: string;
    success: boolean;
    type?: string;
  }) {
    this.push('RemoteDependency', 'RemoteDependencyData', {
      ver: 2,
      id: Math.random().toString(16).slice(2, 18),
      name: d.name,
      target: d.target,
      type: d.type ?? 'HTTP',
      duration: formatDuration(d.durationMs),
      resultCode: d.resultCode,
      success: d.success,
      properties: this.props(),
    });
  }

  /** Sends everything queued. Resolves when the requests are done (or have failed); never rejects. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.opts.enabled()) {
      this.queue = [];
      return this.inFlight;
    }
    const batches: Envelope[][] = [];
    while (this.queue.length > 0)
      batches.push(this.queue.splice(0, this.batchSize));
    if (this.dropped > 0 && batches.length > 0) {
      const lost = this.dropped;
      this.dropped = 0;
      batches[batches.length - 1].push(
        this.envelope('Metric', 'MetricData', {
          ver: 2,
          metrics: [
            { name: 'telemetry.dropped', kind: 0, value: lost, count: 1 },
          ],
          properties: this.props(),
        }),
      );
    }
    const sends = batches.map((b) => this.send(b));
    this.inFlight = Promise.all([this.inFlight, ...sends]).then(() => {});
    return this.inFlight;
  }

  private async send(batch: Envelope[]): Promise<void> {
    try {
      await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Best effort: offline or blocked telemetry is not the user's problem.
    }
  }

  private push(
    kind: string,
    baseType: string,
    baseData: Record<string, unknown>,
  ) {
    if (!this.opts.enabled()) return;
    if (this.queue.length >= this.maxQueue) {
      this.dropped++;
      return;
    }
    this.queue.push(this.envelope(kind, baseType, baseData));
    if (this.queue.length >= this.batchSize) void this.flush();
    else if (!this.timer && this.flushIntervalMs > 0) {
      this.timer = setTimeout(() => void this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  private envelope(
    kind: string,
    baseType: string,
    baseData: Record<string, unknown>,
  ): Envelope {
    const c = this.opts.context;
    return {
      name: `Microsoft.ApplicationInsights.${this.iKey.replace(/-/g, '')}.${kind}`,
      time: new Date(this.now()).toISOString(),
      iKey: this.iKey,
      tags: {
        'ai.application.ver': c.appVersion,
        'ai.cloud.role': 'Shellie',
        'ai.device.os': c.os,
        'ai.device.osVersion': c.osVersion,
        'ai.device.type': 'PC',
        'ai.user.id': c.installId,
        'ai.session.id': c.sessionId,
        'ai.internal.sdkVersion': 'shellie-ai:1',
      },
      data: { baseType, baseData },
    };
  }

  private clean(text: string): string {
    return scrub(text, {
      home: this.opts.home,
      sensitive: this.opts.sensitive?.(),
    });
  }

  /** Common context plus the caller's properties, every string scrubbed and capped. */
  private props(props?: TelemetryProps): Record<string, string> {
    const c = this.opts.context;
    const out: Record<string, string> = {
      arch: c.arch,
      electron: c.electronVersion,
      packaged: String(c.packaged),
    };
    for (const [k, v] of Object.entries(props ?? {}))
      out[k] = typeof v === 'string' ? this.clean(v).slice(0, 200) : String(v);
    return out;
  }
}
