import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskSummary, TaskView } from '../../shared/types';
import { useStore } from '../store';
import { emptyTime, emptyUsage, installFakeApi } from '../test-helpers/fakeApi';
import { DoneTaskPage } from './DoneTaskPage';

const created = new Date(2026, 9, 13, 9, 0);
const finished = new Date(2026, 9, 15, 12, 1);
const task: TaskView = {
  id: 'a',
  repoId: 'r1',
  name: '',
  workItem: {
    id: '1',
    type: 'Issue',
    title: 'Checkout: allow saving a delivery address',
    url: 'https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/1',
    project: null,
  },
  slug: 'a',
  branch: 'feature/1-checkout-allow-saving-a-delivery-address',
  worktreePath: '/w/a',
  baseRef: 'origin/main',
  baseSha: null,
  openPeriods: [],
  time: null,
  status: 'done',
  setup: {
    copy: false,
    commands: [],
    startClaude: false,
    openShell: false,
    openCopilot: false,
    summary: null,
  },
  terminals: [],
  createdAt: created.toISOString(),
  finishedAt: finished.toISOString(),
  usageSyncedAt: new Date(2026, 9, 15, 12, 2).toISOString(),
  usageSyncError: null,
  usageCommentId: 77,
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
const summary: TaskSummary = {
  commits: [
    { sha: 'a1b2c3d', subject: 'Store the address on the profile' },
    { sha: 'e4f5a6b', subject: 'Show saved addresses at checkout' },
  ],
  commitCount: 3,
  filesChanged: 12,
  insertions: 340,
  deletions: 95,
  pushed: true,
  upstream: 'origin/feature/1-checkout-allow-saving-a-delivery-address',
  baseKnown: true,
};
const usage = {
  ...emptyUsage('a'),
  billable: { costUsd: 2, costEur: 1.84, tokens: 1000 },
  byTool: {
    'claude-code': { costUsd: 1.5, costEur: 1.38, sessions: 1, tokens: 800 },
    'copilot-cli': { costUsd: 0.5, costEur: 0.46, sessions: 1, tokens: 200 },
    opencode: { costUsd: 0, costEur: 0, sessions: 0, tokens: 0 },
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
    tasks: [task],
    connections: [],
    notices: [],
  }),
);

const fact = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;

describe('DoneTaskPage', () => {
  it('names the environment the task finished on, unless Development', () => {
    installFakeApi({ 'usage:task': () => usage });
    const { rerender } = render(
      <DoneTaskPage task={{ ...task, finishedEnvironment: 'uat' }} />,
    );
    expect(fact('Environment')).toHaveTextContent('UAT');
    rerender(
      <DoneTaskPage task={{ ...task, finishedEnvironment: 'development' }} />,
    );
    expect(screen.queryByText('Environment', { selector: 'dt' })).toBeNull();
  });

  it('adds OpenCode to the AI cost split when it has a cost', async () => {
    installFakeApi({
      'usage:task': () => ({
        ...usage,
        billable: { costUsd: 3, costEur: 2.76, tokens: 1100 },
        byTool: {
          ...usage.byTool,
          opencode: { costUsd: 1, costEur: 0.92, sessions: 1, tokens: 100 },
        },
      }),
    });
    render(<DoneTaskPage task={task} />);
    await waitFor(() =>
      expect(fact('AI cost')).toHaveTextContent(
        '€2.76 (Claude €1.38, Copilot €0.46, OpenCode €0.92)',
      ),
    );
  });

  it('shows what was done and how: facts, commits, live state', async () => {
    const { calls } = installFakeApi({
      'usage:task': () => usage,
      'workItems:get': () => ({
        id: '1',
        type: 'Issue',
        title: 'Checkout: allow saving a delivery address',
        state: 'Doing',
        areaPath: 'Shellie',
        iterationPath: 'Shellie\\Sprint 1',
        assignedTo: null,
        url: task.workItem!.url!,
        project: null,
        originalEstimate: null,
        remainingWork: null,
        completedWork: null,
      }),
    });
    render(<DoneTaskPage task={{ ...task, summary }} />);
    expect(fact('Duration')).toHaveTextContent('2 d 3 h');
    expect(fact('Finished')).toHaveTextContent('15 Oct 2026, 12:01');
    expect(fact('Branch')).toHaveTextContent(
      'feature/1-checkout-allow-saving-a-delivery-address pushed to origin',
    );
    expect(fact('Changes')).toHaveTextContent(
      `12 files, +340 ${String.fromCharCode(0x2212)}95`,
    );
    await waitFor(() =>
      expect(fact('AI cost')).toHaveTextContent(
        '€1.84 (Claude €1.38, Copilot €0.46)',
      ),
    );
    const commits = screen.getByRole('region', { name: 'Commits' });
    expect(
      within(commits)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'a1b2c3dStore the address on the profile',
      'e4f5a6bShow saved addresses at checkout',
    ]);
    expect(within(commits).getByText('and 1 more')).toBeInTheDocument();
    expect(await screen.findByLabelText('State Doing')).toBeInTheDocument();
    expect(calls.find((c) => c.channel === 'workItems:get')?.args).toEqual([
      'c1',
      '1',
    ]);
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(
      screen.queryByText('Finished before Shellie recorded summaries.'),
    ).toBeNull();
  });

  it('without a summary, says so instead of the commit and change facts', async () => {
    installFakeApi({ 'workItems:get': () => null });
    render(<DoneTaskPage task={task} />);
    expect(
      screen.getByText('Finished before Shellie recorded summaries.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Changes', { selector: 'dt' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Commits' })).toBeNull();
    expect(fact('Branch')).toHaveTextContent(task.branch);
    expect(
      await screen.findByRole('region', { name: 'AI usage' }),
    ).toBeInTheDocument();
  });

  it('hides the live state when Azure DevOps cannot be asked', async () => {
    const { calls } = installFakeApi({
      'workItems:get': () => {
        throw new Error('offline');
      },
    });
    render(<DoneTaskPage task={{ ...task, summary }} />);
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'workItems:get')).toBe(true),
    );
    expect(screen.queryByLabelText(/^State /)).toBeNull();
  });

  it('Reopen goes to the task when the worktree was kept, and to Setup when it is made again', async () => {
    let setup = false;
    const { calls } = installFakeApi({
      'workItems:get': () => null,
      'tasks:reopen': () => ({ setup }),
    });
    useStore.setState({ tasks: [task], screen: { kind: 'task' } });
    const { unmount } = render(<DoneTaskPage task={task} />);
    await userEvent.click(screen.getByRole('button', { name: /Reopen/ }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'task' }),
    );
    expect(calls.find((c) => c.channel === 'tasks:reopen')?.args).toEqual([
      task.id,
    ]);
    unmount();
    setup = true;
    render(<DoneTaskPage task={task} />);
    await userEvent.click(screen.getByRole('button', { name: /Reopen/ }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({
        kind: 'setup',
        taskId: task.id,
      }),
    );
    expect(useStore.getState().selectedTaskId).toBe(task.id);
  });

  it('shows why Reopen failed and stays on the Done page', async () => {
    installFakeApi({
      'workItems:get': () => null,
      'tasks:reopen': () => {
        throw new Error('Branch x cannot be restored');
      },
    });
    useStore.setState({ screen: { kind: 'task' } });
    render(<DoneTaskPage task={task} />);
    await userEvent.click(screen.getByRole('button', { name: /Reopen/ }));
    await waitFor(() =>
      expect(
        useStore
          .getState()
          .notices.some((n) => n.message === 'Branch x cannot be restored'),
      ).toBe(true),
    );
    expect(screen.getByRole('button', { name: /Reopen/ })).toBeEnabled();
  });

  it('shows a worktree still being removed as a quiet status with Retry now, not an error (#115)', async () => {
    const { calls } = installFakeApi({
      'workItems:get': () => null,
      'tasks:retryCleanup': () => false,
    });
    render(
      <DoneTaskPage
        task={{
          ...task,
          pendingCleanup: [
            {
              workspaceId: 'home',
              repoPath: '/r',
              worktreePath: '/w/a',
              branch: task.branch,
              since: finished.toISOString(),
              attempts: 3,
              error: 'Could not delete /w/a: EPERM, unlink',
              code: 'EPERM',
              notified: false,
            },
          ],
        }}
      />,
    );
    const status = screen.getByRole('status', { name: 'Cleanup' });
    expect(status).toHaveTextContent(
      'Removing the worktree folder: a process still holds files in it',
    );
    expect(status).toHaveTextContent('/w/a');
    expect(status).toHaveTextContent(/Resource Monitor/);
    await userEvent.click(
      within(status).getByRole('button', { name: 'Retry now' }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'tasks:retryCleanup')?.args,
      ).toEqual([task.id]),
    );
    expect(
      useStore.getState().notices.some((n) => n.message.includes('EPERM')),
    ).toBe(false);
  });

  it('shows no cleanup status when everything was removed', () => {
    installFakeApi({ 'workItems:get': () => null });
    render(<DoneTaskPage task={task} />);
    expect(screen.queryByRole('status', { name: 'Cleanup' })).toBeNull();
  });

  it('marks a local branch and a task without a work item', () => {
    installFakeApi();
    render(
      <DoneTaskPage
        task={{
          ...task,
          workItem: null,
          name: 'spike',
          summary: { ...summary, pushed: false, upstream: null },
        }}
      />,
    );
    expect(fact('Branch')).toHaveTextContent('local only');
  });

  it('says commits are unavailable when the branch start was not found', () => {
    installFakeApi();
    render(
      <DoneTaskPage
        task={{
          ...task,
          summary: {
            ...summary,
            baseKnown: false,
            commits: [],
            commitCount: 0,
            filesChanged: 0,
            insertions: 0,
            deletions: 0,
          },
        }}
      />,
    );
    const commits = screen.getByRole('region', { name: 'Commits' });
    expect(commits).toHaveTextContent(
      'Commits unavailable: Shellie could not find where this branch started.',
    );
    expect(commits).not.toHaveTextContent('No commits on this branch.');
    expect(screen.queryByText('Changes', { selector: 'dt' })).toBeNull();
    expect(fact('Branch')).toHaveTextContent('pushed to origin');
  });

  it('a task with a recorded base but no summary does not claim to be old', () => {
    installFakeApi();
    render(<DoneTaskPage task={{ ...task, baseSha: 'abc123' }} />);
    expect(
      screen.queryByText('Finished before Shellie recorded summaries.'),
    ).toBeNull();
    expect(
      screen.getByText(
        'No summary: git could not read the branch when it finished.',
      ),
    ).toBeInTheDocument();
  });

  describe('pull request', () => {
    const pr = {
      id: 7,
      url: 'https://dev.azure.com/contoso/P/_git/R/pullrequest/7',
      repositoryId: 'rid',
      project: 'P',
      repo: 'R',
      status: 'active' as const,
      isDraft: true,
    };
    it('shows the PR, opens it, and updates with the live status', async () => {
      const { calls } = installFakeApi({
        'usage:task': () => usage,
        'tasks:prStatus': () => ({
          ...pr,
          status: 'completed' as const,
          isDraft: false,
        }),
      });
      render(<DoneTaskPage task={{ ...task, pullRequest: pr }} />);
      expect(fact('Pull request')).toHaveTextContent('PR 7 · Draft');
      await waitFor(() =>
        expect(fact('Pull request')).toHaveTextContent('PR 7 · Completed'),
      );
      await userEvent.click(within(fact('Pull request')).getByRole('button'));
      expect(
        calls.find((c) => c.channel === 'shell:openExternal')?.args,
      ).toEqual([pr.url]);
      expect(calls.filter((c) => c.channel === 'tasks:prStatus')).toHaveLength(
        1,
      );
    });
    it('has no PR fact without a pull request', () => {
      installFakeApi({ 'usage:task': () => usage });
      render(<DoneTaskPage task={task} />);
      expect(screen.queryByText('Pull request', { selector: 'dt' })).toBeNull();
    });
  });

  it('shows the booked time and retries a failed write', async () => {
    const booking = {
      bookedSeconds: 14400,
      measuredSeconds: 11400,
      realisticSeconds: 12000,
      wallClockSeconds: 20000,
      agentSeconds: { 'claude-code': 0, 'copilot-cli': 0, opencode: 0 },
      bookedAt: '2026-10-15T12:00:00Z',
      writtenHours: 0,
      syncError: 'boom',
    };
    const { calls } = installFakeApi({
      'usage:task': () => usage,
      'time:task': (id) => ({ ...emptyTime(id), booking }),
      'time:sync': () => undefined,
    });
    render(<DoneTaskPage task={task} />);
    await waitFor(() =>
      expect(fact('Time booked')).toHaveTextContent(
        'booked 4h (measured 3h 10m)',
      ),
    );
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(calls.find((c) => c.channel === 'time:sync')?.args).toEqual(['a']);
  });
  it('says Not booked for a task without a booking', async () => {
    installFakeApi({ 'usage:task': () => usage });
    render(<DoneTaskPage task={task} />);
    await waitFor(() =>
      expect(fact('Time booked')).toHaveTextContent('Not booked'),
    );
  });
  describe('several repos', () => {
    const pr = {
      id: 9,
      url: 'https://dev.azure.com/contoso/P/_git/api/pullrequest/9',
      repositoryId: 'rid2',
      project: 'P',
      repo: 'api',
      status: 'active' as const,
      isDraft: true,
    };
    const multi: TaskView = {
      ...task,
      summary,
      extraWorkspaces: [
        {
          id: 'w2',
          repoId: 'r2',
          branch: 'feature/api',
          worktreePath: '/w/api',
          baseRef: 'origin/main',
          baseSha: 'abc',
          source: 'detected',
          summary: {
            ...summary,
            commits: [{ sha: '9999999', subject: 'API change' }],
            commitCount: 1,
            filesChanged: 2,
          },
          pullRequest: pr,
          reopen: null,
          dropped: false,
        },
        {
          id: 'w3',
          repoId: 'r3',
          branch: 'feature/docs',
          worktreePath: '/w/docs',
          baseRef: 'origin/main',
          baseSha: 'abc',
          source: 'detected',
          summary: null,
          pullRequest: null,
          reopen: null,
          dropped: true,
        },
      ],
    };
    it('shows a section per repo, a note for the removed one, and the PR status per workspace', async () => {
      useStore.setState({
        repos: [
          ...useStore.getState().repos,
          { ...useStore.getState().repos[0], id: 'r2', name: 'api' },
        ],
      });
      const { calls } = installFakeApi({
        'usage:task': () => usage,
        'tasks:prStatus': () => ({
          ...pr,
          status: 'completed' as const,
          isDraft: false,
        }),
      });
      render(<DoneTaskPage task={multi} />);
      expect(
        screen.getByRole('region', { name: 'webshop' }),
      ).toBeInTheDocument();
      const api = screen.getByRole('region', { name: 'api' });
      expect(within(api).getByText('API change')).toBeInTheDocument();
      expect(within(api).getByText('feature/api')).toBeInTheDocument();
      await waitFor(() =>
        expect(
          within(api).getByRole('button', { name: /pull request 9/ }),
        ).toHaveTextContent('PR 9 · Completed'),
      );
      expect(calls.find((c) => c.channel === 'tasks:prStatus')?.args).toEqual([
        'a',
        'w2',
      ]);
      expect(screen.getByText('docs: no changes, removed')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'docs' })).toBeNull();
      expect(screen.getAllByText('Duration')).toHaveLength(1);
      expect(screen.getAllByText('AI cost')).toHaveLength(1);
    });
  });
});
