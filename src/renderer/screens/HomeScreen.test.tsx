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
import { listedBrain } from '../test-helpers/brainFixture';
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
  writeTimeToAdo: false,
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

  it("a connection chip opens that project's page", async () => {
    const { tracked } = installFakeApi({ 'home:get': () => snapshot() });
    render(<Shell />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'uw: Shellie, connected' }),
    );
    expect(useStore.getState().screen.kind).toBe('project');
    expect(useStore.getState().connectionId).toBe(connection.id);
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'project.open',
      props: { from: 'home' },
    });
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

  it('without connections it shows the Get started band with Connect Azure DevOps', async () => {
    useStore.setState({ connections: [], settings: defaultSettings() });
    installFakeApi();
    render(<Shell />);
    const band = await screen.findByRole('region', { name: 'Get started' });
    expect(
      within(band).getByRole('region', { name: '2 · Connect Azure DevOps' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Add an Azure DevOps connection' }),
    ).toBeNull();
    expect(screen.getByRole('region', { name: 'My tasks' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Stats' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'My sprints' })).toBeNull();
  });

  it('the band lists the brain step while it is todo', async () => {
    useStore.setState({ connections: [], settings: defaultSettings() });
    installFakeApi();
    render(<Shell />);
    const band = await screen.findByRole('region', { name: 'Get started' });
    expect(
      within(band).getByRole('region', {
        name: '4 · A brain for your project',
      }),
    ).toBeTruthy();
  });

  it('the band waits for the brains before it shows', async () => {
    const s = defaultSettings();
    // Every other step done: only the brain step could keep the band up.
    useStore.setState({
      connections: [connection],
      repos: [{ id: 'r1', name: 'webshop' } as never],
      settings: { ...s, onboarding: { ...s.onboarding, agentsCheckedAt: 'x' } },
    });
    // Home asks for the brains in more than one place; all of them wait.
    const answers: ((b: unknown[]) => void)[] = [];
    installFakeApi({
      'home:get': () => snapshot(),
      'brain:list': () =>
        new Promise((r) => {
          answers.push(r);
        }) as never,
    });
    render(<Shell />);
    await screen.findByRole('heading', { name: 'Home' });
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull();
    act(() => answers.forEach((answer) => answer([])));
    expect(
      await screen.findByRole('region', { name: 'Get started' }),
    ).toBeTruthy();
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

  it('the app header goes Home, and Home has the places the nav no longer lists', async () => {
    installFakeApi({
      'brain:list': () => [listedBrain({ connectionId: 'c1' })],
    });
    useStore.setState({ screen: { kind: 'settings' } });
    render(<Shell />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Shellie, go to Home' }),
    );
    expect(useStore.getState().screen.kind).toBe('home');
    const places = await screen.findByRole('region', { name: 'Places' });
    expect(
      await within(places).findByRole('button', { name: /Acme/ }),
    ).toBeInTheDocument();
    expect(
      within(places)
        .getAllByRole('button')
        .map((b) => b.querySelector('b')?.textContent),
    ).toEqual(['Sprint', 'Week', 'Dreams', 'Acme', 'Cost']);
    await userEvent.click(within(places).getByRole('button', { name: /Week/ }));
    expect(useStore.getState().screen.kind).toBe('week');
  });

  it("lists only the active project's brains that are not archived as places, and opens one", async () => {
    installFakeApi({
      'brain:list': () => [
        listedBrain({ id: 'b1', name: 'Acme', connectionId: 'c1' }),
        listedBrain({ id: 'b2', name: 'Elsewhere', connectionId: 'c9' }),
        listedBrain({
          id: 'b3',
          name: 'Old',
          connectionId: 'c1',
          archived: true,
        }),
      ],
    });
    render(<Shell />);
    const places = await screen.findByRole('region', { name: 'Places' });
    await userEvent.click(
      await within(places).findByRole('button', { name: /Acme/ }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'brain',
      brainId: 'b1',
    });
    act(() => useStore.getState().go({ kind: 'home' }));
    const again = await screen.findByRole('region', { name: 'Places' });
    await within(again).findByRole('button', { name: /Acme/ });
    expect(
      within(again).queryByRole('button', { name: /Elsewhere/ }),
    ).toBeNull();
    expect(within(again).queryByRole('button', { name: /Old/ })).toBeNull();
  });

  it('has no Dreams place and no Project link without a project', async () => {
    installFakeApi();
    useStore.setState({ connections: [], connectionId: null });
    render(<Shell />);
    const places = await screen.findByRole('region', { name: 'Places' });
    expect(within(places).queryByRole('button', { name: /Dreams/ })).toBeNull();
    expect(
      within(
        screen.getByRole('navigation', { name: 'More places' }),
      ).queryByRole('button', { name: 'Project' }),
    ).toBeNull();
  });

  it('ends with quiet links to Project, Settings, Secrets and Get started', async () => {
    installFakeApi({ 'home:get': () => snapshot() });
    render(<Shell />);
    const links = await screen.findByRole('navigation', {
      name: 'More places',
    });
    expect(
      within(links)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Project', 'Settings', 'Secrets', 'Get started']);
    await userEvent.click(
      within(links).getByRole('button', { name: 'Secrets' }),
    );
    expect(useStore.getState().screen.kind).toBe('secrets');
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
