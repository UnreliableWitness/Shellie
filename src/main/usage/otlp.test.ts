import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attrMap,
  parseClaudeActiveTime,
  parseClaudeLogs,
  safeIso,
} from './otlp';

const FIXTURE_TASK = '00000000-0000-4000-8000-000000000001';
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(path.join(__dirname, '__fixtures__', 'claude', name), 'utf8'),
  ) as unknown;

const kv = (key: string, value: Record<string, unknown>) => ({ key, value });
const body = (
  attrs: { key: string; value: Record<string, unknown> }[],
  resource = [kv('shellie.task.id', { stringValue: 'task-9' })],
) => ({
  resourceLogs: [
    {
      resource: { attributes: resource },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: '1760436000000000000',
              body: { stringValue: 'claude_code.api_request' },
              attributes: [
                kv('event.name', { stringValue: 'api_request' }),
                ...attrs,
              ],
            },
          ],
        },
      ],
    },
  ],
});
const full = [
  kv('model', { stringValue: 'claude-opus-5-5' }),
  kv('input_tokens', { intValue: '1200' }),
  kv('output_tokens', { intValue: 300 }),
  kv('cache_read_tokens', { intValue: '45000' }),
  kv('cache_creation_tokens', { intValue: '2000' }),
  kv('cost_usd', { doubleValue: 0.05 }),
  kv('speed', { stringValue: 'fast' }),
  kv('request_id', { stringValue: 'req_1' }),
  kv('session.id', { stringValue: 'sess_1' }),
];

describe('parseClaudeLogs source', () => {
  it('reads shellie.source', () => {
    const tagged = body(full, [
      kv('shellie.task.id', { stringValue: 'task-9' }),
      kv('shellie.source', { stringValue: 'pr-summary' }),
    ]);
    expect(parseClaudeLogs(tagged).events[0].source).toBe('pr-summary');
    expect(parseClaudeLogs(body(full)).events[0].source).toBeUndefined();
  });
});

describe('attrMap', () => {
  it('reads every OTLP AnyValue kind, including int64 as string', () => {
    expect(
      attrMap([
        kv('a', { stringValue: 'x' }),
        kv('b', { intValue: '7' }),
        kv('c', { doubleValue: 1.5 }),
        kv('d', { boolValue: true }),
        kv('e', {}),
      ]),
    ).toEqual({ a: 'x', b: 7, c: 1.5, d: true, e: null });
  });
});

describe('parseClaudeLogs', () => {
  it('maps an api_request record to a usage event', () => {
    const { events, skipped } = parseClaudeLogs(body(full));
    expect(skipped).toBe(0);
    expect(events).toEqual([
      {
        id: 'req_1',
        taskId: 'task-9',
        tool: 'claude-code',
        sessionId: 'sess_1',
        model: 'claude-opus-5-5',
        at: new Date(1760436000000).toISOString(),
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 45000,
        cacheWriteTokens: 2000,
        fast: true,
      },
    ]);
  });
  it('reads the subagent from query_source and the effort', () => {
    const one = (qs: string) =>
      parseClaudeLogs(
        body([
          ...full,
          kv('query_source', { stringValue: qs }),
          kv('effort', { stringValue: 'high' }),
        ]),
      ).events[0];
    expect(one('agent:builtin:Explore')).toMatchObject({
      agent: 'Explore',
      effort: 'high',
    });
    expect(one('agent:custom').agent).toBe('Subagent');
    expect(one('repl_main_thread').agent).toBeUndefined();
    expect(one('main').agent).toBeUndefined();
    expect(parseClaudeLogs(body(full)).events[0].effort).toBeUndefined();
  });
  it('lets a record attribute carry the task id when the resource does not', () => {
    const { events } = parseClaudeLogs(
      body([...full, kv('shellie.task.id', { stringValue: 'task-r' })], []),
    );
    expect(events[0].taskId).toBe('task-r');
  });
  it('ignores records without a task id and other event names', () => {
    expect(parseClaudeLogs(body(full, [])).events).toEqual([]);
    const other = body(full);
    (
      other.resourceLogs[0].scopeLogs[0].logRecords[0] as { body: unknown }
    ).body = { stringValue: 'claude_code.tool_result' };
    other.resourceLogs[0].scopeLogs[0].logRecords[0].attributes[0] = kv(
      'event.name',
      { stringValue: 'tool_result' },
    );
    expect(parseClaudeLogs(other).events).toEqual([]);
  });
  it('counts an api_request without a model or request id as skipped', () => {
    expect(
      parseClaudeLogs(body(full.filter((a) => a.key !== 'model'))),
    ).toEqual({ events: [], skipped: 1 });
    expect(
      parseClaudeLogs(body(full.filter((a) => a.key !== 'request_id'))),
    ).toEqual({ events: [], skipped: 1 });
  });
  it('returns nothing for bodies that are not OTLP logs', () => {
    expect(parseClaudeLogs(null)).toEqual({ events: [], skipped: 0 });
    expect(parseClaudeLogs({ resourceLogs: 'x' })).toEqual({
      events: [],
      skipped: 0,
    });
  });
  it('parses the recorded Claude Code fixture', () => {
    const { events } = parseClaudeLogs(fixture('api-request-logs.json'));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e).toMatchObject({
        taskId: FIXTURE_TASK,
        tool: 'claude-code',
        fast: false,
      });
      expect(e.model).toMatch(/^claude-/);
      expect(e.id.length).toBeGreaterThan(0);
      expect(e.sessionId.length).toBeGreaterThan(0);
      for (const n of [
        e.inputTokens,
        e.outputTokens,
        e.cacheReadTokens,
        e.cacheWriteTokens,
      ])
        expect(Number.isInteger(n) && n >= 0).toBe(true);
    }
  });
});

describe('timestamps', () => {
  const recent = (iso: string) => {
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Math.abs(Date.now() - Date.parse(iso))).toBeLessThan(60_000);
  };
  const withTime = (timeUnixNano: string, attrs = full) => {
    const b = body(attrs);
    b.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano = timeUnixNano;
    return b;
  };
  it('falls back to now for an absurd timeUnixNano instead of throwing', () => {
    recent(parseClaudeLogs(withTime('1e30')).events[0].at);
  });
  it('falls back to now for a year past 9999', () => {
    // 10000-01-02 in nanoseconds
    recent(parseClaudeLogs(withTime('253402387200000000000')).events[0].at);
    recent(
      parseClaudeLogs(
        body([
          ...full,
          kv('event.timestamp', { stringValue: '+010000-01-01T00:00:00Z' }),
        ]),
      ).events[0].at,
    );
  });
  it('safeIso accepts only finite dates in 1970..9999', () => {
    expect(safeIso(1760436000000)).toBe(new Date(1760436000000).toISOString());
    recent(safeIso(Number.NaN));
    recent(safeIso(-1));
    recent(safeIso(1e30));
  });
});

describe('tasks tagged before the rename', () => {
  it('reads miac.task.id from logs', () => {
    const { events } = parseClaudeLogs(
      body(full, [kv('miac.task.id', { stringValue: 'task-old' })]),
    );
    expect(events[0]?.taskId).toBe('task-old');
  });
  it('reads miac.task.id from metrics', () => {
    const doc = {
      resourceMetrics: [
        {
          resource: {
            attributes: [kv('miac.task.id', { stringValue: 'task-old' })],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.active_time.total',
                  sum: {
                    dataPoints: [
                      {
                        attributes: [kv('type', { stringValue: 'cli' })],
                        timeUnixNano: '1760436000000000000',
                        asInt: '5',
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(parseClaudeActiveTime(doc)[0]?.taskId).toBe('task-old');
  });
});

describe('parseClaudeActiveTime', () => {
  it('reads the cli active_time point of the recorded metrics body', () => {
    expect(parseClaudeActiveTime(fixture('metrics.json'))).toEqual([
      {
        taskId: FIXTURE_TASK,
        sessionId: 'bd9b14be-bf37-4435-bac0-3e56ffda4e90',
        endMs: 1791986361380,
        value: 1.72,
        cumulative: false,
      },
    ]);
  });
  it('ignores user points, other metrics, cumulative flag read from temporality', () => {
    const point = (type: string, extra: Record<string, unknown> = {}) => ({
      attributes: [kv('type', { stringValue: type })],
      timeUnixNano: '1760436000000000000',
      asInt: '5',
      ...extra,
    });
    const doc = {
      resourceMetrics: [
        {
          resource: {
            attributes: [kv('shellie.task.id', { stringValue: 'task-9' })],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.active_time.total',
                  sum: {
                    aggregationTemporality: 2,
                    dataPoints: [point('user'), point('cli')],
                  },
                },
                {
                  name: 'claude_code.cost.usage',
                  sum: { dataPoints: [point('cli')] },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(parseClaudeActiveTime(doc)).toEqual([
      {
        taskId: 'task-9',
        sessionId: 'unknown-session',
        endMs: 1760436000000,
        value: 5,
        cumulative: true,
      },
    ]);
    expect(parseClaudeActiveTime(null)).toEqual([]);
  });
});
