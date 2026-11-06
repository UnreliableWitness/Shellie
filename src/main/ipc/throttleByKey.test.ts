import { afterEach, describe, expect, it, vi } from 'vitest';
import { throttleByKey } from './throttleByKey';

afterEach(() => vi.useRealTimers());

describe('throttleByKey', () => {
  it('calls at once, then once more per window for calls inside it, per key', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = throttleByKey(fn, 250);
    t('a');
    t('a');
    t('a');
    t('b');
    expect(fn.mock.calls).toEqual([['a'], ['b']]);
    vi.advanceTimersByTime(250);
    expect(fn.mock.calls).toEqual([['a'], ['b'], ['a']]);
    // A quiet window ends it: the next call goes out at once.
    vi.advanceTimersByTime(250);
    t('a');
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
