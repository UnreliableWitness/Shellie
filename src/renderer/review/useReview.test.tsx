import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewFiles } from '../../shared/review';
import type { TaskView } from '../../shared/types';
import { installFakeApi } from '../test-helpers/fakeApi';
import { useChangeCount, useReview } from './useReview';

const task = {
  id: 't1',
  repoId: 'r1',
  status: 'ready',
  worktreeMissing: false,
  extraWorkspaces: [],
  homeDropped: false,
  terminals: [],
} as unknown as TaskView;

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const hooks: [
  string,
  'review:files' | 'review:count',
  (t?: TaskView) => unknown,
][] = [
  [
    'useReview',
    'review:files',
    (t = task) => useReview(t, { kind: 'all' }, true),
  ],
  ['useChangeCount', 'review:count', (t = task) => useChangeCount(t, true)],
];

describe.each(hooks)('%s', (_name, channel, hook) => {
  it('loads again when a repo joins the task (#84)', async () => {
    const api = installFakeApi();
    const { rerender } = renderHook((t: TaskView) => hook(t), {
      initialProps: task,
    });
    await settle();
    const files = () => api.calls.filter((c) => c.channel === channel).length;
    const before = files();
    rerender({ ...task, terminals: [] } as TaskView);
    await settle();
    expect(files()).toBe(before);
    rerender({
      ...task,
      extraWorkspaces: [{ id: 'w2', repoId: 'r2', dropped: false }],
    } as unknown as TaskView);
    await settle();
    expect(files()).toBe(before + 1);
  });

  it('makes one call for a burst of events', async () => {
    const api = installFakeApi();
    renderHook(hook);
    await settle();
    const files = () => api.calls.filter((c) => c.channel === channel).length;
    const before = files();
    for (let i = 0; i < 5; i++) {
      act(() => api.emit('review:changed', { taskId: 't1' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
    }
    await settle();
    expect(files()).toBe(before + 1);
  });

  it('runs exactly one follow-up for events during a call', async () => {
    let answer: (f: never) => void = () => {};
    let pending = false;
    const api = installFakeApi({
      [channel]: () =>
        pending
          ? new Promise<never>((r) => {
              answer = r;
            })
          : channel === 'review:count'
            ? 0
            : { repos: [] },
    });
    renderHook(hook);
    await settle();
    const files = () => api.calls.filter((c) => c.channel === channel).length;
    const before = files();
    pending = true;
    act(() => api.emit('review:changed', { taskId: 't1' }));
    await settle();
    expect(files()).toBe(before + 1);
    pending = false;
    act(() => api.emit('docs:changed', { taskId: 't1', paths: ['a'] }));
    await settle();
    act(() => api.emit('review:changed', { taskId: 't1' }));
    await settle();
    expect(files()).toBe(before + 1);
    await act(async () => {
      answer((channel === 'review:count' ? 0 : { repos: [] }) as never);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(files()).toBe(before + 2);
  });
});
