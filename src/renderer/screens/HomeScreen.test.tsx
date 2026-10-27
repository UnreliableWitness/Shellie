import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeSnapshot } from '../../shared/home';
import type { Connection } from '../../shared/types';
import { defaultSettings } from '../../shared/usage';
import { Shell } from '../App';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';

vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }));

export const connection: Connection = {
  id: 'c1',
  name: 'uw',
  organizationUrl: 'https://dev.azure.com/uw',
  project: 'Shellie',
  user: 'D',
  status: 'ok',
  checkedAt: null,
  userUniqueName: null,
  provider: 'azure-devops' as const,
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
};

export const snapshot = (over: Partial<HomeSnapshot> = {}): HomeSnapshot => ({
  version: 1,
  builtAt: new Date().toISOString(),
  connections: [
    {
      connectionId: 'c1',
      name: 'uw',
      project: 'Shellie',
      status: 'ok',
      error: null,
      fetchedAt: new Date().toISOString(),
      sprints: [],
      sprintsError: null,
      reviews: [],
      teamReviews: [],
      myPrs: [],
      prsError: null,
    },
  ],
  ...over,
});

beforeEach(() =>
  useStore.setState({
    repos: [],
    tasks: [],
    connections: [connection],
    connectionId: null,
    notices: [],
    selectedTaskId: null,
    previous: null,
    screen: { kind: 'home' },
  }),
);

describe('Home page', () => {
  it('shows the cached snapshot without waiting for a rebuild', async () => {
    const { calls } = installFakeApi({ 'home:get': () => snapshot() });
    render(<Shell />);
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'uw: Shellie, connected' }),
    ).toBeTruthy();
    // Fresh snapshot: no rebuild on open.
    expect(calls.some((c) => c.channel === 'home:refresh')).toBe(false);
  });

  it('rebuilds a snapshot older than a minute, and with none', async () => {
    const old = snapshot({
      builtAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const { calls } = installFakeApi({ 'home:get': () => old });
    render(<Shell />);
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'home:refresh')).toBe(true),
    );
  });

  it('shows Loading in the PR (both columns) and sprint bands until a snapshot exists', async () => {
    installFakeApi({
      'home:get': () => null,
      'home:refresh': () => new Promise(() => {}),
    });
    render(<Shell />);
    expect(await screen.findAllByText('Loading')).toHaveLength(3);
    expect(screen.queryByText('No reviews waiting.')).toBeNull();
  });

  it('the refresh button rebuilds', async () => {
    const { calls } = installFakeApi({ 'home:get': () => snapshot() });
    render(<Shell />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Refresh' }),
    );
    expect(calls.filter((c) => c.channel === 'home:refresh')).toHaveLength(1);
  });

  it('takes the snapshot from home:updated', async () => {
    const { emit } = installFakeApi({ 'home:get': () => snapshot() });
    render(<Shell />);
    await screen.findByRole('heading', { name: 'Home' });
    act(() =>
      emit(
        'home:updated',
        snapshot({
          connections: [
            { ...snapshot().connections[0], status: 'stale', error: 'refused' },
          ],
        }),
      ),
    );
    expect(
      await screen.findByRole('button', {
        name: 'uw: Shellie, stale: refused',
      }),
    ).toBeTruthy();
  });

  it('a chip opens Settings', async () => {
    installFakeApi({ 'home:get': () => snapshot() });
    render(<Shell />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'uw: Shellie, connected' }),
    );
    expect(useStore.getState().screen.kind).toBe('settings');
  });

  it('the refused-token notice has a Settings button', async () => {
    useStore.setState({
      connections: [{ ...connection, status: 'unauthorized' }],
    });
    installFakeApi({ 'home:get': () => snapshot() });
    render(<Shell />);
    await userEvent.click(
      await within(
        (await screen.findByText(/refused the token/)) as HTMLElement,
      ).findByRole('button', {
        name: 'Settings',
      }),
    );
    expect(useStore.getState().screen.kind).toBe('settings');
  });

  it('hides rows of a connection that was removed', async () => {
    const withPr = snapshot();
    withPr.connections[0].myPrs = [
      {
        id: 7,
        repo: 'web',
        title: 'Old PR',
        author: 'A',
        authorId: 'a',
        createdAt: '2026-10-10T00:00:00Z',
        isDraft: false,
        conflicts: false,
        myVote: null,
        votes: { approved: 0, waiting: 0, rejected: 0 },
        url: 'u',
      },
    ];
    installFakeApi({ 'home:get': () => withPr });
    render(<Shell />);
    expect(await screen.findByText(/Old PR/)).toBeTruthy();
    act(() => useStore.setState({ connections: [] }));
    expect(screen.queryByText(/Old PR/)).toBeNull();
  });

  it('rebuilds when a connection is added', async () => {
    const { calls, emit } = installFakeApi({ 'home:get': () => snapshot() });
    render(<Shell />);
    await screen.findByRole('heading', { name: 'Home' });
    act(() =>
      emit('connections:changed', [connection, { ...connection, id: 'c2' }]),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'home:refresh')).toBe(true),
    );
  });

  it('does not rebuild when only a connection status changes', async () => {
    const { calls, emit } = installFakeApi({ 'home:get': () => snapshot() });
    render(<Shell />);
    await screen.findByRole('heading', { name: 'Home' });
    act(() =>
      emit('connections:changed', [{ ...connection, status: 'unauthorized' }]),
    );
    act(() =>
      emit('connections:changed', [{ ...connection, status: 'unreachable' }]),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.channel === 'home:refresh')).toHaveLength(0);
  });

  it('without connections it shows the Get started band with Connect your tracker', async () => {
    useStore.setState({ connections: [], settings: defaultSettings() });
    installFakeApi();
    render(<Shell />);
    const band = await screen.findByRole('region', { name: 'Get started' });
    expect(
      within(band).getByRole('region', { name: '2 · Connect your tracker' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Add an Azure DevOps connection' }),
    ).toBeNull();
    expect(screen.getByRole('region', { name: 'My tasks' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Stats' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'My sprints' })).toBeNull();
  });

  it('the band shows only unfinished steps and goes once dismissed', async () => {
    const s = defaultSettings();
    useStore.setState({
      connections: [],
      settings: { ...s, onboarding: { ...s.onboarding, agentsCheckedAt: 'x' } },
    });
    const { tracked } = installFakeApi({
      'settings:get': () => useStore.getState().settings!,
      'settings:save': (next) => next,
    });
    render(<Shell />);
    const band = await screen.findByRole('region', { name: 'Get started' });
    expect(
      within(band).queryByRole('region', { name: '1 · Agents' }),
    ).toBeNull();
    await userEvent.click(
      within(band).getByRole('button', { name: 'Dismiss' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull(),
    );
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'onboarding.dismissed',
      props: { repos: 0, connections: 0 },
    });
  });

  it('no band once dismissed', async () => {
    const s = defaultSettings();
    useStore.setState({
      connections: [],
      settings: { ...s, onboarding: { ...s.onboarding, dismissedAt: 'x' } },
    });
    installFakeApi();
    render(<Shell />);
    await screen.findByRole('region', { name: 'My tasks' });
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull();
  });

  it('the nav has Home above Sprint and the app header goes Home', async () => {
    installFakeApi();
    useStore.setState({ screen: { kind: 'settings' } });
    render(<Shell />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Shellie, go to Home' }),
    );
    expect(useStore.getState().screen.kind).toBe('home');
    await userEvent.click(screen.getByRole('button', { name: 'Sprint' }));
    expect(useStore.getState().screen.kind).toBe('sprint');
  });
});

describe('Home page scrolling (#167)', () => {
  it('scrolls the bands inside the content area, so the nav and header stay put', () => {
    const css = readFileSync(
      path.join(__dirname, '..', 'styles', 'home.css'),
      'utf8',
    );
    const rule = /\.home-bands \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('overflow: auto;');
    expect(rule).toContain('min-height: 0;');
  });
});
