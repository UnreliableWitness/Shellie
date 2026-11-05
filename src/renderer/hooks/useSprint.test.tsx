import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sprint } from '../../shared/types';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { useSprint } from './useSprint';

const sprint: Sprint = {
  iteration: {
    id: 'i1',
    path: 'Shellie\\Sprint 1',
    name: 'Sprint 1',
    startDate: null,
    finishDate: null,
  },
  rows: [],
};

beforeEach(() => useStore.setState({ sprints: {} }));

describe('useSprint', () => {
  it('serves the cache and fetches once when stale', async () => {
    const fetchSprint = vi.fn(async () => sprint);
    installFakeApi({ 'workItems:sprint': fetchSprint });
    const first = renderHook(() => useSprint('c1'));
    expect(first.result.current.sprint).toBeNull();
    await waitFor(() => expect(first.result.current.sprint).toEqual(sprint));
    expect(useStore.getState().sprints.c1?.sprint).toEqual(sprint);
    const second = renderHook(() => useSprint('c1'));
    expect(second.result.current.sprint).toEqual(sprint);
    expect(fetchSprint).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a connection', () => {
    const fetchSprint = vi.fn(async () => sprint);
    installFakeApi({ 'workItems:sprint': fetchSprint });
    const { result } = renderHook(() => useSprint(null));
    expect(result.current.sprint).toBeNull();
    expect(fetchSprint).not.toHaveBeenCalled();
  });
});
