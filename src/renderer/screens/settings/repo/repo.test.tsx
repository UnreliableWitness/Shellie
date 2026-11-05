import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Channels } from '../../../../shared/ipc';
import type { ConfigSource } from '../../../../shared/repoConfig';
import type { Repo, ShellieConfig } from '../../../../shared/types';
import { useStore } from '../../../store';
import { installFakeApi, noOverrides } from '../../../test-helpers/fakeApi';
import { RepoScope } from '../RepoScope';

const webshop: Repo = {
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
};

const conn = {
  id: 'c1',
  name: 'unreliablewitness',
  organizationUrl: 'https://dev.azure.com/unreliablewitness',
  project: 'Shellie',
  user: null,
  status: 'ok' as const,
  checkedAt: null,
  userUniqueName: null,
  provider: 'azure-devops' as const,
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
  writeTimeToAdo: false,
};

const baseConfig: ShellieConfig = {
  base: 'main',
  branch: '{type}/{id}-{slug}',
  copy: [],
  setup: ['npm ci'],
  run: { dev: 'npm run dev' },
  found: true,
};

type ConfigResult = Channels['repos:config']['result'];

function configResult(
  over: Partial<Omit<ConfigResult, 'config'>> & {
    config?: Partial<ShellieConfig>;
    sourceOf?: Partial<Record<string, ConfigSource>>;
  } = {},
): ConfigResult {
  const { sourceOf, config, ...rest } = over;
  return {
    worktreeRoot: '/src/webshop.worktrees',
    ...noOverrides,
    sources: { ...noOverrides.sources, ...sourceOf },
    ...rest,
    config: { ...baseConfig, ...config },
  };
}

beforeEach(() => {
  useStore.setState({
    repos: [webshop],
    tasks: [],
    connections: [],
    notices: [],
    screen: { kind: 'settings' },
  });
});

describe('RepoScope categories', () => {
  it('editing setup commands sends repos:setOverride setup', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => configResult(),
      'repos:setOverride': () => webshop,
    });
    render(<RepoScope repo={webshop} active />);
    const item = await screen.findByLabelText('Setup commands item 1');
    await userEvent.clear(item);
    await userEvent.type(item, 'npm install{Enter}');
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'repos:setOverride')?.args,
      ).toEqual(['r1', 'setup', ['npm install']]),
    );
  });

  it('Reset sends null', async () => {
    const { calls } = installFakeApi({
      'repos:config': () =>
        configResult({
          config: { setup: ['npm install'] },
          sourceOf: { setup: 'override' },
        }),
      'repos:setOverride': () => webshop,
    });
    render(<RepoScope repo={webshop} active />);
    await screen.findByText('Modified by you');
    await userEvent.click(
      screen.getByLabelText('More actions for Setup commands'),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reset' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'repos:setOverride')?.args,
      ).toEqual(['r1', 'setup', null]),
    );
  });

  it('source label from .shellie.yml', async () => {
    installFakeApi({
      'repos:config': () =>
        configResult({
          config: { base: 'develop' },
          sourceOf: { base: 'file' },
        }),
    });
    render(<RepoScope repo={webshop} active />);
    expect(await screen.findByLabelText('Base branch')).toHaveValue('develop');
    const row = document.getElementById('repo-general-base');
    expect(row).toHaveAttribute('data-modified', 'true');
    expect(row).toHaveTextContent('From .shellie.yml');
    // Not your override, so nothing to reset.
    await userEvent.click(
      screen.getByLabelText('More actions for Base branch'),
    );
    expect(screen.getByRole('menuitem', { name: 'Reset' })).toBeDisabled();
  });

  it('Base branch saves once on Enter then leaving the field', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => configResult(),
      'repos:setOverride': () => webshop,
    });
    render(<RepoScope repo={webshop} active />);
    const input = await screen.findByLabelText('Base branch');
    await userEvent.clear(input);
    await userEvent.type(input, 'develop{Enter}');
    await userEvent.tab();
    await waitFor(() =>
      expect(
        calls.filter((c) => c.channel === 'repos:setOverride'),
      ).toHaveLength(1),
    );
    expect(calls.filter((c) => c.channel === 'repos:setOverride')).toHaveLength(
      1,
    );
  });

  it('branch preview renders', async () => {
    installFakeApi({ 'repos:config': () => configResult() });
    render(<RepoScope repo={webshop} active />);
    expect(
      await screen.findByText('feature/1234-add-login-page'),
    ).toBeInTheDocument();
    const input = screen.getByLabelText('Branch name pattern');
    await userEvent.clear(input);
    await userEvent.type(input, 'users/me/{{id}');
    expect(screen.getByText('users/me/1234')).toBeInTheDocument();
  });

  it('work item types shown without a fold', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => configResult(),
      'workItems:types': () => [
        {
          name: 'Task',
          color: null,
          icon: null,
          states: [
            { name: 'To Do', color: null, category: 'Proposed' },
            { name: 'Doing', color: null, category: 'InProgress' },
          ],
        },
      ],
    });
    const linked = { ...webshop, connectionId: 'c1' };
    useStore.setState({ repos: [linked], connections: [conn] });
    render(<RepoScope repo={linked} active />);
    const select = await screen.findByLabelText('In Progress state for Task');
    expect(screen.queryByText('Override per type')).toBeNull();
    await userEvent.selectOptions(select, 'Doing');
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'repos:setWorkItemOnStart')?.args,
      ).toEqual([
        'r1',
        {
          moveToInProgress: true,
          assignToMe: true,
          stateOverrides: { Task: 'Doing' },
        },
      ]),
    );
  });

  it('no connection disables work item rows', async () => {
    const { calls } = installFakeApi({ 'repos:config': () => configResult() });
    render(<RepoScope repo={webshop} active />);
    expect(
      screen.getByRole('checkbox', {
        name: 'Move the work item to In Progress on start',
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'Assign it to me if unassigned' }),
    ).toBeDisabled();
    expect(
      screen.getAllByText('Link a connection in General first').length,
    ).toBeGreaterThan(0);
    await screen.findByLabelText('Base branch');
    expect(calls.some((c) => c.channel === 'workItems:types')).toBe(false);
  });

  it('Create .shellie.yml shown only without a file', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => configResult({ config: { found: false } }),
      'repos:createConfigFile': () => ({ ...webshop, configFound: true }),
    });
    const bare = { ...webshop, configFound: false };
    const { unmount } = render(<RepoScope repo={bare} active />);
    const create = await screen.findByRole('button', {
      name: 'Create .shellie.yml',
    });
    expect(
      screen.queryByRole('button', { name: 'Open .shellie.yml' }),
    ).toBeNull();
    await userEvent.click(create);
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'repos:createConfigFile')).toBe(
        true,
      ),
    );
    unmount();

    installFakeApi({ 'repos:config': () => configResult() });
    render(<RepoScope repo={webshop} active />);
    expect(
      await screen.findByRole('button', { name: 'Open .shellie.yml' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create .shellie.yml' }),
    ).toBeNull();
  });

  it('broken file shows the banner and still renders rows', async () => {
    installFakeApi({
      'repos:config': () =>
        configResult({
          config: { found: false },
          fileError: 'setup must be a list',
        }),
    });
    render(<RepoScope repo={webshop} active />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'setup must be a list',
    );
    expect(screen.getByLabelText('Setup commands item 1')).toHaveValue(
      'npm ci',
    );
    expect(
      screen.getByRole('button', { name: 'Open .shellie.yml' }),
    ).toBeInTheDocument();
  });

  it('Remove asks to confirm', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => configResult(),
      'repos:remove': () => undefined,
      'repos:list': () => [],
    });
    render(<RepoScope repo={webshop} active />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove repository' }),
    );
    expect(calls.some((c) => c.channel === 'repos:remove')).toBe(false);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'repos:remove')?.args).toEqual([
        'r1',
      ]),
    );
  });

  it('reloads when repos:changed is broadcast', async () => {
    let base = 'main';
    const { emit } = installFakeApi({
      'repos:config': () => configResult({ config: { base } }),
    });
    render(<RepoScope repo={webshop} active />);
    expect(await screen.findByLabelText('Base branch')).toHaveValue('main');
    base = 'develop';
    emit('repos:changed', [webshop]);
    await waitFor(() =>
      expect(screen.getByLabelText('Base branch')).toHaveValue('develop'),
    );
  });

  it('sets the apm list from the checkboxes', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => configResult({ config: { apm: ['claude'] } }),
      'repos:setOverride': () => webshop,
    });
    render(<RepoScope repo={webshop} active />);
    expect(await screen.findByLabelText('Agent packages')).toHaveValue(
      'choose',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'opencode' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'repos:setOverride')?.args,
      ).toEqual(['r1', 'apm', ['claude', 'opencode']]),
    );
  });

  it('unticking the last apm box stores Off, not an empty list', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => configResult({ config: { apm: ['claude'] } }),
      'repos:setOverride': () => webshop,
    });
    render(<RepoScope repo={webshop} active />);
    expect(await screen.findByLabelText('Agent packages')).toHaveValue(
      'choose',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'claude' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'repos:setOverride')?.args,
      ).toEqual(['r1', 'apm', false]),
    );
  });

  it('saves this repo’s editor', async () => {
    let current = {} as Channels['settings:get']['result'];
    const { calls } = installFakeApi({
      'repos:config': () => configResult(),
      'editor:installed': () => [
        { id: 'vscode', label: 'VS Code' },
        { id: 'visualstudio', label: 'Visual Studio' },
      ],
      'settings:save': (s) => (current = s),
    });
    render(<RepoScope repo={webshop} active />);
    await userEvent.selectOptions(
      await screen.findByLabelText('Editor for webshop'),
      'vscode',
    );
    await waitFor(() =>
      expect(current.editor?.repos).toEqual({
        r1: { editor: 'vscode', solution: null },
      }),
    );
    expect(calls.some((c) => c.channel === 'editor:installed')).toBe(true);
  });
});
