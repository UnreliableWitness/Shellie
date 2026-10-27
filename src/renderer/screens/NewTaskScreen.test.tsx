import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../shared/types';
import { defaultSettings } from '../../shared/usage';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { NewTaskScreen } from './NewTaskScreen';

const webshop: Repo = {
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
};
const config = {
  worktreeRoot: '/src/webshop.worktrees',
  config: {
    base: 'main',
    branch: '{type}/{id}-{slug}',
    copy: ['.env', '.env.local'],
    setup: ['npm ci', 'npm run build'],
    run: {},
    found: true,
  },
};

beforeEach(() =>
  useStore.setState({
    repos: [webshop],
    tasks: [],
    connections: [],
    notices: [],
    screen: { kind: 'new-task' },
  }),
);

describe('NewTaskScreen', () => {
  it('prefills branch and folder from the work item and the repo template', async () => {
    installFakeApi({ 'repos:config': () => config });
    render(<NewTaskScreen />);
    await userEvent.type(screen.getByLabelText('Work item id'), '48231');
    await userEvent.type(
      screen.getByLabelText('Title'),
      'Show estimated delivery date on product page',
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Branch')).toHaveValue(
        'feature/48231-show-estimated-delivery-date-on-product',
      ),
    );
    expect(
      screen.getByText(
        '/src/webshop.worktrees/48231-show-estimated-delivery-date-on-product',
      ),
    ).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'Bug');
    expect(screen.getByLabelText('Branch')).toHaveValue(
      'bugfix/48231-show-estimated-delivery-date-on-product',
    );
  });

  it('keeps a branch the user edited by hand', async () => {
    installFakeApi({ 'repos:config': () => config });
    render(<NewTaskScreen />);
    await userEvent.type(screen.getByLabelText('Title'), 'One');
    await userEvent.clear(screen.getByLabelText('Branch'));
    await userEvent.type(screen.getByLabelText('Branch'), 'custom/x');
    await userEvent.type(screen.getByLabelText('Title'), ' two');
    expect(screen.getByLabelText('Branch')).toHaveValue('custom/x');
  });

  it('uses the task name for a blank task', async () => {
    installFakeApi({ 'repos:config': () => config });
    render(<NewTaskScreen />);
    await userEvent.click(screen.getByRole('tab', { name: 'Blank' }));
    await userEvent.type(
      screen.getByLabelText('Task name'),
      'Spike new search',
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Branch')).toHaveValue(
        'feature/spike-new-search',
      ),
    );
  });

  it('creates the task with the chosen options and opens the setup screen', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'tasks:create': () => ({ id: 't1' }) as never,
    });
    render(<NewTaskScreen />);
    await userEvent.type(screen.getByLabelText('Work item id'), '48231');
    await userEvent.type(screen.getByLabelText('Title'), 'Delivery date');
    await waitFor(() =>
      expect(screen.getByLabelText('npm run build')).toBeChecked(),
    );
    await userEvent.click(screen.getByLabelText('npm run build'));
    await userEvent.click(screen.getByLabelText('Open a shell tab'));
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({
        kind: 'setup',
        taskId: 't1',
      }),
    );
    const create = calls.find((c) => c.channel === 'tasks:create');
    expect(create?.args[0]).toEqual({
      repoId: 'r1',
      baseRef: 'origin/main',
      name: '',
      workItem: {
        id: '48231',
        type: 'User Story',
        title: 'Delivery date',
        url: null,
      },
      branch: 'feature/48231-delivery-date',
      copy: true,
      commands: ['npm ci'],
      startClaude: true,
      openShell: false,
      openCopilot: false,
      openOpencode: false,
      environment: 'development',
    });
  });

  it('lists in the confirm only the names that reach a tab setup opens', async () => {
    const value = { mask: '••••', source: null, changedAt: 'x' };
    installFakeApi({
      'repos:config': () => config,
      'secrets:list': () => [
        {
          id: '1',
          scope: { repoId: 'r1' },
          name: 'SHELL_KEY',
          givenTo: ['shell'],
          values: { uat: value },
        },
        {
          id: '2',
          scope: { repoId: 'r1' },
          name: 'RUN_ONLY',
          givenTo: ['run'],
          values: { uat: value },
        },
        {
          id: '3',
          scope: 'all',
          name: 'DEV_ONLY',
          givenTo: ['shell'],
          values: { development: value },
        },
      ],
    });
    render(<NewTaskScreen />);
    await userEvent.type(screen.getByLabelText('Work item id'), '48231');
    await userEvent.type(screen.getByLabelText('Title'), 'Delivery date');
    await waitFor(() => expect(screen.getByLabelText('npm ci')).toBeChecked());
    await userEvent.selectOptions(screen.getByLabelText('Environment'), 'uat');
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    const confirm = screen.getByRole('alertdialog', {
      name: 'Start 48231 on UAT?',
    });
    await waitFor(() => expect(confirm).toHaveTextContent('SHELL_KEY'));
    expect(confirm).not.toHaveTextContent('RUN_ONLY');
    expect(confirm).not.toHaveTextContent('DEV_ONLY');
    expect(screen.getByRole('button', { name: 'Use UAT' })).toBeEnabled();
  });

  it('names in the confirm only the tabs a stored value goes into', async () => {
    const value = { mask: '••••', source: null, changedAt: 'x' };
    installFakeApi({
      'repos:config': () => config,
      'secrets:list': () => [
        {
          id: '2',
          scope: { repoId: 'r1' },
          name: 'RUN_ONLY',
          givenTo: ['run'],
          values: { uat: value },
        },
        {
          id: '3',
          scope: { repoId: 'r1' },
          name: 'SETUP_KEY',
          givenTo: ['setup'],
          values: { uat: value },
        },
      ],
    });
    render(<NewTaskScreen />);
    await userEvent.type(screen.getByLabelText('Work item id'), '48231');
    await userEvent.type(screen.getByLabelText('Title'), 'Delivery date');
    await waitFor(() => expect(screen.getByLabelText('npm ci')).toBeChecked());
    await userEvent.selectOptions(screen.getByLabelText('Environment'), 'uat');
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    const confirm = screen.getByRole('alertdialog', {
      name: 'Start 48231 on UAT?',
    });
    await waitFor(() => expect(confirm).toHaveTextContent('SETUP_KEY'));
    expect(confirm).toHaveTextContent('These go into Setup until');
    expect(confirm).not.toHaveTextContent('your shell');
  });

  it('offers the four environments with the repo default selected', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'secrets:repoDefault': () => 'test',
    });
    render(<NewTaskScreen />);
    const select = screen.getByLabelText('Environment');
    await waitFor(() => expect(select).toHaveValue('test'));
    expect(
      [...(select as HTMLSelectElement).options].map((o) => o.textContent),
    ).toEqual(['Development', 'Test', 'UAT', 'Production']);
    expect(calls).toContainEqual({
      channel: 'secrets:repoDefault',
      args: ['r1'],
    });
  });

  it('asks before creating a task on Production, and sends the confirm', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'tasks:create': () => ({ id: 't1' }) as never,
    });
    render(<NewTaskScreen />);
    await userEvent.type(screen.getByLabelText('Work item id'), '48231');
    await userEvent.type(screen.getByLabelText('Title'), 'Delivery date');
    await waitFor(() =>
      expect(screen.getByLabelText('Environment')).toHaveValue('development'),
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Environment'),
      'production',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    const confirm = screen.getByRole('alertdialog', {
      name: 'Start 48231 on Production?',
    });
    expect(confirm).toHaveTextContent('60 minutes');
    expect(calls.some((c) => c.channel === 'tasks:create')).toBe(false);
    await userEvent.click(
      screen.getByRole('button', { name: 'Use Production for 60 min' }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'tasks:create')?.args[0]).toEqual(
        expect.objectContaining({
          environment: 'production',
          environmentConfirmed: true,
        }),
      ),
    );
  });

  it('starts Copilot CLI with the task when ticked', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'tasks:create': () => ({ id: 't1' }) as never,
    });
    render(<NewTaskScreen />);
    await userEvent.type(screen.getByLabelText('Work item id'), '48231');
    await userEvent.type(screen.getByLabelText('Title'), 'Delivery date');
    const box = screen.getByLabelText('Start Copilot CLI with the task');
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'tasks:create')?.args[0],
      ).toMatchObject({ openCopilot: true }),
    );
  });

  it('pre-ticks the tabs chosen in Settings and can start OpenCode', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'settings:get': () => ({
        ...defaultSettings(),
        defaultTerminals: {
          claude: false,
          copilot: false,
          opencode: true,
          shell: true,
        },
      }),
      'tasks:create': () => ({ id: 't1' }) as never,
    });
    render(<NewTaskScreen />);
    await userEvent.type(screen.getByLabelText('Work item id'), '48231');
    await userEvent.type(screen.getByLabelText('Title'), 'Delivery date');
    const opencode = screen.getByLabelText('Start OpenCode with the task');
    await waitFor(() => expect(opencode).toBeChecked());
    expect(
      screen.getByLabelText(/Open Claude Code with the task loaded/),
    ).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'tasks:create')?.args[0],
      ).toMatchObject({
        startClaude: false,
        openShell: true,
        openCopilot: false,
        openOpencode: true,
      }),
    );
  });

  it('shows the error and stays open when create fails', async () => {
    installFakeApi({
      'repos:config': () => config,
      'tasks:create': () => {
        throw new Error('Branch feature/x already exists in webshop');
      },
    });
    render(<NewTaskScreen />);
    await userEvent.type(screen.getByLabelText('Work item id'), '48231');
    await userEvent.type(screen.getByLabelText('Title'), 'x');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create task' })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(useStore.getState().notices[0]?.message).toMatch(/already exists/),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'new-task' });
  });

  it('requires both id and title in work-item mode', async () => {
    installFakeApi({ 'repos:config': () => config });
    render(<NewTaskScreen />);
    await userEvent.type(screen.getByLabelText('Title'), 'Only a title');
    await waitFor(() =>
      expect(screen.getByLabelText('npm run build')).toBeChecked(),
    );
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Work item id'), '48231');
    expect(screen.getByRole('button', { name: 'Create task' })).toBeEnabled();
  });

  it('preselects the work item and repo it was opened with', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'workItems:currentIteration': () => ({
        path: 'Shellie\\Sprint 1',
        name: 'Sprint 1',
      }),
      'workItems:search': () => [],
      'tasks:create': () => ({ id: 't9' }) as never,
    });
    const linked = { ...webshop, id: 'r2', name: 'api', connectionId: 'c1' };
    useStore.setState({
      repos: [webshop, linked],
      connections: [
        {
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
        },
      ],
    });
    const workItem = {
      id: '12',
      type: 'Bug',
      title: 'Broken checkout',
      url: 'https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/12',
    };
    render(<NewTaskScreen initial={{ workItem, repoId: 'r2' }} />);
    expect(screen.getByLabelText('Repo')).toHaveValue('r2');
    expect(screen.getByRole('tab', { name: 'Work item' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Branch')).toHaveValue(
        'bugfix/12-broken-checkout',
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'tasks:create')?.args[0],
      ).toMatchObject({ repoId: 'r2', workItem }),
    );
  });

  it('returns to the previous page on Cancel', async () => {
    installFakeApi({ 'repos:config': () => config });
    useStore.setState({ screen: { kind: 'settings' }, previous: null });
    useStore.getState().go({ kind: 'new-task' });
    render(<NewTaskScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useStore.getState().screen).toEqual({ kind: 'settings' });
  });

  it('creates a task from a picked work item when the repo has a connection', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'workItems:currentIteration': () => ({
        path: 'Shellie\\Sprint 1',
        name: 'Sprint 1',
      }),
      'workItems:search': () => [
        {
          id: '12',
          type: 'Issue',
          title: 'Save delivery address',
          state: 'To Do',
          areaPath: 'Shellie',
          iterationPath: 'Shellie\\Sprint 1',
          assignedTo: null,
          url: 'https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/12',
        },
      ],
      'tasks:create': () => ({ id: 't9' }) as never,
    });
    useStore.setState({
      repos: [{ ...webshop, connectionId: 'c1' }],
      connections: [
        {
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
        },
      ],
    });
    render(<NewTaskScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: /Save delivery address/ }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Branch')).toHaveValue(
        'feature/12-save-delivery-address',
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'tasks:create')?.args[0],
      ).toMatchObject({
        workItem: {
          id: '12',
          type: 'Issue',
          title: 'Save delivery address',
          url: 'https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/12',
        },
      }),
    );
  });

  const conn = {
    id: 'c1',
    name: 'uw',
    organizationUrl: 'https://dev.azure.com/unreliablewitness',
    project: 'Shellie',
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
  };
  const pickerApi = {
    'repos:config': () => config,
    'workItems:currentIteration': () => ({ path: 'p', name: 'S' }),
    'workItems:search': () => [],
  };

  it('follows the selected repo between picker and typed form', async () => {
    installFakeApi(pickerApi);
    useStore.setState({
      repos: [
        { ...webshop, connectionId: 'c1' },
        { ...webshop, id: 'r2', name: 'plain' },
      ],
      connections: [conn],
    });
    render(<NewTaskScreen />);
    expect(
      await screen.findByLabelText('Search work items'),
    ).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Repo'), 'plain');
    expect(await screen.findByLabelText('Work item id')).toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: 'Work item' }),
    ).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Repo'), 'webshop');
    expect(
      await screen.findByLabelText('Search work items'),
    ).toBeInTheDocument();
  });

  it('falls back to the typed form when the repo loses its connection', async () => {
    installFakeApi(pickerApi);
    useStore.setState({
      repos: [{ ...webshop, connectionId: 'c1' }],
      connections: [conn],
    });
    render(<NewTaskScreen />);
    expect(
      await screen.findByLabelText('Search work items'),
    ).toBeInTheDocument();
    act(() =>
      useStore.setState({ repos: [{ ...webshop, connectionId: null }] }),
    );
    expect(await screen.findByLabelText('Work item id')).toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: 'Work item' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the work item when switching to another repo on the same connection', async () => {
    const { calls } = installFakeApi({
      ...pickerApi,
      'tasks:create': () => ({ id: 't9' }) as never,
    });
    useStore.setState({
      repos: [
        { ...webshop, connectionId: 'c1' },
        { ...webshop, id: 'r2', name: 'api', connectionId: 'c1' },
      ],
      connections: [conn],
    });
    const workItem = {
      id: '12',
      type: 'Bug',
      title: 'Broken checkout',
      url: 'u',
    };
    render(<NewTaskScreen initial={{ workItem, repoId: 'r1' }} />);
    await userEvent.selectOptions(screen.getByLabelText('Repo'), 'api');
    await waitFor(() =>
      expect(screen.getByLabelText('Branch')).toHaveValue(
        'bugfix/12-broken-checkout',
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'tasks:create')?.args[0],
      ).toMatchObject({ repoId: 'r2', workItem }),
    );
  });

  it('clears the picked item when the repo switches to another connection', async () => {
    installFakeApi({
      ...pickerApi,
      'workItems:search': () => [
        {
          id: '12',
          type: 'Issue',
          title: 'Save delivery address',
          state: 'To Do',
          areaPath: 'Shellie',
          iterationPath: 'p',
          assignedTo: null,
          url: 'https://dev.azure.com/o/p/_workitems/edit/12',
        },
      ],
    });
    useStore.setState({
      repos: [{ ...webshop, connectionId: 'c1' }],
      connections: [conn, { ...conn, id: 'c2', name: 'other' }],
    });
    render(<NewTaskScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: /Save delivery address/ }),
    );
    const create = screen.getByRole('button', { name: 'Create task' });
    await waitFor(() => expect(create).toBeEnabled());
    act(() =>
      useStore.setState({ repos: [{ ...webshop, connectionId: 'c2' }] }),
    );
    await waitFor(() => expect(create).toBeDisabled());
    await userEvent.click(
      await screen.findByRole('button', { name: /Save delivery address/ }),
    );
    await waitFor(() => expect(create).toBeEnabled());
  });
});
