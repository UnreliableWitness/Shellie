import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeConnection, HomeSnapshot } from '../../../shared/home';
import type { Repo } from '../../../shared/types';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { SprintsBand } from './SprintsBand';

const item = (id: string, state: string) => ({
  id,
  type: 'Issue',
  title: id,
  state,
  areaPath: 'Shellie',
  iterationPath: 'Shellie\\Sprint 1',
  assignedTo: 'Me',
  url: 'u',
  project: null,
  remainingWork: null,
  originalEstimate: 2,
  completedWork: null,
});
const conn = (over: Partial<HomeConnection>): HomeConnection => ({
  connectionId: 'c1',
  name: 'uw',
  project: 'Shellie',
  status: 'ok',
  error: null,
  fetchedAt: '',
  sprints: [],
  sprintsError: null,
  reviews: [],
  teamReviews: [],
  myPrs: [],
  prsError: null,
  ...over,
});
const snap = (...connections: HomeConnection[]): HomeSnapshot => ({
  version: 1,
  builtAt: '',
  connections,
});
const finish = new Date(Date.now() + 4 * 86_400_000).toISOString();

beforeEach(() =>
  useStore.setState({
    repos: [
      { id: 'r1', connectionId: 'c1', discovered: false },
      { id: 'r2', connectionId: 'c2', discovered: false },
    ] as Repo[],
    connectionId: null,
    screen: { kind: 'home' },
  }),
);

describe('SprintsBand', () => {
  it('a card per sprint with my items by state and days left', async () => {
    installFakeApi();
    render(
      <SprintsBand
        snapshot={snap(
          conn({
            sprints: [
              {
                iterationId: 'i',
                name: 'Sprint 1',
                path: 'Shellie\\Sprint 1',
                startDate: null,
                finishDate: finish,
                items: [
                  item('1', 'To Do'),
                  item('2', 'Doing'),
                  item('3', 'Done'),
                ],
              },
            ],
          }),
        )}
      />,
    );
    const card = await screen.findByRole('button', {
      name: /uw\/Shellie, Sprint 1/,
    });
    expect(card.textContent).toContain('1 to do · 1 in progress · 1 done');
    expect(card.textContent).toMatch(/4 days left/);
    expect(card.textContent).toContain('/ 6h');
  });

  it('a click opens that project on the Sprint page', async () => {
    installFakeApi();
    render(
      <SprintsBand
        snapshot={snap(
          conn({
            sprints: [
              {
                iterationId: 'i',
                name: 'Sprint 1',
                path: 'p',
                startDate: null,
                finishDate: null,
                items: [item('1', 'To Do')],
              },
            ],
          }),
        )}
      />,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /Sprint 1/ }),
    );
    expect(useStore.getState().connectionId).toBe('c1');
    expect(useStore.getState().screen.kind).toBe('sprint');
  });

  it('a linked project without my items gets a slim card', () => {
    installFakeApi();
    render(
      <SprintsBand
        snapshot={snap(
          conn({ connectionId: 'c2', name: 'fab', project: 'Api' }),
        )}
      />,
    );
    expect(screen.getByText('fab/Api: nothing assigned')).toBeTruthy();
  });

  it('names a failed sprint load', () => {
    installFakeApi();
    render(<SprintsBand snapshot={snap(conn({ sprintsError: 'boom' }))} />);
    expect(
      screen.getByText("Couldn't load sprints for uw/Shellie"),
    ).toBeTruthy();
  });

  it('names a stale connection and hides the empty line', () => {
    installFakeApi();
    render(
      <SprintsBand
        snapshot={snap(
          conn({
            status: 'stale',
            error: 'down',
            fetchedAt: '2026-10-17T09:12:00Z',
          }),
        )}
      />,
    );
    expect(
      screen.getByText(/^Stale since \d\d:\d\d for uw\/Shellie: down$/),
    ).toBeTruthy();
    expect(
      screen.queryByText('Nothing assigned to you in a current sprint.'),
    ).toBeNull();
  });

  it('names a connection that could not load', () => {
    installFakeApi();
    render(
      <SprintsBand
        snapshot={snap(
          conn({ status: 'error', error: 'refused', fetchedAt: null }),
        )}
      />,
    );
    expect(screen.getByText("Couldn't load uw/Shellie: refused")).toBeTruthy();
    expect(
      screen.queryByText('Nothing assigned to you in a current sprint.'),
    ).toBeNull();
  });

  it('refetches time when the snapshot is rebuilt and, throttled, on time:changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls, emit } = installFakeApi();
    const sprints = [
      {
        iterationId: 'i',
        name: 'Sprint 1',
        path: 'p',
        startDate: null,
        finishDate: null,
        items: [item('1', 'To Do')],
      },
    ];
    const count = () => calls.filter((c) => c.channel === 'time:sprint').length;
    const view = render(
      <SprintsBand snapshot={{ ...snap(conn({ sprints })), builtAt: 'a' }} />,
    );
    await waitFor(() => expect(count()).toBe(1));
    view.rerender(
      <SprintsBand snapshot={{ ...snap(conn({ sprints })), builtAt: 'b' }} />,
    );
    await waitFor(() => expect(count()).toBe(2));
    act(() => {
      emit('time:changed', { taskId: 't' });
      emit('time:changed', { taskId: 't' });
    });
    expect(count()).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(5_100));
    expect(count()).toBe(3);
    vi.useRealTimers();
  });

  it('empty state', () => {
    installFakeApi();
    useStore.setState({ repos: [] });
    render(<SprintsBand snapshot={snap(conn({}))} />);
    expect(
      screen.getByText('Nothing assigned to you in a current sprint.'),
    ).toBeTruthy();
  });
});
