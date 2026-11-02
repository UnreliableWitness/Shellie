import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, noOverrides } from '../test-helpers/fakeApi';
import { invalidateRepoConfig, useRepoConfig } from './useRepoConfig';

const configWith = (run: Record<string, string>) => ({
  worktreeRoot: '/w',
  ...noOverrides,
  config: {
    base: 'main',
    branch: '{type}/{id}-{slug}',
    copy: [],
    setup: [],
    run,
    found: true,
  },
});

beforeEach(() => invalidateRepoConfig());

describe('useRepoConfig', () => {
  it('refetches a mounted repo after repos:changed', async () => {
    let run: Record<string, string> = { dev: 'npm run dev' };
    const { emit } = installFakeApi({
      'repos:config': () => configWith(run),
    });
    const { result } = renderHook(() => useRepoConfig('r1'));
    await waitFor(() =>
      expect(result.current?.config.run).toEqual({ dev: 'npm run dev' }),
    );
    run = { dev: 'pnpm dev' };
    act(() => emit('repos:changed', []));
    await waitFor(() =>
      expect(result.current?.config.run).toEqual({ dev: 'pnpm dev' }),
    );
  });
});
