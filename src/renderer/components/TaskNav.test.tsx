import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Repo, TaskView } from '../../shared/types';
import { useStore } from '../store';
import { emptyUsage, installFakeApi } from '../test-helpers/fakeApi';
import { groupTasks, TaskNav } from './TaskNav';

const repos: Repo[] = [
  {
    id: 'r1',
    name: 'webshop',
    path: '/src/webshop',
    baseBranch: 'main',
    connectionId: null,
    configFound: true,
    discovered: false,
    workItemOnStart: {
      moveToInProgress: true,
      assignToMe: true,
      stateOverrides: {},
    },
  },
  {
    id: 'r2',
    name: 'backoffice-api',
    path: '/src/api',
    baseBranch: 'develop',
    connectionId: null,
    configFound: false,
    discovered: false,
    workItemOnStart: {
      moveToInProgress: true,
      assignToMe: true,
      stateOverrides: {},
    },
  },
];
const base = {
  setup: {
    copy: true,
    commands: [],
    startClaude: true,
    openShell: true,
    openCopilot: false,
  },
  terminals: [],
  createdAt: 'now',
  openPeriods: [],
  time: null,
  finishedAt: null,
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
  environment: 'development' as const,
  environmentUntil: null,
  pendingCleanup: [],
  worktreeMissing: false,
  baseRef: 'origin/main',
  baseSha: null,
};
const tasks: TaskView[] = [
  {
    ...base,
    id: 'a',
    repoId: 'r1',
    name: '',
    workItem: {
      id: '48213',
      type: 'User Story',
      title: 'Checkout: save address',
      url: null,
    },
    slug: 'a',
    branch: 'feature/48213-a',
    worktreePath: '/w/a',
    status: 'ready',
  },
  {
    ...base,
    id: 'b',
    repoId: 'r1',
    name: 'spike-new-search',
    workItem: null,
    slug: 'b',
    branch: 'feature/spike',
    worktreePath: '/w/b',
    status: 'setting-up',
  },
  {
    ...base,
    id: 'c',
    repoId: 'r2',
    name: '',
    workItem: { id: '47988', type: 'Task', title: 'Export orders', url: null },
    slug: 'c',
    branch: 'feature/47988-c',
    worktreePath: '/w/c',
    status: 'done',
    finishedAt: 'then',
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
  },
  {
    ...base,
    id: 'd',
    repoId: 'r1',
    name: '',
    workItem: { id: '1', type: 'Bug', title: 'Broken', url: null },
    slug: 'd',
    branch: 'bugfix/1-d',
    worktreePath: '/w/d',
    status: 'setup-failed',
  },
];

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    attention: {},
    navCollapsed: false,
    navWidth: 240,
    repos,
    tasks,
    connections: [],
    notices: [],
    screen: { kind: 'task' },
    connectionId: null,
    selectedTaskId: 'a',
  });
});

describe('attention', () => {
  it('marks a task whose terminal waits on the developer', () => {
    installFakeApi();
    const withTerminal = {
      ...tasks[0],
      terminals: [{ id: 'c1', kind: 'claude', label: 'Claude Code' }],
    } as unknown as TaskView;
    useStore.setState({
      tasks: [withTerminal],
      attention: {
        c1: {
          reason: 'blocked',
          kind: 'permission',
          message: 'approve Bash: ls',
          since: 1,
        },
      },
    });
    render(<TaskNav />);
    expect(
      screen.getByLabelText('Needs permission: approve Bash: ls'),
    ).toBeInTheDocument();
  });
});

describe('groupTasks', () => {
  it('groups open tasks by repo and collects done tasks separately', () => {
    const g = groupTasks(tasks, repos);
    expect(g.open.map((x) => [x.repo.name, x.tasks.map((t) => t.id)])).toEqual([
      ['webshop', ['a', 'b', 'd']],
    ]);
    expect(g.done.map((t) => t.id)).toEqual(['c']);
  });

  it('groups a task whose home was dropped under the repo that took over', () => {
    const moved: TaskView = {
      ...tasks[0],
      homeDropped: true,
      extraWorkspaces: [
        {
          id: 'w1',
          repoId: 'r2',
          branch: 'feature/48213-a',
          worktreePath: '/w/a-api',
          baseRef: 'origin/main',
          baseSha: null,
          source: 'detected',
          summary: null,
          pullRequest: null,
          reopen: null,
          dropped: false,
        },
      ],
    };
    const g = groupTasks([moved], repos);
    expect(g.open.map((x) => [x.repo.id, x.tasks.map((t) => t.id)])).toEqual([
      ['r2', ['a']],
    ]);
  });
});

describe('TaskNav', () => {
  it('draws the no-connection avatar in a readable text colour, not white', () => {
    installFakeApi();
    useStore.setState({ repos, connections: [] });
    render(<TaskNav />);
    expect(screen.getByText('?').style.color).toBe('var(--muted)');
  });
  it('shows the selected task repo connection status in the footer', () => {
    installFakeApi();
    useStore.setState({
      repos: [{ ...repos[0], connectionId: 'c1' }, repos[1]],
      connections: [
        {
          id: 'c1',
          name: 'unreliablewitness',
          organizationUrl: 'https://dev.azure.com/unreliablewitness',
          project: 'Shellie',
          user: 'D',
          status: 'unauthorized',
          checkedAt: null,
          userUniqueName: null,
          provider: 'azure-devops' as const,
          workItemOnStart: {
            moveToInProgress: true,
            assignToMe: true,
            stateOverrides: {},
          },
        },
      ],
    });
    render(<TaskNav />);
    expect(
      screen.getByText('unreliablewitness: token rejected'),
    ).toBeInTheDocument();
  });
  it('renders rows with id or name, state dots and selects on click', async () => {
    installFakeApi();
    render(<TaskNav />);
    expect(screen.getByText('48213')).toBeInTheDocument();
    expect(screen.getByText('spike-new-search')).toBeInTheDocument();
    expect(screen.getByLabelText('Setting up')).toBeInTheDocument();
    expect(screen.getByLabelText('Setup failed')).toBeInTheDocument();
    // A ready task gets no status dot.
    expect(
      screen
        .getByRole('button', { name: /Checkout: save address/ })
        .querySelector('.dot'),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /Checkout: save address/ }),
    ).toHaveAttribute('aria-current', 'true');
    await userEvent.click(screen.getByRole('button', { name: /Broken/ }));
    expect(useStore.getState().selectedTaskId).toBe('d');
    expect(useStore.getState().screen).toEqual({ kind: 'setup', taskId: 'd' });
  });

  it('hides done tasks behind a toggle', async () => {
    installFakeApi();
    render(<TaskNav />);
    expect(screen.queryByText('47988')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Done \(1\)/ }));
    expect(screen.getByText('47988')).toBeInTheDocument();
  });

  it('draws Done as a section header aligned with Tasks, with a chevron (#11)', async () => {
    installFakeApi();
    render(<TaskNav />);
    const tasksHeader = screen.getByText('Tasks').closest('.nav-section')!;
    const done = screen.getByRole('button', { name: 'Done (1)' });
    expect(done).toHaveClass('nav-section');
    expect(tasksHeader).toHaveClass('nav-section');
    expect(done.parentElement).toBe(tasksHeader.parentElement);
    expect(done).toHaveAttribute('aria-expanded', 'false');
    expect(done.querySelector('svg')).not.toBeNull();
    await userEvent.click(done);
    expect(done).toHaveAttribute('aria-expanded', 'true');
  });

  it('has the Sprint hub and Settings items', async () => {
    installFakeApi();
    render(<TaskNav />);
    await userEvent.click(screen.getByRole('button', { name: 'Sprint' }));
    expect(useStore.getState().screen).toEqual({ kind: 'sprint' });
    expect(screen.getByRole('button', { name: 'Sprint' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // On Sprint no task row is highlighted.
    expect(
      screen.getByRole('button', { name: /Checkout: save address/ }),
    ).not.toHaveAttribute('aria-current');
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useStore.getState().screen).toEqual({ kind: 'settings' });
  });

  it('switches project when there is more than one connection', async () => {
    installFakeApi();
    const conn = (id: string, project: string) => ({
      id,
      name: 'unreliablewitness',
      organizationUrl: 'https://dev.azure.com/unreliablewitness',
      project,
      user: 'D',
      status: 'ok' as const,
      checkedAt: null,
      userUniqueName: null,
      provider: 'azure-devops' as const,
      workItemOnStart: {
        moveToInProgress: true,
        assignToMe: true,
        stateOverrides: {},
      },
    });
    useStore.setState({
      connections: [conn('c1', 'Shellie'), conn('c2', 'DXP')],
      selectedTaskId: null,
    });
    render(<TaskNav />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Project Shellie, switch project' }),
    );
    const menu = screen.getByRole('menu', { name: 'Projects' });
    await userEvent.click(
      within(menu).getByRole('menuitemradio', { name: /DXP/ }),
    );
    expect(useStore.getState().connectionId).toBe('c2');
    expect(
      screen.getByRole('button', { name: 'Project DXP, switch project' }),
    ).toBeInTheDocument();
    expect(screen.getByText('unreliablewitness: DXP')).toBeInTheDocument();
  });

  it('the project switcher is a keyboard menu: focus moves in, arrows move, Escape and outside clicks close', async () => {
    installFakeApi();
    const conn = (id: string, project: string) => ({
      id,
      name: 'unreliablewitness',
      organizationUrl: 'https://dev.azure.com/unreliablewitness',
      project,
      user: 'D',
      status: 'ok' as const,
      checkedAt: null,
      userUniqueName: null,
      provider: 'azure-devops' as const,
      workItemOnStart: {
        moveToInProgress: true,
        assignToMe: true,
        stateOverrides: {},
      },
    });
    useStore.setState({
      connections: [conn('c1', 'Shellie'), conn('c2', 'DXP')],
      connectionId: 'c1',
      selectedTaskId: null,
    });
    render(<TaskNav />);
    const trigger = screen.getByRole('button', {
      name: 'Project Shellie, switch project',
    });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const items = within(
      screen.getByRole('menu', { name: 'Projects' }),
    ).getAllByRole('menuitemradio');
    // Focus lands on the current project.
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(useStore.getState().connectionId).toBe('c1');
  });

  it('shows the billable EUR total per task', async () => {
    installFakeApi({
      'repos:list': () => repos,
      'tasks:list': () => tasks,
      'usage:task': (id) => ({
        ...emptyUsage(id),
        billable: { costUsd: 1, costEur: id === 'a' ? 12.5 : 0, tokens: 1 },
      }),
    });
    useStore.setState({ repos, tasks, selectedTaskId: 'a' });
    render(<TaskNav />);
    expect(
      await screen.findByText(`${String.fromCharCode(0x20ac)}12.50`),
    ).toBeInTheDocument();
  });

  it('collapses to a rail of type icons and back, and remembers it', async () => {
    installFakeApi();
    render(<TaskNav />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Collapse task list' }),
    );
    expect(screen.getByRole('navigation', { name: 'Tasks' })).toHaveClass(
      'is-rail',
    );
    expect(localStorage.getItem('shellie.ui.navCollapsed')).toBe('true');
    const rail = screen.getByRole('button', { name: /48213 Checkout/ });
    expect(
      within(rail).getByRole('img', { name: 'User Story' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sprint' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Settings' }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Expand task list' }),
    );
    expect(screen.getByRole('navigation', { name: 'Tasks' })).not.toHaveClass(
      'is-rail',
    );
  });

  it('shows one dense row per task with id, title and cost', () => {
    installFakeApi();
    render(<TaskNav />);
    const row = screen.getByRole('button', { name: /48213/ });
    expect(row).toHaveTextContent('Checkout: save address');
    expect(row).not.toHaveTextContent('feature/48213-a');
  });
});

describe('TaskNav task actions (#95)', () => {
  beforeEach(() => {
    installFakeApi({ 'usage:task': emptyUsage });
    useStore.setState({ repos, tasks, connections: [], navCollapsed: false });
  });

  it('has New task at the Tasks header, marked current on its page', async () => {
    useStore.setState({ screen: { kind: 'sprint' } });
    render(<TaskNav />);
    const head = screen.getByText('Tasks').closest('.nav-section')!;
    const add = within(head as HTMLElement).getByRole('button', {
      name: 'New task',
    });
    await userEvent.click(add);
    expect(useStore.getState().screen).toEqual({ kind: 'new-task' });
    expect(add).toHaveAttribute('aria-current', 'page');
  });

  it('shows a primary Finish task under the current ready task only', async () => {
    useStore.setState({ selectedTaskId: 'a', screen: { kind: 'task' } });
    render(<TaskNav />);
    const finish = screen.getAllByRole('button', { name: 'Finish task' });
    expect(finish).toHaveLength(1);
    expect(finish[0]).toHaveClass('btn-primary');
    // Right after the task's own row.
    const row = screen.getByRole('button', { name: /48213/ });
    expect(row.nextElementSibling).toContainElement(finish[0]);
    await userEvent.click(finish[0]);
    expect(useStore.getState().screen).toEqual({ kind: 'finish', taskId: 'a' });
    // On the Finish page itself it steps aside.
    expect(screen.queryByRole('button', { name: 'Finish task' })).toBeNull();
  });

  it('has no Finish away from a task, and a disabled Finishing… while it runs', () => {
    useStore.setState({ selectedTaskId: 'a', screen: { kind: 'sprint' } });
    const { unmount } = render(<TaskNav />);
    expect(screen.queryByRole('button', { name: 'Finish task' })).toBeNull();
    unmount();
    useStore.setState({
      tasks: [{ ...tasks[0], status: 'finishing' }, ...tasks.slice(1)],
      screen: { kind: 'finish', taskId: 'a' },
    });
    render(<TaskNav />);
    expect(screen.getByRole('button', { name: 'Finishing…' })).toBeDisabled();
  });

  it('has a Discard task button next to Finish that asks on the task page (#124)', async () => {
    useStore.setState({
      selectedTaskId: 'a',
      screen: { kind: 'finish', taskId: 'x' },
      discardTaskId: null,
    });
    const { unmount } = render(<TaskNav />);
    // Not on another task's page.
    expect(screen.queryByRole('button', { name: 'Discard task' })).toBeNull();
    unmount();
    useStore.setState({ screen: { kind: 'task' } });
    render(<TaskNav />);
    const discard = screen.getByRole('button', { name: 'Discard task' });
    const finish = screen.getByRole('button', { name: 'Finish task' });
    expect(discard.parentElement).toBe(finish.parentElement);
    await userEvent.click(discard);
    expect(useStore.getState().discardTaskId).toBe('a');
    expect(useStore.getState().screen).toEqual({ kind: 'task' });
  });

  it('has Discard task under Finish in the collapsed rail, with a tooltip (#124)', async () => {
    useStore.setState({
      selectedTaskId: 'a',
      screen: { kind: 'task' },
      navCollapsed: true,
      discardTaskId: null,
    });
    render(<TaskNav />);
    const discard = screen.getByRole('button', { name: 'Discard task' });
    expect(discard).toHaveAttribute('title', 'Discard task');
    const finish = screen.getByRole('button', { name: 'Finish task' });
    expect(finish.nextElementSibling).toBe(discard);
    await userEvent.click(discard);
    expect(useStore.getState().discardTaskId).toBe('a');
  });

  it('keeps New task and Finish task in the collapsed rail', async () => {
    useStore.setState({
      selectedTaskId: 'a',
      screen: { kind: 'task' },
      navCollapsed: true,
    });
    render(<TaskNav />);
    await userEvent.click(screen.getByRole('button', { name: 'Finish task' }));
    expect(useStore.getState().screen).toEqual({ kind: 'finish', taskId: 'a' });
    const add = screen.getByRole('button', { name: 'New task' });
    expect(add).toHaveAttribute('title', 'New task');
    await userEvent.click(add);
    expect(useStore.getState().screen).toEqual({ kind: 'new-task' });
  });
});

describe('TaskNav extra repos', () => {
  it('shows +1 repo and +2 repos on a task with extras', () => {
    installFakeApi({ 'usage:task': emptyUsage });
    const w = (id: string, dropped = false) =>
      ({ id, repoId: 'r2', dropped }) as never;
    useStore.setState({
      repos,
      connections: [],
      selectedTaskId: 'a',
      screen: { kind: 'task' },
      tasks: [
        { ...tasks[0], extraWorkspaces: [w('w1')] },
        {
          ...tasks[0],
          id: 'z',
          extraWorkspaces: [w('w2'), w('w3'), w('w4', true)],
        },
      ],
    });
    render(<TaskNav />);
    expect(screen.getByText('+1 repo')).toBeInTheDocument();
    expect(screen.getByText('+2 repos')).toBeInTheDocument();
  });
});

describe('TaskNav width (#160)', () => {
  beforeEach(() => installFakeApi({ 'usage:task': emptyUsage }));

  const nav = () => screen.getByRole('navigation', { name: 'Tasks' });
  const handle = () =>
    screen.getByRole('separator', { name: 'Resize task list' });

  it('grows and shrinks with the arrow keys and remembers it', async () => {
    render(<TaskNav />);
    expect(nav()).toHaveStyle({ width: '240px' });
    expect(handle()).toHaveAttribute('aria-valuenow', '240');
    handle().focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(nav()).toHaveStyle({ width: '256px' });
    expect(localStorage.getItem('shellie.ui.navWidth')).toBe('256');
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(nav()).toHaveStyle({ width: '224px' });
    expect(useStore.getState().navWidth).toBe(224);
  });

  it('follows a drag and stores the width on release', () => {
    render(<TaskNav />);
    fireEvent.pointerDown(handle(), { clientX: 240, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 300, pointerId: 1 });
    expect(nav()).toHaveStyle({ width: '300px' });
    expect(localStorage.getItem('shellie.ui.navWidth')).toBeNull();
    fireEvent.pointerMove(handle(), { clientX: 2000, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientX: 2000, pointerId: 1 });
    expect(nav()).toHaveStyle({ width: '480px' });
    expect(localStorage.getItem('shellie.ui.navWidth')).toBe('480');
  });

  it('resets to 240 on double-click', () => {
    useStore.setState({ navWidth: 400 });
    render(<TaskNav />);
    expect(nav()).toHaveStyle({ width: '400px' });
    fireEvent.doubleClick(handle());
    expect(nav()).toHaveStyle({ width: '240px' });
    expect(localStorage.getItem('shellie.ui.navWidth')).toBe('240');
  });

  it('has no handle and keeps the rail width when collapsed', () => {
    useStore.setState({ navCollapsed: true, navWidth: 400 });
    render(<TaskNav />);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(nav().style.width).toBe('');
  });
});
