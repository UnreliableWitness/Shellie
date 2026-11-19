import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi } from '../test-helpers/fakeApi';
import { useGitSummary } from './useGitSummary';

function Summary({ missing }: { missing: boolean }) {
  useGitSummary('t1', missing);
  return null;
}

function start(missing: boolean) {
  const a = installFakeApi({
    'tasks:gitSummary': () => ({
      branch: 'b',
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      files: [],
    }),
  });
  render(<Summary missing={missing} />);
  return () => a.calls.filter((c) => c.channel === 'tasks:gitSummary').length;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useGitSummary', () => {
  it('polls the git summary while the window has focus', async () => {
    const summaries = start(false);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(summaries()).toBe(4);
  });

  it('never asks for a summary of a task whose worktree is missing (#332)', async () => {
    const summaries = start(true);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    window.dispatchEvent(new Event('focus'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(summaries()).toBe(0);
  });
});
