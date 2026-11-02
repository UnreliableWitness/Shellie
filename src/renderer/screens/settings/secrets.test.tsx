import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Channels } from '../../../shared/ipc';
import type { SecretsStatus } from '../../../shared/secrets';
import type { Repo, ShellieConfig } from '../../../shared/types';
import { SettingsSearchProvider } from '../../components/settings/settingsSearch';
import { useStore } from '../../store';
import { installFakeApi, noOverrides } from '../../test-helpers/fakeApi';
import { RepoScope } from './RepoScope';
import { SecretsCategory } from './SecretsCategory';

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
const payments: Repo = { ...webshop, id: 'r2', name: 'payments-api' };
const found: Repo = { ...webshop, id: 'r3', name: 'scratch', discovered: true };

const protectedStatus: SecretsStatus = {
  state: 'protected',
  reasons: [],
  given: ['run'],
  secrets: 3,
};
const copyStatus: SecretsStatus = {
  state: 'attention',
  reasons: [{ kind: 'copy', files: ['.env'], count: 2 }],
  given: [],
  secrets: 1,
};

const config = (copy: string[]): ShellieConfig => ({
  base: 'main',
  branch: '{type}/{id}-{slug}',
  copy,
  setup: [],
  run: {},
  found: true,
});
const configResult = (copy: string[]): Channels['repos:config']['result'] => ({
  worktreeRoot: '/src/webshop.worktrees',
  ...noOverrides,
  config: config(copy),
});

beforeEach(() => {
  useStore.setState({
    repos: [webshop, payments, found],
    tasks: [],
    connections: [],
    notices: [],
    screen: { kind: 'settings' },
  });
});

describe('User › Secrets', () => {
  it('User Secrets lists each repo with its status and Manage opens the manager on it', async () => {
    installFakeApi({
      'secrets:status': (repoId) =>
        repoId === 'r1'
          ? protectedStatus
          : repoId === 'r2'
            ? copyStatus
            : { state: 'empty', reasons: [], given: [], secrets: 0 },
    });
    render(<SecretsCategory />);
    const shop = document.getElementById('secrets-repo-r1')!;
    expect(await within(shop).findByText('Protected')).toBeInTheDocument();
    expect(within(shop).getByText('3 secrets')).toBeInTheDocument();
    expect(within(shop).queryByRole('button', { name: /Import/ })).toBeNull();

    const pay = document.getElementById('secrets-repo-r2')!;
    expect(await within(pay).findByText('Needs attention')).toBeInTheDocument();
    expect(within(pay).getByText('1 secret')).toBeInTheDocument();
    expect(
      within(pay).getByText('Copies .env into every worktree'),
    ).toBeInTheDocument();
    await userEvent.click(within(pay).getByRole('button', { name: /Import/ }));
    expect(useStore.getState().screen).toEqual({
      kind: 'secrets-import',
      repoId: 'r2',
    });

    // A repo found in a task is not listed.
    expect(document.getElementById('secrets-repo-r3')).toBeNull();

    await userEvent.click(within(shop).getByRole('button', { name: 'Manage' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'secrets',
      repoId: 'r1',
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Open secrets manager' }),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'secrets' });
  });

  it('offers Import for a repo with nothing stored', async () => {
    installFakeApi();
    useStore.setState({ repos: [webshop] });
    render(<SecretsCategory />);
    const shop = document.getElementById('secrets-repo-r1')!;
    expect(await within(shop).findByText('Nothing stored')).toBeInTheDocument();
    expect(
      within(shop).getByRole('button', { name: /Import/ }),
    ).toBeInTheDocument();
  });
});

describe('User › Secrets when a status fails', () => {
  it("one failing status leaves the others shown and says Couldn't check, without a notice", async () => {
    const { emit } = installFakeApi({
      'secrets:status': (repoId) => {
        if (repoId === 'r2') throw new Error('git broke');
        return protectedStatus;
      },
    });
    render(<SecretsCategory />);
    const shop = document.getElementById('secrets-repo-r1')!;
    const pay = document.getElementById('secrets-repo-r2')!;
    expect(await within(shop).findByText('Protected')).toBeInTheDocument();
    expect(await within(pay).findByText("Couldn't check")).toBeInTheDocument();
    emit('repos:changed', []);
    expect(await within(pay).findByText("Couldn't check")).toBeInTheDocument();
    expect(useStore.getState().notices).toEqual([]);
  });
});

describe('Repository › Secrets & env', () => {
  it('Repository Secrets & env shows the status panel and entries with states', async () => {
    const { calls } = installFakeApi({
      'repos:config': () =>
        configResult(['.env', 'secrets.json', 'appsettings.json', 'gone']),
      'secrets:status': () => copyStatus,
      'secrets:repoDefault': () => 'test',
      'secrets:setRepoDefault': () => undefined,
      'repos:reveal': () => undefined,
      'repos:copyEntries': () => ({
        entries: [
          { path: '.env', state: 'holdsSecrets', folder: false },
          { path: 'secrets.json', state: 'notIgnored', folder: false },
          { path: 'appsettings.json', state: 'present', folder: false },
          { path: 'gone', state: 'missing', folder: false },
        ],
        suggestions: [],
      }),
    });
    render(<RepoScope repo={webshop} active />);
    // The manager's own panel, with its Move action.
    expect(
      await screen.findByText(/webshop still copies .env into every worktree/),
    ).toBeInTheDocument();
    expect(screen.getByText('1 secret stored')).toBeInTheDocument();

    const list = await screen.findByRole('list', {
      name: 'Files copied into each worktree',
    });
    const row = (p: string) =>
      within(list).getByText(p).closest('li') as HTMLElement;
    expect(await within(list).findByText('Holds secrets')).toBeInTheDocument();
    expect(within(row('.env')).getByText('Holds secrets')).toHaveClass(
      'tag-warn',
    );
    expect(
      within(row('secrets.json')).getByText('Not ignored by git'),
    ).toHaveClass('tag-red');
    expect(within(row('appsettings.json')).getByText('Present')).toHaveClass(
      'tag-green',
    );
    expect(within(row('gone')).getByText('Missing')).toHaveClass('tag-warn');
    expect(
      within(row('gone')).getByRole('button', { name: 'Reveal gone' }),
    ).toBeDisabled();

    await userEvent.click(
      within(row('appsettings.json')).getByRole('button', {
        name: 'Reveal appsettings.json',
      }),
    );
    expect(calls.find((c) => c.channel === 'repos:reveal')?.args).toEqual([
      'r1',
      'appsettings.json',
    ]);

    const env = screen.getByLabelText('Default environment');
    expect(env).toHaveValue('test');
    expect(
      within(env)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Development', 'Test']);
    await userEvent.selectOptions(env, 'development');
    expect(
      calls.find((c) => c.channel === 'secrets:setRepoDefault')?.args,
    ).toEqual(['r1', 'development']);

    await userEvent.click(
      within(row('.env')).getByRole('button', { name: 'Manage' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'secrets',
      repoId: 'r1',
    });
  });

  it('Default environment goes back when saving it fails', async () => {
    installFakeApi({
      'repos:config': () => configResult([]),
      'secrets:repoDefault': () => 'test',
      'secrets:setRepoDefault': () => {
        throw new Error('disk full');
      },
    });
    render(<RepoScope repo={webshop} active />);
    const env = screen.getByLabelText('Default environment');
    await waitFor(() => expect(env).toHaveValue('test'));
    await userEvent.selectOptions(env, 'development');
    await waitFor(() => expect(env).toHaveValue('test'));
    expect(useStore.getState().notices.length).toBe(1);
  });

  it('Remove a copied file sends the shorter copy override', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => configResult(['.env', '.env.local']),
      'repos:setOverride': () => webshop,
      'repos:copyEntries': () => ({
        entries: [
          { path: '.env', state: 'present', folder: false },
          { path: '.env.local', state: 'present', folder: false },
        ],
        suggestions: [],
      }),
    });
    render(<RepoScope repo={webshop} active />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove .env' }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'repos:setOverride')?.args,
      ).toEqual(['r1', 'copy', ['.env.local']]),
    );
  });

  it('Add file offers suggestions', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => configResult(['.env']),
      'repos:setOverride': () => webshop,
      'repos:pickFile': () => 'config/local.json',
      'repos:copyEntries': () => ({
        entries: [{ path: '.env', state: 'present', folder: false }],
        suggestions: ['.env.local', 'appsettings.Development.local.json'],
      }),
    });
    render(<RepoScope repo={webshop} active />);
    await screen.findByText('Present');
    await userEvent.click(screen.getByRole('button', { name: /Add file/ }));
    expect(
      screen.getByRole('menuitem', {
        name: 'appsettings.Development.local.json',
      }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: '.env.local' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'repos:setOverride')?.args,
      ).toEqual(['r1', 'copy', ['.env', '.env.local']]),
    );

    await userEvent.click(screen.getByRole('button', { name: /Add file/ }));
    await userEvent.click(
      screen.getByRole('menuitem', { name: /Choose a file/ }),
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.channel === 'repos:setOverride').at(-1)?.args,
      ).toEqual(['r1', 'copy', ['.env', 'config/local.json']]),
    );
  });

  it('the copy agent config switch sends its override', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => configResult([]),
      'repos:setOverride': () => webshop,
    });
    render(
      <SettingsSearchProvider query="">
        <RepoScope repo={webshop} active />
      </SettingsSearchProvider>,
    );
    const box = await screen.findByRole('checkbox', {
      name: 'Copy agent config',
    });
    expect(box).toBeChecked();
    await userEvent.click(box);
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'repos:setOverride')?.args,
      ).toEqual(['r1', 'copyAgentConfig', false]),
    );
  });
});
