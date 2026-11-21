import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repo, TaskView } from '../../shared/types';
import { useStore } from '../store';
import { listedBrain } from '../test-helpers/brainFixture';
import { installFakeApi } from '../test-helpers/fakeApi';
import { readingBrain, readingRead } from '../test-helpers/readingFixture';
import { type PrPulse, type PulseSnapshot } from '../../shared/pulse';
import { listTasks, TaskNav } from './TaskNav';

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
  const withAgent = (reason: 'blocked' | 'done') => {
    installFakeApi();
    const withTerminal = {
      ...tasks[0],
      terminals: [{ id: 'c1', kind: 'claude', label: 'Claude Code' }],
    } as unknown as TaskView;
    useStore.setState({
      tasks: [withTerminal],
      attention: {
        c1: {
          reason,
          kind: 'permission',
          message: 'approve Bash: ls',
          since: 1,
        },
      },
    });
    render(<TaskNav />);
  };

  it('marks a task whose agent is blocked with what it asks, and the mark is not a button', () => {
    withAgent('blocked');
    const mark = screen.getByRole('img', {
      name: 'Needs permission: approve Bash: ls',
    });
    expect(mark).toHaveClass('navmark', 'navmark-waits');
  });

  it('does not mark a task whose agent only finished its turn', () => {
    withAgent('done');
    expect(document.querySelector('.navmark')).toBeNull();
    expect(document.querySelector('.attention-dot')).toBeNull();
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

const ids = (list: TaskView[]) => list.map((t) => t.id);

describe('listTasks', () => {
  const at = (id: string, createdAt: string): TaskView => ({
    ...tasks[0],
    id,
    createdAt,
  });
  const openIds = (list: TaskView[]) =>
    ids(listTasks(list, repos, null, undefined).open);

  it('lists open tasks newest first and collects done tasks apart', () => {
    const l = listTasks(
      [
        at('old', '2026-11-01T08:00:00.000Z'),
        at('new', '2026-11-20T08:00:00.000Z'),
        at('mid', '2026-11-10T08:00:00.000Z'),
        tasks[2],
      ],
      repos,
      null,
      undefined,
    );
    expect(ids(l.open)).toEqual(['new', 'mid', 'old']);
    expect(ids(l.done)).toEqual(['c']);
  });

  it('orders tasks created at the same moment by id', () => {
    const t = '2026-11-20T08:00:00.000Z';
    expect(openIds([at('z', t), at('x', t), at('y', t)])).toEqual([
      'x',
      'y',
      'z',
    ]);
  });

  it('keeps one order for unreadable dates, whatever order they arrive in', () => {
    const list = [at('z', 'now'), at('x', 'now'), at('y', 'now')];
    expect(openIds(list)).toEqual(['x', 'y', 'z']);
    expect(openIds([...list].reverse())).toEqual(['x', 'y', 'z']);
  });

  it('does not order by status: a setting-up task keeps its place', () => {
    expect(
      openIds([
        at('old', '2026-11-01T08:00:00.000Z'),
        { ...at('busy', '2026-11-02T08:00:00.000Z'), status: 'setting-up' },
        at('new', '2026-11-20T08:00:00.000Z'),
      ]),
    ).toEqual(['new', 'busy', 'old']);
  });

  it('lets tasks without a repo join the list like any other (#225)', () => {
    const scratch: TaskView = {
      ...tasks[0],
      id: 'n',
      repoId: null,
      branch: '',
      baseRef: '',
      connectionId: 'A',
    };
    const l = listTasks(
      [scratch, { ...scratch, id: 'm', status: 'done' }],
      repos,
      null,
      undefined,
    );
    expect(ids(l.open)).toEqual(['n']);
    expect(ids(l.done)).toEqual(['m']);
    expect(listTasks([scratch], repos, 'B', ['A', 'B']).open).toEqual([]);
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
    const l = listTasks(mixed, split, 'A', undefined);
    expect(ids(l.open)).toEqual(['a1', 'a2', 'n1']);
    expect(ids(l.done)).toEqual(['a3', 'n2']);
    const all = listTasks(mixed, split, null, undefined);
    expect(all.open).toHaveLength(4);
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
    expect(ids(listTasks([orphan], split, 'A', ['A']).open)).toEqual(['o1']);
    expect(listTasks([orphan], split, 'A', ['A', 'B']).open).toEqual([]);
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
  over: Partial<PulseSnapshot> & { tasks: PulseSnapshot['tasks'] },
): PulseSnapshot => ({
  error: null,
  checkedAt: null,
  ...over,
});
const withPulse = (view: PulseSnapshot) =>
  installFakeApi({ 'pulse:get': () => view });

const mergedPulse = (workspaceId: string) =>
  pulseOf(workspaceId, {
    pr: {
      id: 9,
      url: 'https://x/9',
      status: 'completed',
      isDraft: false,
      createdAt: '2026-11-16T08:00:00.000Z',
      closedAt: '2026-11-17T08:00:00.000Z',
    },
  });
const EUR = String.fromCharCode(0x20ac);
const rowOf = (name: RegExp) =>
  screen.getByRole('button', { name }).closest('.navrow') as HTMLElement;
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

describe('TaskNav calm list', () => {
  const mk = (id: string, title: string, createdAt = 'now'): TaskView => ({
    ...tasks[0],
    id,
    createdAt,
    workItem: { ...tasks[0].workItem!, id: `9${id}`, title },
  });
  const three = () => [
    mk('t1', 'One', '2026-11-01T08:00:00.000Z'),
    mk('t2', 'Two', '2026-11-10T08:00:00.000Z'),
    mk('t3', 'Three', '2026-11-20T08:00:00.000Z'),
  ];
  const titles = () =>
    [...document.querySelectorAll('.navrow-title')].map((e) => e.textContent);

  it('has no group headings, counts or chips, whatever the PRs say', async () => {
    useStore.setState({ tasks: three(), selectedTaskId: null });
    withPulse(
      pulseView({
        tasks: {
          t1: [pulseOf('t1', { ci: 'failing' })],
          t2: [pulseOf('t2', { review: 'approved' })],
          t3: [mergedPulse('t3')],
        },
      }),
    );
    render(<TaskNav />);
    await screen.findByRole('button', { name: /CI failing/ });
    for (const heading of [
      'Needs you',
      'Active',
      'In review',
      'Merged · close me',
      'Parked',
    ])
      expect(screen.queryByText(heading)).toBeNull();
    expect(document.querySelector('.nav-subhead')).toBeNull();
    expect(document.querySelector('.navchip')).toBeNull();
    expect(document.querySelector('.is-muted')).toBeNull();
  });

  it('keeps every task in its place when a task is opened and when PR status changes', async () => {
    useStore.setState({ tasks: three(), selectedTaskId: null });
    let view = pulseView({ tasks: {} });
    const { emit } = installFakeApi({ 'pulse:get': () => view });
    render(<TaskNav />);
    await settle();
    expect(titles()).toEqual(['Three', 'Two', 'One']);
    await userEvent.click(screen.getByRole('button', { name: /One/ }));
    expect(useStore.getState().selectedTaskId).toBe('t1');
    expect(titles()).toEqual(['Three', 'Two', 'One']);
    view = pulseView({
      tasks: {
        t2: [pulseOf('t2', { ci: 'failing' })],
        t1: [mergedPulse('t1')],
      },
    });
    act(() => emit('pulse:changed', view));
    await screen.findByRole('button', { name: /CI failing/ });
    expect(titles()).toEqual(['Three', 'Two', 'One']);
  });

  it('puts Finish and Discard inside the current row, on no line of their own', () => {
    installFakeApi();
    useStore.setState({
      tasks: three(),
      selectedTaskId: 't2',
      screen: { kind: 'task' },
    });
    render(<TaskNav />);
    expect(document.querySelector('.nav-task-action')).toBeNull();
    const row = rowOf(/Two/);
    expect(
      within(row).getByRole('button', { name: 'Finish task' }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: 'Discard task' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Finish task' })).toHaveLength(
      1,
    );
  });

  it('opens the PR from an amber mark and tracks it, without opening the task', async () => {
    useStore.setState({ tasks: three(), selectedTaskId: null });
    const { calls, tracked } = withPulse(
      pulseView({
        tasks: {
          t1: [pulseOf('t1', { ci: 'failing', ciFailedName: 'PR build' })],
        },
      }),
    );
    render(<TaskNav />);
    const mark = await screen.findByRole('button', {
      name: /CI failing: PR build/,
    });
    expect(mark).toHaveClass('navmark', 'navmark-waits');
    expect(rowOf(/One/)).toContainElement(mark);
    await userEvent.click(mark);
    expect(calls).toContainEqual({
      channel: 'links:open',
      args: ['https://dev.azure.com/o/p/_git/r/pullrequest/7'],
    });
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'nav.chipClicked',
      props: { kind: 'waits' },
    });
    expect(useStore.getState().selectedTaskId).toBeNull();
  });

  it('uses one amber mark for a conflict, changes asked and comments alike', async () => {
    useStore.setState({ tasks: three(), selectedTaskId: null });
    withPulse(
      pulseView({
        tasks: {
          t1: [pulseOf('t1', { conflict: true })],
          t2: [pulseOf('t2', { review: 'changes-asked' })],
          t3: [pulseOf('t3', { unanswered: 2 })],
        },
      }),
    );
    render(<TaskNav />);
    await screen.findByRole('button', { name: /merge conflict/ });
    expect(document.querySelectorAll('.navmark-waits')).toHaveLength(3);
    expect(document.querySelectorAll('.navmark')).toHaveLength(3);
  });

  it('gives a merged task a green check that opens its Finish page', async () => {
    useStore.setState({ tasks: three(), selectedTaskId: null });
    withPulse(pulseView({ tasks: { t1: [mergedPulse('t1')] } }));
    render(<TaskNav />);
    const check = await screen.findByRole('button', {
      name: 'Merged: finish this task',
    });
    expect(check).toHaveClass('navmark-merged');
    await userEvent.click(check);
    expect(useStore.getState().screen).toEqual({
      kind: 'finish',
      taskId: 't1',
    });
  });

  it('shows one Finish control on a current task that is merged', async () => {
    useStore.setState({
      tasks: three(),
      selectedTaskId: 't1',
      screen: { kind: 'task', taskId: 't1' } as never,
    });
    withPulse(pulseView({ tasks: { t1: [mergedPulse('t1')] } }));
    render(<TaskNav />);
    await settle();
    expect(
      within(rowOf(/One/)).getAllByRole('button', { name: /finish/i }),
    ).toHaveLength(1);
    expect(document.querySelector('.navmark-merged')).toBeNull();
  });

  it('keeps the amber mark beside Finish on the current task', async () => {
    useStore.setState({
      tasks: three(),
      selectedTaskId: 't1',
      screen: { kind: 'task', taskId: 't1' } as never,
    });
    withPulse(pulseView({ tasks: { t1: [pulseOf('t1', { ci: 'failing' })] } }));
    render(<TaskNav />);
    const mark = await screen.findByRole('button', { name: /CI failing/ });
    const row = rowOf(/One/);
    expect(row).toContainElement(mark);
    expect(
      within(row).getByRole('button', { name: 'Finish task' }),
    ).toBeInTheDocument();
  });

  it('shows a blocked agent on a merged task, also when it is the current one', async () => {
    useStore.setState({
      tasks: [
        {
          ...mk('t1', 'One'),
          terminals: [{ id: 'c1', kind: 'claude', label: 'Claude Code' }],
        } as unknown as TaskView,
      ],
      attention: { c1: { reason: 'blocked', kind: 'question', since: 1 } },
      selectedTaskId: 't1',
      screen: { kind: 'task', taskId: 't1' } as never,
    });
    withPulse(pulseView({ tasks: { t1: [mergedPulse('t1')] } }));
    render(<TaskNav />);
    await settle();
    const row = rowOf(/One/);
    expect(
      within(row).getByRole('img', { name: 'Has a question' }),
    ).toHaveClass('navmark-waits');
    expect(
      within(row).getByRole('button', { name: 'Finish task' }),
    ).toBeInTheDocument();
  });

  it('leaves a quiet task without any mark, in review or not', async () => {
    useStore.setState({ tasks: three(), selectedTaskId: null });
    withPulse(
      pulseView({
        tasks: {
          t1: [pulseOf('t1', { ci: 'failing' })],
          t2: [pulseOf('t2', { review: 'approved' })],
        },
      }),
    );
    render(<TaskNav />);
    await screen.findByRole('button', { name: /CI failing/ });
    for (const name of [/Two/, /Three/]) {
      expect(rowOf(name).querySelector('.navmark')).toBeNull();
      expect(rowOf(name).querySelector('.dot')).toBeNull();
    }
  });

  it('shows no marks before any pulse', async () => {
    useStore.setState({ tasks: three(), selectedTaskId: null });
    installFakeApi({ 'pulse:get': () => null as never });
    render(<TaskNav />);
    await settle();
    expect(titles()).toEqual(['Three', 'Two', 'One']);
    expect(document.querySelector('.navmark')).toBeNull();
  });

  it('lets a setting-up task show its own dot, not a stale pulse', async () => {
    useStore.setState({
      tasks: [{ ...tasks[0], status: 'setting-up' }],
      selectedTaskId: null,
    });
    withPulse(pulseView({ tasks: { a: [pulseOf('a', { ci: 'failing' })] } }));
    render(<TaskNav />);
    await settle();
    expect(screen.getByRole('img', { name: 'Setting up' })).toHaveClass(
      'navmark-busy',
    );
    expect(document.querySelector('.navmark-waits')).toBeNull();
    expect(
      screen.getByRole('button', { name: /Checkout/ }).getAttribute('title'),
    ).not.toMatch(/CI failing/);
  });

  it('marks a failed setup and a missing worktree folder in red', () => {
    installFakeApi();
    useStore.setState({
      tasks: [
        { ...tasks[3] },
        { ...tasks[0], id: 'gone', worktreeMissing: true },
      ],
      selectedTaskId: null,
    });
    render(<TaskNav />);
    expect(screen.getByRole('img', { name: 'Setup failed' })).toHaveClass(
      'navmark-broken',
    );
    expect(
      screen.getByRole('img', { name: 'Worktree folder missing' }),
    ).toHaveClass('navmark-broken');
  });

  it('shows Finishing as a dot on the current task, with no Finish button', () => {
    installFakeApi();
    useStore.setState({
      tasks: [{ ...tasks[0], status: 'finishing' }],
      selectedTaskId: 'a',
      screen: { kind: 'finish', taskId: 'a' },
    });
    render(<TaskNav />);
    expect(screen.getByRole('img', { name: 'Finishing' })).toHaveClass(
      'navmark-busy',
    );
    expect(screen.queryByRole('button', { name: /Finish/ })).toBeNull();
  });

  it('keeps repo and cost in the tooltip, not on the row', async () => {
    const w = (id: string) => ({ id, repoId: 'r2', dropped: false }) as never;
    useStore.setState({
      tasks: [
        { ...mk('t1', 'One'), extraWorkspaces: [w('w1')] },
        { ...mk('t2', 'Two'), extraWorkspaces: [w('w2'), w('w3')] },
        mk('t3', 'Three'),
      ],
      selectedTaskId: null,
    });
    installFakeApi({
      'pulse:get': () => pulseView({ tasks: {} }),
      'usage:costs': () => ({ t1: 1.5 }),
    });
    render(<TaskNav />);
    const title = (name: RegExp) =>
      screen.getByRole('button', { name }).getAttribute('title');
    await waitFor(() => expect(title(/One/)).toContain(`${EUR}1.50`));
    expect(title(/One/)).toContain('webshop +1 repo');
    expect(title(/Two/)).toBe('webshop +2 repos');
    expect(title(/Three/)).toBe('webshop');
    expect(screen.queryByText(`${EUR}1.50`)).toBeNull();
    expect(screen.queryByText('webshop')).toBeNull();
    expect(screen.queryByText('+1 repo')).toBeNull();
  });

  it('still shows the cost on a done task', async () => {
    installFakeApi({ 'usage:costs': () => ({ c: 2.5 }) });
    render(<TaskNav />);
    await userEvent.click(screen.getByRole('button', { name: /Done \(1\)/ }));
    expect(await screen.findByText(`${EUR}2.50`)).toBeInTheDocument();
  });

  it('keeps the auth note in the footer', async () => {
    useStore.setState({ tasks: three(), selectedTaskId: null });
    installFakeApi({
      'pulse:get': () => pulseView({ error: 'auth', tasks: {} }),
    });
    render(<TaskNav />);
    expect(
      await screen.findByText(
        'PR status unavailable: check the Azure DevOps token',
      ),
    ).toBeInTheDocument();
  });
});

describe('TaskNav collapsed rail', () => {
  const mk = (id: string, title: string): TaskView => ({
    ...tasks[0],
    id,
    workItem: { ...tasks[0].workItem!, id: `9${id}`, title },
  });
  const setup = async (current: string | null = null) => {
    useStore.setState({
      tasks: ['t1', 't2', 't3', 't4', 't5', 't6'].map((id, i) =>
        mk(id, `Title${i + 1}`),
      ),
      selectedTaskId: current,
      screen: { kind: 'task' },
      navCollapsed: true,
    });
    withPulse(
      pulseView({
        tasks: {
          t1: [pulseOf('t1', { ci: 'failing', ciFailedName: 'PR build' })],
          t2: [pulseOf('t2', { conflict: true })],
          t3: [pulseOf('t3', { review: 'changes-asked' })],
          t4: [
            pulseOf('t4', {
              review: 'approved',
              approvals: { have: 2, need: 2 },
            }),
          ],
          t5: [mergedPulse('t5')],
        },
      }),
    );
    render(<TaskNav />);
    await waitFor(() =>
      expect(document.querySelector('.rail-dot-amber')).not.toBeNull(),
    );
  };
  const icon = (name: RegExp) => screen.getByRole('button', { name });
  afterEach(() => useStore.setState({ navCollapsed: false }));

  it('has no count pill, separators, dimming or hollow Finish square', async () => {
    await setup();
    for (const gone of [
      '.rail-count',
      '.rail-sep',
      '.is-dim',
      '.rail-finish-hollow',
    ])
      expect(document.querySelector(gone)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Finish/ })).toBeNull();
  });

  it('draws an amber corner dot for anything that waits, a green check for merged, nothing on a quiet task', async () => {
    await setup();
    for (const name of [/Title1/, /Title2/, /Title3/])
      expect(icon(name).querySelector('.rail-dot')).toHaveClass(
        'rail-dot-amber',
      );
    expect(icon(/Title5/).querySelector('.rail-check')).not.toBeNull();
    for (const name of [/Title4/, /Title6/]) {
      expect(icon(name).querySelector('.rail-dot')).toBeNull();
      expect(icon(name).querySelector('.rail-check')).toBeNull();
    }
  });

  it('keeps the icons in the list order', async () => {
    await setup();
    expect(
      [...document.querySelectorAll('.railrow[aria-label^="9t"]')].map((e) =>
        e.getAttribute('aria-label'),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6].map((n) => `9t${n} Title${n}`));
  });

  it('titles an icon with the id and title, plus what its mark means', async () => {
    await setup();
    expect(icon(/Title1/).getAttribute('title')).toMatch(
      /^9t1 Title1 · CI failing: PR build/,
    );
    expect(icon(/Title5/).getAttribute('title')).toBe(
      '9t5 Title5 · Merged: finish this task',
    );
    expect(icon(/Title6/).getAttribute('title')).toBe('9t6 Title6');
  });

  it('shows a setting-up task its own dot, not a stale pulse, and a failed setup in red', async () => {
    useStore.setState({
      tasks: [
        { ...mk('t1', 'Busy'), status: 'setting-up' },
        { ...mk('t2', 'Broken'), status: 'setup-failed' },
      ],
      selectedTaskId: null,
      navCollapsed: true,
    });
    withPulse(pulseView({ tasks: { t1: [pulseOf('t1', { ci: 'failing' })] } }));
    render(<TaskNav />);
    await settle();
    expect(icon(/Busy/).querySelector('.rail-dot')).toHaveClass(
      'rail-dot-accent',
    );
    expect(icon(/Broken/).querySelector('.rail-dot')).toHaveClass(
      'rail-dot-red',
    );
    expect(document.querySelector('.rail-dot-amber')).toBeNull();
  });

  it('shows one Finish and one Discard for a current task that is merged', async () => {
    await setup('t5');
    expect(screen.getAllByRole('button', { name: /Finish/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Discard/ })).toHaveLength(1);
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
  it('shows no connection line in the footer while the connection is fine', () => {
    installFakeApi();
    useStore.setState({ connections: [conn('c1', 'Shellie')] });
    const { unmount } = render(<TaskNav />);
    expect(screen.queryByText('unreliablewitness: Shellie')).toBeNull();
    expect(
      document.querySelector('.leftnav-foot .nav-status > .dot'),
    ).toBeNull();
    unmount();
    useStore.setState({ navCollapsed: true });
    render(<TaskNav />);
    expect(
      document.querySelector('.leftnav-foot .nav-status > .dot'),
    ).toBeNull();
    useStore.setState({ navCollapsed: false });
  });

  it('says so in the footer when there is no connection', () => {
    installFakeApi();
    render(<TaskNav />);
    expect(screen.getByText('Azure DevOps: not connected')).toBeInTheDocument();
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

  it('has a Week item that opens the week overview', async () => {
    installFakeApi();
    render(<TaskNav />);
    await userEvent.click(screen.getByRole('button', { name: 'Week' }));
    expect(useStore.getState().screen).toEqual({ kind: 'week' });
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute(
      'aria-current',
      'page',
    );
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
    // The footer stays quiet while the connection is fine.
    expect(screen.queryByText('unreliablewitness: DXP')).toBeNull();
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

  it('shows Finish task in the row of the current ready task only', async () => {
    useStore.setState({ selectedTaskId: 'a', screen: { kind: 'task' } });
    render(<TaskNav />);
    const finish = screen.getAllByRole('button', { name: 'Finish task' });
    expect(finish).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: /48213/ }).closest('.navrow'),
    ).toContainElement(finish[0]);
    await userEvent.click(finish[0]);
    expect(useStore.getState().screen).toEqual({ kind: 'finish', taskId: 'a' });
    // On the Finish page itself it steps aside.
    expect(screen.queryByRole('button', { name: 'Finish task' })).toBeNull();
  });

  it('has no Finish away from a task', () => {
    useStore.setState({ selectedTaskId: 'a', screen: { kind: 'sprint' } });
    render(<TaskNav />);
    expect(screen.queryByRole('button', { name: 'Finish task' })).toBeNull();
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
