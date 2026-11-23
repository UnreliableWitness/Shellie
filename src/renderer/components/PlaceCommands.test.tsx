import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Shell } from '../App';
import { allCommands } from '../commands/registry';
import type { Connection, TaskView } from '../../shared/types';
import { useStore } from '../store';
import { listedBrain } from '../test-helpers/brainFixture';
import { installFakeApi } from '../test-helpers/fakeApi';

describe('the places the palette can go to', () => {
  it('lists the project brains also in Focus, where the nav is not shown', async () => {
    installFakeApi({ 'brain:list': () => [listedBrain()] });
    useStore.setState({
      connections: [
        {
          id: 'c1',
          name: 'acme',
          project: 'Shellie',
          status: 'ok',
        } as unknown as Connection,
      ],
      connectionId: 'c1',
      repos: [],
      tasks: [
        {
          id: 'a',
          name: 'A',
          status: 'ready',
          createdAt: '2026-11-01T09:00:00.000Z',
          connectionId: 'c1',
          repoId: null,
          terminals: [],
          workItem: null,
          worktreeMissing: false,
          environment: 'development',
          mainCheckoutEdits: [],
          extraWorkspaces: [],
          detachedPaths: [],
        } as unknown as TaskView,
      ],
      selectedTaskId: 'a',
      screen: { kind: 'task' },
      focus: true,
      navCollapsed: false,
    });
    render(<Shell />);
    await waitFor(() =>
      expect(allCommands().map((c) => c.title)).toContain('Brain: Acme'),
    );
    useStore.setState({ focus: false, screen: { kind: 'home' } });
  });
});
