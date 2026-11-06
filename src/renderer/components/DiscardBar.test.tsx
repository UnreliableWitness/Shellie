import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  DiscardChecks,
  DiscardWorkspaceCheck,
  TaskView,
} from '../../shared/types';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { DiscardBar } from './DiscardBar';

const task = {
  id: 't1',
  name: 'try something',
  workItem: null,
  status: 'ready',
} as unknown as TaskView;

const ws = (
  over: Partial<DiscardWorkspaceCheck> = {},
): DiscardWorkspaceCheck => ({
  workspaceId: 'home',
  repoName: 'webshop',
  worktreePath: '/w/webshop.worktrees/try',
  branch: 'task/try',
  kept: false,
  missing: false,
  commits: 0,
  unpushed: 0,
  uncommitted: 0,
  ...over,
});

const checks = (over: Partial<DiscardChecks> = {}): DiscardChecks => ({
  workspaces: [ws()],
  runningTerminals: 2,
  commitsLost: 0,
  uncommitted: 0,
  blank: true,
  ...over,
});

beforeEach(() => {
  useStore.setState({
    tasks: [task],
    selectedTaskId: 't1',
    screen: { kind: 'task' },
    discardTaskId: 't1',
    notices: [],
  });
});

describe('DiscardBar (#124)', () => {
  it('names what goes and what does not happen, then discards and goes Home', async () => {
    const api = installFakeApi({
      'tasks:discardChecks': () => checks(),
      'tasks:discard': () => undefined,
    });
    render(<DiscardBar task={task} />);
    const bar = await screen.findByRole('alertdialog');
    await waitFor(() =>
      expect(bar).toHaveTextContent('/w/webshop.worktrees/try'),
    );
    expect(bar).toHaveTextContent('task/try');
    expect(bar).toHaveTextContent('2 terminals');
    expect(bar).toHaveTextContent(/not appear under Done/);
    expect(bar).toHaveTextContent(/Nothing is pushed/);
    expect(bar).toHaveTextContent(/AI cost stays/);
    expect(bar).not.toHaveTextContent(/lost/);
    await userEvent.click(screen.getByRole('button', { name: 'Discard task' }));
    expect(api.calls.map((c) => c.channel)).toContain('tasks:discard');
    expect(useStore.getState().screen).toEqual({ kind: 'home' });
    expect(useStore.getState().discardTaskId).toBeNull();
  });

  it('warns about commits no remote has and uncommitted files: Discard anyway', async () => {
    installFakeApi({
      'tasks:discardChecks': () =>
        checks({
          workspaces: [ws({ commits: 3, unpushed: 3, uncommitted: 1 })],
          commitsLost: 3,
          uncommitted: 1,
          blank: false,
        }),
    });
    render(<DiscardBar task={task} />);
    expect(
      await screen.findByRole('button', { name: 'Discard anyway' }),
    ).toBeInTheDocument();
    const bar = screen.getByRole('alertdialog');
    expect(bar).toHaveTextContent(/3 commits on no remote/);
    expect(bar).toHaveTextContent(/1 uncommitted file/);
  });

  it('Discard anyway confirms the loss; a blank task confirms nothing (#244)', async () => {
    const api = installFakeApi({
      'tasks:discardChecks': () =>
        checks({ workspaces: [ws({ uncommitted: 1 })], uncommitted: 1 }),
      'tasks:discard': () => undefined,
    });
    render(<DiscardBar task={task} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Discard anyway' }),
    );
    expect(api.calls.find((c) => c.channel === 'tasks:discard')?.args).toEqual([
      't1',
      true,
    ]);
  });

  it('a refusal for work done since the bar opened shows that work, and Discard anyway follows (#244)', async () => {
    let found = false;
    const api = installFakeApi({
      'tasks:discardChecks': () =>
        found
          ? checks({
              workspaces: [ws({ commits: 1, unpushed: 1 })],
              commitsLost: 1,
              blank: false,
            })
          : checks(),
      'tasks:discard': (_id, confirmed) => {
        if (confirmed) return;
        found = true;
        throw new Error('Nothing was removed, since that would lose work');
      },
    });
    render(<DiscardBar task={task} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Discard task' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Discard anyway' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      /1 commit on no remote/,
    );
    expect(api.calls.find((c) => c.channel === 'tasks:discard')?.args).toEqual([
      't1',
      false,
    ]);
  });

  it('lists every repo of a multi-repo task and says which one stays', async () => {
    installFakeApi({
      'tasks:discardChecks': () =>
        checks({
          workspaces: [
            ws(),
            ws({
              workspaceId: 'w2',
              repoName: 'api',
              worktreePath: '/w/api-wt',
            }),
            ws({
              workspaceId: 'w3',
              repoName: 'docs',
              branch: 'dev',
              kept: true,
            }),
          ],
        }),
    });
    render(<DiscardBar task={task} />);
    const bar = await screen.findByRole('alertdialog');
    await waitFor(() => expect(bar).toHaveTextContent('/w/api-wt'));
    expect(bar).toHaveTextContent(/docs stays as it is \(on dev,/);
  });

  it('Cancel closes the bar and changes nothing', async () => {
    const api = installFakeApi({
      'tasks:discardChecks': () => checks(),
    });
    render(<DiscardBar task={task} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Cancel' }),
    );
    expect(useStore.getState().discardTaskId).toBeNull();
    expect(api.calls.map((c) => c.channel)).not.toContain('tasks:discard');
  });

  it('a refused discard is a notice and the bar stays', async () => {
    installFakeApi({
      'tasks:discardChecks': () => checks(),
      'tasks:discard': () => {
        throw new Error('Cannot discard a task that is finishing');
      },
    });
    render(<DiscardBar task={task} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Discard task' }),
    );
    await waitFor(() =>
      expect(useStore.getState().notices.map((n) => n.message)).toEqual([
        'Cannot discard a task that is finishing',
      ]),
    );
    expect(useStore.getState().discardTaskId).toBe('t1');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});
