import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TaskView } from '../../../shared/types';
import { allCommands } from '../../commands/registry';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { CleanWorktreeCommand } from './CleanWorktreeCommand';

const task = {
  id: 't1',
  repoId: 'r1',
  extraWorkspaces: [],
  homeDropped: false,
} as unknown as TaskView;
const dirty = {
  state: 'attention' as const,
  reasons: [{ kind: 'worktrees' as const, taskIds: ['t1'] }],
  given: [],
  secrets: 1,
};
const command = () => allCommands().find((c) => c.id === 'task.cleanWorktree');

describe('CleanWorktreeCommand', () => {
  it('is offered only while this task still has the old copy, and cleans just it', async () => {
    let state = dirty;
    const api = installFakeApi({
      'secrets:status': () => state,
      'secrets:cleanWorktrees': () => {
        state = { state: 'attention', reasons: [], given: [], secrets: 1 };
        return ['t1'];
      },
    });
    const { container } = render(<CleanWorktreeCommand task={task} />);
    await waitFor(() => expect(command()?.title).toBe('Clean worktree'));
    expect(container).toBeEmptyDOMElement();
    await act(async () => command()?.run());
    await waitFor(() =>
      expect(
        api.calls.find((c) => c.channel === 'secrets:cleanWorktrees')?.args,
      ).toEqual(['r1', 't1']),
    );
    act(() => api.emit('secrets:changed', null));
    await waitFor(() => expect(command()).toBeUndefined());
  });

  it('offers nothing when another task is the dirty one', async () => {
    const api = installFakeApi({
      'secrets:status': () => ({
        ...dirty,
        reasons: [{ kind: 'worktrees', taskIds: ['other'] }],
      }),
    });
    render(<CleanWorktreeCommand task={task} />);
    await waitFor(() =>
      expect(api.calls.some((c) => c.channel === 'secrets:status')).toBe(true),
    );
    expect(command()).toBeUndefined();
  });
});
