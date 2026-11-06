import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskView } from '../../shared/types';
import { CHANGES_TAB, useStore } from '../store';
import { listedBrain } from '../test-helpers/brainFixture';
import { installFakeApi, noOverrides } from '../test-helpers/fakeApi';
import { Shell } from '../App';
import { invalidateRepoConfig } from '../hooks/useRepoConfig';
import { brainTerminalOpenedOnStart } from '../components/TerminalTabs';

const mounts = vi.hoisted(() => ({ count: 0 }));

vi.mock('../components/TerminalView', async () => {
  const { useEffect } = await import('react');
  return {
    TerminalView: ({
      terminalId,
      taskId,
      active,
    }: {
      terminalId: string;
      taskId?: string;
      active: boolean;
    }) => {
      useEffect(() => {
        mounts.count++;
      }, []);
      return (
        <div
          data-testid={`term-${terminalId}`}
          data-task={taskId}
          data-active={active}
        />
      );
    },
  };
});

const AHEAD_CHANGED = new RegExp(
  `${String.fromCharCode(0x2191)}2 ${String.fromCharCode(0xb7)} 3${String.fromCharCode(0x394)}`,
);

const task: TaskView = {
  id: 'a',
  repoId: 'r1',
  name: '',
  workItem: {
    id: '48213',
    type: 'User Story',
    title: 'Checkout: allow saving a delivery address',
    url: null,
    project: null,
  },
  slug: 'a',
  branch: 'feature/48213-save-delivery-address',
  worktreePath: '/src/webshop.worktrees/48213-save-delivery-address',
  baseRef: 'origin/main',
  baseSha: null,
  openPeriods: [],
  time: null,
  status: 'ready',
  setup: {
    copy: true,
    commands: [],
    startClaude: true,
    openShell: true,
    openCopilot: false,
    summary: null,
  },
  terminals: [
    { id: 'c1', kind: 'claude', label: 'Claude Code' },
    { id: 's1', kind: 'shell', label: 'zsh' },
  ],
  createdAt: 'now',
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
  environment: 'development',
  environmentUntil: null,
  pendingCleanup: [],
  worktreeMissing: false,
};
const extra = {
  id: 'w1',
  repoId: 'r2',
  branch: 'feature/48213-save-delivery-address',
  worktreePath: '/src/api.worktrees/x',
  baseRef: 'origin/main',
  baseSha: null,
  source: 'detected',
  summary: null,
  pullRequest: null,
  reopen: null,
  dropped: false,
} as unknown as TaskView['extraWorkspaces'][number];
const config = {
  worktreeRoot: '/src/webshop.worktrees',
  ...noOverrides,
  config: {
    base: 'main',
    branch: '{type}/{id}-{slug}',
    copy: [],
    setup: [],
    run: { dev: 'npm run dev', test: 'npm test' },
    found: true,
  },
};

beforeEach(() =>
  useStore.setState({
    repos: [
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
    ],
    tasks: [task],
    connections: [],
    notices: [],
    screen: { kind: 'task' },
    previous: null,
    connectionId: null,
    selectedTaskId: 'a',
  }),
);

describe('TaskScreen', () => {
  it('shows the task in the breadcrumb, git state and the terminal tabs', async () => {
    installFakeApi({
      'repos:config': () => config,
      'tasks:gitSummary': () => ({
        branch: 'feature/48213-save-delivery-address',
        ahead: 2,
        behind: 0,
        hasUpstream: true,
        files: [
          { status: 'M', path: 'a' },
          { status: 'M', path: 'b' },
          { status: '?', path: 'c' },
        ],
      }),
    });
    render(<Shell />);
    expect(
      within(screen.getByRole('banner')).getByText(
        'User Story 48213 Checkout: allow saving a delivery address',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText(AHEAD_CHANGED)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Claude Code/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('term-c1')).toHaveAttribute(
      'data-active',
      'true',
    );
    expect(screen.getByTestId('term-s1')).toHaveAttribute(
      'data-active',
      'false',
    );
    await userEvent.click(screen.getByRole('tab', { name: /zsh/ }));
    expect(screen.getByTestId('term-s1')).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  it('opens run commands from .shellie.yml as new terminals', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'tasks:gitSummary': () => ({
        branch: 'x',
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        files: [],
      }),
      'terminals:open': () => ({
        id: 'n1',
        kind: 'run',
        label: 'dev',
        command: 'npm run dev',
      }),
    });
    render(<Shell />);
    await userEvent.click(await screen.findByRole('button', { name: 'dev' }));
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'terminals:open')?.args).toEqual([
        'a',
        { kind: 'run', label: 'dev', command: 'npm run dev' },
      ]),
    );
  });

  it('opens a Copilot CLI terminal from the + menu', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'tasks:gitSummary': () => ({
        branch: 'x',
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        files: [],
      }),
      'terminals:open': () => ({
        id: 'n2',
        kind: 'copilot',
        label: 'Copilot CLI',
      }),
    });
    render(<Shell />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'New terminal' }),
    );
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Copilot CLI' }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'terminals:open')?.args).toEqual([
        'a',
        { kind: 'copilot', label: 'Copilot CLI' },
      ]),
    );
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers Claude Code, a shell, Copilot CLI and OpenCode, and works from the keyboard', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'terminals:open': (_id, def) => ({ id: 'n3', ...def }),
    });
    render(<Shell />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'New terminal' }),
    );
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Claude Code',
      'Shell',
      'Copilot CLI',
      'OpenCode',
    ]);
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(items[3]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'terminals:open')?.args).toEqual([
        'a',
        { kind: 'opencode', label: 'OpenCode' },
      ]),
    );
    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'New terminal' })).toHaveFocus();
  });

  it('keeps the + button outside the scrolling tab row, so it stays in view (#215)', async () => {
    installFakeApi({ 'repos:config': () => config });
    const { container } = render(<Shell />);
    const add = await screen.findByRole('button', { name: 'New terminal' });
    expect(
      screen.getByRole('tablist', { name: 'Terminals' }),
    ).not.toContainElement(add);
    expect(container.querySelector('.taskbar')).toContainElement(add);
  });

  it('closes a terminal tab with its close button or a middle click', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'terminals:kill': () => undefined,
    });
    render(<Shell />);
    const tabs = await screen.findAllByRole('tab');
    const terminal = tabs.find(
      (t) => !/Usage|Docs|Changes/.test(t.textContent ?? ''),
    );
    const label = terminal?.textContent ?? '';
    await userEvent.click(
      screen.getByRole('button', { name: `Close ${label}` }),
    );
    expect(calls.filter((c) => c.channel === 'terminals:kill')).toHaveLength(1);
    await userEvent.pointer({ keys: '[MouseMiddle]', target: terminal! });
    expect(calls.filter((c) => c.channel === 'terminals:kill')).toHaveLength(2);
  });

  it('shows an HTML file in a tab and closes it with its close button or a middle click', async () => {
    const OUT = 'C:/Users/me/.claude/reviews/pr-759/index.html';
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'html:open': () => ({
        url: 'shellie-view://tok/index.html',
        name: 'index.html',
      }),
    });
    useStore.setState({ viewsByTask: {}, tabByTask: {} });
    render(<Shell />);
    act(() => useStore.getState().openView('a', OUT));
    const tab = await screen.findByRole('tab', { name: /index\.html/ });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).toHaveAttribute('title', OUT);
    expect(await screen.findByTitle('index.html')).toHaveAttribute(
      'src',
      'shellie-view://tok/index.html',
    );
    expect(calls.find((c) => c.channel === 'html:open')?.args).toEqual([
      'a',
      OUT,
    ]);
    expect(screen.getByTestId('term-c1')).toHaveAttribute(
      'data-active',
      'false',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Close index.html' }),
    );
    expect(screen.queryByRole('tab', { name: /index\.html/ })).toBeNull();
    expect(screen.queryByTitle('index.html')).toBeNull();
    expect(screen.getByRole('tab', { name: /Claude Code/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    act(() => useStore.getState().openView('a', 'report/b.html'));
    const again = await screen.findByRole('tab', { name: /b\.html/ });
    await userEvent.pointer({ keys: '[MouseMiddle]', target: again });
    expect(screen.queryByRole('tab', { name: /b\.html/ })).toBeNull();
  });

  it('opens the editor and the Finish page from the task row', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'tasks:gitSummary': () => ({
        branch: 'x',
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        files: [],
      }),
      'tasks:openInEditor': () => undefined,
      'editor:showFolder': () => undefined,
    });
    render(<Shell />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open folder' }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'editor:showFolder')).toBe(true),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Finish task' }));
    expect(useStore.getState().screen).toEqual({ kind: 'finish', taskId: 'a' });
  });

  it('shows a Done page with a header, a local finish time and the usage panel', async () => {
    const url =
      'https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/48213';
    const { calls } = installFakeApi({
      'shell:openExternal': () => undefined,
    });
    const finishedAt = new Date(2026, 9, 14, 12, 0).toISOString();
    useStore.setState({
      tasks: [
        {
          ...task,
          workItem: { ...task.workItem!, url },
          status: 'done',
          terminals: [],
          finishedAt,
        },
      ],
    });
    render(<Shell />);
    const main = screen.getByRole('main');
    expect(
      within(main).getByRole('heading', {
        level: 1,
        name: 'Checkout: allow saving a delivery address',
      }),
    ).toBeInTheDocument();
    expect(within(main).getByText('14 Oct 2026, 12:00')).toBeInTheDocument();
    expect(main).not.toHaveTextContent(finishedAt);
    await userEvent.click(
      within(main).getByRole('button', {
        name: 'Open User Story 48213 in Azure DevOps',
      }),
    );
    expect(calls.find((c) => c.channel === 'shell:openExternal')?.args).toEqual(
      [url],
    );
    expect(
      await screen.findByRole('region', { name: 'AI usage' }),
    ).toBeInTheDocument();
    expect(useStore.getState().activeTab('a')).toBe('usage');
  });

  it('shows an empty state without a selected task', () => {
    installFakeApi();
    useStore.setState({ tasks: [], selectedTaskId: null });
    render(<Shell />);
    expect(
      screen.getByRole('heading', { name: 'No task selected' }),
    ).toBeInTheDocument();
  });

  it('shows the other task when the selection changes', async () => {
    installFakeApi({
      'repos:config': () => config,
      'tasks:gitSummary': () => ({
        branch: 'x',
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        files: [],
      }),
    });
    const second: TaskView = {
      ...task,
      id: 'b',
      workItem: {
        id: '2',
        type: 'Bug',
        title: 'Second task',
        url: null,
        project: null,
      },
      terminals: [{ id: 'c2', kind: 'claude', label: 'Claude Code' }],
    };
    useStore.setState({ tasks: [task, second] });
    render(<Shell />);
    expect(screen.getByTestId('term-c1')).toBeInTheDocument();
    act(() => useStore.setState({ selectedTaskId: 'b' }));
    expect(
      within(screen.getByRole('banner')).getByText('Bug 2 Second task'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('term-c2')).toHaveAttribute(
      'data-active',
      'true',
    );
    // The other task's terminals stay mounted but inactive, so switching back does not replay them.
    expect(screen.getByTestId('term-c1')).toHaveAttribute(
      'data-active',
      'false',
    );
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Claude Code/ })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
  });

  it('shows the cost in the task row and opens the Usage tab from it', async () => {
    installFakeApi({
      'repos:config': () => config,
      'tasks:gitSummary': () => ({
        branch: 'x',
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        files: [],
      }),
      'usage:costs': () => ({ a: 23 }),
      'usage:task': (id) => ({
        taskId: id,
        sessions: [],
        recent: [],
        byModel: [],
        unpricedRequests: 0,
        usdToEur: 0.92,
        billable: { costUsd: 25, costEur: 23, tokens: 1 },
        byTool: {
          'claude-code': { costUsd: 25, costEur: 23, sessions: 1, tokens: 1 },
          'copilot-cli': { costUsd: 0, costEur: 0, sessions: 0, tokens: 0 },
          opencode: { costUsd: 0, costEur: 0, sessions: 0, tokens: 0 },
        },
      }),
    });
    render(<Shell />);
    await userEvent.click(
      await screen.findByRole('button', { name: /AI cost .*23\.00/ }),
    );
    expect(useStore.getState().activeTab('a')).toBe('usage');
    expect(screen.getByRole('region', { name: 'AI usage' })).toBeVisible();
  });

  it('disables Open folder when the worktree is missing and hides Finish unless ready', async () => {
    installFakeApi({
      'repos:config': () => config,
      'tasks:gitSummary': () => ({
        branch: 'x',
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        files: [],
      }),
    });
    useStore.setState({ tasks: [{ ...task, worktreeMissing: true }] });
    const { unmount } = render(<Shell />);
    expect(
      await screen.findByRole('button', { name: 'Open folder' }),
    ).toBeDisabled();
    unmount();
    useStore.setState({ tasks: [{ ...task, status: 'finishing' }] });
    render(<Shell />);
    expect(screen.queryByRole('button', { name: 'Finish task' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull();
  });

  it('shows an Open setup panel instead of the terminals for a setup-failed task', async () => {
    installFakeApi();
    useStore.setState({ tasks: [{ ...task, status: 'setup-failed' }] });
    render(<Shell />);
    expect(screen.getByText('Setup failed for this task.')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open setup' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'setup',
      taskId: 'a',
    });
  });
});

function setup(
  over: Partial<TaskView> = {},
  handlers: Parameters<typeof installFakeApi>[0] = {},
) {
  const { emit, calls } = installFakeApi({
    'repos:config': () => config,
    'tasks:gitSummary': () => ({
      branch: 'x',
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      files: [],
    }),
    ...handlers,
  });
  useStore.setState({
    tasks: [{ ...task, ...over }],
    selectedTaskId: 'a',
  });
  return { emit, calls };
}

const FOCUS_KEYS = {
  key: 'F',
  code: 'KeyF',
  shiftKey: true,
  ctrlKey: true,
  metaKey: true,
};

describe('tabs and focus', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ focus: false, navCollapsed: false, tabByTask: {} });
  });

  it('pins Usage first, before the terminals', async () => {
    setup();
    render(<Shell />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      expect.stringContaining('Usage'),
      expect.stringContaining('Docs'),
      expect.stringContaining('Changes'),
      'Claude Code',
      'zsh',
    ]);
  });

  it('switches with Mod+0 and Mod+2 even when the key comes from inside the terminal', async () => {
    setup();
    render(<Shell />);
    const term = await screen.findByTestId('term-c1');
    const ev = createEvent.keyDown(term, {
      key: '0',
      code: 'Digit0',
      ctrlKey: true,
      metaKey: true,
    });
    fireEvent(term, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(screen.getByRole('region', { name: 'AI usage' })).toBeVisible();
    fireEvent.keyDown(term, {
      key: '2',
      code: 'Digit2',
      ctrlKey: true,
      metaKey: true,
    });
    expect(screen.getByTestId('term-s1')).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  it('switches by physical key on AZERTY layouts (Mod+à is Digit0, Mod+é is Digit2)', async () => {
    setup();
    render(<Shell />);
    const term = await screen.findByTestId('term-c1');
    const ev = createEvent.keyDown(term, {
      key: '\u00e0',
      code: 'Digit0',
      ctrlKey: true,
      metaKey: true,
    });
    fireEvent(term, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(screen.getByRole('region', { name: 'AI usage' })).toBeVisible();
    fireEvent.keyDown(term, {
      key: '\u00e9',
      code: 'Digit2',
      ctrlKey: true,
      metaKey: true,
    });
    expect(screen.getByTestId('term-s1')).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  it('switches with the numpad digits', async () => {
    setup();
    render(<Shell />);
    const term = await screen.findByTestId('term-c1');
    fireEvent.keyDown(term, {
      key: '2',
      code: 'Numpad2',
      ctrlKey: true,
      metaKey: true,
    });
    expect(screen.getByTestId('term-s1')).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  it('does not treat a digit character on another physical key as a tab shortcut', async () => {
    setup();
    render(<Shell />);
    const term = await screen.findByTestId('term-c1');
    const ev = createEvent.keyDown(term, {
      key: '1',
      code: 'KeyQ',
      ctrlKey: true,
      metaKey: true,
    });
    fireEvent(term, ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('leaves other keys alone', async () => {
    setup();
    render(<Shell />);
    const term = await screen.findByTestId('term-c1');
    const ev = createEvent.keyDown(term, { key: 'c', ctrlKey: true });
    fireEvent(term, ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('keeps the same terminal node across Usage, terminals and Focus', async () => {
    setup();
    render(<Shell />);
    const before = await screen.findByTestId('term-c1');
    await userEvent.click(screen.getByRole('tab', { name: /Usage/ }));
    await userEvent.click(screen.getByRole('tab', { name: 'Claude Code' }));
    fireEvent.keyDown(window, FOCUS_KEYS);
    expect(screen.getByTestId('term-c1')).toBe(before);
  });

  it('Focus hides the header and the nav, persists, and double-click toggles it back', async () => {
    setup();
    render(<Shell />);
    expect(document.querySelector('.app.in-focus')).toBeNull();
    fireEvent.keyDown(window, FOCUS_KEYS);
    expect(screen.queryByRole('navigation', { name: 'Tasks' })).toBeNull();
    expect(document.querySelector('header.headerbar')).toBeNull();
    // The tab row stands in as the window's title bar (shell.css, #49).
    expect(document.querySelector('.app.in-focus')).not.toBeNull();
    expect(localStorage.getItem('shellie.ui.focus')).toBe('true');
    await userEvent.dblClick(
      screen.getByRole('tablist', { name: 'Terminals' }),
    );
    expect(
      screen.getByRole('navigation', { name: 'Tasks' }),
    ).toBeInTheDocument();
  });

  it('keeps the rail in Focus when the nav was collapsed', async () => {
    setup();
    useStore.setState({ navCollapsed: true });
    render(<Shell />);
    fireEvent.keyDown(window, FOCUS_KEYS);
    expect(screen.getByRole('navigation', { name: 'Tasks' })).toHaveClass(
      'is-rail',
    );
  });

  it('offers Finish task once: in the nav, in the rail, or in the tab row in Focus (#95)', async () => {
    setup();
    render(<Shell />);
    await screen.findByTestId('term-c1');
    const finish = () => screen.getAllByRole('button', { name: 'Finish task' });
    const nav = () => screen.queryByRole('navigation', { name: 'Tasks' });
    expect(finish()).toHaveLength(1);
    expect(nav()).toContainElement(finish()[0]);
    // Focus hides the nav, so the tab row takes Finish, as a primary button.
    fireEvent.keyDown(window, FOCUS_KEYS);
    expect(nav()).toBeNull();
    expect(finish()).toHaveLength(1);
    expect(finish()[0]).toHaveClass('btn-primary');
    expect(
      within(
        screen
          .getByRole('tablist', { name: 'Terminals' })
          .closest<HTMLElement>('.taskbar')!,
      ).getByRole('button', { name: 'Finish task' }),
    ).toBe(finish()[0]);
    // Focus with the rail: the rail has it.
    act(() => useStore.setState({ navCollapsed: true }));
    expect(finish()).toHaveLength(1);
    expect(nav()).toContainElement(finish()[0]);
    await userEvent.click(finish()[0]);
    expect(useStore.getState().screen).toEqual({ kind: 'finish', taskId: 'a' });
  });

  it('shows a new-usage dot on the Usage tab until it is selected', async () => {
    const { emit } = setup();
    render(<Shell />);
    await screen.findByTestId('term-c1');
    act(() => emit('usage:changed', { taskId: 'a' }));
    expect(
      screen.getByRole('tab', { name: /Usage, new usage/ }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /Usage/ }));
    expect(screen.getByRole('tab', { name: 'Usage' })).toBeInTheDocument();
  });

  it('shows a changed dot on the Docs tab while another tab is active', async () => {
    const { emit } = setup();
    render(<Shell />);
    await screen.findByTestId('term-c1');
    act(() =>
      emit('docs:changed', { taskId: 'a', paths: ['src/app.ts', 'docs'] }),
    );
    expect(screen.queryByRole('tab', { name: 'Docs, changed' })).toBeNull();
    act(() => emit('docs:changed', { taskId: 'a', paths: ['README.md'] }));
    expect(
      screen.getByRole('tab', { name: 'Docs, changed' }),
    ).toBeInTheDocument();
  });

  it("lights the Docs dot for a change in another repo's worktree", async () => {
    const { emit } = setup({ extraWorkspaces: [extra] });
    render(<Shell />);
    await screen.findByTestId('term-c1');
    act(() => emit('docs:changed', { taskId: 'b#w1', paths: ['README.md'] }));
    expect(screen.queryByRole('tab', { name: 'Docs, changed' })).toBeNull();
    act(() => emit('docs:changed', { taskId: 'a#w1', paths: ['README.md'] }));
    expect(
      screen.getByRole('tab', { name: 'Docs, changed' }),
    ).toBeInTheDocument();
  });

  it('does not light the Docs dot for Markdown in build output folders', async () => {
    const { emit } = setup();
    render(<Shell />);
    await screen.findByTestId('term-c1');
    act(() =>
      emit('docs:changed', {
        taskId: 'a',
        paths: [
          'dist/a.md',
          'build/b.md',
          'out/c.md',
          'node_modules/d/README.md',
        ],
      }),
    );
    expect(screen.queryByRole('tab', { name: 'Docs, changed' })).toBeNull();
    act(() => emit('docs:changed', { taskId: 'a', paths: ['docs/dist.md'] }));
    expect(
      screen.getByRole('tab', { name: 'Docs, changed' }),
    ).toBeInTheDocument();
  });

  it('does not send docs:watch off when its on failed', async () => {
    const { calls } = setup(
      {},
      {
        'docs:watch': () => {
          throw new Error('nope');
        },
      },
    );
    const view = render(<Shell />);
    await screen.findByTestId('term-c1');
    await act(async () => {});
    view.unmount();
    await act(async () => {});
    expect(
      calls.filter((c) => c.channel === 'docs:watch').map((c) => c.args[1]),
    ).toEqual([true]);
  });

  it('does not send docs:watch off after main stopped the watcher', async () => {
    const { calls, emit } = setup();
    const view = render(<Shell />);
    await screen.findByTestId('term-c1');
    await act(async () => {});
    act(() => emit('docs:watchStopped', { taskId: 'a' }));
    view.unmount();
    await act(async () => {});
    expect(
      calls.filter((c) => c.channel === 'docs:watch').map((c) => c.args[1]),
    ).toEqual([true]);
  });

  it('opens the Docs tab with Mod+Shift+D', async () => {
    setup();
    render(<Shell />);
    const term = await screen.findByTestId('term-c1');
    const ev = createEvent.keyDown(term, {
      key: 'D',
      code: 'KeyD',
      shiftKey: true,
      ctrlKey: true,
      metaKey: true,
    });
    fireEvent(term, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(useStore.getState().activeTab('a')).toBe('docs');
  });

  it('shows a Brain tab with the wiki when the task has a brain', async () => {
    const { calls } = setup(
      {},
      {
        'brain:forTask': () => listedBrain(),
      },
    );
    render(<Shell />);
    const tab = await screen.findByRole('tab', { name: /Brain/ });
    expect(tab).toHaveAttribute('title', expect.stringContaining('Shift+B'));
    await userEvent.click(tab);
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls).toContainEqual({
        channel: 'brain:pages',
        args: ['b1'],
      }),
    );
    // The body lives in the page area, not among the tab buttons.
    expect(
      within(screen.getByRole('tablist')).queryByText('Open brain'),
    ).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open brain' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'brain',
      brainId: 'b1',
    });
  });

  it('the Brain tab lists the pages for the task and all pages, searches, and adds dropped files', async () => {
    const { calls } = setup(
      {},
      {
        'brain:forTask': () => listedBrain(),
        'brain:pages': () => [
          {
            path: 'wiki/scope.md',
            title: 'Scope of work',
            summary: 'What we build.',
            type: 'other',
            lastUpdated: null,
            confidence: null,
            verified: null,
            changedSinceVerified: false,
            sources: [],
            linkedFrom: [],
          },
          {
            path: 'wiki/account.md',
            title: 'Account',
            summary: 'Who Acme is.',
            type: 'other',
            lastUpdated: null,
            confidence: null,
            verified: null,
            changedSinceVerified: false,
            sources: [],
            linkedFrom: [],
          },
        ],
        'brain:relevant': () => ['wiki/scope.md'],
        'brain:search': () => [
          {
            path: 'wiki/account.md',
            kind: 'page',
            title: 'Account',
            line: 3,
            text: 'Acme is the customer.',
            anchor: null,
          },
        ],
        'brain:read': () => ({ text: '# Account\n\nAcme is the customer.' }),
        'brain:addFiles': () => [
          {
            ok: true,
            path: 'sources/x.md',
            images: 0,
            warnings: [],
            contents: '',
          },
        ],
      },
    );
    render(<Shell />);
    await userEvent.click(await screen.findByRole('tab', { name: /^Brain$/ }));
    const forTask = await screen.findByRole('region', {
      name: 'For this task',
    });
    expect(
      within(forTask).getByRole('button', { name: /Scope of work/ }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.channel === 'brain:relevant')).toBe(true);
    expect(
      screen.getByRole('region', { name: 'Other pages' }),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search the brain'), 'acme');
    await userEvent.click(
      await screen.findByRole('button', { name: /Account/ }),
    );
    expect(
      await screen.findByText('Acme is the customer.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(
      await screen.findByLabelText('Search the brain'),
    ).toBeInTheDocument();
    const file = Object.assign(new File(['x'], 'notes.vtt'), {
      path: '/dl/notes.vtt',
    });
    fireEvent.drop(screen.getByLabelText(/Acme brain, drop files/), {
      dataTransfer: { files: [file] },
    });
    await userEvent.type(
      await screen.findByLabelText('Note for notes.vtt'),
      'Weekly call',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add 1 file' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        channel: 'brain:addFiles',
        args: [
          'b1',
          [{ path: '/dl/notes.vtt', type: 'transcript', note: 'Weekly call' }],
        ],
      }),
    );
  });

  it('has no Brain tab without a brain', async () => {
    const { calls } = setup();
    render(<Shell />);
    await screen.findByTestId('term-c1');
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'brain:forTask')).toBe(true),
    );
    expect(screen.queryByRole('tab', { name: /Brain/ })).toBeNull();
  });

  it('opens the Brain tab with Mod+Shift+B only when there is a brain', async () => {
    setup({}, { 'brain:forTask': () => listedBrain() });
    render(<Shell />);
    const term = await screen.findByTestId('term-c1');
    const ev = createEvent.keyDown(term, {
      key: 'B',
      code: 'KeyB',
      shiftKey: true,
      ctrlKey: true,
      metaKey: true,
    });
    fireEvent(term, ev);
    expect(ev.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(useStore.getState().activeTab('a')).toBe('brain'),
    );
  });

  it('the Brain terminal entry opens the brain terminal and selects its tab', async () => {
    const { calls } = setup(
      {},
      {
        'brain:forTask': () => listedBrain(),
        'brain:terminal': () => ({ id: 'bt1', kind: 'claude', label: 'Brain' }),
      },
    );
    render(<Shell />);
    await screen.findByRole('tab', { name: /Brain/ });
    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /Brain terminal/ }),
    );
    expect(calls).toContainEqual({ channel: 'brain:terminal', args: ['b1'] });
    expect(calls.some((c) => c.channel === 'terminals:open')).toBe(false);
    const tab = await screen.findByRole('tab', { name: 'Acme brain' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('term-bt1')).toHaveAttribute(
      'data-task',
      'brain:b1',
    );
    expect(screen.getByTestId('term-bt1')).toHaveAttribute(
      'data-active',
      'true',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Close Acme brain' }),
    );
    expect(screen.queryByRole('tab', { name: 'Acme brain' })).toBeNull();
  });

  it('opens the brain terminal once when the brain asks for it on start', async () => {
    brainTerminalOpenedOnStart.clear();
    const brain = listedBrain();
    brain.options.openBrainTerminalOnStart = true;
    const { calls } = setup(
      {},
      {
        'brain:forTask': () => brain,
        'brain:terminal': () => ({ id: 'bt1', kind: 'claude', label: 'Brain' }),
      },
    );
    const { unmount } = render(<Shell />);
    expect(
      await screen.findByRole('tab', { name: 'Acme brain' }),
    ).toHaveAttribute('aria-selected', 'false');
    expect(calls).toContainEqual({ channel: 'brain:terminal', args: ['b1'] });
    unmount();
    // Again in this app session: not opened a second time.
    render(<Shell />);
    await screen.findByRole('tab', { name: /^Brain$/ });
    expect(calls.filter((c) => c.channel === 'brain:terminal')).toHaveLength(1);
    expect(screen.queryByRole('tab', { name: 'Acme brain' })).toBeNull();
  });

  it('does not open the brain terminal on start when the option is off', async () => {
    brainTerminalOpenedOnStart.clear();
    const { calls } = setup({}, { 'brain:forTask': () => listedBrain() });
    render(<Shell />);
    await screen.findByRole('tab', { name: /^Brain$/ });
    expect(calls.some((c) => c.channel === 'brain:terminal')).toBe(false);
  });

  it('keeps the Brain tab when a refetch fails, drops it when the answer is null', async () => {
    let answer: () => unknown = () => listedBrain();
    const { emit } = setup({}, { 'brain:forTask': () => answer() as never });
    render(<Shell />);
    await userEvent.click(await screen.findByRole('tab', { name: /Brain/ }));
    expect(useStore.getState().activeTab('a')).toBe('brain');
    answer = () => {
      throw new Error('boom');
    };
    act(() => emit('brain:changed', { brainId: 'b1' } as never));
    await new Promise((r) => setTimeout(r, 350));
    expect(screen.getByRole('tab', { name: /Brain/ })).toBeInTheDocument();
    answer = () => null;
    act(() => emit('brain:changed', { brainId: 'b1' } as never));
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: /Brain/ })).toBeNull(),
    );
    expect(screen.getByRole('tab', { name: /Claude Code/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('hides the Brain tab and falls back when the worktree is missing', async () => {
    setup({ worktreeMissing: true }, { 'brain:forTask': () => listedBrain() });
    useStore.setState({ tabByTask: { a: 'brain' } });
    render(<Shell />);
    await screen.findByTestId('term-c1');
    expect(screen.queryByRole('tab', { name: /Brain/ })).toBeNull();
    expect(useStore.getState().activeTab('a')).toBe('brain');
    expect(screen.getByRole('tab', { name: /Claude Code/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('closing the brain terminal tab only detaches it, and the menu brings it back', async () => {
    const { calls } = setup(
      {},
      {
        'brain:forTask': () => listedBrain(),
        'brain:terminal': () => ({ id: 'bt1', kind: 'claude', label: 'Brain' }),
      },
    );
    render(<Shell />);
    await screen.findByRole('tab', { name: /Brain/ });
    const openIt = async () => {
      await userEvent.click(
        screen.getByRole('button', { name: 'New terminal' }),
      );
      await userEvent.click(
        await screen.findByRole('menuitem', { name: /Brain terminal/ }),
      );
    };
    await openIt();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Close Acme brain' }),
    );
    expect(calls.some((c) => c.channel === 'terminals:kill')).toBe(false);
    expect(screen.queryByRole('tab', { name: 'Acme brain' })).toBeNull();
    expect(screen.getByRole('tab', { name: /Claude Code/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await openIt();
    expect(calls.filter((c) => c.channel === 'brain:terminal')).toHaveLength(2);
    expect(
      await screen.findByRole('tab', { name: 'Acme brain' }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  it('falls back to Usage when a task has no terminals', async () => {
    setup({ terminals: [] });
    render(<Shell />);
    expect(
      await screen.findByRole('region', { name: 'AI usage' }),
    ).toBeVisible();
  });

  it('shows the header and nav with Focus on and no task selected', () => {
    setup();
    useStore.setState({ tasks: [], selectedTaskId: null, focus: true });
    render(<Shell />);
    expect(document.querySelector('header.headerbar')).not.toBeNull();
    expect(
      screen.getByRole('navigation', { name: 'Tasks' }),
    ).toBeInTheDocument();
  });

  it.each(['done', 'setup-failed'] as const)(
    'shows the header with Focus on and a %s task',
    (status) => {
      setup({ status, terminals: [] });
      useStore.setState({ focus: true });
      render(<Shell />);
      expect(document.querySelector('header.headerbar')).not.toBeNull();
      expect(
        screen.getByRole('navigation', { name: 'Tasks' }),
      ).toBeInTheDocument();
    },
  );

  it('keeps the tab row out of Focus chrome for a finishing task', async () => {
    setup({ status: 'finishing' });
    useStore.setState({ focus: true });
    render(<Shell />);
    const tabs = await screen.findByRole('tablist', { name: 'Terminals' });
    expect(document.querySelector('header.headerbar')).not.toBeNull();
    expect(tabs.querySelector('.tabrow-brand')).toBeNull();
    const row = tabs.closest<HTMLElement>('.taskbar')!;
    expect(
      within(row).queryByRole('button', { name: 'Exit focus' }),
    ).toBeNull();
    // Focus does nothing for a task that is not ready, so no button offers it.
    expect(within(row).queryByRole('button', { name: 'Focus' })).toBeNull();
  });

  it('does not show the Changes panel of a finishing task', async () => {
    const { calls } = setup({ status: 'finishing' });
    useStore.setState({ tabByTask: { a: CHANGES_TAB } });
    render(<Shell />);
    await screen.findByRole('tablist', { name: 'Terminals' });
    expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull();
    expect(calls.some((c) => c.channel === 'review:files')).toBe(false);
  });

  it('shows the Focus chrome in the tab row for a ready task', async () => {
    setup();
    useStore.setState({ focus: true });
    render(<Shell />);
    const tabs = await screen.findByRole('tablist', { name: 'Terminals' });
    expect(tabs.querySelector('.tabrow-brand')).not.toBeNull();
    expect(
      within(tabs.closest<HTMLElement>('.taskbar')!).getByRole('button', {
        name: 'Exit focus',
      }),
    ).toBeVisible();
  });

  it('toggles Focus with the shortcut when no task is selected', () => {
    setup();
    useStore.setState({ tasks: [], selectedTaskId: null });
    render(<Shell />);
    fireEvent.keyDown(window, FOCUS_KEYS);
    expect(useStore.getState().focus).toBe(true);
    fireEvent.keyDown(window, FOCUS_KEYS);
    expect(useStore.getState().focus).toBe(false);
  });

  it('keeps the terminals mounted while another page is open, so they do not replay', async () => {
    setup();
    render(<Shell />);
    await screen.findByRole('tablist', { name: 'Terminals' });
    mounts.count = 0;
    for (const page of [
      { kind: 'settings' },
      { kind: 'new-task' },
      { kind: 'finish', taskId: 'a' },
      { kind: 'sprint' },
    ] as const) {
      act(() => useStore.getState().go(page));
      expect(screen.getByTestId('term-c1')).toHaveAttribute(
        'data-active',
        'false',
      );
      expect(screen.queryByRole('tablist', { name: 'Terminals' })).toBeNull();
      act(() => useStore.getState().go({ kind: 'task' }));
      expect(screen.getByTestId('term-c1')).toHaveAttribute(
        'data-active',
        'true',
      );
    }
    expect(mounts.count).toBe(0);
  });
});

describe('TaskScreen workspaces', () => {
  const api2 = {
    id: 'r2',
    name: 'api',
    path: '/src/api',
    baseBranch: 'main',
    connectionId: null,
    configFound: false,
    discovered: false,
    overrides: {},
    workItemOnStart: {
      moveToInProgress: true,
      assignToMe: true,
      stateOverrides: {},
    },
  };
  const two = () =>
    useStore.setState({
      repos: [...useStore.getState().repos, api2],
      tasks: [{ ...task, extraWorkspaces: [extra] }],
    });
  const handlers = {
    'repos:config': () => config,
    'tasks:gitSummary': () => ({
      branch: 'x',
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      files: [],
    }),
  };

  it('shows no repos chip for a single-repo task', () => {
    installFakeApi(handlers);
    render(<Shell />);
    expect(screen.queryByRole('button', { name: 'Repos of this task' })).toBe(
      null,
    );
  });

  it('shows one chip for all repos, with a menu per repo, home first', async () => {
    two();
    const { calls } = installFakeApi({
      ...handlers,
      'tasks:openInEditor': () => undefined,
      'tasks:removeWorkspace': () => undefined,
      'terminals:open': (_t, def) => ({ id: 'n1', ...def }),
    });
    render(<Shell />);
    const chip = screen.getByRole('button', { name: 'Repos of this task' });
    expect(chip).toHaveTextContent('2 repos');
    expect(
      [...chip.querySelectorAll('.repo-mark')].map((m) =>
        m.getAttribute('data-color'),
      ),
    ).toEqual(['1', '2']);

    const menu = async () => {
      await userEvent.click(chip);
      return screen.getByRole('menu', { name: 'Repos of this task' });
    };
    const repo = (name: string) =>
      within(
        within(
          screen.getByRole('menu', { name: 'Repos of this task' }),
        ).getByRole('group', { name }),
      );
    expect(
      within(await menu())
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-label')),
    ).toEqual(['webshop', 'api']);
    const web = repo('webshop');
    expect(web.queryByRole('menuitem', { name: 'Remove from task' })).toBe(
      null,
    );
    await userEvent.click(
      web.getByRole('menuitem', { name: 'Open in editor' }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'tasks:openInEditor')?.args,
      ).toEqual(['a', 'home']),
    );

    await menu();
    await userEvent.click(
      repo('api').getByRole('menuitem', { name: 'New shell here' }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'terminals:open')?.args).toEqual([
        'a',
        { kind: 'shell', label: 'shell', workspaceId: 'w1' },
      ]),
    );
    await menu();
    await userEvent.click(
      repo('api').getByRole('menuitem', { name: 'Remove from task' }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'tasks:removeWorkspace')?.args,
      ).toEqual(['a', 'w1']),
    );
  });

  it('shows ahead, behind and changes per repo in the repos menu', async () => {
    two();
    installFakeApi({
      ...handlers,
      'tasks:gitSummary': (_t, workspaceId) => ({
        branch: 'x',
        ahead: workspaceId === 'w1' ? 3 : 0,
        behind: workspaceId === 'w1' ? 1 : 0,
        hasUpstream: true,
        files: workspaceId === 'w1' ? [{ status: 'M', path: 'a' }] : [],
      }),
    });
    render(<Shell />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Repos of this task' }),
    );
    const head = (name: string) =>
      within(screen.getByRole('menu', { name: 'Repos of this task' }))
        .getByRole('group', { name })
        .querySelector('.ws-menu-head');
    const up = String.fromCharCode(0x2191);
    const down = String.fromCharCode(0x2193);
    const dot = String.fromCharCode(0x2022);
    await waitFor(() =>
      expect(head('api')).toHaveTextContent(`api${up}3 ${down}1 ${dot}1`),
    );
    expect(head('webshop')).toHaveTextContent(`webshop${up}0 ${down}0 ${dot}0`);
  });

  it("shows each repo's run commands, grouped by repo, and runs them there", async () => {
    // The config cache outlives a test; these repos' configs differ from the other tests'.
    invalidateRepoConfig();
    two();
    const { calls } = installFakeApi({
      ...handlers,
      'repos:config': (repoId) =>
        repoId === 'r2'
          ? {
              ...config,
              config: { ...config.config, run: { serve: 'npm run serve' } },
            }
          : config,
      'terminals:open': (_t, def) => ({ id: 'n1', ...def }),
    });
    render(<Shell />);
    expect(await screen.findByText('Run api')).toBeInTheDocument();
    expect(screen.getByText('Run webshop')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Run serve in api' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Run dev in webshop' }),
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.channel === 'terminals:open').map((c) => c.args),
      ).toEqual([
        [
          'a',
          {
            kind: 'run',
            label: 'serve',
            command: 'npm run serve',
            workspaceId: 'w1',
          },
        ],
        [
          'a',
          {
            kind: 'run',
            label: 'dev',
            command: 'npm run dev',
            workspaceId: 'home',
          },
        ],
      ]),
    );
  });

  it("after the home was dropped, the run commands are the remaining repo's", async () => {
    // The config cache outlives a test; these repos' configs differ from the other tests'.
    invalidateRepoConfig();
    useStore.setState({
      repos: [...useStore.getState().repos, api2],
      tasks: [{ ...task, homeDropped: true, extraWorkspaces: [extra] }],
    });
    const { calls } = installFakeApi({
      ...handlers,
      'repos:config': (repoId) =>
        repoId === 'r2'
          ? {
              ...config,
              config: { ...config.config, run: { serve: 'npm run serve' } },
            }
          : config,
      'terminals:open': (_t, def) => ({ id: 'n1', ...def }),
    });
    render(<Shell />);
    await userEvent.click(await screen.findByRole('button', { name: 'serve' }));
    expect(screen.queryByRole('button', { name: 'dev' })).toBeNull();
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'terminals:open')?.args).toEqual([
        'a',
        { kind: 'run', label: 'serve', command: 'npm run serve' },
      ]),
    );
  });

  it('scans on mount and every 2 minutes while focused and ready', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const { calls } = installFakeApi(handlers);
      render(<Shell />);
      const scans = () =>
        calls.filter((c) => c.channel === 'tasks:scanWorkspaces').length;
      expect(scans()).toBe(1);
      act(() => vi.advanceTimersByTime(120000));
      expect(scans()).toBe(2);
      focus.mockReturnValue(false);
      act(() => vi.advanceTimersByTime(240000));
      expect(scans()).toBe(2);
      focus.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not scan a task that is not ready', () => {
    useStore.setState({ tasks: [{ ...task, status: 'done' }] });
    const { calls } = installFakeApi(handlers);
    render(<Shell />);
    expect(calls.some((c) => c.channel === 'tasks:scanWorkspaces')).toBe(false);
  });

  it('scans and adds a worktree from the task menu', async () => {
    const { calls } = installFakeApi({
      ...handlers,
      'repos:pickFolder': () => '/src/api.worktrees/x',
      'tasks:addWorkspace': () => extra as never,
    });
    render(<Shell />);
    await userEvent.click(screen.getByRole('button', { name: 'Task menu' }));
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Scan for other repos' }),
    );
    await waitFor(() =>
      expect(useStore.getState().notices.map((n) => n.message)).toContain(
        'No other repos found for this task',
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Task menu' }));
    await userEvent.click(
      screen.getByRole('menuitem', { name: /Add a worktree/ }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'tasks:addWorkspace')?.args,
      ).toEqual(['a', '/src/api.worktrees/x']),
    );
  });

  it('notifies when adding a worktree fails', async () => {
    installFakeApi({
      ...handlers,
      'repos:pickFolder': () => '/tmp/x',
      'tasks:addWorkspace': () => {
        throw new Error('Not inside a git worktree');
      },
    });
    render(<Shell />);
    await userEvent.click(screen.getByRole('button', { name: 'Task menu' }));
    await userEvent.click(
      screen.getByRole('menuitem', { name: /Add a worktree/ }),
    );
    await waitFor(() =>
      expect(useStore.getState().notices.map((n) => n.message)).toContain(
        'Not inside a git worktree',
      ),
    );
  });

  it('warns about changes in another repo main checkout', () => {
    useStore.setState({
      tasks: [
        {
          ...task,
          mainCheckoutEdits: [{ repoPath: '/src/api', branch: 'develop' }],
        },
      ],
    });
    installFakeApi(handlers);
    render(<Shell />);
    expect(
      screen.getByText("Changes made in api's main checkout (branch develop)"),
    ).toBeInTheDocument();
  });
});

describe('running tasks', () => {
  it('mounts a task terminals the first time it is shown, then keeps them', async () => {
    setup();
    const other: TaskView = {
      ...task,
      id: 'b',
      terminals: [{ id: 'b1', kind: 'shell', label: 'zsh' }],
    };
    useStore.setState({
      tasks: [{ ...task }, other],
      selectedTaskId: 'a',
      screen: { kind: 'task' },
    } as never);
    render(<Shell />);
    await screen.findByTestId('term-c1');
    expect(screen.queryByTestId('term-b1')).toBeNull();
    act(() => useStore.setState({ selectedTaskId: 'b' }));
    await screen.findByTestId('term-b1');
    const before = mounts.count;
    act(() => useStore.setState({ selectedTaskId: 'a' }));
    act(() => useStore.setState({ selectedTaskId: 'b' }));
    // Both stayed mounted: switching back mounts no terminal again.
    expect(screen.getByTestId('term-c1')).toBeInTheDocument();
    expect(mounts.count).toBe(before);
  });
});
