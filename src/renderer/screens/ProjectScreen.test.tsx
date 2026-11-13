import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeItem, HomeSnapshot } from '../../shared/home';
import type {
  Connection,
  Repo,
  Sprint,
  SprintItem,
  TaskView,
} from '../../shared/types';
import { Shell } from '../App';
import { useStore } from '../store';
import { listedBrain, brainView } from '../test-helpers/brainFixture';
import {
  type FakeHandlers,
  installFakeApi,
  noOverrides,
} from '../test-helpers/fakeApi';

vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }));

const connection: Connection = {
  id: 'c1',
  name: 'uw',
  organizationUrl: 'https://dev.azure.com/unreliablewitness',
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
const other: Connection = { ...connection, id: 'c2', project: 'Platform' };
const repo = (over: Partial<Repo>): Repo => ({
  id: 'r1',
  name: 'webshop',
  path: '/src/webshop',
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
  ...over,
});
const repos = [
  repo({}),
  repo({ id: 'r2', name: 'api', path: '/src/api' }),
  repo({
    id: 'r3',
    name: 'design-system',
    path: '/src/ds',
    connectionId: 'c2',
  }),
];
const item = (
  id: number,
  type: string,
  title: string,
  over: Partial<SprintItem> = {},
): SprintItem => ({
  id: String(id),
  type,
  title,
  state: 'To Do',
  areaPath: 'Shellie',
  iterationPath: 'Shellie\\Sprint 1',
  assignedTo: 'Dries Hoebeke',
  url: `https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/${id}`,
  project: 'Shellie',
  remainingWork: null,
  originalEstimate: null,
  completedWork: null,
  ...over,
});
const items = [
  item(1, 'Issue', 'Save a delivery address'),
  item(5, 'Task', 'Store the address', { state: 'Doing' }),
  item(2, 'Issue', 'Estimated delivery date', { assignedTo: 'Anna' }),
  item(4, 'Task', 'Upgrade payment SDK', { state: 'Done', assignedTo: null }),
];
const sprint: Sprint = {
  iteration: {
    id: 'it-1',
    name: 'Sprint 1',
    path: 'Shellie\\Sprint 1',
    startDate: '2026-10-15T00:00:00Z',
    finishDate: '2026-10-28T00:00:00Z',
  },
  rows: items.map((i) => ({
    item: i,
    depth: 0,
    parentId: null,
    hasChildren: false,
  })),
};
const task = (over: Partial<TaskView>): TaskView => ({
  id: 't1',
  repoId: 'r1',
  name: '',
  workItem: {
    id: '2',
    type: 'Issue',
    title: 'Estimated delivery date',
    url: null,
    project: null,
  },
  slug: 's',
  branch: 'feature/2-estimated-delivery-date',
  worktreePath: '/w/2',
  baseRef: 'origin/main',
  baseSha: null,
  openPeriods: [],
  time: null,
  status: 'ready',
  setup: {
    copy: false,
    commands: [],
    startClaude: false,
    openShell: false,
    openCopilot: false,
    summary: null,
  },
  terminals: [],
  createdAt: '2026-10-15T08:00:00.000Z',
  finishedAt: null,
  worktreeMissing: false,
  usageSyncedAt: null,
  usageSyncError: null,
  usageCommentId: null,
  summary: null,
  pullRequest: null,
  closedTerminals: [],
  reopen: null,
  extraWorkspaces: [],
  detachedPaths: [],
  homeDropped: false,
  connectionId: null,
  mainCheckoutEdits: [],
  environment: 'development',
  environmentUntil: null,
  pendingCleanup: [],
  ...over,
});
const extra = (repoId: string) => ({
  id: `w-${repoId}`,
  repoId,
  branch: 'feature/x',
  worktreePath: `/w/${repoId}`,
  baseRef: 'origin/main',
  baseSha: null,
  source: 'detected' as const,
  summary: null,
  pullRequest: null,
  reopen: null,
  dropped: false,
});
const recent = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString();
const tasks = [
  task({ extraWorkspaces: [extra('r3')] }),
  task({
    id: 't2',
    workItem: {
      id: '9',
      type: 'Issue',
      title: 'Old checkout',
      url: null,
      project: null,
    },
    status: 'done',
    finishedAt: recent(2),
  }),
];
const mine: HomeItem[] = [items[0], items[1]];
// Home's snapshot (HomeScreen.test.tsx has the same shape): my items in the current sprint.
const home = (): HomeSnapshot => ({
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
      sprintsError: null,
      reviews: [],
      teamReviews: [],
      myPrs: [],
      prsError: null,
      sprints: [
        {
          iterationId: 'it-1',
          name: 'Sprint 1',
          path: 'Shellie\\Sprint 1',
          startDate: '2026-10-15T00:00:00Z',
          finishDate: '2026-10-28T00:00:00Z',
          items: mine,
        },
      ],
    },
  ],
});

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    repos,
    tasks,
    connections: [connection, other],
    connectionId: 'c1',
    notices: [],
    selectedTaskId: null,
    previous: null,
    sprints: {},
    screen: { kind: 'project' },
  });
});

const fake = (over: FakeHandlers = {}) =>
  installFakeApi({
    'workItems:sprint': () => sprint,
    'home:get': () => home(),
    'brain:list': () => [
      listedBrain(),
      listedBrain({ id: 'b2', name: 'Elsewhere', connectionId: 'c2' }),
      listedBrain({ id: 'b3', name: 'Old', archived: true }),
    ],
    'brain:counts': () => ({ pages: 7, sources: 0 }),
    'usage:costs': () => ({ t1: 1.5, t2: 0.25 }),
    'repos:config': () => ({
      worktreeRoot: '/w',
      ...noOverrides,
      config: {
        base: 'main',
        branch: '{type}/{id}-{slug}',
        copy: [],
        setup: [],
        run: {},
        found: true,
      },
    }),
    'workItems:currentIteration': () => sprint.iteration,
    'workItems:search': () => [],
    ...over,
  });

const band = (name: string) => screen.findByRole('region', { name });

describe('Project page', () => {
  it('shows the sprint band with whole-sprint counts and my items', async () => {
    fake();
    render(<Shell />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Shellie' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('uw · dev.azure.com · Connected as D'),
    ).toBeInTheDocument();
    const s = await band('Sprint');
    expect(await within(s).findByText('Sprint 1')).toBeInTheDocument();
    expect(await within(s).findByText('Mine 2')).toBeInTheDocument();
    expect(within(s).getByText('In progress 1')).toBeInTheDocument();
    expect(within(s).getByText('Done 1 / 4')).toBeInTheDocument();
    expect(
      await within(s).findByText('AI this sprint €1.50'),
    ).toBeInTheDocument();
    expect(within(s).getByText(/Save a delivery address/)).toBeInTheDocument();
    expect(within(s).getByText(/Store the address/)).toBeInTheDocument();
    // Not mine: only in the whole-sprint counts.
    expect(within(s).queryByText(/Upgrade payment SDK/)).toBeNull();
    await userEvent.click(
      within(s).getByRole('button', { name: 'Open sprint' }),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'sprint' });
  });

  it('brains band links to the brain screen with a focus', async () => {
    const source = (path: string) => ({
      path,
      type: 'doc' as const,
      ingestedAt: '2026-11-02T09:00:00.000Z',
      captured: true,
      original: null,
      contents: null,
      note: null,
    });
    fake({ 'brain:counts': () => ({ pages: 7, sources: 2 }) });
    render(<Shell />);
    const b = await band('Brains');
    expect(await within(b).findByText('Acme')).toBeInTheDocument();
    // Another project's brain and an archived one are not listed.
    expect(within(b).queryByText('Elsewhere')).toBeNull();
    expect(within(b).queryByText('Old')).toBeNull();
    expect(
      await within(b).findByText(/7 pages · 2 sources · refreshed/),
    ).toBeInTheDocument();
    await userEvent.click(within(b).getByRole('button', { name: 'Browse' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'brain',
      brainId: 'b1',
      focus: 'wiki',
    });
  });

  it('brains band manages brains in settings and lists recently finished tasks', async () => {
    fake();
    render(<Shell />);
    const b = await band('Brains');
    expect(
      await within(b).findByRole('button', { name: /Old checkout/ }),
    ).toHaveTextContent('€0.25');
    await userEvent.click(within(b).getByRole('button', { name: 'Manage' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      scope: 'project',
      connectionId: 'c1',
      section: 'project-brains',
    });
  });

  it('+ New brain opens Settings with the create form', async () => {
    fake();
    render(<Shell />);
    const b = await band('Brains');
    await userEvent.click(
      within(b).getByRole('button', { name: '+ New brain' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      scope: 'project',
      connectionId: 'c1',
      section: 'project-brains-new',
    });
  });

  it('recently finished lists the last 3 finished tasks, newest first, however long ago', async () => {
    const done = (id: string, title: string, days: number) =>
      task({
        id,
        workItem: { id, type: 'Issue', title, url: null, project: null },
        status: 'done',
        finishedAt: recent(days),
      });
    fake();
    render(<Shell />);
    act(() =>
      useStore.setState({
        tasks: [
          done('d1', 'Oldest', 400),
          done('d2', 'Last spring', 200),
          done('d3', 'Last year', 300),
          done('d4', 'Last month', 30),
        ],
      }),
    );
    const b = await band('Brains');
    const list = await within(b).findByRole('list');
    expect(
      within(list)
        .getAllByRole('button')
        .map((x) => x.querySelector('.project-row-title')?.textContent),
    ).toEqual(['#d4 Last month', '#d2 Last spring', '#d3 Last year']);
  });

  it('repositories band meta counts linked and elsewhere', async () => {
    fake();
    render(<Shell />);
    const r = await band('Repositories');
    expect(
      within(r).getByText('2 linked · 1 used from elsewhere'),
    ).toBeInTheDocument();
    expect(
      within(r).getByRole('button', { name: 'Repository design-system' }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(r).getByRole('button', {
        name: '1 task in webshop and design-system',
      }),
    );
    const menu = await screen.findByRole('menu');
    await userEvent.click(
      within(menu).getByRole('menuitem', {
        name: /#2 Estimated delivery date/,
      }),
    );
    expect(useStore.getState().selectedTaskId).toBe('t1');
    expect(useStore.getState().screen).toEqual({ kind: 'task' });
  });

  it('clicking a repository opens its settings', async () => {
    fake();
    render(<Shell />);
    const r = await band('Repositories');
    await userEvent.click(
      within(r).getByRole('button', { name: 'Repository api' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      scope: 'repo',
      repoId: 'r2',
    });
  });

  it('New task opens with the project preselected', async () => {
    fake();
    render(<Shell />);
    const title = await screen.findByRole('heading', {
      level: 1,
      name: 'Shellie',
    });
    const head = title.closest('header') as HTMLElement;
    await userEvent.click(
      within(head).getByRole('button', { name: 'New task' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'new-task',
      connectionId: 'c1',
    });
  });

  it('shows the repositories empty state', async () => {
    fake();
    useStore.setState({ repos: [], tasks: [] });
    render(<Shell />);
    const r = await band('Repositories');
    expect(
      within(r).getByText('No repositories in this project yet'),
    ).toBeInTheDocument();
    await userEvent.click(
      within(r).getByRole('button', { name: 'Add repository' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'add-repo',
      from: 'settings',
      connectionId: 'c1',
    });
  });

  it('empty state without a connection', async () => {
    fake();
    useStore.setState({ connections: [], connectionId: null, repos: [] });
    render(<Shell />);
    const empty = (await screen.findByText('Add a project in Settings'))
      .parentElement as HTMLElement;
    await userEvent.click(
      within(empty).getByRole('button', { name: 'Settings' }),
    );
    expect(useStore.getState().screen.kind).toBe('settings');
  });

  it('an unauthorized project still renders and the sprint band offers Update token', async () => {
    fake({
      'workItems:sprint': () => {
        throw new Error('Azure DevOps refused the token');
      },
    });
    useStore.setState({
      connections: [{ ...connection, status: 'unauthorized' }, other],
    });
    render(<Shell />);
    const s = await band('Sprint');
    expect(
      await within(s).findByText(/Not connected: Token rejected/),
    ).toBeInTheDocument();
    await waitFor(() => expect(within(s).queryByText('Loading')).toBeNull());
    expect(await band('Brains')).toBeInTheDocument();
    const r = await band('Repositories');
    expect(
      within(r).getByRole('button', { name: 'Repository webshop' }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(s).getByRole('button', { name: 'Update token' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      scope: 'project',
      connectionId: 'c1',
      section: 'project-connection',
    });
  });
});

describe('ProjectScreen join card', () => {
  it('offers to join the project’s shared brain', async () => {
    useStore.setState({
      connections: [connection],
      screen: { kind: 'project' },
    });
    installFakeApi({
      'brain:discover': () => [
        { repositoryId: 'r', name: 'Acme', joinLink: 'shellie://join?a' },
      ],
    });
    render(<Shell />);
    // In the project's Brains band and in the nav.
    expect(
      await screen.findAllByText('Your team has a brain for Shellie. Join?'),
    ).toHaveLength(2);
  });
});
