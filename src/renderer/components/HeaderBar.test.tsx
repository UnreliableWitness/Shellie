import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { GitSummary, TaskView } from '../../shared/types';
import { useStore } from '../store';
import { emptyUsage, installFakeApi } from '../test-helpers/fakeApi';
import { HeaderBar } from './HeaderBar';

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
const git: GitSummary = {
  branch: 'feature/48213-save-delivery-address',
  ahead: 2,
  behind: 0,
  hasUpstream: true,
  files: [{ status: 'M', path: 'a' }],
};
const usage = {
  ...emptyUsage('a'),
  billable: { costUsd: 10, costEur: 9.2, tokens: 100 },
  byTool: {
    'claude-code': { costUsd: 9, costEur: 8.28, sessions: 1, tokens: 90 },
    'copilot-cli': { costUsd: 1, costEur: 0.92, sessions: 1, tokens: 10 },
    opencode: { costUsd: 0, costEur: 0, sessions: 0, tokens: 0 },
  },
};

async function openCard() {
  await userEvent.tab(); // Shellie
  await userEvent.tab(); // project
  await userEvent.tab(); // task crumb
  return screen.findByRole('dialog', { name: 'Task details' });
}

const crumbs = () =>
  within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
    .getAllByRole('button')
    .map((b) => b.textContent);

beforeEach(() => {
  useStore.setState({
    screen: { kind: 'task' },
    previous: null,
    tasks: [task],
    selectedTaskId: 'a',
    connectionId: null,
    repos: [
      {
        id: 'r1',
        name: 'webshop',
        path: '/r',
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
    connections: [
      {
        id: 'c1',
        name: 'unreliablewitness',
        organizationUrl: 'https://dev.azure.com/unreliablewitness',
        project: 'DXP',
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
      },
    ],
  });
});

describe('HeaderBar', () => {
  it('shows Shellie, the project and the task as breadcrumb links', async () => {
    const { tracked } = installFakeApi();
    render(<HeaderBar />);
    expect(crumbs()).toEqual([
      'Shellie',
      'DXP',
      'User Story 48213 Checkout: allow saving a delivery address',
    ]);
    expect(
      screen.getByRole('button', { name: /User Story 48213/ }),
    ).toHaveAttribute('aria-current', 'page');
    await userEvent.click(screen.getByRole('button', { name: 'DXP' }));
    expect(useStore.getState().screen).toEqual({ kind: 'project' });
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'project.open',
      props: { from: 'crumb' },
    });
  });
  it('names the task environment after the task, coloured for UAT and Production', () => {
    installFakeApi();
    useStore.setState({
      tasks: [{ ...task, environment: 'production' }],
    });
    const { rerender } = render(<HeaderBar />);
    expect(crumbs().at(-1)).toBe('Production');
    expect(screen.getByText('Production')).toHaveClass(
      'crumb-env',
      'crumb-env-production',
    );
    useStore.setState({ tasks: [{ ...task, environment: 'development' }] });
    rerender(<HeaderBar />);
    expect(crumbs()).not.toContain('Development');
  });
  it('names the page for Sprint, Settings, Setup, Finish and New task', () => {
    installFakeApi();
    const { rerender } = render(<HeaderBar />);
    const at = (
      screen: Parameters<ReturnType<typeof useStore.getState>['go']>[0],
    ) => {
      useStore.setState({ screen });
      rerender(<HeaderBar />);
      return crumbs();
    };
    expect(at({ kind: 'sprint' })).toEqual(['Shellie', 'DXP', 'Sprint']);
    expect(at({ kind: 'project' })).toEqual(['Shellie', 'DXP', 'Project']);
    expect(at({ kind: 'settings' })).toEqual(['Shellie', 'Settings']);
    expect(at({ kind: 'new-task' })).toEqual(['Shellie', 'DXP', 'New task']);
    expect(at({ kind: 'setup', taskId: 'a' })).toEqual([
      'Shellie',
      'DXP',
      'User Story 48213 Checkout: allow saving a delivery address',
      'Setup',
    ]);
    expect(at({ kind: 'finish', taskId: 'a' }).at(-1)).toBe('Finish');
  });
  it('names the Brain page of the first-run steps', () => {
    installFakeApi();
    useStore.setState({ screen: { kind: 'brain-new', from: 'get-started' } });
    render(<HeaderBar />);
    expect(crumbs().at(-1)).toBe('Brain');
  });
  it('leaves out the project without a connection', () => {
    installFakeApi();
    useStore.setState({ connections: [], screen: { kind: 'sprint' } });
    render(<HeaderBar />);
    expect(crumbs()).toEqual(['Shellie', 'Sprint']);
  });
  it('goes to Home from the Shellie crumb', async () => {
    installFakeApi();
    useStore.setState({ screen: { kind: 'settings' } });
    render(<HeaderBar />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Shellie, go to Home' }),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'home' });
  });
  it('has Settings, and New task no longer (it moved to the nav, #95)', async () => {
    installFakeApi();
    render(<HeaderBar />);
    expect(screen.queryByRole('button', { name: 'New task' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useStore.getState().screen).toEqual({ kind: 'settings' });
  });
  it('opens the detail card on task crumb focus and closes it with Escape', async () => {
    installFakeApi({ 'tasks:gitSummary': () => git });
    render(<HeaderBar />);
    const card = await openCard();
    expect(card).toHaveTextContent('User Story 48213');
    expect(card).toHaveTextContent(
      '/src/webshop.worktrees/48213-save-delivery-address',
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Task details' })).toBeNull();
    // The card took the Escape; the page did not navigate.
    expect(useStore.getState().screen).toEqual({ kind: 'task' });
  });
  it('closes the card when focus tabs past its last control', async () => {
    installFakeApi({ 'tasks:gitSummary': () => git });
    useStore.setState({
      tasks: [
        {
          ...task,
          workItem: { ...task.workItem!, url: 'https://example.test/48213' },
        },
      ],
    });
    render(<HeaderBar />);
    await openCard();
    await userEvent.tab(); // ADO link inside the card
    expect(screen.getByRole('dialog', { name: 'Task details' })).toBeTruthy();
    await userEvent.tab(); // out of the card
    expect(screen.queryByRole('dialog', { name: 'Task details' })).toBeNull();
  });
  it('shows the git summary, changed files and clean state in the card', async () => {
    installFakeApi({
      'tasks:gitSummary': () => ({
        ...git,
        files: [
          { status: 'M', path: 'a' },
          { status: 'M', path: 'b' },
          { status: '?', path: 'c' },
        ],
      }),
    });
    render(<HeaderBar />);
    const card = await openCard();
    await waitFor(() =>
      expect(card).toHaveTextContent(
        `${String.fromCharCode(0x2191)}2 ${String.fromCharCode(0x2193)}0`,
      ),
    );
    expect(card).toHaveTextContent('3 changed');
  });
  it('opens the work item in Azure DevOps from the card', async () => {
    const url =
      'https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/48213';
    const { calls } = installFakeApi({
      'tasks:gitSummary': () => git,
      'shell:openExternal': () => undefined,
    });
    useStore.setState({
      tasks: [{ ...task, workItem: { ...task.workItem!, url } }],
    });
    render(<HeaderBar />);
    await openCard();
    await userEvent.click(
      screen.getByRole('button', {
        name: /Open User Story 48213 in Azure DevOps/,
      }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'shell:openExternal')?.args,
      ).toEqual([url]),
    );
  });
  it('shows a plain badge for work items without a url', async () => {
    installFakeApi({ 'tasks:gitSummary': () => git });
    render(<HeaderBar />);
    const card = await openCard();
    expect(
      screen.queryByRole('button', { name: /in Azure DevOps/ }),
    ).not.toBeInTheDocument();
    expect(within(card).getByText('User Story 48213')).toBeInTheDocument();
  });
  it('shows the Claude and Copilot split in the card', async () => {
    installFakeApi({
      'usage:task': () => usage,
      'tasks:gitSummary': () => git,
    });
    useStore.setState({
      tasks: [task],
    });
    render(<HeaderBar />);
    const card = await openCard();
    await waitFor(() => expect(card).toHaveTextContent(/Claude .8\.28/));
    expect(card).toHaveTextContent(/Copilot .0\.92/);
    expect(card).not.toHaveTextContent(/OpenCode/);
  });
  it('adds OpenCode to the split when it has a cost', async () => {
    installFakeApi({
      'usage:task': () => ({
        ...usage,
        byTool: {
          ...usage.byTool,
          opencode: { costUsd: 2, costEur: 1.84, sessions: 1, tokens: 5 },
        },
      }),
      'tasks:gitSummary': () => git,
    });
    render(<HeaderBar />);
    const card = await openCard();
    await waitFor(() => expect(card).toHaveTextContent(/OpenCode .1\.84/));
  });
});

describe('HeaderBar workspaces', () => {
  it('lists each repo and branch in the task details', async () => {
    installFakeApi({
      'tasks:gitSummary': () => git,
      'usage:task': () => usage,
    });
    useStore.setState({
      repos: [
        ...useStore.getState().repos,
        {
          ...useStore.getState().repos[0],
          id: 'r2',
          name: 'api',
        },
      ],
      tasks: [
        {
          ...task,
          extraWorkspaces: [
            {
              id: 'w1',
              repoId: 'r2',
              branch: 'feature/api-side',
              worktreePath: '/api.wt',
              baseRef: 'origin/main',
              baseSha: null,
              source: 'detected',
              summary: null,
              pullRequest: null,
              reopen: null,
              dropped: false,
            } as never,
          ],
        },
      ],
    });
    render(<HeaderBar />);
    const card = await openCard();
    expect(within(card).getByText('webshop')).toBeInTheDocument();
    expect(
      within(card).getByText('feature/48213-save-delivery-address'),
    ).toBeInTheDocument();
    expect(within(card).getByText('api')).toBeInTheDocument();
    expect(within(card).getByText('feature/api-side')).toBeInTheDocument();
  });

  it("shows the remaining repo's branch and folder once the home was dropped", async () => {
    installFakeApi({
      'tasks:gitSummary': () => git,
      'usage:task': () => usage,
    });
    useStore.setState({
      tasks: [
        {
          ...task,
          homeDropped: true,
          extraWorkspaces: [
            {
              id: 'w1',
              repoId: 'r2',
              branch: 'feature/api-side',
              worktreePath: '/api.wt',
              baseRef: 'origin/main',
              baseSha: null,
              source: 'detected',
              summary: null,
              pullRequest: null,
              reopen: null,
              dropped: false,
            } as never,
          ],
        },
      ],
    });
    render(<HeaderBar />);
    const card = await openCard();
    expect(within(card).getByText('feature/api-side')).toBeInTheDocument();
    expect(within(card).getByText('/api.wt')).toBeInTheDocument();
    expect(within(card).queryByText(task.worktreePath)).toBeNull();
  });
});
