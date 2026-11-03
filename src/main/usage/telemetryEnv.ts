import path from 'node:path';

export const copilotFile = (usageDir: string, taskId: string): string =>
  path.join(usageDir, 'copilot', `${taskId}.jsonl`);

/** Environment for every task pty: Claude Code exports log events and active-time metrics to the receiver, Copilot CLI writes JSON lines to a per-task file. Content capture stays off. `source` marks Shellie's own `claude -p` runs, so the budget can count them (tab usage comes from transcripts). */
export function telemetryEnv(
  taskId: string,
  port: number,
  usageDir: string,
  source?: 'pr-summary' | 'brain',
): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${port}/v1/logs`,
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}/v1/metrics`,
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    OTEL_RESOURCE_ATTRIBUTES: `shellie.task.id=${taskId}${source ? `,shellie.source=${source}` : ''}`,
    COPILOT_OTEL_FILE_EXPORTER_PATH: copilotFile(usageDir, taskId),
  };
}
