import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useBrainNav } from './useBrainNav';

vi.mock('./brainActions', () => ({ trackBrain: vi.fn() }));

describe('useBrainNav', () => {
  it('counts every open, but pushes no entry identical to the current one', () => {
    const { result } = renderHook(() => useBrainNav());
    act(() => result.current.open('wiki/a.md'));
    const first = result.current.opened;
    act(() => result.current.open('wiki/a.md'));
    expect(result.current.opened).toBe(first + 1);
    expect(result.current.current).toEqual({ path: 'wiki/a.md' });
    // One Back leaves the page: no duplicate entry to step over.
    expect(result.current.canForward).toBe(false);
    act(() => result.current.back());
    expect(result.current.current).toBeNull();
  });

  it('pushes an entry for another page or another anchor', () => {
    const { result } = renderHook(() => useBrainNav());
    act(() => result.current.open('wiki/a.md'));
    act(() => result.current.open('wiki/a.md', 'detail'));
    act(() => result.current.open('wiki/b.md'));
    act(() => result.current.back());
    expect(result.current.current).toEqual({
      path: 'wiki/a.md',
      anchor: 'detail',
    });
    act(() => result.current.back());
    expect(result.current.current).toEqual({ path: 'wiki/a.md' });
  });
});
