import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Repo, TaskView } from '../../shared/types';
import { useStore } from '../store';
import { listedBrain } from '../test-helpers/brainFixture';
import { installFakeApi } from '../test-helpers/fakeApi';
import { readingBrain, readingRead } from '../test-helpers/readingFixture';
import {
  type Lifecycle,
  type PrPulse,
  type PulseView,
  type TaskLifecycle,
} from '../../shared/pulse';
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
    overrides: {},
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
    overrides: {},
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
    summary: null,
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
      project: null,
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
    workItem: {
      id: '47988',
      type: 'Task',
      title: 'Export orders',
      url: null,
      project: null,
    },
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
    workItem: {
      id: '1',
      type: 'Bug',
      title: 'Broken',
      url: null,
      project: null,
    },
    slug: 'd',
    branch: 'bugfix/1-d',
    worktreePath: '/w/d',
    status: 'setup-failed',
  },
];

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
  writeTimeToAdo: false,
});

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    attention: {},
    reading: [],
    settings: null,
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

describe('brains', () => {
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
    writeTimeToAdo: false,
  });

  it('shows one item per brain and opens its screen', async () => {
    installFakeApi({
      'brain:list': () => [
        listedBrain(),
        listedBrain({ id: 'b2', name: 'Globex' }),
      ],
    });
    useStore.setState({ connections: [conn('c1', 'Shellie')] });
    render(<TaskNav />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Globex' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'brain',
      brainId: 'b2',
    });
    expect(screen.getByRole('button', { name: 'Acme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Globex' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('offers the shared brain of the project only when there is none of its own', async () => {
    const found = [
      { repositoryId: 'r', name: 'Acme', joinLink: 'shellie://join?a' },
    ];
    useStore.setState({ connections: [conn('c1', 'Shellie')] });
    installFakeApi({ 'brain:discover': () => found });
    const first = render(<TaskNav />);
    expect(
      await screen.findByText('Your team has a brain for Shellie. Join?'),
    ).toBeInTheDocument();
    first.unmount();
    installFakeApi({
      'brain:discover': () => found,
      'brain:list': () => [listedBrain()],
    });
    render(<TaskNav />);
    await screen.findByRole('button', { name: 'Acme' });
    expect(screen.queryByText(/Your team has a brain/)).not.toBeInTheDocument();
  });

  it('marks a brain with something for the work or a change to read, unless the nudges are off', async () => {
    installFakeApi({
      'brain:list': () => [
        listedBrain(),
        listedBrain({ id: 'b2', name: 'Globex' }),
      ],
    });
    useStore.setState({
      connections: [conn('c1', 'Shellie')],
      reading: [
        readingBrain({
          reads: [readingRead({ work: [{ id: 412, title: 'Return flow' }] })],
        }),
        // Unread foundations are the pile, not an event.
        readingBrain({
          brainId: 'b2',
          reads: [readingRead({ chapter: 'Orders' })],
        }),
      ],
    });
    render(<TaskNav />);
    expect(
      await screen.findByRole('button', { name: 'Acme, something to read' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Globex' })).toBeInTheDocument();
    act(() =>
      useStore.setState({ settings: { readingNudges: false } as never }),
    );
    expect(screen.getByRole('button', { name: 'Acme' })).toBeInTheDocument();
  });

  it('shows only the active project’s brains (#229)', async () => {
    installFakeApi({
      'brain:list': () => [
        listedBrain({ id: 'b1', name: 'IML HUB brain', connectionId: 'c1' }),
        listedBrain({ id: 'b2', name: 'DXP brain', connectionId: 'c2' }),
      ],
    });
    useStore.setState({
      connections: [conn('c1', 'IML Hub'), conn('c2', 'DXP')],
      connectionId: 'c2',
      selectedTaskId: null,
      screen: { kind: 'sprint' },
    });
    render(<TaskNav />);
    expect(
      await screen.findByRole('button', { name: 'DXP brain' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'IML HUB brain' })).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: 'Project DXP, switch project' }),
    );
    await userEvent.click(
      within(screen.getByRole('menu', { name: 'Projects' })).getByRole(
        'menuitemradio',
        { name: /IML Hub/ },
      ),
    );
    expect(
      screen.getByRole('button', { name: 'IML HUB brain' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'DXP brain' })).toBeNull();
  });
});

const lifeOf =
  (by: Record<string, { group: Lifecycle; sortKey?: number }> = {}) =>
  (t: TaskView): TaskLifecycle => ({
    group: by[t.id]?.group ?? 'parked',
    chip: null,
    story: '',
    sortKey: by[t.id]?.sortKey ?? 0,
  });
const ids = (list: TaskView[]) => list.map((t) => t.id);

describe('groupTasks', () => {
  it('groups open tasks by lifecycle in order, omits empty groups and collects done tasks', () => {
    const ready = (id: string): TaskView => ({ ...tasks[0], id });
    const g = groupTasks(
      [...tasks, ready('p'), ready('q'), ready('r')],
      repos,
      null,
      undefined,
      lifeOf({
        p: { group: 'parked' },
        q: { group: 'in-review' },
        r: { group: 'needs-you' },
        a: { group: 'merged' },
      }),
    );
    expect(g.groups.map((x) => [x.group, ids(x.tasks)])).toEqual([
      ['needs-you', ['r']],
      ['active', ['b', 'd']],
      ['in-review', ['q']],
      ['merged', ['a']],
      ['parked', ['p']],
    ]);
    expect(ids(g.done)).toEqual(['c']);
  });

  it('sorts a group by sortKey', () => {
    const ready = (id: string): TaskView => ({ ...tasks[0], id });
    const g = groupTasks(
      [ready('x'), ready('y'), ready('z')],
      repos,
      null,
      undefined,
      lifeOf({
        x: { group: 'parked', sortKey: 3 },
        y: { group: 'parked', sortKey: 1 },
        z: { group: 'parked', sortKey: 2 },
      }),
    );
    expect(ids(g.groups[0].tasks)).toEqual(['y', 'z', 'x']);
  });

  it('puts setting-up, setup-failed and finishing tasks in Active whatever their lifecycle', () => {
    const t = (id: string, status: TaskView['status']): TaskView => ({
      ...tasks[0],
      id,
      status,
    });
    const g = groupTasks(
      [t('x', 'setting-up'), t('y', 'setup-failed'), t('z', 'finishing')],
      repos,
      null,
      undefined,
      lifeOf({
        x: { group: 'merged' },
        y: { group: 'parked' },
        z: { group: 'needs-you' },
      }),
    );
    expect(g.groups.map((x) => [x.group, ids(x.tasks)])).toEqual([
      ['active', ['x', 'y', 'z']],
    ]);
  });

  it('lets tasks without a repo join the groups like any other (#225)', () => {
    const scratch: TaskView = {
      ...tasks[0],
      id: 'n',
      repoId: null,
      branch: '',
      baseRef: '',
      connectionId: 'A',
    };
    const g = groupTasks(
      [scratch, { ...scratch, id: 'm', status: 'done' }],
      repos,
      null,
      undefined,
      lifeOf(),
    );
    expect(g.groups.map((x) => [x.group, ids(x.tasks)])).toEqual([
      ['parked', ['n']],
    ]);
    expect(ids(g.done)).toEqual(['m']);
    expect(
      groupTasks([scratch], repos, 'B', ['A', 'B'], lifeOf()).groups,
    ).toEqual([]);
  });

  it('keeps only the connection’s tasks and tasks without one (#219)', () => {
    const split: Repo[] = [
      { ...repos[0], connectionId: 'A' },
      { ...repos[1], connectionId: 'B' },
      { ...repos[1], id: 'r3', name: 'scratch', connectionId: null },
    ];
    const mixed: TaskView[] = [
      { ...tasks[0], id: 'a1' },
      { ...tasks[0], id: 'b1', connectionId: 'B' },
      { ...tasks[0], id: 'a2', repoId: 'r2', connectionId: 'A' },
      { ...tasks[2], id: 'a3', repoId: 'r1' },
      { ...tasks[2], id: 'b2' },
      { ...tasks[1], id: 'n1', repoId: 'r3' },
      { ...tasks[2], id: 'n2', repoId: 'r3' },
    ];
    const g = groupTasks(mixed, split, 'A', undefined, lifeOf());
    expect(g.groups.flatMap((x) => ids(x.tasks)).sort()).toEqual([
      'a1',
      'a2',
      'n1',
    ]);
    expect(ids(g.done)).toEqual(['a3', 'n2']);
    const all = groupTasks(mixed, split, null, undefined, lifeOf());
    expect(all.groups.flatMap((x) => x.tasks)).toHaveLength(4);
    expect(all.done).toHaveLength(3);
  });

  it('shows a task whose own connection was removed under every project (#219)', () => {
    const split: Repo[] = [{ ...repos[0], connectionId: 'A' }];
    const orphan: TaskView = {
      ...tasks[0],
      id: 'o1',
      repoId: 'r1',
      connectionId: 'B',
    };
    const g = groupTasks([orphan], split, 'A', ['A'], lifeOf());
    expect(g.groups.flatMap((x) => ids(x.tasks))).toEqual(['o1']);
    expect(
      groupTasks([orphan], split, 'A', ['A', 'B'], lifeOf()).groups,
    ).toEqual([]);
  });
});

const pulseOf = (
  workspaceId: string,
  over: Partial<PrPulse> = {},
): PrPulse => ({
  workspaceId,
  pr: {
    id: 7,
    url: 'https://dev.azure.com/o/p/_git/r/pullrequest/7',
    status: 'active',
    isDraft: false,
    createdAt: '2026-11-17T08:00:00.000Z',
    closedAt: null,
  },
  ci: 'none',
  ciFailedName: null,
  review: 'waiting',
  approvals: { have: 0, need: 2 },
  conflict: false,
  unanswered: 0,
  checkedAt: '2026-11-18T08:00:00.000Z',
  ...over,
});
const pulseView = (
  over: Partial<PulseView> & { tasks: PulseView['tasks'] },
): PulseView => ({
  error: null,
  checkedAt: null,
  lastActive: {},
  ...over,
});
const withPulse = (view: PulseView) =>
  installFakeApi({ 'pulse:get': () => view });

describe('TaskNav lifecycle groups', () => {
  const three = () => {
    const mk = (id: string, title: string): TaskView => ({
      ...tasks[0],
      id,
      workItem: { ...tasks[0].workItem!, id: `9${id}`, title },
    });
    return [mk('t1', 'One'), mk('t2', 'Two'), mk('t3', 'Three')];
  };

  it('shows an amber Needs you header with its count and a red chip on the row', async () => {
    const list = three();
    useStore.setState({ tasks: list, selectedTaskId: null });
    withPulse(
      pulseView({
        tasks: {
          t1: [pulseOf('t1', { ci: 'failing', ciFailedName: 'PR build' })],
          t2: [pulseOf('t2', { conflict: true })],
          t3: [pulseOf('t3', { review: 'changes-asked' })],
        },
      }),
    );
    render(<TaskNav />);
    const header = await screen.findByText('Needs you');
    const head = header.closest('.nav-subhead')!;
    expect(head).toHaveClass('nav-subhead-amber');
    expect(head).toHaveTextContent('3');
    const chip = screen.getByRole('button', { name: 'CI failing' });
    expect(chip).toHaveClass('navchip', 'navchip-red');
    expect(
      screen.getByRole('button', { name: /One/ }).getAttribute('title'),
    ).toMatch(/CI failing/);
  });

  it('opens the PR from the chip and tracks it, without opening the task', async () => {
    const list = three();
    useStore.setState({ tasks: list, selectedTaskId: null });
    const { calls, tracked } = withPulse(
      pulseView({
        tasks: {
          t1: [pulseOf('t1', { ci: 'failing' })],
        },
      }),
    );
    render(<TaskNav />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'CI failing' }),
    );
    expect(calls).toContainEqual({
      channel: 'links:open',
      args: ['https://dev.azure.com/o/p/_git/r/pullrequest/7'],
    });
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'nav.chipClicked',
      props: { kind: 'ci-failing' },
    });
    expect(useStore.getState().selectedTaskId).toBeNull();
  });

  it('gives a merged task a Finish button that opens its Finish page', async () => {
    const list = three();
    useStore.setState({ tasks: list, selectedTaskId: null });
    withPulse(
      pulseView({
        tasks: {
          t1: [
            pulseOf('t1', {
              pr: {
                id: 7,
                url: 'https://x/7',
                status: 'completed',
                isDraft: false,
                createdAt: '2026-11-16T08:00:00.000Z',
                closedAt: '2026-11-17T08:00:00.000Z',
              },
            }),
          ],
        },
      }),
    );
    render(<TaskNav />);
    await screen.findByText('Merged · close me');
    await userEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'finish',
      taskId: 't1',
    });
  });

  it('shows the repo name on a row only with more than one repo', async () => {
    installFakeApi();
    const one = tasks.filter((t) => t.repoId === 'r1' && t.status !== 'done');
    useStore.setState({ tasks: one });
    const { unmount } = render(<TaskNav />);
    expect(screen.queryByText('webshop')).toBeNull();
    unmount();
    useStore.setState({
      tasks: [...one, { ...tasks[0], id: 'e', repoId: 'r2' }],
    });
    render(<TaskNav />);
    expect(screen.getAllByText('backoffice-api')).toHaveLength(1);
    expect(screen.getAllByText('webshop').length).toBeGreaterThan(0);
  });

  it('shows no chips and only Active or Parked groups before any pulse', async () => {
    installFakeApi({ 'pulse:get': () => null as never });
    render(<TaskNav />);
    expect(await screen.findByText('Parked')).toBeInTheDocument();
    expect(screen.queryByText('Needs you')).toBeNull();
    expect(document.querySelector('.navchip')).toBeNull();
  });

  it('shows cost only in Active and the auth note in the footer', async () => {
    const list = three();
    useStore.setState({ tasks: list, selectedTaskId: null });
    installFakeApi({
      'pulse:get': () =>
        pulseView({
          error: 'auth',
          tasks: { t1: [pulseOf('t1', { ci: 'failing' })] },
          lastActive: { t2: Date.now() },
        }),
      'usage:costs': () => ({ t1: 1.5, t2: 2.5 }),
    });
    render(<TaskNav />);
    expect(
      await screen.findByText(
        'PR status unavailable: check the Azure DevOps token',
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(`${String.fromCharCode(0x20ac)}2.50`),
    ).toBeInTheDocument();
    expect(screen.queryByText(`${String.fromCharCode(0x20ac)}1.50`)).toBeNull();
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
          writeTimeToAdo: false,
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

  it('has a Project item that opens the project page', async () => {
    installFakeApi();
    useStore.setState({ connections: [conn('c1', 'Shellie')] });
    render(<TaskNav />);
    await userEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(useStore.getState().screen).toEqual({ kind: 'project' });
    expect(screen.getByRole('button', { name: 'Project' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('has no Project item without connections', () => {
    installFakeApi();
    render(<TaskNav />);
    expect(
      screen.queryByRole('button', { name: 'Project' }),
    ).not.toBeInTheDocument();
  });

  it('switches project when there is more than one connection', async () => {
    installFakeApi();
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
    expect(useStore.getState().screen).toEqual({ kind: 'project' });
    expect(
      screen.getByRole('button', { name: 'Project DXP, switch project' }),
    ).toBeInTheDocument();
    expect(screen.getByText('unreliablewitness: DXP')).toBeInTheDocument();
  });

  it('shows only the switched-to project’s open and done tasks (#219)', async () => {
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
      writeTimeToAdo: false,
    });
    useStore.setState({
      repos: [
        { ...repos[0], connectionId: 'c1' },
        { ...repos[1], connectionId: 'c2' },
      ],
      tasks: [
        tasks[0],
        {
          ...tasks[0],
          id: 'x',
          repoId: 'r2',
          workItem: null,
          name: 'dxp-open',
        },
        tasks[2],
        {
          ...tasks[2],
          id: 'y',
          repoId: 'r1',
          workItem: null,
          name: 'iml-done',
        },
      ],
      connections: [conn('c1', 'IML Hub'), conn('c2', 'DXP')],
      connectionId: 'c2',
      selectedTaskId: null,
      screen: { kind: 'sprint' },
    });
    render(<TaskNav />);
    expect(screen.getByText('dxp-open')).toBeInTheDocument();
    expect(screen.queryByText('48213')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Done (1)' }));
    expect(screen.getByText('47988')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Project DXP, switch project' }),
    );
    await userEvent.click(
      within(screen.getByRole('menu', { name: 'Projects' })).getByRole(
        'menuitemradio',
        { name: /IML Hub/ },
      ),
    );
    expect(screen.getByText('48213')).toBeInTheDocument();
    expect(screen.queryByText('dxp-open')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Done (1)' }),
    ).toBeInTheDocument();
    expect(screen.getByText('iml-done')).toBeInTheDocument();
    expect(screen.queryByText('47988')).toBeNull();
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
      writeTimeToAdo: false,
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
      'usage:costs': () => ({ a: 12.5 }),
      'pulse:get': () =>
        pulseView({ tasks: {}, lastActive: { a: Date.now() } }),
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
    installFakeApi();
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
    const row = screen
      .getByRole('button', { name: /48213/ })
      .closest('.navrow')!;
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
    installFakeApi();
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
  beforeEach(() => installFakeApi());

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
