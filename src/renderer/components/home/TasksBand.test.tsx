import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HomeSnapshot } from '../../../shared/home';
import type { Repo, TaskView } from '../../../shared/types';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { TasksBand } from './TasksBand';

const repo = {
  id: 'r1',
  name: 'web',
  connectionId: 'c1',
  discovered: false,
} as Repo;
const task = (over: Partial<TaskView>): TaskView =>
  ({
    id: 't1',
    repoId: 'r1',
    connectionId: 'c1',
    name: '',
    status: 'ready',
    worktreeMissing: false,
    workItem: { id: '42', type: 'Issue', title: 'Login loop', url: null },
    createdAt: '2026-10-17T08:00:00Z',
    terminals: [],
    ...over,
  }) as TaskView;
const snapshot: HomeSnapshot = {
  version: 1,
  builtAt: '',
  connections: [
    {
      connectionId: 'c1',
      name: 'uw',
      project: 'Shellie',
      status: 'ok',
      error: null,
      fetchedAt: '',
      sprints: [
        {
          iterationId: 'i',
          name: 'S1',
          path: 'Shellie\\S1',
          startDate: null,
          finishDate: null,
          items: [
            {
              id: '7',
              type: 'Issue',
              title: 'Reset mail',
              state: 'To Do',
              areaPath: 'Shellie',
              iterationPath: 'Shellie\\S1',
              assignedTo: 'Me',
              url: 'u',
              remainingWork: null,
              originalEstimate: null,
              completedWork: null,
            },
          ],
        },
      ],
      sprintsError: null,
      reviews: [],
      teamReviews: [],
      myPrs: [],
      prsError: null,
    },
  ],
};

beforeEach(() =>
  useStore.setState({
    repos: [repo],
    tasks: [],
    connections: [{ id: 'c1', name: 'uw', project: 'Shellie' } as never],
    screen: { kind: 'home' },
  }),
);

describe('TasksBand', () => {
  it('shows open tasks, not done ones, and opens a task on click', async () => {
    installFakeApi();
    useStore.setState({
      tasks: [task({}), task({ id: 't2', status: 'done' })],
    });
    render(<TasksBand snapshot={null} />);
    const card = await screen.findByRole('button', {
      name: /Issue 42 Login loop/,
    });
    expect(screen.queryAllByRole('button', { name: /Issue 42/ })).toHaveLength(
      1,
    );
    await userEvent.click(card);
    expect(useStore.getState().screen.kind).toBe('task');
    expect(useStore.getState().selectedTaskId).toBe('t1');
  });

  it('marks a failed setup and lands on Setup', async () => {
    installFakeApi();
    useStore.setState({ tasks: [task({ status: 'setup-failed' })] });
    render(<TasksBand snapshot={null} />);
    const card = await screen.findByRole('button', {
      name: /needs attention/,
    });
    await userEvent.click(card);
    expect(useStore.getState().screen).toEqual({
      kind: 'setup',
      taskId: 't1',
    });
  });

  it('Up next starts a task with the repo defaults', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => ({
        worktreeRoot: '/w',
        config: {
          base: 'main',
          branch: '{type}/{id}-{slug}',
          copy: [],
          setup: [],
          run: {},
          found: true,
        },
      }),
      'tasks:create': (input) => ({ id: 'new', ...input }) as never,
    });
    render(<TasksBand snapshot={snapshot} />);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Start a task for Issue 7 Reset mail',
      }),
    );
    expect(calls.some((c) => c.channel === 'tasks:create')).toBe(true);
    expect(useStore.getState().screen).toEqual({
      kind: 'setup',
      taskId: 'new',
    });
  });

  it('Up next opens New task to choose the repo when several repos share the project', async () => {
    const { calls } = installFakeApi();
    useStore.setState({ repos: [repo, { ...repo, id: 'r2', name: 'api' }] });
    render(<TasksBand snapshot={snapshot} />);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Start a task for Issue 7 Reset mail',
      }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'new-task',
      workItem: { id: '7', type: 'Issue', title: 'Reset mail', url: 'u' },
      repoId: 'r1',
    });
    expect(calls.some((c) => c.channel === 'tasks:create')).toBe(false);
  });

  it('Up next without a linked repo explains why it cannot start', async () => {
    installFakeApi();
    useStore.setState({ repos: [] });
    render(<TasksBand snapshot={snapshot} />);
    const start = await screen.findByRole('button', {
      name: 'Start a task for Issue 7 Reset mail',
    });
    expect(start.getAttribute('aria-disabled')).toBe('true');
  });

  it('empty state', async () => {
    installFakeApi();
    render(<TasksBand snapshot={null} />);
    expect(await screen.findByText('No open tasks.')).toBeTruthy();
  });
});
