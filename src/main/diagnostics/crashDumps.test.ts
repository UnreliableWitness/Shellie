import { describe, expect, it, vi } from 'vitest';
import { startLocalCrashDumps } from './crashDumps';

describe('startLocalCrashDumps', () => {
  it('starts the reporter without ever uploading', () => {
    const start = vi.fn();
    startLocalCrashDumps({ start }, () => undefined);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0].uploadToServer).toBe(false);
    expect(start.mock.calls[0][0].submitURL).toBeUndefined();
  });

  it('logs a reporter that cannot start and carries on', () => {
    const log = vi.fn();
    const failure = new Error('no crashpad');
    expect(() =>
      startLocalCrashDumps(
        {
          start: () => {
            throw failure;
          },
        },
        log,
      ),
    ).not.toThrow();
    expect(log).toHaveBeenCalledWith(failure);
  });
});
