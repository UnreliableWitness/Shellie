import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../shared/usage';
import { startTaskFor, useStartTask } from './startTask';
import { useStore } from './store';
import { installFakeApi, noOverrides } from './test-helpers/fakeApi';

const config = {
  worktreeRoot: '/w',
  ...noOverrides,
  config: {
    base: 'main',
    branch: '{type}/{id}-{slug}',
    copy: [],
    setup: ['npm ci'],
    run: {},
    found: true,
  },
};

describe('startTaskFor', () => {
  it('opens the tabs chosen in Settings', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'settings:get': () => ({
        ...defaultSettings(),
        defaultTerminals: {
          claude: false,
          copilot: false,
          opencode: true,
          shell: false,
        },
      }),
      'tasks:create': () => ({ id: 't1' }) as never,
    });
    await startTaskFor(
      'r1',
      {
        id: '5',
        type: 'Task',
        title: 'Store the address',
        url: null,
        project: null,
      },
      vi.fn(),
    );
    expect(
      calls.find((c) => c.channel === 'tasks:create')?.args[0],
    ).toMatchObject({
      startClaude: false,
      openShell: false,
      openCopilot: false,
      openOpencode: true,
    });
  });

  it('opens only the chosen agent, keeping the shell from Settings', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'settings:get': () => ({
        ...defaultSettings(),
        defaultTerminals: {
          claude: true,
          copilot: true,
          opencode: false,
          shell: true,
        },
      }),
      'tasks:create': () => ({ id: 't1' }) as never,
    });
    await startTaskFor(
      'r1',
      {
        id: '5',
        type: 'Task',
        title: 'Store the address',
        url: null,
        project: null,
      },
      vi.fn(),
      'opencode',
    );
    expect(
      calls.find((c) => c.channel === 'tasks:create')?.args[0],
    ).toMatchObject({
      startClaude: false,
      openShell: true,
      openCopilot: false,
      openOpencode: true,
    });
  });

  it('uses the repo default environment, Development or Test', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'secrets:repoDefault': () => 'test',
      'tasks:create': () => ({ id: 't1' }) as never,
    });
    await startTaskFor(
      'r1',
      {
        id: '5',
        type: 'Task',
        title: 'Store the address',
        url: null,
        project: null,
      },
      vi.fn(),
    );
    expect(
      calls.find((c) => c.channel === 'tasks:create')?.args[0],
    ).toMatchObject({ environment: 'test' });
  });

  it('never starts on UAT or Production, even when a repo default says so', async () => {
    for (const env of ['uat', 'production'] as const) {
      const { calls } = installFakeApi({
        'repos:config': () => config,
        'secrets:repoDefault': () => env,
        'tasks:create': () => ({ id: 't1' }) as never,
      });
      await startTaskFor(
        'r1',
        {
          id: '5',
          type: 'Task',
          title: 'Store the address',
          url: null,
          project: null,
        },
        vi.fn(),
      );
      const input = calls.find((c) => c.channel === 'tasks:create')
        ?.args[0] as Record<string, unknown>;
      expect(input.environment).toBe('development');
      expect(input.environmentConfirmed).toBeUndefined();
    }
  });

  it('refuses with the error when .shellie.yml is broken', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => ({
        ...config,
        fileError: '/r/.shellie.yml: not valid YAML: bad',
      }),
      'tasks:create': () => ({ id: 't1' }) as never,
    });
    const notify = vi.fn();
    const task = await startTaskFor(
      'r1',
      {
        id: '5',
        type: 'Task',
        title: 'Store the address',
        url: null,
        project: null,
      },
      notify,
    );
    expect(task).toBeUndefined();
    expect(calls.some((c) => c.channel === 'tasks:create')).toBe(false);
    expect(notify).toHaveBeenCalledWith(
      'error',
      '/r/.shellie.yml: not valid YAML: bad',
    );
  });
});

describe('useStartTask', () => {
  const item = { id: '5', type: 'Task', title: 'Store the address', url: null };
  const workItem = { ...item, project: null };
  const stubStore = () => {
    const go = vi.fn();
    const select = vi.fn();
    useStore.setState({ go, select, notify: vi.fn() });
    return { go, select };
  };

  it('opens New task to pick the repo when several share the project', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'tasks:create': () => ({ id: 't1' }) as never,
    });
    const { go } = stubStore();
    const { result } = renderHook(() => useStartTask('r1', item, true));
    await act(() => result.current.start());
    expect(go).toHaveBeenCalledWith({
      kind: 'new-task',
      workItem,
      repoId: 'r1',
    });
    expect(calls.some((c) => c.channel === 'tasks:create')).toBe(false);
  });

  it('creates the task with the picked agent, then opens its setup', async () => {
    let release = () => {};
    const created = new Promise<void>((resolve) => (release = resolve));
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'tasks:create': async () => {
        await created;
        return { id: 't1' } as never;
      },
    });
    const { go, select } = stubStore();
    const { result } = renderHook(() => useStartTask('r1', item, false));
    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.start('opencode');
    });
    await vi.waitFor(() =>
      expect(calls.some((c) => c.channel === 'tasks:create')).toBe(true),
    );
    expect(result.current.starting).toBe(true);
    await act(async () => {
      release();
      await done;
    });
    expect(result.current.starting).toBe(false);
    expect(
      calls.find((c) => c.channel === 'tasks:create')?.args[0],
    ).toMatchObject({ repoId: 'r1', workItem, openOpencode: true });
    expect(select).toHaveBeenCalledWith('t1');
    expect(go).toHaveBeenCalledWith({ kind: 'setup', taskId: 't1' });
  });

  it('does nothing without a repo', async () => {
    const { calls } = installFakeApi({
      'tasks:create': () => ({ id: 't1' }) as never,
    });
    const { go, select } = stubStore();
    const { result } = renderHook(() => useStartTask(null, item, false));
    await act(() => result.current.start());
    expect(go).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
