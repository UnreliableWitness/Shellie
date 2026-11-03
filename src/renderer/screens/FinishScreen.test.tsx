import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  FinishRowResult,
  TaskView,
  WorkspaceCheck,
} from '../../shared/types';
import { readPrChoice, readPushChoice, writePrChoice } from '../uiPrefs';
import { CHANGES_TAB, useStore } from '../store';
import { listedBrain } from '../test-helpers/brainFixture';
import { emptyTime, emptyUsage, installFakeApi } from '../test-helpers/fakeApi';
import { clearPrDrafts, FinishScreen } from './FinishScreen';

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
  worktreePath: '/w/a',
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
const dirty = {
  uncommitted: [
    { status: 'M', path: 'src/a.ts' },
    { status: '?', path: 'src/b.ts' },
  ],
  unpushed: 2,
  runningTerminals: 2,
  workspaces: [],
};
const clean = {
  uncommitted: [],
  unpushed: 0,
  runningTerminals: 0,
  workspaces: [],
};

beforeEach(() => {
  localStorage.clear();
  clearPrDrafts();
  useStore.setState({
    repos: [],
    tasks: [task],
    connections: [],
    notices: [],
    screen: { kind: 'finish', taskId: 'a' },
    selectedTaskId: 'a',
  });
});

describe('FinishScreen', () => {
  it('shows the safety checks and the cleanup options', async () => {
    installFakeApi({ 'tasks:finishChecks': () => dirty });
    render(<FinishScreen taskId="a" />);
    expect(
      await screen.findByText('2 uncommitted changes'),
    ).toBeInTheDocument();
    expect(screen.getByText(/M src\/a\.ts/)).toBeInTheDocument();
    expect(screen.getByText('2 commits not pushed')).toBeInTheDocument();
    expect(screen.getByText('2 terminals still running')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Close 2 terminals (Claude Code, zsh)'),
    ).toBeChecked();
    expect(screen.getByLabelText('Remove worktree folder')).toBeChecked();
    expect(screen.getByLabelText(/Delete local branch/)).toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Discard changes and clean up' }),
    ).toBeInTheDocument();
  });

  it('shows green checks and a plain finish button when clean', async () => {
    installFakeApi({ 'tasks:finishChecks': () => clean });
    render(<FinishScreen taskId="a" />);
    expect(
      await screen.findByText('No uncommitted changes'),
    ).toBeInTheDocument();
    expect(screen.getByText('Nothing to push')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    ).toBeInTheDocument();
  });

  it('finishes with the chosen options and shows the Done page', async () => {
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => undefined,
    });
    render(<FinishScreen taskId="a" />);
    await userEvent.click(await screen.findByLabelText(/Delete local branch/));
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'tasks:finish')?.args).toEqual([
        'a',
        {
          closeTerminals: true,
          removeWorktree: true,
          deleteBranch: false,
          createPullRequest: false,
          bookedSeconds: 0,
        },
      ]),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'task' });
    expect(useStore.getState().selectedTaskId).toBe('a');
  });

  it('sends captureTaskMd when the brain option is ticked', async () => {
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => undefined,
      'brain:forTask': () => listedBrain(),
    });
    render(<FinishScreen taskId="a" />);
    await userEvent.click(
      await screen.findByLabelText('Capture task.md into the brain'),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual({
        channel: 'tasks:finish',
        args: ['a', expect.objectContaining({ captureTaskMd: true })],
      }),
    );
  });

  it('leaves captureTaskMd out by default', async () => {
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => undefined,
      'brain:forTask': () => listedBrain(),
    });
    render(<FinishScreen taskId="a" />);
    expect(
      await screen.findByLabelText('Capture task.md into the brain'),
    ).not.toBeChecked();
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'tasks:finish')).toBe(true),
    );
    expect(
      JSON.stringify(calls.find((c) => c.channel === 'tasks:finish')?.args),
    ).not.toContain('captureTaskMd');
  });

  it('hides the brain option when the task has no brain', async () => {
    installFakeApi({ 'tasks:finishChecks': () => clean });
    render(<FinishScreen taskId="a" />);
    await screen.findByLabelText(/Delete local branch/);
    expect(screen.queryByLabelText(/into the brain/)).toBeNull();
  });

  it('does not move the user to the Done page when they left the Finish page while it ran', async () => {
    let resolve: () => void = () => {};
    installFakeApi({
      'tasks:finishChecks': () => clean,
      'tasks:finish': () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    });
    useStore.setState({
      screen: { kind: 'finish', taskId: 'a' },
      previous: { kind: 'sprint' },
    });
    render(<FinishScreen taskId="a" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Finish and clean up' }),
    );
    await userEvent.keyboard('{Escape}');
    useStore.getState().go({ kind: 'new-task' });
    resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().screen).toEqual({ kind: 'new-task' });
  });

  it('opens commit and push in a terminal tab', async () => {
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => dirty,
      'terminals:open': () => ({
        id: 'g1',
        kind: 'run',
        label: 'git commit',
        command: 'x',
      }),
    });
    render(<FinishScreen taskId="a" />);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Commit' + String.fromCharCode(0x2026),
      }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'terminals:open')?.args).toEqual([
        'a',
        {
          kind: 'run',
          label: 'git commit',
          command: 'git add -A && git commit',
        },
      ]),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'task' });
    expect(useStore.getState().selectedTaskId).toBe('a');
  });

  it('stays open and shows the error when finishing fails', async () => {
    installFakeApi({
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => {
        throw new Error('git worktree remove failed: locked');
      },
    });
    render(<FinishScreen taskId="a" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Finish and clean up' }),
    );
    await waitFor(() =>
      expect(useStore.getState().notices[0]?.message).toMatch(/locked/),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'finish', taskId: 'a' });
  });

  it('lets you clean up without checks when inspecting fails', async () => {
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => {
        throw new Error('worktree gone');
      },
      'tasks:finish': () => undefined,
    });
    render(<FinishScreen taskId="a" />);
    expect(
      await screen.findByText(
        /Could not inspect the worktree: .*worktree gone/,
      ),
    ).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Clean up without checks' });
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'tasks:finish')).toBe(true),
    );
  });

  it('does not fetch checks for a task that is not ready', async () => {
    useStore.setState({ tasks: [{ ...task, status: 'setup-failed' }] });
    const { calls } = installFakeApi({ 'tasks:finishChecks': () => clean });
    render(<FinishScreen taskId="a" />);
    expect(
      screen.getByText(
        /This task is setup-failed\. Finish it once setup has succeeded/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Keep task' }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.channel === 'tasks:finishChecks')).toBe(false);
  });

  it('lists uncommitted files in a scrollable block', async () => {
    installFakeApi({
      'tasks:finishChecks': () => ({
        ...dirty,
        uncommitted: [
          { status: 'M', path: 'src/a.ts' },
          { status: 'M', path: 'src/b.ts' },
          { status: 'M', path: 'src/c.ts' },
        ],
      }),
    });
    render(<FinishScreen taskId="a" />);
    const el = await screen.findByText(/M src\/a\.ts/);
    expect(el).toHaveClass('files');
    expect(el.textContent).toContain('src/b.ts');
    expect(el.textContent).toContain('src/c.ts');
  });

  it('says that removing the folder closes the terminals anyway', async () => {
    installFakeApi({ 'tasks:finishChecks': () => clean });
    render(<FinishScreen taskId="a" />);
    const close = await screen.findByLabelText(
      'Close 2 terminals (Claude Code, zsh)',
    );
    const hint = /Removing the worktree folder closes its terminals too/;
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
    await userEvent.click(close);
    expect(screen.getByText(hint)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Remove worktree folder'));
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
  });

  it('disables the terminal checkbox when there are no terminals', async () => {
    useStore.setState({ tasks: [{ ...task, terminals: [] }] });
    installFakeApi({ 'tasks:finishChecks': () => clean });
    render(<FinishScreen taskId="a" />);
    const box = await screen.findByLabelText('Close 0 terminals');
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
  });
});

describe('FinishScreen AI usage', () => {
  it('shows the total and offers no write to the work item', async () => {
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => undefined,
      'usage:task': (id) => ({
        ...emptyUsage(id),
        sessions: [{ sessionId: 's' } as never],
        billable: { costUsd: 10, costEur: 9.2, tokens: 5 },
        byTool: {
          'claude-code': { costUsd: 10, costEur: 9.2, sessions: 2, tokens: 5 },
          'copilot-cli': { costUsd: 0, costEur: 0, sessions: 0, tokens: 0 },
          opencode: { costUsd: 0, costEur: 0, sessions: 0, tokens: 0 },
        },
      }),
    });
    render(<FinishScreen taskId={task.id} />);
    expect(
      await screen.findByText(/Claude Code .9\.20 over 2 sessions/),
    ).toBeTruthy();
    expect(
      screen.queryByRole('checkbox', { name: /Write final totals/ }),
    ).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Finish/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'tasks:finish')).toBe(true),
    );
    expect(
      calls.find((c) => c.channel === 'tasks:finish')?.args[1],
    ).not.toHaveProperty('syncUsage');
  });
});

describe('FinishScreen AI usage per tool', () => {
  it('lists OpenCode with the other tools, so the parts add up', async () => {
    installFakeApi({
      'tasks:finishChecks': () => clean,
      'usage:task': (id) => ({
        ...emptyUsage(id),
        sessions: [{ sessionId: 's' } as never],
        billable: { costUsd: 12, costEur: 11.04, tokens: 7 },
        byTool: {
          'claude-code': { costUsd: 10, costEur: 9.2, sessions: 2, tokens: 5 },
          'copilot-cli': { costUsd: 0, costEur: 0, sessions: 0, tokens: 0 },
          opencode: { costUsd: 2, costEur: 1.84, sessions: 1, tokens: 2 },
        },
      }),
    });
    render(<FinishScreen taskId={task.id} />);
    expect(
      await screen.findByText(/^OpenCode .1\.84 over 1 session$/),
    ).toBeTruthy();
    expect(screen.queryByText(/Copilot CLI/)).toBeNull();
  });
});

describe('FinishScreen pull request', () => {
  const available = {
    'tasks:prAvailability': () => ({
      available: true,
      reason: null,
      target: 'main',
    }),
  };
  const label = 'Create a draft pull request into main';
  const finishArgs = (calls: { channel: string; args: unknown[] }[]) =>
    calls.filter((c) => c.channel === 'tasks:finish').map((c) => c.args[1]);

  it('starts unchecked on first use; ticking it sends true and remembers it', async () => {
    const { calls } = installFakeApi({
      ...available,
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => undefined,
    });
    render(<FinishScreen taskId="a" />);
    const box = await screen.findByLabelText(label);
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(localStorage.length).toBe(0);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Finish and clean up' }),
    );
    await waitFor(() =>
      expect(finishArgs(calls)[0]).toMatchObject({ createPullRequest: true }),
    );
    expect(readPrChoice('r1')).toBe(true);
  });

  it('starts checked when the last choice for the repo was yes', async () => {
    writePrChoice('r1', true);
    installFakeApi({ ...available, 'tasks:finishChecks': () => clean });
    render(<FinishScreen taskId="a" />);
    await waitFor(() => expect(screen.getByLabelText(label)).toBeChecked());
  });

  it('is disabled and unchecked with the reason when unavailable, and saves nothing', async () => {
    writePrChoice('r1', true);
    const { calls } = installFakeApi({
      'tasks:prAvailability': () => ({
        available: false,
        reason: 'origin is not an Azure Repos URL',
        target: null,
      }),
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => undefined,
    });
    render(<FinishScreen taskId="a" />);
    const box = await screen.findByLabelText(/^Create a draft pull request/);
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(
      await screen.findByText('origin is not an Azure Repos URL'),
    ).toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Finish and clean up' }),
    );
    await waitFor(() =>
      expect(finishArgs(calls)[0]).toMatchObject({ createPullRequest: false }),
    );
    expect(readPrChoice('r1')).toBe(true);
  });

  it('hides the unpushed warning only while the box is checked', async () => {
    installFakeApi({
      ...available,
      'tasks:finishChecks': () => ({ ...clean, unpushed: 2 }),
    });
    render(<FinishScreen taskId="a" />);
    const box = await screen.findByLabelText(label);
    expect(await screen.findByText('2 commits not pushed')).toBeInTheDocument();
    await userEvent.click(box);
    expect(screen.queryByText('2 commits not pushed')).toBeNull();
    await userEvent.click(box);
    expect(screen.getByText('2 commits not pushed')).toBeInTheDocument();
  });

  it('shows the failure with Retry and Finish without PR, staying on the page', async () => {
    const message =
      'Pull request not created: The token cannot create pull requests (needs Code: Read & write)';
    let n = 0;
    const { calls } = installFakeApi({
      ...available,
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => {
        if (n++ < 2) throw new Error(message);
        return undefined;
      },
    });
    render(<FinishScreen taskId="a" />);
    await userEvent.click(await screen.findByLabelText(label));
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(useStore.getState().screen).toEqual({ kind: 'finish', taskId: 'a' });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(2));
    expect(finishArgs(calls)[1]).toEqual(finishArgs(calls)[0]);
    await screen.findByText(message);
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish without PR' }),
    );
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(3));
    expect(finishArgs(calls)[2]).toMatchObject({ createPullRequest: false });
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'task' }),
    );
  });
});

describe('FinishScreen push refused for a stored secret', () => {
  const finishArgs = (calls: { channel: string; args: unknown[] }[]) =>
    calls.filter((c) => c.channel === 'tasks:finish').map((c) => c.args[1]);

  it('asks to push anyway and retries with confirmLeak only when ticked', async () => {
    let n = 0;
    const { calls } = installFakeApi({
      'tasks:prAvailability': () => ({
        available: true,
        reason: null,
        target: 'main',
      }),
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => {
        if (n++ < 2)
          throw new Error(
            "Pull request not created: A stored secret appears in this branch's changes; not pushed",
          );
        return undefined;
      },
    });
    render(<FinishScreen taskId="a" />);
    await userEvent.click(
      await screen.findByLabelText('Create a draft pull request into main'),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    const confirm = await screen.findByLabelText(
      "A stored secret appears in this branch's changes. Push anyway?",
    );
    expect(finishArgs(calls)[0]).not.toHaveProperty('confirmLeak');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(2));
    expect(finishArgs(calls)[1]).not.toHaveProperty('confirmLeak');
    await userEvent.click(
      await screen.findByLabelText(
        "A stored secret appears in this branch's changes. Push anyway?",
      ),
    );
    expect(confirm).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(3));
    expect(finishArgs(calls)[2]).toMatchObject({ confirmLeak: true });
  });
});

describe('FinishScreen push refused for an unchecked branch', () => {
  it('asks to push anyway when Shellie could not check the branch', async () => {
    let n = 0;
    const { calls } = installFakeApi({
      'tasks:prAvailability': () => ({
        available: true,
        reason: null,
        target: 'main',
      }),
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => {
        if (n++ < 1)
          throw new Error(
            'Pull request not created: Shellie could not check this branch for stored secrets; not pushed',
          );
        return undefined;
      },
    });
    render(<FinishScreen taskId="a" />);
    await userEvent.click(
      await screen.findByLabelText('Create a draft pull request into main'),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    await userEvent.click(
      await screen.findByLabelText(
        'Shellie could not check this branch for stored secrets. Push anyway?',
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.channel === 'tasks:finish')[1]?.args[1],
      ).toMatchObject({ confirmLeak: true }),
    );
  });
});

describe('FinishScreen pull request description', () => {
  const available = {
    'tasks:prAvailability': () => ({
      available: true,
      reason: null,
      target: 'main',
    }),
  };
  const finishArgs = (calls: { channel: string; args: unknown[] }[]) =>
    calls.filter((c) => c.channel === 'tasks:finish').map((c) => c.args[1]);

  it('writes the description once the PR is ticked, lets the user edit it and sends it', async () => {
    const { calls } = installFakeApi({
      ...available,
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => undefined,
      'tasks:prSummary': () => ({
        text: '## What changed\n- Dates',
        error: null,
      }),
    });
    render(<FinishScreen taskId="a" />);
    // Not asked for while no PR is wanted.
    expect(screen.queryByLabelText('Pull request description')).toBeNull();
    await userEvent.click(
      await screen.findByLabelText('Create a draft pull request into main'),
    );
    const box = await screen.findByLabelText('Pull request description');
    await waitFor(() => expect(box).toHaveValue('## What changed\n- Dates'));
    expect(
      calls.filter((c) => c.channel === 'tasks:prSummary').map((c) => c.args),
    ).toEqual([['a', 'home']]);
    await userEvent.type(box, '\n- Edited');
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(1));
    expect(finishArgs(calls)[0]).toMatchObject({
      createPullRequest: true,
      prSummaries: { home: '## What changed\n- Dates\n- Edited' },
    });
  });

  it('holds Finish while Claude Code writes, and Skip lets the user go on without it', async () => {
    writePrChoice('r1', true);
    const { calls } = installFakeApi({
      ...available,
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => undefined,
      'tasks:prSummary': () => new Promise(() => {}),
    });
    render(<FinishScreen taskId="a" />);
    expect(
      await screen.findByText(/Claude Code is writing it/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));
    const finish = screen.getByRole('button', { name: 'Finish and clean up' });
    await waitFor(() => expect(finish).toBeEnabled());
    await userEvent.click(finish);
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(1));
    expect(finishArgs(calls)[0]).not.toHaveProperty('prSummaries');
  });

  it('says why it could not write one and offers to try again', async () => {
    writePrChoice('r1', true);
    let n = 0;
    const { calls } = installFakeApi({
      ...available,
      'tasks:finishChecks': () => clean,
      'tasks:prSummary': () =>
        n++ === 0
          ? { text: null, error: 'Claude Code (claude) was not found' }
          : { text: 'Second try', error: null },
    });
    render(<FinishScreen taskId="a" />);
    expect(
      await screen.findByText(/Claude Code \(claude\) was not found/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Write again' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Pull request description')).toHaveValue(
        'Second try',
      ),
    );
    expect(calls.filter((c) => c.channel === 'tasks:prSummary')).toHaveLength(
      2,
    );
  });
});

describe('FinishScreen push that cannot sign in', () => {
  const connection = {
    id: 'c1',
    name: 'o',
    organizationUrl: 'https://dev.azure.com/o',
    project: 'p',
    user: null,
    status: 'ok' as const,
    checkedAt: null,
    userUniqueName: null,
    provider: 'azure-devops' as const,
    workItemOnStart: {
      moveToInProgress: true,
      assignToMe: true,
      stateOverrides: {},
    },
  };

  it('says to update the token and opens Settings at the connection', async () => {
    useStore.setState({
      repos: [
        {
          id: task.repoId,
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
      connections: [connection],
    });
    installFakeApi({
      'tasks:prAvailability': () => ({
        available: true,
        reason: null,
        target: 'main',
      }),
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => {
        throw new Error(
          "Pull request not created: fatal: could not read Password for 'https://o@dev.azure.com/o/p/_git/r': terminal prompts disabled",
        );
      },
    });
    render(<FinishScreen taskId="a" />);
    await userEvent.click(
      await screen.findByLabelText('Create a draft pull request into main'),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    expect(
      await screen.findByText(
        'Git could not sign in to dev.azure.com with your Azure DevOps token. Update the token, then Retry.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Update token' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      section: 'conn-c1',
    });
  });

  it('shows no sign-in advice for other push failures', async () => {
    installFakeApi({
      'tasks:prAvailability': () => ({
        available: true,
        reason: null,
        target: 'main',
      }),
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => {
        throw new Error('Pull request not created: ! [rejected] (fetch first)');
      },
    });
    render(<FinishScreen taskId="a" />);
    await userEvent.click(
      await screen.findByLabelText('Create a draft pull request into main'),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    await screen.findByText(/rejected/);
    expect(screen.queryByText(/Git could not sign in/)).toBeNull();
  });
});

describe('FinishScreen pull request failure with unpushed commits', () => {
  const available = {
    'tasks:prAvailability': () => ({
      available: true,
      reason: null,
      target: 'main',
    }),
  };
  const label = 'Create a draft pull request into main';
  const message =
    'Pull request not created: git push failed: could not read from remote';
  const finishArgs = (calls: { channel: string; args: unknown[] }[]) =>
    calls.filter((c) => c.channel === 'tasks:finish').map((c) => c.args[1]);
  const checkCalls = (calls: { channel: string }[]) =>
    calls.filter((c) => c.channel === 'tasks:finishChecks').length;

  it('Finish without PR does not delete unpushed commits until the user confirms the discard', async () => {
    let n = 0;
    const { calls } = installFakeApi({
      ...available,
      'tasks:finishChecks': () => ({ ...clean, unpushed: 3 }),
      'tasks:finish': () => {
        if (n++ === 0) throw new Error(message);
        return undefined;
      },
    });
    render(<FinishScreen taskId="a" />);
    await userEvent.click(await screen.findByLabelText(label));
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    expect(await screen.findByText(message)).toBeInTheDocument();
    // The failure re-runs the checks: a push that went through changes the count.
    await waitFor(() => expect(checkCalls(calls)).toBe(2));
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish without PR' }),
    );
    expect(finishArgs(calls)).toHaveLength(1);
    expect(screen.getByText('3 commits not pushed')).toBeInTheDocument();
    expect(screen.getByLabelText(label)).not.toBeChecked();
    expect(screen.queryByText(message)).toBeNull();
    const danger = screen.getByRole('button', {
      name: 'Discard changes and clean up',
    });
    expect(danger).toHaveClass('btn-danger');
    await userEvent.click(danger);
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(2));
    expect(finishArgs(calls)[1]).toMatchObject({
      createPullRequest: false,
      deleteBranch: true,
    });
  });

  it('Finish without PR finishes directly when the push went through', async () => {
    let checks = 0;
    let n = 0;
    const { calls } = installFakeApi({
      ...available,
      'tasks:finishChecks': () => ({ ...clean, unpushed: checks++ ? 0 : 3 }),
      'tasks:finish': () => {
        if (n++ === 0)
          throw new Error(
            'Pull request not created: Azure DevOps is unreachable',
          );
        return undefined;
      },
    });
    render(<FinishScreen taskId="a" />);
    await userEvent.click(await screen.findByLabelText(label));
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    await screen.findByText(/Azure DevOps is unreachable/);
    await waitFor(() => expect(checkCalls(calls)).toBe(2));
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish without PR' }),
    );
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(2));
    expect(finishArgs(calls)[1]).toMatchObject({ createPullRequest: false });
  });

  it('unticking the box clears the stale error, so Retry cannot run a plain finish', async () => {
    const { calls } = installFakeApi({
      ...available,
      'tasks:finishChecks': () => ({ ...clean, unpushed: 3 }),
      'tasks:finish': () => {
        throw new Error(message);
      },
    });
    render(<FinishScreen taskId="a" />);
    const box = await screen.findByLabelText(label);
    await userEvent.click(box);
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    await screen.findByText(message);
    await waitFor(() => expect(checkCalls(calls)).toBe(2));
    await userEvent.click(box);
    expect(screen.queryByText(message)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Discard changes and clean up' }),
    ).toHaveClass('btn-danger');
    expect(finishArgs(calls)).toHaveLength(1);
  });

  it('keeps Finish disabled until pull request availability has loaded', async () => {
    writePrChoice('r1', true);
    let resolve: (v: {
      available: boolean;
      reason: string | null;
      target: string | null;
    }) => void = () => {};
    const { calls } = installFakeApi({
      'tasks:prAvailability': () =>
        new Promise((r) => {
          resolve = r;
        }),
      'tasks:finishChecks': () => clean,
      'tasks:finish': () => undefined,
    });
    render(<FinishScreen taskId="a" />);
    const btn = await screen.findByRole('button', {
      name: 'Finish and clean up',
    });
    await screen.findByText('Nothing to push');
    expect(btn).toBeDisabled();
    resolve({ available: true, reason: null, target: 'main' });
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    await waitFor(() =>
      expect(finishArgs(calls)[0]).toMatchObject({ createPullRequest: true }),
    );
  });

  it('enables Finish when pull request availability fails to load', async () => {
    installFakeApi({
      'tasks:prAvailability': () => {
        throw new Error('boom');
      },
      'tasks:finishChecks': () => clean,
    });
    render(<FinishScreen taskId="a" />);
    const btn = await screen.findByRole('button', {
      name: 'Finish and clean up',
    });
    await waitFor(() => expect(btn).toBeEnabled());
  });

  describe('time spent', () => {
    const measured = {
      ...emptyTime('a'),
      activeSeconds: 11400,
      realisticSeconds: 14700,
      wallClockSeconds: 34200,
    };

    it('books the time in the field with Finish', async () => {
      const { calls } = installFakeApi({
        'tasks:finishChecks': () => clean,
        'tasks:finish': () => undefined,
        'time:task': () => measured,
      });
      render(<FinishScreen taskId="a" />);
      const field = await screen.findByLabelText('Time to book');
      expect(field).toHaveValue('3h 10m');
      await userEvent.clear(field);
      await userEvent.type(field, '4h');
      await userEvent.click(
        await screen.findByRole('button', { name: 'Finish and clean up' }),
      );
      await waitFor(() =>
        expect(calls.find((c) => c.channel === 'tasks:finish')).toBeDefined(),
      );
      const opts = calls.find((c) => c.channel === 'tasks:finish')?.args[1] as
        | { bookedSeconds?: number }
        | undefined;
      expect(opts?.bookedSeconds).toBe(14400);
    });

    it('starts from the earlier booking plus time measured since the reopen', async () => {
      installFakeApi({
        'tasks:finishChecks': () => clean,
        'time:task': () => ({
          ...measured,
          measuredSinceReopenSeconds: 1800,
          booking: {
            bookedSeconds: 7200,
            measuredSeconds: 7200,
            realisticSeconds: 7200,
            wallClockSeconds: 7200,
            agentSeconds: { 'claude-code': 0, 'copilot-cli': 0, opencode: 0 },
            bookedAt: 'then',
            writtenHours: 0,
            syncError: null,
          },
        }),
      });
      render(<FinishScreen taskId="a" />);
      expect(await screen.findByLabelText('Time to book')).toHaveValue(
        '2h 30m',
      );
    });

    it('invalid time blocks finish', async () => {
      installFakeApi({
        'tasks:finishChecks': () => clean,
        'time:task': () => measured,
      });
      render(<FinishScreen taskId="a" />);
      const field = await screen.findByLabelText('Time to book');
      await userEvent.clear(field);
      await userEvent.type(field, 'abc');
      expect(
        screen.getByText('Enter a time like 3h 30m or 3.5'),
      ).toBeInTheDocument();
      expect(
        await screen.findByRole('button', { name: 'Finish and clean up' }),
      ).toBeDisabled();
    });

    it('uses the live original estimate from the work item', async () => {
      useStore.setState({
        repos: [
          {
            id: 'r1',
            name: 'repo',
            path: '/src/repo',
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
      });
      installFakeApi({
        'tasks:finishChecks': () => clean,
        'time:task': () => ({
          ...measured,
          estimate: { hours: 8, source: 'baseline' },
        }),
        'workItems:get': () => ({
          id: '48213',
          type: 'User Story',
          title: 't',
          state: 'Active',
          areaPath: 'a',
          iterationPath: 'i',
          assignedTo: null,
          url: 'u',
          project: null,
          originalEstimate: 5,
          remainingWork: 1,
          completedWork: 2,
        }),
      });
      render(<FinishScreen taskId="a" />);
      expect(
        await screen.findByText('3h 10m of 5h estimate'),
      ).toBeInTheDocument();
    });

    it('falls back to the recorded estimate without a connection', async () => {
      installFakeApi({
        'tasks:finishChecks': () => clean,
        'time:task': () => ({
          ...measured,
          estimate: { hours: 8, source: 'baseline' },
        }),
      });
      render(<FinishScreen taskId="a" />);
      expect(
        await screen.findByText('3h 10m of 8h estimate'),
      ).toBeInTheDocument();
    });
  });

  describe('time loading', () => {
    const measured = { ...emptyTime('a'), activeSeconds: 11400 };
    const finishOpts = (calls: { channel: string; args: unknown[] }[]) =>
      calls.find((c) => c.channel === 'tasks:finish')?.args[1] as
        | Record<string, unknown>
        | undefined;

    it('disables Finish while the time is loading', async () => {
      installFakeApi({
        'tasks:finishChecks': () => clean,
        'time:task': () => new Promise(() => undefined),
      });
      render(<FinishScreen taskId="a" />);
      expect(await screen.findByText('Loading time\u2026')).toBeInTheDocument();
      await screen.findByText('Nothing to push');
      expect(
        screen.getByRole('button', { name: 'Finish and clean up' }),
      ).toBeDisabled();
    });

    it('offers Retry and Finish without booking time when loading fails', async () => {
      let fail = true;
      installFakeApi({
        'tasks:finishChecks': () => clean,
        'tasks:finish': () => undefined,
        'time:task': () => {
          if (fail) throw new Error('boom');
          return measured;
        },
      });
      render(<FinishScreen taskId="a" />);
      expect(
        await screen.findByText('Time could not be loaded'),
      ).toBeInTheDocument();
      await screen.findByText('Nothing to push');
      expect(
        screen.getByRole('button', { name: 'Finish and clean up' }),
      ).toBeDisabled();
      fail = false;
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByLabelText('Time to book')).toHaveValue(
        '3h 10m',
      );
    });

    it('finishes without bookedSeconds via Finish without booking time', async () => {
      const { calls } = installFakeApi({
        'tasks:finishChecks': () => clean,
        'tasks:finish': () => undefined,
        'time:task': () => {
          throw new Error('boom');
        },
      });
      render(<FinishScreen taskId="a" />);
      await screen.findByText('Nothing to push');
      await userEvent.click(
        await screen.findByRole('button', {
          name: 'Finish without booking time',
        }),
      );
      await waitFor(() => expect(finishOpts(calls)).toBeDefined());
      expect(finishOpts(calls)).not.toHaveProperty('bookedSeconds');
    });

    it('keeps the starting value when time changes while the page is open', async () => {
      let active = 11400;
      const { calls, emit } = installFakeApi({
        'tasks:finishChecks': () => clean,
        'tasks:finish': () => undefined,
        'time:task': () => ({ ...measured, activeSeconds: active }),
      });
      render(<FinishScreen taskId="a" />);
      expect(await screen.findByLabelText('Time to book')).toHaveValue(
        '3h 10m',
      );
      active = 12000;
      emit('time:changed', { taskId: 'a' });
      await waitFor(() =>
        expect(
          calls.filter((c) => c.channel === 'time:task').length,
        ).toBeGreaterThan(1),
      );
      await screen.findByText('Nothing to push');
      expect(screen.getByLabelText('Time to book')).toHaveValue('3h 10m');
      await userEvent.click(
        screen.getByRole('button', { name: 'Finish and clean up' }),
      );
      await waitFor(() => expect(finishOpts(calls)).toBeDefined());
      expect(finishOpts(calls)?.bookedSeconds).toBe(11400);
    });
  });
});

describe('FinishScreen with several repos', () => {
  const extra = (id: string, repoId: string) => ({
    id,
    repoId,
    branch: task.branch,
    worktreePath: `/w/${id}`,
    baseRef: 'origin/main',
    baseSha: null,
    source: 'detected' as const,
    summary: null,
    pullRequest: null,
    reopen: null,
    dropped: false,
  });
  const multi: TaskView = {
    ...task,
    extraWorkspaces: [extra('w2', 'r2'), extra('w3', 'r3'), extra('w4', 'r4')],
  };
  const row = (
    workspaceId: string,
    repoId: string,
    repoName: string,
    over: Partial<WorkspaceCheck> = {},
  ): WorkspaceCheck => ({
    workspaceId,
    repoId,
    repoName,
    branch: task.branch,
    missing: false,
    uncommitted: [],
    unpushed: 0,
    commits: 0,
    baseKnown: true,
    pr: {
      available: true,
      reason: null,
      target: 'main',
      linksWorkItem: true,
    },
    ...over,
  });
  const checks = (api: Partial<WorkspaceCheck> = {}) => ({
    ...clean,
    workspaces: [
      row('home', 'r1', 'webshop'),
      row('w2', 'r2', 'api', { commits: 2, unpushed: 2, ...api }),
      row('w3', 'r3', 'docs', {
        commits: 1,
        unpushed: 0,
        pr: {
          available: false,
          reason: 'origin is not an Azure Repos URL',
          target: null,
          linksWorkItem: false,
        },
      }),
      row('w4', 'r4', 'tools', { missing: true }),
    ],
  });
  const finishArgs = (calls: { channel: string; args: unknown[] }[]) =>
    calls.filter((c) => c.channel === 'tasks:finish').map((c) => c.args[1]);
  const group = (name: string) => screen.getByRole('group', { name });

  beforeEach(() => {
    useStore.setState({ tasks: [multi] });
  });

  it('writes a description per repo that gets a PR and sends each under its workspace', async () => {
    writePrChoice('r2', true);
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => checks(),
      'tasks:finish': () => undefined,
      'tasks:prSummary': (_t, ws) => ({ text: `About ${ws}`, error: null }),
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    const box = await within(group('api')).findByLabelText(
      'Pull request description',
    );
    await waitFor(() => expect(box).toHaveValue('About w2'));
    // Only the repo with a PR gets one.
    expect(screen.getAllByLabelText('Pull request description')).toHaveLength(
      1,
    );
    await userEvent.click(screen.getByRole('button', { name: /clean up/ }));
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(1));
    expect(finishArgs(calls)[0]).toMatchObject({
      prSummaries: { w2: 'About w2' },
    });
  });

  it("keeps a repo that is not on the task's branch as is: no remove, a push or PR only when ticked", async () => {
    // A PR was the last choice for r3; a repo on another branch still starts unticked.
    writePrChoice('r3', true);
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => ({
        ...clean,
        workspaces: [
          row('home', 'r1', 'webshop'),
          row('w2', 'r2', 'api', { branch: 'dev' }),
          row('w3', 'r3', 'docs', { branch: 'dev2', commits: 1, unpushed: 1 }),
        ],
      }),
      'tasks:finish': () => undefined,
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    expect(
      within(group('api')).getByText(
        "Not this task's branch (dev): kept as is",
      ),
    ).toBeInTheDocument();
    expect(within(group('api')).queryByRole('checkbox')).toBeNull();
    expect(
      within(group('docs')).getByText(
        "Not this task's branch (dev2): kept as is",
      ),
    ).toBeInTheDocument();
    const docsPr = within(group('docs')).getByLabelText(
      'Create a draft pull request into main',
    );
    expect(docsPr).not.toBeChecked();
    // Kept as is, so its unpushed commit is not discarded.
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(1));
    expect(
      (finishArgs(calls)[0] as { workspaces: unknown }).workspaces,
    ).toEqual([
      { workspaceId: 'home', action: 'drop' },
      { workspaceId: 'w2', action: 'keep' },
      { workspaceId: 'w3', action: 'keep' },
    ]);
  });

  it('pushes or opens a PR for a repo on another branch once ticked', async () => {
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => ({
        ...clean,
        workspaces: [
          row('home', 'r1', 'webshop'),
          row('w3', 'r3', 'docs', { branch: 'dev2', commits: 1, unpushed: 1 }),
        ],
      }),
      'tasks:finish': () => undefined,
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'docs' });
    await userEvent.click(
      within(group('docs')).getByLabelText(
        'Create a draft pull request into main',
      ),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(1));
    expect(
      (finishArgs(calls)[0] as { workspaces: unknown }).workspaces,
    ).toEqual([
      { workspaceId: 'home', action: 'drop' },
      { workspaceId: 'w3', action: 'pr' },
    ]);
  });

  it('a task whose other repos were all dropped finishes like a single repo', async () => {
    useStore.setState({
      tasks: [
        { ...task, extraWorkspaces: [{ ...extra('w2', 'r2'), dropped: true }] },
      ],
    });
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => ({
        ...clean,
        workspaces: [row('home', 'r1', 'webshop')],
      }),
      'tasks:finish': () => undefined,
    });
    render(<FinishScreen taskId="a" />);
    expect(
      await screen.findByLabelText('Remove worktree folder'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'webshop' })).toBeNull();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Finish and clean up' }),
    );
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(1));
    expect(finishArgs(calls)[0]).not.toHaveProperty('workspaces');
  });

  it('a task whose home was dropped finishes per repo, even with one repo left', async () => {
    useStore.setState({
      tasks: [
        { ...task, homeDropped: true, extraWorkspaces: [extra('w2', 'r2')] },
      ],
    });
    installFakeApi({
      'tasks:finishChecks': () => ({
        ...clean,
        workspaces: [row('w2', 'r2', 'api', { commits: 1, unpushed: 1 })],
      }),
    });
    render(<FinishScreen taskId="a" />);
    expect(
      await screen.findByRole('group', { name: 'api' }),
    ).toBeInTheDocument();
  });

  it('shows a row per workspace with its default action', async () => {
    writePrChoice('r2', false);
    installFakeApi({ 'tasks:finishChecks': () => checks() });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'webshop' });
    expect(
      within(group('webshop')).getByLabelText('Remove, no changes (no push)'),
    ).toBeChecked();
    expect(
      within(group('api')).getByLabelText(
        'Create a draft pull request into main',
      ),
    ).not.toBeChecked();
    expect(within(group('api')).getByText('2 commits')).toBeInTheDocument();
    expect(
      within(group('docs')).getByLabelText('Push the branch'),
    ).not.toBeChecked();
    expect(
      within(group('tools')).getByText('Folder missing, skipped'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Remove worktree folders')).toBeChecked();
    expect(screen.getByLabelText('Delete local branches')).toBeChecked();
  });

  it('remembers the PR and push choices per repo and sends an action per workspace', async () => {
    writePrChoice('r2', true);
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => checks(),
      'tasks:finish': () => undefined,
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    expect(
      within(group('api')).getByLabelText(
        'Create a draft pull request into main',
      ),
    ).toBeChecked();
    await userEvent.click(
      within(group('docs')).getByLabelText('Push the branch'),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(1));
    expect(finishArgs(calls)[0]).toEqual({
      closeTerminals: true,
      removeWorktree: true,
      deleteBranch: true,
      bookedSeconds: 0,
      workspaces: [
        { workspaceId: 'home', action: 'drop' },
        { workspaceId: 'w2', action: 'pr' },
        { workspaceId: 'w3', action: 'push' },
        { workspaceId: 'w4', action: 'keep' },
      ],
    });
    expect(readPushChoice('r3')).toBe(true);
    expect(readPrChoice('r2')).toBe(true);
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'task' }),
    );
  });

  it('shows the Time spent step and books the chosen time with the per-repo Finish', async () => {
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => checks(),
      'tasks:finish': () => undefined,
      'time:task': () => ({ ...emptyTime('a'), activeSeconds: 11400 }),
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    expect(
      screen.getByRole('heading', { name: 'Time spent' }),
    ).toBeInTheDocument();
    const field = await screen.findByLabelText('Time to book');
    expect(field).toHaveValue('3h 10m');
    await userEvent.clear(field);
    await userEvent.type(field, '4h');
    await userEvent.click(
      screen.getByRole('button', { name: /and clean up$/ }),
    );
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(1));
    expect(finishArgs(calls)[0]).toMatchObject({
      bookedSeconds: 14400,
      workspaces: expect.any(Array),
    });
  });

  it('waits for the time, and finishes every repo without booking when the time fails', async () => {
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => checks(),
      'tasks:finish': () => undefined,
      'time:task': () => {
        throw new Error('boom');
      },
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    expect(
      await screen.findByText('Time could not be loaded'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /and clean up$/ }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish without booking time' }),
    );
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(1));
    expect(finishArgs(calls)[0]).not.toHaveProperty('bookedSeconds');
    expect(finishArgs(calls)[0]).toHaveProperty('workspaces');
  });

  it('warns about unpushed commits of a row that is neither pushed nor PR', async () => {
    installFakeApi({ 'tasks:finishChecks': () => checks() });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    expect(
      within(group('api')).getByText('2 commits not pushed'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Discard changes and clean up' }),
    ).toBeInTheDocument();
  });

  it('opens commit in a terminal in that workspace', async () => {
    const { calls } = installFakeApi({
      'tasks:finishChecks': () =>
        checks({ uncommitted: [{ status: 'M', path: 'src/x.ts' }] }),
      'terminals:open': () => ({
        id: 'g1',
        kind: 'run',
        label: 'git commit',
        command: 'x',
      }),
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    await userEvent.click(
      within(group('api')).getByRole('button', {
        name: 'Commit' + String.fromCharCode(0x2026),
      }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'terminals:open')?.args).toEqual([
        'a',
        {
          kind: 'run',
          label: 'git commit',
          command: 'git add -A && git commit',
          workspaceId: 'w2',
        },
      ]),
    );
  });

  const ok = (
    workspaceId: string,
    action: 'pr' | 'push' | 'keep' | 'drop',
    over: Partial<FinishRowResult> = {},
  ): FinishRowResult => ({
    workspaceId,
    action,
    ok: true,
    pushed: false,
    pullRequest: null,
    error: null,
    ...over,
  });
  const STOPPED =
    'Finish stopped before cleanup: 1 repo failed. Nothing was removed.';

  it('on a failed PR shows each row, offers Retry, and Finish without PR keeps only the failed rows', async () => {
    writePrChoice('r2', true);
    let n = 0;
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => checks({ unpushed: 0 }),
      'tasks:finish': () => {
        if (n++ < 2)
          throw new Error(
            "Error invoking remote method 'tasks:finish': Error: Pull request not created for api: The token cannot create pull requests",
          );
        return undefined;
      },
      'tasks:finishResults': () => [
        ok('home', 'drop'),
        ok('w2', 'pr', {
          ok: false,
          error: 'The token cannot create pull requests',
        }),
        ok('w3', 'push', { pushed: true }),
        ok('w4', 'keep'),
      ],
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    await userEvent.click(
      within(group('docs')).getByLabelText('Push the branch'),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    expect(await screen.findByText(STOPPED)).toBeInTheDocument();
    expect(
      within(group('api')).getByText('The token cannot create pull requests'),
    ).toBeInTheDocument();
    expect(within(group('docs')).getByText('Pushed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(2));
    expect(finishArgs(calls)[1]).toEqual(finishArgs(calls)[0]);
    await screen.findByText(STOPPED);
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish without PR' }),
    );
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(3));
    expect(finishArgs(calls)[2]).toMatchObject({
      workspaces: [
        { workspaceId: 'home', action: 'drop' },
        { workspaceId: 'w2', action: 'keep' },
        { workspaceId: 'w3', action: 'push' },
        { workspaceId: 'w4', action: 'keep' },
      ],
    });
    // Leaving out the failed PR is not a new preference for the repo.
    expect(readPrChoice('r2')).toBe(true);
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'task' }),
    );
  });

  it('asks to push anyway when a row was refused for a stored secret', async () => {
    let n = 0;
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => checks({ unpushed: 0 }),
      'tasks:finish': () => {
        if (n++ < 1)
          throw new Error(
            "Branch not pushed for api: A stored secret appears in this branch's changes; not pushed",
          );
        return undefined;
      },
      'tasks:finishResults': () => [
        ok('home', 'drop'),
        ok('w2', 'pr', {
          ok: false,
          leak: 'found',
          error: "A stored secret appears in this branch's changes; not pushed",
        }),
        ok('w3', 'keep'),
        ok('w4', 'keep'),
      ],
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    await userEvent.click(
      await screen.findByLabelText(
        "A stored secret appears in this branch's changes. Push anyway?",
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(finishArgs(calls)).toHaveLength(2));
    // Confirmed for that row only, not page-wide.
    expect(finishArgs(calls)[1]).not.toHaveProperty('confirmLeak');
    expect(finishArgs(calls)[1]).toMatchObject({
      workspaces: expect.arrayContaining([
        expect.objectContaining({ workspaceId: 'w2', confirmLeak: true }),
      ]),
    });
    const others = (
      finishArgs(calls)[1] as { workspaces: { workspaceId: string }[] }
    ).workspaces.filter((w) => w.workspaceId !== 'w2');
    for (const w of others) expect(w).not.toHaveProperty('confirmLeak');
  });

  it('under a row whose push could not sign in, says how to sign in', async () => {
    installFakeApi({
      'tasks:finishChecks': () => checks({ unpushed: 0 }),
      'tasks:finish': () => {
        throw new Error(
          'Pull request not created for api: fatal: could not read Username',
        );
      },
      'tasks:finishResults': () => [
        ok('home', 'drop'),
        ok('w2', 'pr', {
          ok: false,
          error: 'fatal: could not read Username',
          auth: { host: 'github.com', connectionId: null, path: '/src/api.wt' },
        }),
        ok('w3', 'push'),
        ok('w4', 'keep'),
      ],
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    expect(
      await within(group('api')).findByText(
        'Git could not sign in to github.com. Sign in once from a terminal (run `git push` in /src/api.wt), then Retry.',
      ),
    ).toBeInTheDocument();
    expect(
      within(group('docs')).queryByText(/Git could not sign in/),
    ).toBeNull();
  });

  it('shows the pull request a row got when another row failed', async () => {
    writePrChoice('r2', true);
    installFakeApi({
      'tasks:finishChecks': () => checks({ unpushed: 0 }),
      'tasks:finish': () => {
        throw new Error('Branch not pushed for docs: rejected');
      },
      'tasks:finishResults': () => [
        ok('home', 'drop'),
        ok('w2', 'pr', {
          pushed: true,
          pullRequest: { id: 7, url: 'u', linked: false },
        }),
        ok('w3', 'push', { ok: false, error: 'rejected' }),
        ok('w4', 'keep'),
      ],
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    await userEvent.click(
      within(group('docs')).getByLabelText('Push the branch'),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Finish and clean up' }),
    );
    expect(await screen.findByText(STOPPED)).toBeInTheDocument();
    expect(
      within(group('api')).getByText('Pull request #7 created'),
    ).toBeInTheDocument();
    expect(within(group('docs')).getByText('rejected')).toBeInTheDocument();
    expect(useStore.getState().screen).toEqual({ kind: 'finish', taskId: 'a' });
  });

  it('a failure without failed rows is a notice, not row states', async () => {
    installFakeApi({
      'tasks:finishChecks': () => checks(),
      'tasks:finish': () => {
        throw new Error('git worktree remove failed: locked');
      },
      'tasks:finishResults': () => [ok('home', 'drop')],
    });
    render(<FinishScreen taskId="a" />);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Discard changes and clean up',
      }),
    );
    await waitFor(() =>
      expect(useStore.getState().notices[0]?.message).toMatch(/locked/),
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('adds a worktree from a picked folder, then checks again', async () => {
    let n = 0;
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => {
        n++;
        return checks();
      },
      'repos:pickFolder': () => '/src/other',
      'tasks:addWorkspace': () => extra('w5', 'r5'),
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Add a worktree' + String.fromCharCode(0x2026),
      }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'tasks:addWorkspace')?.args,
      ).toEqual(['a', '/src/other']),
    );
    await waitFor(() => expect(n).toBe(2));
  });

  it('a row whose base is unknown is not offered as "no changes"', async () => {
    installFakeApi({
      'tasks:finishChecks': () => ({
        ...clean,
        workspaces: [
          row('home', 'r1', 'webshop'),
          row('w2', 'r2', 'api', { baseKnown: false }),
        ],
      }),
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    expect(
      within(group('api')).queryByLabelText('Remove, no changes (no push)'),
    ).toBeNull();
    expect(
      within(group('api')).getByLabelText(
        'Create a draft pull request into main',
      ),
    ).toBeInTheDocument();
    expect(
      within(group('api')).getByText('Changes unknown'),
    ).toBeInTheDocument();
  });

  it('removes a repo from the task, but not the home', async () => {
    let n = 0;
    const { calls } = installFakeApi({
      'tasks:finishChecks': () => {
        n++;
        return checks();
      },
      'tasks:removeWorkspace': () => undefined,
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    expect(
      within(group('webshop')).queryByRole('button', {
        name: 'Remove from task',
      }),
    ).toBeNull();
    await userEvent.click(
      within(group('api')).getByRole('button', { name: 'Remove from task' }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'tasks:removeWorkspace')?.args,
      ).toEqual(['a', 'w2']),
    );
    await waitFor(() => expect(n).toBe(2));
  });

  it('says a dropped repo closes the terminals even when that is unticked', async () => {
    installFakeApi({ 'tasks:finishChecks': () => checks() });
    render(<FinishScreen taskId="a" />);
    await screen.findByRole('group', { name: 'api' });
    const note = 'Removing a repo without changes closes the terminals too.';
    await userEvent.click(screen.getByLabelText('Remove worktree folders'));
    await userEvent.click(screen.getByLabelText(/^Close 2 terminals/));
    expect(screen.getByText(note)).toBeInTheDocument();
    await userEvent.click(
      within(group('webshop')).getByLabelText('Remove, no changes (no push)'),
    );
    expect(screen.queryByText(note)).toBeNull();
  });
});

describe('FinishScreen review reminder', () => {
  it('shows files not viewed and unresolved comments, and opens Changes', async () => {
    installFakeApi({
      'tasks:finishChecks': () => clean,
      'review:summary': () => ({ files: 5, notViewed: 2, unresolved: 1 }),
    });
    render(<FinishScreen taskId="a" />);
    expect(
      await screen.findByText('2 files not viewed · 1 comment unresolved'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(useStore.getState().activeTab('a')).toBe(CHANGES_TAB);
    expect(useStore.getState().screen.kind).toBe('task');
  });

  it('stays hidden when everything is viewed and resolved', async () => {
    installFakeApi({
      'tasks:finishChecks': () => clean,
      'review:summary': () => ({ files: 5, notViewed: 0, unresolved: 0 }),
    });
    render(<FinishScreen taskId="a" />);
    await screen.findByText('No uncommitted changes');
    expect(screen.queryByText(/not viewed/)).toBeNull();
  });
});
