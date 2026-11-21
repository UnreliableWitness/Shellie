import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODELS_MS, MODELS_TIMEOUT_MS, opencodeModelList } from './models';

afterEach(() => vi.useRealTimers());

describe('opencodeModelList', () => {
  it('knows nothing until asked, and knowing never starts a process', () => {
    const ask = vi.fn(async () => ['a/b']);
    const list = opencodeModelList({ ask, now: () => 0 });
    expect(list.known()).toBeNull();
    expect(list.known()).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks at most every 10 minutes, one ask for callers at the same time', async () => {
    let t = 0;
    const ask = vi.fn(async () => ['a/b']);
    const list = opencodeModelList({ ask, now: () => t });
    expect(await Promise.all([list.get(), list.get()])).toEqual([
      ['a/b'],
      ['a/b'],
    ]);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(list.known()).toEqual(['a/b']);
    t += MODELS_MS - 1;
    await list.get();
    expect(ask).toHaveBeenCalledTimes(1);
    t += 1;
    await list.get();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed ask for the same 10 minutes: no OpenCode is not asked again each minute', async () => {
    let t = 0;
    const ask = vi.fn(async () => null);
    const list = opencodeModelList({ ask, now: () => t });
    expect(await list.get()).toBeNull();
    t += MODELS_MS - 1;
    expect(await list.get()).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
    t += 1;
    await list.get();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good list one more interval after a failed refresh, then knows none', async () => {
    let t = 0;
    const answers: (string[] | null)[] = [['a/b'], null, null];
    const list = opencodeModelList({
      ask: async () => answers.shift() ?? null,
      now: () => t,
    });
    expect(await list.get()).toEqual(['a/b']);
    t += MODELS_MS;
    expect(await list.get()).toEqual(['a/b']);
    t += MODELS_MS;
    expect(await list.get()).toBeNull();
    expect(list.known()).toBeNull();
  });

  it('gives up on a hung ask after 30 s', async () => {
    vi.useFakeTimers();
    const list = opencodeModelList({
      ask: () => new Promise<string[] | null>(() => {}),
      now: Date.now,
    });
    const got = list.get();
    await vi.advanceTimersByTimeAsync(MODELS_TIMEOUT_MS);
    expect(await got).toBeNull();
  });

  it('fresh asks again at once; a list seen elsewhere (agents:opencodeModels) is known', async () => {
    const ask = vi.fn(async () => ['c/d']);
    const list = opencodeModelList({ ask, now: () => 0 });
    list.seen(['a/b']);
    expect(list.known()).toEqual(['a/b']);
    expect(await list.get()).toEqual(['a/b']);
    expect(ask).not.toHaveBeenCalled();
    expect(await list.get(true)).toEqual(['c/d']);
    // A failed ask elsewhere does not forget a good list.
    list.seen(null);
    expect(list.known()).toEqual(['c/d']);
  });
});
