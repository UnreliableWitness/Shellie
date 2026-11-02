import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SetupState, TaskView } from '../../shared/types';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { SetupScreen } from './SetupScreen';

const task: TaskView = {
  id: 't1',
  repoId: 'r1',
  name: '',
  workItem: {
    id: '48231',
    type: 'User Story',
    title: 'Show estimated delivery date',
    url: null,
  },
  slug: '48231-show',
  branch: 'feature/48231-show',
  worktreePath: '/src/webshop.worktrees/48231-show',
  baseRef: 'origin/main',
  baseSha: null,
  openPeriods: [],
  time: null,
  status: 'setting-up',
  setup: {
    copy: true,
    commands: ['npm ci'],
    startClaude: true,
    openShell: true,
    openCopilot: false,
  },
  terminals: [],
  createdAt: 'now',
  finishedAt: null,
  usageSyncedAt: null,
  usageSyncError: null,
  usageCommentId: null,
  summary: null,
  pullRequest: null,
  closedTerminals: [],
  reopen: null,
  extraWorkspaces: [],
  detachedPaths: [],
  homeDropped: false,
  connectionId: null,
  mainCheckoutEdits: [],
  environment: 'development',
  environmentUntil: null,
  pendingCleanup: [],
  worktreeMissing: false,
};
const state: SetupState = {
  steps: [
    {
      def: { kind: 'fetch', label: 'Fetch base', detail: 'origin/main' },
      status: 'done',
      ms: 400,
    },
    {
      def: {
        kind: 'worktree',
        label: 'Create branch and worktree',
        detail: 'feature/48231-show',
      },
      status: 'running',
    },
    {
      def: {
        kind: 'apm',
        label: 'npm ci',
        detail: 'in worktree',
      },
      status: 'todo',
    },
  ],
  log: ['$ git fetch origin/main'],
  finished: false,
  ok: null,
  failedStep: null,
};

beforeEach(() =>
  useStore.setState({
    repos: [
      {
        id: 'r1',
        name: 'webshop',
        path: '/src/webshop',
        baseBranch: 'main',
        connectionId: null,
        configFound: true,
        discovered: false,
        overrides: {},
        workItemOnStart: {
          moveToInProgress: true,
          assignToMe: true,
          stateOverrides: {},
        },
      },
    ],
    tasks: [task],
    connections: [],
    notices: [],
    screen: { kind: 'setup', taskId: 't1' },
  }),
);

describe('SetupScreen', () => {
  it('shows the steps and log from the current state, then applies live events', async () => {
    const { emit } = installFakeApi({ 'tasks:setupState': () => state });
    render(<SetupScreen taskId="t1" />);
    expect(
      await screen.findByRole('listitem', {
        name: 'Create branch and worktree',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('$ git fetch origin/main')).toBeInTheDocument();
    expect(screen.getByText('0.4s')).toBeInTheDocument();
    act(() => {
      emit('setup', { taskId: 't1', type: 'log', line: 'Preparing worktree' });
      emit('setup', {
        taskId: 't1',
        type: 'step',
        index: 1,
        status: 'done',
        ms: 2100,
      });
      emit('setup', {
        taskId: 't1',
        type: 'step',
        index: 2,
        status: 'running',
      });
    });
    expect(screen.getByText('Preparing worktree')).toBeInTheDocument();
    expect(screen.getByText('2.1s')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: /npm ci/ })).toHaveAttribute(
      'data-status',
      'running',
    );
  });

  it('ignores events for other tasks', async () => {
    const { emit } = installFakeApi({ 'tasks:setupState': () => state });
    render(<SetupScreen taskId="t1" />);
    await screen.findByText('Fetch base');
    act(() =>
      emit('setup', { taskId: 'other', type: 'log', line: 'not mine' }),
    );
    expect(screen.queryByText('not mine')).not.toBeInTheDocument();
  });

  it('offers retry and cancel after a failure', async () => {
    const failed: SetupState = {
      ...state,
      steps: state.steps.map((s, i) => ({
        ...s,
        status: i === 2 ? 'failed' : 'done',
        detail: i === 2 ? 'npm ci exited with code 1' : s.detail,
      })),
      finished: true,
      ok: false,
      failedStep: 2,
    };
    useStore.setState({ tasks: [{ ...task, status: 'setup-failed' }] });
    const { calls } = installFakeApi({
      'tasks:setupState': () => failed,
      'tasks:retrySetup': () => undefined,
      'tasks:cancelSetup': () => undefined,
    });
    render(<SetupScreen taskId="t1" />);
    expect(
      await screen.findByText('npm ci exited with code 1'),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry from npm ci' }),
    );
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.channel === 'tasks:retrySetup' && c.args[0] === 't1',
        ),
      ).toBe(true),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel and remove' }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'tasks:cancelSetup')).toBe(true),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'home' });
  });

  const authFailed = (connectionId: string | null): SetupState => ({
    ...state,
    steps: state.steps.map((s, i) => ({
      ...s,
      status: i === 0 ? 'failed' : 'todo',
      detail:
        i === 0
          ? "git fetch --quiet origin main failed (128): fatal: could not read Password for 'https://o@dev.azure.com/o/p/_git/r': terminal prompts disabled"
          : s.detail,
      auth:
        i === 0
          ? { host: 'dev.azure.com', connectionId, path: '/src/webshop' }
          : undefined,
    })),
    finished: true,
    ok: false,
    failedStep: 0,
  });

  it('after a sign-in failure, says to update the token and opens Settings at the connection', async () => {
    useStore.setState({
      tasks: [{ ...task, status: 'setup-failed' }],
      connections: [
        {
          id: 'c1',
          name: 'o',
          organizationUrl: 'https://dev.azure.com/o',
          project: 'p',
          user: null,
          status: 'ok',
          checkedAt: null,
          userUniqueName: null,
          provider: 'azure-devops' as const,
          workItemOnStart: {
            moveToInProgress: true,
            assignToMe: true,
            stateOverrides: {},
          },
        },
      ],
    });
    installFakeApi({ 'tasks:setupState': () => authFailed('c1') });
    render(<SetupScreen taskId="t1" />);
    expect(
      await screen.findByText(
        'Git could not sign in to dev.azure.com with your Azure DevOps token. Update the token, then Retry.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Retry from Fetch base' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Update token' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      section: 'conn-c1',
    });
  });

  it('after a sign-in failure without a token, says to sign in from a terminal', async () => {
    useStore.setState({ tasks: [{ ...task, status: 'setup-failed' }] });
    installFakeApi({ 'tasks:setupState': () => authFailed(null) });
    render(<SetupScreen taskId="t1" />);
    expect(
      await screen.findByText(
        'Git could not sign in to dev.azure.com. Sign in once from a terminal (run `git fetch` in /src/webshop), then Retry.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Update token' }),
    ).not.toBeInTheDocument();
  });

  it('drops the sign-in hint once the step runs again', async () => {
    useStore.setState({ tasks: [{ ...task, status: 'setup-failed' }] });
    const { emit } = installFakeApi({
      'tasks:setupState': () => authFailed(null),
    });
    render(<SetupScreen taskId="t1" />);
    await screen.findByText(/Git could not sign in/);
    act(() =>
      emit('setup', {
        taskId: 't1',
        type: 'step',
        index: 0,
        status: 'running',
      }),
    );
    expect(screen.queryByText(/Git could not sign in/)).not.toBeInTheDocument();
  });

  it('for a failed reopen, cancelling puts the task back on its Done page', async () => {
    useStore.setState({
      tasks: [{ ...task, status: 'setup-failed', reopen: { from: null } }],
    });
    const { calls } = installFakeApi({
      'tasks:setupState': () => ({ ...state, finished: true, ok: false }),
      'tasks:cancelSetup': () => undefined,
    });
    render(<SetupScreen taskId="t1" />);
    expect(
      await screen.findByText(/Reopening failed\..*goes back to Done/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel reopen' }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'tasks:cancelSetup')).toBe(true),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'task' });
    expect(useStore.getState().selectedTaskId).toBe('t1');
  });

  it('jumps to the task page when setup finishes successfully', async () => {
    const { emit } = installFakeApi({ 'tasks:setupState': () => state });
    render(<SetupScreen taskId="t1" />);
    await screen.findByText('Fetch base');
    act(() => emit('setup', { taskId: 't1', type: 'finished', ok: true }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'task' }),
    );
    expect(useStore.getState().selectedTaskId).toBe('t1');
  });

  it('replays events that arrive before the snapshot, without duplicating log lines', async () => {
    let resolve!: (s: SetupState) => void;
    const deferred = new Promise<SetupState>((r) => (resolve = r));
    const { emit } = installFakeApi({ 'tasks:setupState': () => deferred });
    render(<SetupScreen taskId="t1" />);
    act(() => {
      emit('setup', { taskId: 't1', type: 'log', line: 'early line' });
      emit('setup', {
        taskId: 't1',
        type: 'step',
        index: 2,
        status: 'running',
      });
    });
    await act(async () =>
      resolve({ ...state, log: [...state.log, 'early line'] }),
    );
    expect(screen.getAllByText('early line')).toHaveLength(1);
    expect(screen.getByRole('listitem', { name: /npm ci/ })).toHaveAttribute(
      'data-status',
      'running',
    );
  });

  it('navigates to the task page on mount when setup already finished', async () => {
    installFakeApi({
      'tasks:setupState': () => ({ ...state, finished: true, ok: true }),
    });
    render(<SetupScreen taskId="t1" />);
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'task' }),
    );
    expect(useStore.getState().selectedTaskId).toBe('t1');
  });

  it('clears the failure state once the failed step runs again', async () => {
    const failed: SetupState = {
      ...state,
      steps: state.steps.map((s, i) => ({
        ...s,
        status: i === 2 ? 'failed' : 'done',
        detail: i === 2 ? 'npm ci exited with code 1' : s.detail,
      })),
      finished: true,
      ok: false,
      failedStep: 2,
    };
    useStore.setState({ tasks: [{ ...task, status: 'setup-failed' }] });
    const { emit } = installFakeApi({
      'tasks:setupState': () => failed,
      'tasks:retrySetup': () => undefined,
    });
    render(<SetupScreen taskId="t1" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Retry from npm ci' }),
    );
    act(() => {
      // main broadcasts tasks:changed (status setting-up) before the step events
      useStore.setState({ tasks: [{ ...task, status: 'setting-up' }] });
      emit('setup', {
        taskId: 't1',
        type: 'step',
        index: 2,
        status: 'running',
      });
    });
    expect(screen.queryByText(/Setup failed/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Retry from/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('npm ci exited with code 1'),
    ).not.toBeInTheDocument();
  });

  it('shows a notice and stops loading when the snapshot request fails', async () => {
    installFakeApi({
      'tasks:setupState': () => Promise.reject(new Error('boom')),
    });
    render(<SetupScreen taskId="t1" />);
    await waitFor(() =>
      expect(useStore.getState().notices.length).toBeGreaterThan(0),
    );
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

  it('offers a plain Retry for a setup-failed task with no setup state (after a relaunch)', async () => {
    useStore.setState({ tasks: [{ ...task, status: 'setup-failed' }] });
    const { calls } = installFakeApi({
      'tasks:setupState': () => null,
      'tasks:retrySetup': () => undefined,
    });
    render(<SetupScreen taskId="t1" />);
    expect(screen.getByText(/Setup failed/)).toBeInTheDocument();
    expect(screen.queryByText(/Setting up your task/)).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.channel === 'tasks:retrySetup' && c.args[0] === 't1',
        ),
      ).toBe(true),
    );
  });
});
