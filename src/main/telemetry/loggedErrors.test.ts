import { describe, expect, it, vi } from 'vitest';
import { NoopTelemetry, type Telemetry } from './AppInsightsClient';
import { reportLoggedErrors } from './loggedErrors';

function setup(limits?: { perMessage?: number; total?: number }) {
  const exception = vi.fn();
  const exceptionParts = vi.fn();
  const t: Telemetry = { ...NoopTelemetry, exception, exceptionParts };
  const printed: unknown[][] = [];
  const target = {
    error: (...a: unknown[]) => printed.push(['error', ...a]),
    warn: (...a: unknown[]) => printed.push(['warn', ...a]),
  };
  const undo = reportLoggedErrors(() => t, target, limits);
  return { target, printed, exception, exceptionParts, undo };
}

describe('reportLoggedErrors', () => {
  it('still prints, and reports an error with its tag as a property', () => {
    const { target, printed, exception } = setup();
    const err = new TypeError('bad');
    target.error('[ledger] pass failed', err);
    expect(printed).toEqual([['error', '[ledger] pass failed', err]]);
    expect(exception).toHaveBeenCalledWith(
      err,
      { source: 'log', level: 'error', log: '[ledger] pass failed' },
      'error',
    );
  });

  it('reports a warning without an Error as a LoggedError', () => {
    const { target, exceptionParts } = setup();
    target.warn('[secrets] could not look for tracked secret files');
    expect(exceptionParts).toHaveBeenCalledWith(
      {
        errorType: 'LoggedError',
        message: '[secrets] could not look for tracked secret files',
      },
      {
        source: 'log',
        level: 'warn',
        log: '[secrets] could not look for tracked secret files',
      },
      'warning',
    );
  });

  it('sends each message a few times and caps the launch', () => {
    const { target, exceptionParts } = setup({ perMessage: 2, total: 3 });
    for (let i = 0; i < 5; i++) target.warn(`[usage] skipped record ${i}`);
    expect(exceptionParts).toHaveBeenCalledTimes(2);
    target.warn('other one');
    target.warn('and another');
    expect(exceptionParts).toHaveBeenCalledTimes(3);
  });

  it('puts the console back on undo', () => {
    const { target, exceptionParts, undo } = setup();
    undo();
    target.warn('after');
    expect(exceptionParts).not.toHaveBeenCalled();
  });
});
