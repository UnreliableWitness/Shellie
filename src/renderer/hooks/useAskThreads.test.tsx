import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskThread } from '../../shared/brainAsk';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { useAskThreads } from './useAskThreads';

const kept: AskThread = {
  id: 'a',
  brainId: 'b1',
  taskId: 't1',
  startedAt: 5,
  current: true,
  exchanges: [
    {
      id: 'e1',
      question: 'Kept?',
      status: 'done',
      startedAt: 5,
      answer: null,
      error: null,
      refused: null,
    },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
  useStore.setState({
    brainAsksByTask: {},
    brainAskOpenByTask: {},
    brainAskThread: {},
    brainAskEarlier: [],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const saves = (a: ReturnType<typeof installFakeApi>) =>
  a.calls.filter((c) => c.channel === 'brainAsk:save');

describe('useAskThreads', () => {
  it('takes the kept threads in, and saves nothing for that', async () => {
    const a = installFakeApi({
      'brainAsk:load': () => [kept],
      'brainAsk:save': () => undefined,
    });
    renderHook(() => useAskThreads());
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(useStore.getState().brainAsksByTask.t1).toHaveLength(1);
    expect(saves(a)).toEqual([]);
  });

  it('saves a change once it has settled for half a second', async () => {
    const a = installFakeApi({
      'brainAsk:load': () => [kept],
      'brainAsk:save': () => undefined,
    });
    renderHook(() => useAskThreads());
    await act(() => vi.advanceTimersByTimeAsync(10));
    act(() => useStore.getState().newBrainQuestion('t1'));
    act(() => useStore.getState().openBrainThread('t1', 'a'));
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(saves(a)).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(saves(a)).toHaveLength(1);
    expect(saves(a)[0].args[0]).toMatchObject([{ id: 'a', current: true }]);
  });

  it('never saves when the kept threads could not be read: the file is left as it is', async () => {
    const a = installFakeApi({
      'brainAsk:load': () => {
        throw new Error('no');
      },
      'brainAsk:save': () => undefined,
    });
    renderHook(() => useAskThreads());
    await act(() => vi.advanceTimersByTimeAsync(10));
    act(() => useStore.getState().loadBrainThreads([{ ...kept, id: 'other' }]));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(saves(a)).toEqual([]);
  });
});
