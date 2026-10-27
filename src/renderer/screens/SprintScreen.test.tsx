import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Connection,
  Repo,
  Sprint,
  SprintItem,
  SprintRow,
  TaskView,
} from '../../shared/types';
import { Shell } from '../App';
import { useStore } from '../store';
import { type FakeHandlers, installFakeApi } from '../test-helpers/fakeApi';
import { filterRows, visibleRows } from './SprintScreen';

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
};
const repo: Repo = {
  id: 'r1',
  name: 'webshop',
  path: '/src/webshop',
  baseBranch: 'main',
  connectionId: 'c1',
  configFound: true,
  discovered: false,
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
};
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
  remainingWork: null,
  originalEstimate: null,
  completedWork: null,
  ...over,
});
const row = (
  i: SprintItem,
  depth = 0,
  parentId: string | null = null,
  hasChildren = false,
): SprintRow => ({ item: i, depth, parentId, hasChildren });
const sprint: Sprint = {
  iteration: {
    id: 'it-1',
    name: 'Sprint 1',
    path: 'Shellie\\Sprint 1',
    startDate: '2026-10-15T00:00:00Z',
    finishDate: '2026-10-28T00:00:00Z',
  },
  rows: [
    row(item(1, 'Issue', 'Save a delivery address'), 0, null, true),
    row(
      item(5, 'Task', 'Store the address', {
        remainingWork: 3,
        state: 'Doing',
      }),
      1,
      '1',
    ),
    row(item(2, 'Issue', 'Estimated delivery date')),
    row(item(4, 'Task', 'Upgrade payment SDK', { state: 'Done' })),
  ],
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

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    repos: [repo],
    tasks: [],
    connections: [connection],
    connectionId: null,
    notices: [],
    selectedTaskId: null,
    previous: null,
    sprintName: null,
    screen: { kind: 'sprint' },
  });
});

const fake = (over: FakeHandlers = {}) =>
  installFakeApi({
    'workItems:sprint': () => sprint,
    'repos:config': () => ({
      worktreeRoot: '/w',
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

const grid = () => screen.findByRole('table', { name: 'Sprint 1 backlog' });
const titles = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent?.match(/^\D*(\d+)/)?.[1]);

describe('Sprint page', () => {
  it('shows the sprint name, its dates and the rows in ADO order with nesting', async () => {
    fake();
    render(<Shell />);
    const table = await grid();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Sprint 1' }),
    ).toBeInTheDocument();
    expect(screen.getByText('15 Oct – 28 Oct')).toBeInTheDocument();
    expect(titles(table)).toEqual(['1', '5', '2', '4']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[1]).toHaveAttribute('aria-level', '2');
    expect(
      (rows[1].querySelector('.sprint-title') as HTMLElement).style.paddingLeft,
    ).toBe('24px');
    expect(within(rows[1]).getByText('Doing')).toBeInTheDocument();
    expect(within(rows[1]).getByText('3')).toBeInTheDocument();
    // Done in ADO shows as in ADO: no extra dimming class.
    expect(rows[3].className).not.toMatch(/dim|done/);
    // The breadcrumb names the sprint.
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText(
        'Sprint 1',
      ),
    ).toBeInTheDocument();
  });

  it('collapses a parent, and collapses and expands all', async () => {
    fake();
    render(<Shell />);
    const table = await grid();
    await userEvent.click(
      within(table).getByRole('button', { name: 'Collapse Issue 1' }),
    );
    expect(titles(table)).toEqual(['1', '2', '4']);
    await userEvent.click(
      within(table).getByRole('button', { name: 'Expand Issue 1' }),
    );
    expect(titles(table)).toEqual(['1', '5', '2', '4']);
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(titles(table)).toEqual(['1', '2', '4']);
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(titles(table)).toEqual(['1', '5', '2', '4']);
  });

  it('shows the Shellie task status and opens the task from it, not Azure DevOps', async () => {
    const { calls } = fake({ 'shell:openExternal': () => undefined });
    useStore.setState({ tasks: [task({})] });
    render(<Shell />);
    const table = await grid();
    const r = within(table).getAllByRole('row')[3];
    expect(within(r).getByText('Open')).toBeInTheDocument();
    expect(within(r).queryByRole('button', { name: /Start/ })).toBeNull();
    await userEvent.click(within(r).getByText('Open'));
    expect(calls.some((c) => c.channel === 'shell:openExternal')).toBe(false);
    expect(useStore.getState().screen).toEqual({ kind: 'task' });
    expect(useStore.getState().selectedTaskId).toBe('t1');
  });

  it('does not match a task whose repo is unlinked or on another connection', async () => {
    fake();
    useStore.setState({
      repos: [
        repo,
        { ...repo, id: 'r0', name: 'unlinked', connectionId: null },
        { ...repo, id: 'r2', name: 'other org', connectionId: 'other' },
      ],
      tasks: [
        task({ id: 't0', repoId: 'r0' }),
        task({ id: 't2', repoId: 'r2' }),
      ],
    });
    render(<Shell />);
    const table = await grid();
    const r = within(table).getAllByRole('row')[3];
    expect(within(r).queryByText('Open')).toBeNull();
  });

  it('opens the work item in Azure DevOps from the row and from its title', async () => {
    const { calls } = fake({ 'shell:openExternal': () => undefined });
    render(<Shell />);
    const table = await grid();
    const opened = () =>
      calls
        .filter((c) => c.channel === 'shell:openExternal')
        .map((c) => c.args[0]);
    await userEvent.click(within(table).getByText('Upgrade payment SDK'));
    expect(opened()).toEqual([
      'https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/4',
    ]);
    await userEvent.click(
      within(table).getByRole('button', {
        name: 'Open Task 5 Store the address in Azure DevOps',
      }),
    );
    expect(opened()).toEqual([
      'https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/4',
      'https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/5',
    ]);
  });

  it('opens the Done page for a finished task', async () => {
    fake();
    useStore.setState({
      tasks: [
        task({
          status: 'done',
          finishedAt: '2026-10-15T12:01:00.000Z',
        }),
      ],
    });
    render(<Shell />);
    const table = await grid();
    await userEvent.click(
      within(table).getByRole('button', {
        name: 'Open the task for Issue 2 Estimated delivery date',
      }),
    );
    expect(
      await screen.findByText('Finished before Shellie recorded summaries.'),
    ).toBeInTheDocument();
  });

  it('filters the sprint by ID or text, shows matches under collapsed parents, and Escape clears it', async () => {
    fake();
    render(<Shell />);
    const table = await grid();
    await userEvent.click(
      within(table).getByRole('button', { name: 'Collapse Issue 1' }),
    );
    const box = screen.getByRole('searchbox', {
      name: 'Filter work items by ID or text',
    });
    await userEvent.type(box, 'store');
    expect(titles(await grid())).toEqual(['1', '5']);
    await userEvent.clear(box);
    await userEvent.type(box, 'zzz');
    expect(screen.getByText('No work items match "zzz".')).toBeInTheDocument();
    await userEvent.type(box, '{Escape}');
    expect(box).toHaveValue('');
    expect(titles(await grid())).toEqual(['1', '2', '4']);
  });

  it('Start creates the task with the first linked repo and its defaults, then opens setup', async () => {
    const { calls } = fake({
      'repos:config': () => ({
        worktreeRoot: '/w',
        config: {
          base: 'main',
          branch: '{type}/{id}-{slug}',
          copy: ['.env'],
          setup: ['npm ci'],
          run: {},
          found: true,
        },
      }),
      'tasks:create': () => ({ id: 't5' }) as never,
    });
    useStore.setState({
      repos: [{ ...repo, id: 'r0', name: 'other', connectionId: null }, repo],
    });
    render(<Shell />);
    const table = await grid();
    await userEvent.click(
      within(table).getByRole('button', {
        name: 'Start a task for Task 5 Store the address',
      }),
    );
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({
        kind: 'setup',
        taskId: 't5',
      }),
    );
    expect(useStore.getState().selectedTaskId).toBe('t5');
    expect(calls.find((c) => c.channel === 'tasks:create')?.args[0]).toEqual({
      repoId: 'r1',
      baseRef: 'origin/main',
      name: '',
      workItem: {
        id: '5',
        type: 'Task',
        title: 'Store the address',
        url: 'https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/5',
      },
      branch: 'feature/5-store-the-address',
      copy: true,
      commands: ['npm ci'],
      startClaude: true,
      openShell: true,
      openCopilot: false,
      openOpencode: false,
      environment: 'development',
    });
  });

  it('Start never picks a discovered repo', async () => {
    const { calls } = fake({
      'repos:config': () => ({
        worktreeRoot: '/w',
        config: {
          base: 'main',
          branch: '{type}/{id}-{slug}',
          copy: [],
          setup: [],
          run: {},
          found: true,
        },
      }),
      'tasks:create': () => ({ id: 't5' }) as never,
    });
    useStore.setState({
      repos: [{ ...repo, id: 'rd', name: 'found', discovered: true }, repo],
    });
    render(<Shell />);
    const table = await grid();
    await userEvent.click(
      within(table).getByRole('button', {
        name: 'Start a task for Task 5 Store the address',
      }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'tasks:create')).toBeDefined(),
    );
    const created = calls.find((c) => c.channel === 'tasks:create');
    expect(created?.args[0]).toMatchObject({ repoId: 'r1' });
  });

  it('Start opens New task to choose the repo when several repos share the project', async () => {
    const { calls } = fake();
    useStore.setState({
      repos: [repo, { ...repo, id: 'r2', name: 'api' }],
    });
    render(<Shell />);
    const table = await grid();
    await userEvent.click(
      within(table).getByRole('button', {
        name: 'Start a task for Task 5 Store the address',
      }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'new-task',
      workItem: {
        id: '5',
        type: 'Task',
        title: 'Store the address',
        url: 'https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/5',
      },
      repoId: 'r1',
    });
    expect(calls.some((c) => c.channel === 'tasks:create')).toBe(false);
  });

  it('disables Start when only a discovered repo is linked', async () => {
    fake();
    useStore.setState({ repos: [{ ...repo, discovered: true }] });
    render(<Shell />);
    const table = await grid();
    const start = within(table).getByRole('button', {
      name: 'Start a task for Issue 2 Estimated delivery date',
    });
    expect(start).toHaveAttribute('aria-disabled', 'true');
  });

  it('stays on the sprint and shows the error when creating the task fails', async () => {
    fake({
      'tasks:create': () => {
        throw new Error('branch already exists');
      },
    });
    useStore.setState({ repos: [repo] });
    render(<Shell />);
    const table = await grid();
    await userEvent.click(
      within(table).getByRole('button', {
        name: 'Start a task for Task 5 Store the address',
      }),
    );
    expect(
      await screen.findByText('branch already exists'),
    ).toBeInTheDocument();
    expect(useStore.getState().screen).toEqual({ kind: 'sprint' });
  });

  it('disables Start when no repo is linked to the project', async () => {
    fake();
    useStore.setState({ repos: [{ ...repo, connectionId: null }] });
    render(<Shell />);
    const table = await grid();
    const start = within(table).getByRole('button', {
      name: 'Start a task for Issue 2 Estimated delivery date',
    });
    // Unavailable but still focusable, so keyboard users can learn why.
    expect(start).toHaveAttribute('aria-disabled', 'true');
    expect(start).not.toBeDisabled();
    expect(start).toHaveAccessibleDescription(
      'Link a repo to this project in Settings to start a task',
    );
    start.focus();
    expect(start).toHaveFocus();
    await userEvent.click(start);
    expect(useStore.getState().screen).toEqual({ kind: 'sprint' });
  });

  it('asks to connect Azure DevOps when there is no connection', async () => {
    const { calls } = fake();
    useStore.setState({ connections: [], repos: [] });
    render(<Shell />);
    expect(
      screen.getByText(/Connect Azure DevOps in Settings/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Open Settings' }),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'settings' });
    expect(calls.some((c) => c.channel === 'workItems:sprint')).toBe(false);
  });

  it('without a current sprint, says so and lists the work assigned to me', async () => {
    const { calls } = fake({
      'workItems:sprint': () => ({ iteration: null, rows: [] }),
      'workItems:search': () => [item(9, 'Bug', 'Mine to fix')],
    });
    render(<Shell />);
    expect(
      await screen.findByText('This project has no current sprint.'),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Assigned to me' });
    expect(within(table).getByText('Mine to fix')).toBeInTheDocument();
    expect(calls.find((c) => c.channel === 'workItems:search')?.args).toEqual([
      'c1',
      { scope: 'mine', text: '' },
    ]);
  });

  it('shows the error and retries', async () => {
    let fail = true;
    fake({
      'workItems:sprint': () => {
        if (fail) throw new Error('Azure DevOps did not answer within 15 s');
        return sprint;
      },
    });
    render(<Shell />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the sprint: Azure DevOps did not answer within 15 s',
    );
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await grid()).toBeInTheDocument();
  });

  it('refreshes on the button and on window focus at most once a minute', async () => {
    const { calls } = fake();
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => t);
    render(<Shell />);
    await grid();
    const loads = () =>
      calls.filter((c) => c.channel === 'workItems:sprint').length;
    expect(loads()).toBe(1);
    t += 30_000;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(loads()).toBe(1);
    t += 31_000;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(loads()).toBe(2));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(loads()).toBe(3));
    now.mockRestore();
  });

  it('shows an empty sprint', async () => {
    fake({
      'workItems:sprint': () => ({ iteration: sprint.iteration, rows: [] }),
    });
    render(<Shell />);
    expect(
      await screen.findByText('No work items in this sprint.'),
    ).toBeInTheDocument();
  });

  it('switches to another sprint from the dropdown', async () => {
    const next: Sprint = {
      iteration: {
        id: 'it-2',
        name: 'Sprint 2',
        path: 'Shellie\\Sprint 2',
        startDate: null,
        finishDate: null,
        timeframe: 'future',
      },
      rows: [row(item(8, 'Issue', 'Pay by invoice'))],
    };
    const { calls } = fake({
      'workItems:iterations': () => [
        { ...sprint.iteration!, timeframe: 'current' },
        next.iteration!,
      ],
      'workItems:sprint': (_c, id) => (id === 'it-2' ? next : sprint),
    });
    render(<Shell />);
    await grid();
    const select = await screen.findByRole('combobox', { name: 'Sprint' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Sprint 1 (current)', 'Sprint 2']);
    expect(select).toHaveValue('it-1');
    await userEvent.selectOptions(select, 'it-2');
    const table = await screen.findByRole('table', {
      name: 'Sprint 2 backlog',
    });
    expect(within(table).getByText('Pay by invoice')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Sprint 2' }),
    ).toBeInTheDocument();
    expect(
      calls.filter((c) => c.channel === 'workItems:sprint').at(-1)?.args,
    ).toEqual(['c1', 'it-2']);
    // Refresh stays on the chosen sprint.
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'workItems:sprint').length).toBe(
        3,
      ),
    );
    expect(
      calls.filter((c) => c.channel === 'workItems:sprint').at(-1)?.args,
    ).toEqual(['c1', 'it-2']);
  });

  it("groups the sprints of my teams and loads a sprint from its team's scope", async () => {
    const teamA = { id: 'ta', name: 'Team A' };
    const teamB = { id: 'tb', name: 'Team B' };
    const other: Sprint = {
      iteration: {
        id: 'it-1',
        name: 'Sprint 1',
        path: 'Shellie\\B\\Sprint 1',
        startDate: null,
        finishDate: null,
      },
      rows: [row(item(9, 'Issue', 'Team B work'))],
    };
    const { calls } = fake({
      'workItems:iterations': () => [
        { ...sprint.iteration!, timeframe: 'current', team: teamA },
        { ...sprint.iteration!, timeframe: 'current', team: teamB },
      ],
      'workItems:sprint': (_c, _id, team) =>
        team === 'Team B' ? other : sprint,
    });
    render(<Shell />);
    await grid();
    const select = await screen.findByRole('combobox', { name: 'Sprint' });
    const groups = within(select).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('label'))).toEqual([
      'Team A',
      'Team B',
    ]);
    expect(
      within(groups[1])
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Team B: Sprint 1 (current)']);
    // Two teams share it-1 and the default team is unknown: none is highlighted.
    expect(select).toHaveValue('');
    await userEvent.selectOptions(select, 'ta|it-1');
    await waitFor(() =>
      expect(
        calls.filter((c) => c.channel === 'workItems:sprint').at(-1)?.args,
      ).toEqual(['c1', 'it-1', 'Team A']),
    );
    await userEvent.selectOptions(select, 'tb|it-1');
    expect(await screen.findByText('Team B work')).toBeInTheDocument();
    expect(select).toHaveValue('tb|it-1');
    expect(
      calls.filter((c) => c.channel === 'workItems:sprint').at(-1)?.args,
    ).toEqual(['c1', 'it-1', 'Team B']);
  });

  it('remembers the picked sprint when the page is opened again (#165)', async () => {
    const teamB = { id: 'tb', name: 'Team B' };
    const other: Sprint = {
      iteration: {
        id: 'it-2',
        name: 'Sprint 2',
        path: 'Shellie\\B\\Sprint 2',
        startDate: null,
        finishDate: null,
      },
      rows: [row(item(9, 'Issue', 'Team B work'))],
    };
    const { calls } = fake({
      'workItems:iterations': () => [
        { ...sprint.iteration!, timeframe: 'current' },
        { ...other.iteration!, team: teamB },
      ],
      'workItems:sprint': (_c, id) => (id === 'it-2' ? other : sprint),
    });
    const first = render(<Shell />);
    await grid();
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Sprint' }),
      'tb|it-2',
    );
    expect(await screen.findByText('Team B work')).toBeInTheDocument();
    first.unmount();
    calls.length = 0;
    render(<Shell />);
    expect(await screen.findByText('Team B work')).toBeInTheDocument();
    expect(
      calls.filter((c) => c.channel === 'workItems:sprint')[0]?.args,
    ).toEqual(['c1', 'it-2', 'Team B']);
    expect(await screen.findByRole('combobox', { name: 'Sprint' })).toHaveValue(
      'tb|it-2',
    );
  });

  it('falls back to the current sprint and forgets a stored sprint that is gone (#165)', async () => {
    localStorage.setItem('shellie.ui.sprint.c1', '{"id":"it-gone"}');
    const { calls } = fake({
      'workItems:sprint': (_c, id) =>
        id === 'it-gone' ? { iteration: null, rows: [] } : sprint,
    });
    render(<Shell />);
    await grid();
    expect(
      calls.filter((c) => c.channel === 'workItems:sprint').map((c) => c.args),
    ).toEqual([['c1', 'it-gone'], ['c1']]);
    expect(localStorage.getItem('shellie.ui.sprint.c1')).toBeNull();
  });

  it('hides the sprint dropdown when the team has one sprint', async () => {
    const { calls } = fake({
      'workItems:iterations': () => [sprint.iteration!],
    });
    render(<Shell />);
    await grid();
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'workItems:iterations')).toBe(
        true,
      ),
    );
    expect(
      screen.queryByRole('combobox', { name: 'Sprint' }),
    ).not.toBeInTheDocument();
  });
});

describe('visibleRows', () => {
  it('hides every row below a collapsed parent, at any depth', () => {
    const rows = [
      row(item(1, 'Epic', 'a'), 0, null, true),
      row(item(2, 'Feature', 'b'), 1, '1', true),
      row(item(3, 'Task', 'c'), 2, '2'),
      row(item(4, 'Task', 'd'), 1, '1'),
      row(item(5, 'Task', 'e')),
    ];
    const ids = (c: string[]) =>
      visibleRows(rows, new Set(c)).map((r) => r.item.id);
    expect(ids([])).toEqual(['1', '2', '3', '4', '5']);
    expect(ids(['2'])).toEqual(['1', '2', '4', '5']);
    expect(ids(['1'])).toEqual(['1', '5']);
  });
});

describe('filterRows', () => {
  const rows = [
    row(item(1, 'Epic', 'Checkout'), 0, null, true),
    row(item(2, 'Feature', 'Delivery address'), 1, '1', true),
    row(
      item(31, 'Task', 'Store the address', { assignedTo: 'Maxime' }),
      2,
      '2',
    ),
    row(item(4, 'Bug', 'Coupon field ignores names')),
  ];
  const ids = (q: string) => filterRows(rows, q).map((r) => r.item.id);

  it('keeps every row for an empty query', () => {
    expect(ids('  ')).toEqual(['1', '2', '31', '4']);
  });
  it('matches the ID, and keeps the parents of a match', () => {
    expect(ids('31')).toEqual(['1', '2', '31']);
    expect(ids('4')).toEqual(['4']);
  });
  it('matches every word of the title or assignee, ignoring case', () => {
    expect(ids('COUPON names')).toEqual(['4']);
    expect(ids('maxime')).toEqual(['1', '2', '31']);
    expect(ids('address store')).toEqual(['1', '2', '31']);
    expect(ids('nothing like this')).toEqual([]);
  });

  it('shows the Spent / est. column with local time against the estimate', async () => {
    fake({
      'workItems:sprint': () => ({
        ...sprint,
        rows: [
          row(
            item(2, 'Issue', 'Estimated delivery date', {
              originalEstimate: 5,
            }),
          ),
          row(item(4, 'Task', 'Upgrade payment SDK')),
        ],
      }),
      'time:sprint': () => ({
        '2': {
          spentSeconds: 11400,
          measuredSeconds: 11400,
          agentSeconds: 6000,
          booked: false,
          baselineHours: null,
        },
      }),
    });
    render(<Shell />);
    const table = await grid();
    expect(
      within(table).getByRole('columnheader', { name: 'Spent / est.' }),
    ).toBeInTheDocument();
    expect(await within(table).findByText('3h 10m / 5h')).toBeInTheDocument();
    expect(within(table).getByText('–')).toBeInTheDocument();
  });

  it('shows ADO Completed Work for an item whose local task has no time yet', async () => {
    fake({
      'workItems:sprint': () => ({
        ...sprint,
        rows: [
          row(
            item(2, 'Task', 'Estimated delivery date', {
              completedWork: 2,
              remainingWork: 3,
            }),
          ),
        ],
      }),
      'time:sprint': () => ({
        '2': {
          spentSeconds: 0,
          measuredSeconds: 0,
          agentSeconds: 0,
          booked: false,
          baselineHours: 4,
        },
      }),
    });
    render(<Shell />);
    const table = await grid();
    const cell = await within(table).findByText('2h / 4h');
    expect(cell.closest('.sprint-time')).toHaveAttribute(
      'title',
      'from Azure DevOps',
    );
  });

  it('renders a pre-feature done task without time', async () => {
    useStore.setState({
      tasks: [
        task({
          status: 'done',
          time: null,
          openPeriods: [],
          finishedAt: '2026-10-15T10:00:00.000Z',
        }),
      ],
    });
    fake({ 'time:sprint': () => ({}) });
    render(<Shell />);
    const table = await grid();
    expect(within(table).getAllByText('–').length).toBeGreaterThan(0);
  });
});
