import type { Severity, Telemetry } from './AppInsightsClient';

type LogConsole = Pick<Console, 'error' | 'warn'>;

/**
 * Reports what main logs with `console.error` (severity error) and `console.warn` (warning): the
 * failures it recovers from (a pass that failed, a file it could not save) and would otherwise only
 * show in a terminal no one watches. The console output itself is unchanged. The string arguments
 * (a tag such as `[ledger] pass failed`) go in property `log`; an Error among the arguments is the
 * exception, so it groups with the same error reported elsewhere, and one the app already reported
 * is not sent again. Without an Error the text is the message of a `LoggedError`. Each message is sent at most `perMessage` times and `total` messages at most
 * per launch, so a loop that logs every second cannot flood the queue. Returns the undo.
 */
export function reportLoggedErrors(
  telemetry: () => Telemetry,
  target: LogConsole = console,
  limits: { perMessage?: number; total?: number } = {},
): () => void {
  const perMessage = limits.perMessage ?? 3;
  const total = limits.total ?? 200;
  const seen = new Map<string, number>();
  let sent = 0;
  const original = { error: target.error, warn: target.warn };
  const wrap =
    (level: 'error' | 'warn', severity: Severity) =>
    (...args: unknown[]) => {
      original[level].apply(target, args);
      try {
        const text = args
          .filter((a): a is string => typeof a === 'string')
          .join(' ')
          .trim();
        const error = args.find((a): a is Error => a instanceof Error);
        if (!text && !error) return;
        // Numbers (counts, ids, ports) vary between otherwise equal messages.
        const key = `${level}:${text.replace(/\d+/g, '#').slice(0, 120)}:${error?.name ?? ''}`;
        const count = seen.get(key) ?? 0;
        if (count >= perMessage || sent >= total) return;
        seen.set(key, count + 1);
        sent++;
        const props = { source: 'log', level, ...(text ? { log: text } : {}) };
        if (error) telemetry().exception(error, props, severity);
        else
          telemetry().exceptionParts(
            { errorType: 'LoggedError', message: text },
            props,
            severity,
          );
      } catch {
        // Reporting must never break logging.
      }
    };
  target.error = wrap('error', 'error');
  target.warn = wrap('warn', 'warning');
  return () => {
    target.error = original.error;
    target.warn = original.warn;
  };
}
