import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { onBrainGitIdle, withBrainGit } from './gitMutex';

describe('onBrainGitIdle', () => {
  it('is called once the folder queue is empty, after a failure too, until unsubscribed', async () => {
    const seen: string[] = [];
    const off = onBrainGitIdle((dir) => seen.push(dir));
    const dir = path.join('x', '..', 'brain-idle');
    let release: () => void = () => undefined;
    const first = withBrainGit(
      dir,
      () => new Promise<void>((r) => (release = r)),
    );
    const second = withBrainGit(dir, async () => {
      throw new Error('boom');
    });
    await Promise.resolve();
    expect(seen).toEqual([]);
    release();
    await first;
    await expect(second).rejects.toThrow('boom');
    await vi.waitFor(() => expect(seen).toEqual([path.resolve(dir)]));
    off();
    await withBrainGit(dir, async () => undefined);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
  });

  it('a listener that throws does not stop the others', async () => {
    const seen: string[] = [];
    const offA = onBrainGitIdle(() => {
      throw new Error('listener');
    });
    const offB = onBrainGitIdle((dir) => seen.push(dir));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await withBrainGit('brain-idle-2', async () => undefined);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    offA();
    offB();
  });
});
