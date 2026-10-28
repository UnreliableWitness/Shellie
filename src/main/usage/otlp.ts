import type { UsageEvent } from '../../shared/usage';

type Scalar = string | number | boolean | null;
export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** One OTLP JSON AnyValue. int64 arrives as a string or a number. */
export function anyValue(v: unknown): Scalar {
  if (!isObj(v)) return null;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (v.intValue !== undefined) {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v.doubleValue === 'number') return v.doubleValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  return null;
}

export function attrMap(list: unknown): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const item of arr(list))
    if (isObj(item) && typeof item.key === 'string')
      out[item.key] = anyValue(item.value);
  return out;
}

export const int = (v: Scalar | undefined): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const str = (v: Scalar | undefined): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

const MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** Milliseconds since the epoch to ISO, accepting only years 1970..9999; anything else falls back to now. */
export function safeIso(ms: number): string {
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_MS
    ? new Date(ms).toISOString()
    : new Date().toISOString();
}

/** Nanoseconds since the epoch (string or number) to ISO; falls back to now. */
export function nanosToIso(v: unknown): string {
  const n =
    typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN;
  return n > 0 ? safeIso(Math.floor(n / 1e6)) : safeIso(Number.NaN);
}

const isApiRequest = (record: Obj, attrs: Record<string, Scalar>): boolean => {
  const body = anyValue(record.body);
  const name = attrs['event.name'];
  return (
    body === 'claude_code.api_request' ||
    name === 'api_request' ||
    name === 'claude_code.api_request'
  );
};

/** The subagent behind a `query_source` such as `agent:builtin:Explore` or `agent:custom`; undefined for the main thread and everything else. */
export function subagentOf(querySource: string): string | undefined {
  if (!querySource.startsWith('agent:')) return undefined;
  const name = querySource.slice('agent:'.length).replace(/^builtin:/, '');
  return !name || name === 'custom' || name === 'default' ? 'Subagent' : name;
}

/** Picks `claude_code.api_request` events tagged with `shellie.task.id` out of an OTLP/HTTP JSON logs body. */
export function parseClaudeLogs(body: unknown): {
  events: UsageEvent[];
  skipped: number;
} {
  const events: UsageEvent[] = [];
  let skipped = 0;
  if (!isObj(body)) return { events, skipped };
  for (const rl of arr(body.resourceLogs)) {
    if (!isObj(rl)) continue;
    const resource = attrMap(
      isObj(rl.resource) ? rl.resource.attributes : undefined,
    );
    for (const sl of arr(rl.scopeLogs)) {
      if (!isObj(sl)) continue;
      for (const record of arr(sl.logRecords)) {
        if (!isObj(record)) continue;
        const attrs = { ...resource, ...attrMap(record.attributes) };
        if (!isApiRequest(record, attrs)) continue;
        const taskId =
          str(attrs['shellie.task.id']) || str(attrs['miac.task.id']);
        if (!taskId) continue;
        const id = str(attrs.request_id);
        const model = str(attrs.model);
        if (!id || !model) {
          skipped++;
          continue;
        }
        const stamp =
          typeof attrs['event.timestamp'] === 'string'
            ? Date.parse(attrs['event.timestamp'])
            : Number.NaN;
        const at = Number.isNaN(stamp)
          ? nanosToIso(record.timeUnixNano ?? record.observedTimeUnixNano)
          : safeIso(stamp);
        const agent = subagentOf(str(attrs.query_source));
        const effort = str(attrs.effort);
        events.push({
          id,
          taskId,
          tool: 'claude-code',
          sessionId: str(attrs['session.id']) || 'unknown-session',
          model,
          at,
          inputTokens: int(attrs.input_tokens),
          outputTokens: int(attrs.output_tokens),
          cacheReadTokens: int(attrs.cache_read_tokens),
          cacheWriteTokens: int(attrs.cache_creation_tokens),
          fast: attrs.speed === 'fast',
          ...(str(attrs['shellie.source']) === 'pr-summary' && {
            source: 'pr-summary' as const,
          }),
          ...(agent && { agent }),
          ...(effort && { effort }),
        });
      }
    }
  }
  return { events, skipped };
}

export type ClaudeActive = {
  taskId: string;
  sessionId: string;
  endMs: number;
  value: number;
  cumulative: boolean;
};

/** Picks `claude_code.active_time.total` points of type `cli` tagged with `shellie.task.id` out of an OTLP/HTTP JSON metrics body. */
export function parseClaudeActiveTime(body: unknown): ClaudeActive[] {
  const out: ClaudeActive[] = [];
  if (!isObj(body)) return out;
  for (const rm of arr(body.resourceMetrics)) {
    if (!isObj(rm)) continue;
    const resource = attrMap(
      isObj(rm.resource) ? rm.resource.attributes : undefined,
    );
    for (const sm of arr(rm.scopeMetrics)) {
      if (!isObj(sm)) continue;
      for (const metric of arr(sm.metrics)) {
        if (
          !isObj(metric) ||
          metric.name !== 'claude_code.active_time.total' ||
          !isObj(metric.sum)
        )
          continue;
        const cumulative = metric.sum.aggregationTemporality === 2;
        for (const dp of arr(metric.sum.dataPoints)) {
          if (!isObj(dp)) continue;
          const attrs = { ...resource, ...attrMap(dp.attributes) };
          if (attrs.type !== 'cli') continue;
          const taskId =
            str(attrs['shellie.task.id']) || str(attrs['miac.task.id']);
          if (!taskId) continue;
          const raw = dp.asDouble ?? dp.asInt;
          const value =
            typeof raw === 'number' || typeof raw === 'string'
              ? Number(raw)
              : Number.NaN;
          const endMs = Math.floor(Number(dp.timeUnixNano) / 1e6);
          if (!Number.isFinite(value) || value < 0 || !(endMs > 0)) continue;
          out.push({
            taskId,
            sessionId: str(attrs['session.id']) || 'unknown-session',
            endMs,
            value,
            cumulative,
          });
        }
      }
    }
  }
  return out;
}
