import { describe, expect, it, vi } from 'vitest';
import { withRetries } from './fetch-electron.mjs';

const quiet = { sleep: () => Promise.resolve(), log: () => {} };

describe('withRetries', () => {
  it('returns the first result without waiting', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    await expect(
      withRetries(() => Promise.resolve('zip'), { ...quiet, sleep }),
    ).resolves.toBe('zip');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits each delay in turn until an attempt works', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue('zip');
    await expect(
      withRetries(attempt, { ...quiet, sleep, delays: [10, 20, 30] }),
    ).resolves.toBe('zip');
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it('fails with the last error once the delays are used up', async () => {
    let n = 0;
    const attempt = () => Promise.reject(new Error(`503 #${++n}`));
    await expect(
      withRetries(attempt, { ...quiet, delays: [1, 2] }),
    ).rejects.toThrow('503 #3');
  });

  it('gives up on an attempt that stalls and tries again', async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue('zip');
    await expect(
      withRetries(attempt, { ...quiet, delays: [1], timeoutMs: 5 }),
    ).resolves.toBe('zip');
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
