import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from '../../shared/types';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { ConnectionsSection } from './ConnectionsSection';

const ok: Connection = {
  id: 'c1',
  name: 'unreliablewitness',
  organizationUrl: 'https://dev.azure.com/unreliablewitness',
  project: 'Shellie',
  user: 'Dries Hoebeke',
  status: 'ok',
  checkedAt: '2026-10-14T10:00:00.000Z',
  userUniqueName: null,
  provider: 'azure-devops' as const,
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
};

beforeEach(() =>
  useStore.setState({
    repos: [],
    tasks: [],
    notices: [],
    connections: [],
    screen: { kind: 'settings' },
  }),
);

describe('ConnectionsSection', () => {
  it('lists connections with their status', () => {
    installFakeApi();
    useStore.setState({
      connections: [
        ok,
        {
          ...ok,
          id: 'c2',
          organizationUrl: 'https://dev.azure.com/client',
          name: 'client',
          status: 'unauthorized',
          user: null,
        },
      ],
    });
    render(<ConnectionsSection />);
    expect(screen.getByText('Connected as Dries Hoebeke')).toBeInTheDocument();
    expect(
      screen.getByText('https://dev.azure.com/unreliablewitness'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Shellie')).toHaveLength(2);
    expect(
      screen.getByText('Token rejected, enter it again'),
    ).toBeInTheDocument();
  });

  it('groups connections by organization, each group with Add a project', async () => {
    installFakeApi();
    useStore.setState({
      connections: [
        ok,
        {
          ...ok,
          id: 'c2',
          name: 'unreliablewitness/Webshop',
          project: 'Webshop',
        },
        {
          ...ok,
          id: 'c3',
          name: 'client',
          organizationUrl: 'https://dev.azure.com/client',
          project: 'Portal',
        },
      ],
    });
    const { container } = render(<ConnectionsSection />);
    const groups = container.querySelectorAll('.conn-group');
    expect(groups).toHaveLength(2);
    expect(groups[0].querySelectorAll('.list-row')).toHaveLength(2);
    expect(groups[1].querySelectorAll('.list-row')).toHaveLength(1);
    expect(
      screen.getAllByRole('button', { name: 'Add a project' }),
    ).toHaveLength(2);
    expect(
      screen.getAllByRole('button', { name: 'Update token' }),
    ).toHaveLength(2);
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Add a project' })[1],
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'connect',
      from: 'settings',
      connectionId: 'c3',
    });
  });

  it('shows the provider picker and opens the Connect page to add a connection', async () => {
    installFakeApi();
    render(<ConnectionsSection />);
    expect(screen.getByRole('heading', { name: 'Connections' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Azure DevOps/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /GitHub/ })).toBeDisabled();
    await userEvent.click(
      screen.getByRole('button', { name: /Add connection/ }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'connect',
      from: 'settings',
    });
  });

  it('saves No tracker from the picker', async () => {
    const { calls } = installFakeApi({ 'settings:save': (x) => x });
    render(<ConnectionsSection />);
    await userEvent.click(screen.getByRole('radio', { name: /No tracker/ }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'settings:save')?.args[0],
      ).toMatchObject({ onboarding: { tracker: 'none' } }),
    );
    expect(screen.getByRole('radio', { name: /No tracker/ })).toBeChecked();
    expect(screen.queryByRole('button', { name: /Add connection/ })).toBeNull();
  });

  it('updates the token of every connection of the organization with the same token', async () => {
    const webshop = {
      ...ok,
      id: 'c2',
      name: 'unreliablewitness/Webshop',
      project: 'Webshop',
    };
    useStore.setState({ connections: [ok, webshop] });
    const { calls } = installFakeApi({
      'connections:save': (input) => (input.id === 'c1' ? ok : webshop),
      'connections:list': () => [ok, webshop],
    });
    render(<ConnectionsSection />);
    await userEvent.click(screen.getByRole('button', { name: 'Update token' }));
    expect(screen.getByText(/Project and Team \(Read\)/)).toBeTruthy();
    await userEvent.type(
      screen.getByLabelText('New personal access token'),
      'fresh-pat',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save token' }));
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.channel === 'connections:save')
          .map((c) => c.args[0]),
      ).toEqual([
        {
          id: 'c1',
          name: 'unreliablewitness',
          organizationUrl: 'https://dev.azure.com/unreliablewitness',
          project: 'Shellie',
          pat: 'fresh-pat',
        },
        {
          id: 'c2',
          name: 'unreliablewitness/Webshop',
          organizationUrl: 'https://dev.azure.com/unreliablewitness',
          project: 'Webshop',
          pat: 'fresh-pat',
        },
      ]),
    );
    await waitFor(() =>
      expect(
        screen.queryByLabelText('New personal access token'),
      ).not.toBeInTheDocument(),
    );
  });

  it('verifies and removes', async () => {
    const { calls } = installFakeApi({
      'connections:verify': () => ({ ...ok, checkedAt: 'later' }),
      'connections:remove': () => undefined,
      'connections:list': () => [ok],
    });
    useStore.setState({
      connections: [ok],
      repos: [
        {
          id: 'r1',
          name: 'webshop',
          path: '/w',
          baseBranch: 'main',
          connectionId: 'c1',
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
    });
    render(<ConnectionsSection />);
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'connections:verify')).toBe(true),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(
      screen.getByText(/1 repository uses this connection/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove anyway' }),
    );
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.channel === 'connections:remove' && c.args[0] === 'c1',
        ),
      ).toBe(true),
    );
  });

  it('removes an unused connection without a confirm row', async () => {
    const { calls } = installFakeApi({
      'connections:remove': () => undefined,
      'connections:list': () => [],
    });
    useStore.setState({ connections: [ok], repos: [] });
    render(<ConnectionsSection />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.channel === 'connections:remove' && c.args[0] === 'c1',
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('replaces the token of an existing connection, checked like a new one', async () => {
    useStore.setState({ connections: [{ ...ok, status: 'unauthorized' }] });
    const { calls } = installFakeApi({
      'connections:save': () => ok,
      'connections:list': () => [ok],
    });
    render(<ConnectionsSection />);
    expect(
      screen.queryByLabelText('New personal access token'),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Update token' }));
    await userEvent.type(
      screen.getByLabelText('New personal access token'),
      'fresh-pat',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save token' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'connections:save')?.args[0],
      ).toEqual({
        id: 'c1',
        name: 'unreliablewitness',
        organizationUrl: 'https://dev.azure.com/unreliablewitness',
        project: 'Shellie',
        pat: 'fresh-pat',
      }),
    );
    await waitFor(() => expect(useStore.getState().connections).toEqual([ok]));
    expect(
      screen.queryByLabelText('New personal access token'),
    ).not.toBeInTheDocument();
  });

  it('keeps the token form open with a redacted error when the new token is refused', async () => {
    useStore.setState({ connections: [ok] });
    installFakeApi({
      'connections:save': () => {
        throw new Error('Azure DevOps rejected fresh-pat');
      },
    });
    render(<ConnectionsSection />);
    await userEvent.click(screen.getByRole('button', { name: 'Update token' }));
    await userEvent.type(
      screen.getByLabelText('New personal access token'),
      'fresh-pat',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Azure DevOps rejected ***',
    );
    expect(
      screen.getByLabelText('New personal access token'),
    ).toBeInTheDocument();
  });

  it('opens the token form of the connection Settings was opened at', () => {
    installFakeApi();
    useStore.setState({
      connections: [
        ok,
        {
          ...ok,
          id: 'c2',
          name: 'client',
          organizationUrl: 'https://dev.azure.com/client',
        },
      ],
      screen: { kind: 'settings', section: 'conn-c2' },
    });
    const { container } = render(<ConnectionsSection />);
    const forms = container.querySelectorAll('.conn-form');
    expect(forms).toHaveLength(1);
    expect(
      container.querySelector('#conn-c2')?.closest('.conn-group'),
    ).toContainElement(forms[0] as HTMLElement);
  });
});
