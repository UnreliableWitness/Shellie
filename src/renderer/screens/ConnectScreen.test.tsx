import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Channels } from '../../shared/ipc';
import type { Connection } from '../../shared/types';
import type { AppSettings } from '../../shared/usage';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { ConnectScreen } from './ConnectScreen';

type Probe = Channels['connections:probe']['result'];
const probe = (over: Partial<Probe> = {}): Probe => ({
  user: 'Dries Hoebeke',
  uniqueName: 'dries@example.com',
  projects: [{ id: 'p1', name: 'Shellie' }],
  canListProjects: true,
  ...over,
});
const three = probe({
  projects: [
    { id: 'p1', name: 'Shellie' },
    { id: 'p2', name: 'Webshop' },
    { id: 'p3', name: 'Infra' },
  ],
});
const conn: Connection = {
  id: 'c1',
  name: 'unreliablewitness/Shellie',
  organizationUrl: 'https://dev.azure.com/unreliablewitness',
  project: 'Shellie',
  user: 'Dries Hoebeke',
  status: 'ok',
  checkedAt: null,
  userUniqueName: null,
  provider: 'azure-devops',
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
  writeTimeToAdo: false,
};

const agentsDone = {
  onboarding: {
    dismissedAt: null,
    agentsCheckedAt: '2026-10-22T09:00:00.000Z',
    tracker: null,
  },
} as AppSettings;

function open(
  from: 'settings' | 'get-started',
  connectionId?: string,
  connections: Connection[] = [],
) {
  useStore.setState({
    screen: { kind: 'connect', from, connectionId },
    previous: null,
    notices: [],
    connections,
    repos: [],
    settings: null,
  });
}
const callsOf = (
  calls: { channel: string; args: unknown[] }[],
  channel: string,
) => calls.filter((c) => c.channel === channel).map((c) => c.args[0]);

async function signIn(pat = 'secret-pat') {
  await userEvent.type(
    screen.getByLabelText('Organization URL'),
    'https://dev.azure.com/unreliablewitness/',
  );
  await userEvent.type(screen.getByLabelText('Personal access token'), pat);
  await userEvent.click(screen.getByRole('button', { name: 'Test' }));
}

beforeEach(() => open('get-started'));

describe('ConnectScreen', () => {
  it('tests the token and shows the user and the projects, a single one ticked', async () => {
    const { calls } = installFakeApi({ 'connections:probe': () => probe() });
    render(<ConnectScreen />);
    expect(screen.getByRole('list', { name: 'Setup steps' })).toBeTruthy();
    await signIn();
    expect(await screen.findByText('Signed in as Dries Hoebeke')).toBeTruthy();
    expect(callsOf(calls, 'connections:probe')).toEqual([
      {
        organizationUrl: 'https://dev.azure.com/unreliablewitness/',
        pat: 'secret-pat',
      },
    ]);
    expect(screen.getByRole('checkbox', { name: 'Shellie' })).toBeChecked();
    expect(document.body.textContent).not.toContain('secret-pat');
  });

  it('leaves every project unticked when there are several', async () => {
    installFakeApi({ 'connections:probe': () => three });
    render(<ConnectScreen />);
    await signIn();
    await screen.findByText('Signed in as Dries Hoebeke');
    for (const name of ['Shellie', 'Webshop', 'Infra'])
      expect(screen.getByRole('checkbox', { name })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('lists the three scopes and links to the tokens page of the organization', async () => {
    installFakeApi();
    render(<ConnectScreen />);
    await userEvent.type(
      screen.getByLabelText('Organization URL'),
      'https://dev.azure.com/unreliablewitness/',
    );
    const scopes = screen.getByTestId('connect-scopes');
    expect(scopes).toHaveTextContent('Work Items (Read & write)');
    expect(scopes).toHaveTextContent('Code (Read & write)');
    expect(scopes).toHaveTextContent('Project and Team (Read)');
    expect(
      screen.getByRole('link', { name: /Open the tokens page/ }),
    ).toHaveAttribute(
      'href',
      'https://dev.azure.com/unreliablewitness/_usersSettings/tokens',
    );
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('says what to add when the token cannot list projects', async () => {
    installFakeApi({
      'connections:probe': () =>
        probe({ projects: [], canListProjects: false }),
    });
    render(<ConnectScreen />);
    await signIn();
    expect(
      await screen.findByText(
        'The token can sign in but cannot list projects: add Project and Team (Read)',
      ),
    ).toBeTruthy();
  });

  it('saves a typed project when the token cannot list projects', async () => {
    const { calls } = installFakeApi({
      'connections:probe': () =>
        probe({ projects: [], canListProjects: false }),
      'connections:saveMany': () => [conn],
      'connections:list': () => [conn],
    });
    render(<ConnectScreen />);
    await signIn();
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Project name' }),
      'Shellie',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // Agents is still to do, so Continue goes there rather than back to Get started.
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({
        kind: 'agents',
        from: 'get-started',
      }),
    );
    expect(
      (callsOf(calls, 'connections:saveMany')[0] as { projects: string[] })
        .projects,
    ).toEqual(['Shellie']);
  });

  it('marks the projects of an organization that is typed again as connected, and stays when nothing new was saved', async () => {
    open('get-started', undefined, [conn]);
    installFakeApi({
      'connections:probe': () => probe(),
      'connections:saveMany': () => [],
    });
    render(<ConnectScreen />);
    await signIn();
    const shellie = await screen.findByRole('checkbox', { name: /Shellie/ });
    expect(shellie).toBeChecked();
    expect(shellie).toBeDisabled();
    expect(screen.getByText('(added)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('stays with a notice when every ticked project was already connected', async () => {
    installFakeApi({
      'connections:probe': () => probe(),
      'connections:saveMany': () => [],
    });
    render(<ConnectScreen />);
    await signIn();
    await screen.findByText('Signed in as Dries Hoebeke');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(useStore.getState().notices.map((n) => n.message)).toContain(
        'Every ticked project is already connected',
      ),
    );
    expect(useStore.getState().screen.kind).toBe('connect');
  });

  it('saves the ticked projects with the on-start options and goes on to Add a repository', async () => {
    useStore.setState({ settings: agentsDone });
    const { calls, tracked } = installFakeApi({
      'connections:probe': () => three,
      'connections:saveMany': () => [conn],
      'connections:list': () => [conn],
    });
    render(<ConnectScreen />);
    await signIn();
    await screen.findByText('Signed in as Dries Hoebeke');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Shellie' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Webshop' }));
    expect(
      screen.getByRole('checkbox', {
        name: 'Move the work item to In Progress',
      }),
    ).toBeChecked();
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Assign it to me' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({
        kind: 'add-repo',
        from: 'get-started',
      }),
    );
    expect(callsOf(calls, 'connections:saveMany')).toEqual([
      {
        organizationUrl: 'https://dev.azure.com/unreliablewitness/',
        pat: 'secret-pat',
        projects: ['Shellie', 'Webshop'],
        workItemOnStart: {
          moveToInProgress: true,
          assignToMe: false,
          stateOverrides: {},
        },
        provider: 'azure-devops',
      },
    ]);
    expect(useStore.getState().connections).toEqual([conn]);
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'onboarding.step',
      props: { step: 'connect', outcome: 'continued' },
    });
  });

  it('No tracker: Continue saves the choice and goes Home when the steps are done', async () => {
    useStore.setState({ repos: [{ id: 'r1' } as never] });
    const { calls, tracked } = installFakeApi({
      'settings:save': (s: AppSettings) => s,
    });
    render(<ConnectScreen />);
    await userEvent.click(screen.getByRole('radio', { name: /No tracker/ }));
    expect(screen.queryByLabelText('Personal access token')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'home' }),
    );
    const saved = callsOf(calls, 'settings:save') as AppSettings[];
    expect(saved).toHaveLength(1);
    expect(saved[0].onboarding.tracker).toBe('none');
    expect(saved[0].onboarding.agentsCheckedAt).toBe(
      '2026-10-22T09:00:00.000Z',
    );
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'onboarding.step',
      props: { step: 'connect', outcome: 'continued' },
    });
  });

  it('renders the page header outside the padded page body, as Settings does', () => {
    installFakeApi();
    const { container } = render(<ConnectScreen />);
    expect(container.querySelector('.page > .pagehead')).toBeTruthy();
    expect(container.querySelector('.page-body .pagehead')).toBeNull();
  });

  it('shows GitHub as coming soon and not selectable', () => {
    installFakeApi();
    render(<ConnectScreen />);
    const github = screen.getByRole('radio', { name: /GitHub/ });
    expect(github).toBeDisabled();
    expect(screen.getByText('Soon')).toBeTruthy();
    expect(github.closest('[title]')?.getAttribute('title')).toBe(
      'Issues, Projects iterations and pull requests come in a later release',
    );
  });

  it('adds a project with the stored token: no token field, the connected project marked', async () => {
    open('settings', 'c1', [conn]);
    const { calls } = installFakeApi({
      'connections:probe': () => three,
      'connections:saveMany': () => [{ ...conn, id: 'c3', project: 'Infra' }],
      'connections:list': () => [conn],
    });
    render(<ConnectScreen />);
    expect(screen.queryByLabelText('Personal access token')).toBeNull();
    expect(screen.queryByRole('radio', { name: /No tracker/ })).toBeNull();
    expect(await screen.findByText('Signed in as Dries Hoebeke')).toBeTruthy();
    expect(callsOf(calls, 'connections:probe')).toEqual([
      {
        organizationUrl: 'https://dev.azure.com/unreliablewitness',
        connectionId: 'c1',
      },
    ]);
    const shellie = screen.getByRole('checkbox', { name: /Shellie/ });
    expect(shellie).toBeChecked();
    expect(shellie).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Infra' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({
        kind: 'settings',
        section: 'ado',
      }),
    );
    expect(callsOf(calls, 'connections:saveMany')).toEqual([
      {
        organizationUrl: 'https://dev.azure.com/unreliablewitness',
        connectionId: 'c1',
        projects: ['Infra'],
        workItemOnStart: {
          moveToInProgress: true,
          assignToMe: true,
          stateOverrides: {},
        },
        provider: 'azure-devops',
      },
    ]);
    expect(screen.queryByRole('list', { name: 'Setup steps' })).toBeNull();
  });

  it('shows a refused token as an error without the token', async () => {
    installFakeApi({
      'connections:probe': () => {
        throw new Error('Azure DevOps rejected secret-pat');
      },
    });
    render(<ConnectScreen />);
    await signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Azure DevOps rejected ***',
    );
    expect(document.body.textContent).not.toContain('secret-pat');
  });

  it('Skip for now goes on to the next unfinished step and reports skipped', async () => {
    useStore.setState({ settings: agentsDone });
    const { tracked } = installFakeApi();
    render(<ConnectScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'add-repo',
      from: 'get-started',
    });
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'onboarding.step',
      props: { step: 'connect', outcome: 'skipped' },
    });
  });

  it('from Settings, Back returns to the connections section', async () => {
    open('settings');
    installFakeApi();
    render(<ConnectScreen />);
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      section: 'ado',
    });
  });
});
