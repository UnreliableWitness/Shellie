import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copilotFile, telemetryEnv } from './telemetryEnv';

describe('telemetryEnv', () => {
  it('points Claude Code at the receiver and Copilot CLI at a per-task file', () => {
    const env = telemetryEnv('t-1', 4319, '/data/usage');
    expect(env).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:4319/v1/logs',
      OTEL_LOGS_EXPORT_INTERVAL: '2000',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:4319/v1/metrics',
      OTEL_METRIC_EXPORT_INTERVAL: '10000',
      OTEL_RESOURCE_ATTRIBUTES: 'shellie.task.id=t-1',
      COPILOT_OTEL_FILE_EXPORTER_PATH: path.join(
        '/data/usage',
        'copilot',
        't-1.jsonl',
      ),
    });
    expect(copilotFile('/data/usage', 't-1')).toBe(
      env.COPILOT_OTEL_FILE_EXPORTER_PATH,
    );
  });
  it('tags the PR summary run', () => {
    expect(
      telemetryEnv('t1', 1, '/u', 'pr-summary').OTEL_RESOURCE_ATTRIBUTES,
    ).toBe('shellie.task.id=t1,shellie.source=pr-summary');
    expect(telemetryEnv('t1', 1, '/u').OTEL_RESOURCE_ATTRIBUTES).toBe(
      'shellie.task.id=t1',
    );
  });
  it('tags a brain source', () => {
    expect(
      telemetryEnv('brain:b1', 1, '/u', 'brain').OTEL_RESOURCE_ATTRIBUTES,
    ).toBe('shellie.task.id=brain:b1,shellie.source=brain');
  });
  it('never turns on prompt or content capture', () => {
    const keys = Object.keys(telemetryEnv('t', 1, '/u'));
    for (const k of [
      'OTEL_LOG_USER_PROMPTS',
      'OTEL_LOG_TOOL_DETAILS',
      'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
    ])
      expect(keys).not.toContain(k);
  });
});
