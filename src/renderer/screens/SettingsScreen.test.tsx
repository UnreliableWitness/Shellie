import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../shared/usage';
import type { Connection, Repo } from '../../shared/types';
import { useStore } from '../store';
import { installFakeApi, noOverrides } from '../test-helpers/fakeApi';
import { SettingsScreen } from './SettingsScreen';

const ADD_FOLDER = `Add folder${String.fromCharCode(8230)}`;

const webshop: Repo = {
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
};

const repoScope = { kind: 'settings' as const, scope: 'repo' as const };

const conn = (id: string, project: string): Connection => ({
  id,
  name: 'contoso',
  organizationUrl: 'https://dev.azure.com/contoso',
  project,
  user: null,
  status: 'ok',
  checkedAt: null,
  userUniqueName: null,
  provider: 'azure-devops',
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
  writeTimeToAdo: false,
});
const shop = conn('c1', 'Shop');
const platform = conn('c2', 'Platform');

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({
    repos: [],
    tasks: [],
    connections: [],
    notices: [],
    screen: { kind: 'settings' },
  });
});

describe('SettingsScreen', () => {
  it('lists repos with their base branch and .shellie.yml status', async () => {
    installFakeApi();
    useStore.setState({
      repos: [
        webshop,
        {
          ...webshop,
          id: 'r2',
          name: 'api',
          path: '/src/api',
          baseBranch: 'develop',
          configFound: false,
          discovered: false,
          overrides: {},
          workItemOnStart: {
            moveToInProgress: true,
            assignToMe: true,
            stateOverrides: {},
          },
        },
      ],
      screen: repoScope,
    });
    render(<SettingsScreen />);
    expect(screen.getByLabelText('Repository')).toHaveValue('r1');
    expect(screen.getByRole('option', { name: 'api' })).toBeInTheDocument();
    expect(screen.getByText('/src/webshop')).toBeInTheDocument();
    expect(screen.getByText('.shellie.yml found')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Repository'), 'r2');
    expect(
      screen.getByText('No .shellie.yml, using defaults'),
    ).toBeInTheDocument();
    expect(screen.getByText('/src/api')).toBeInTheDocument();
  });

  it('marks a discovered repo and lets the user make it normal', async () => {
    const { calls } = installFakeApi({
      'repos:setDiscovered': () => ({ ...webshop, discovered: false }),
    });
    useStore.setState({
      repos: [{ ...webshop, discovered: true }],
      screen: repoScope,
    });
    render(<SettingsScreen />);
    expect(
      screen.getByRole('option', { name: 'webshop (found in a task)' }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Make it a normal repo' }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'repos:setDiscovered')?.args,
      ).toEqual(['r1', false]),
    );
  });

  it('opens the Add repository page with the picked folder', async () => {
    const { calls } = installFakeApi({
      'repos:pickFolder': () => '/src/picked',
    });
    render(<SettingsScreen />);
    await userEvent.click(screen.getByRole('tab', { name: 'Repository' }));
    await userEvent.click(screen.getByRole('button', { name: ADD_FOLDER }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({
        kind: 'add-repo',
        from: 'settings',
        folder: '/src/picked',
      }),
    );
    expect(calls.some((c) => c.channel === 'repos:add')).toBe(false);
  });

  it('shows the effective config as rows', async () => {
    installFakeApi({
      'repos:config': () => ({
        worktreeRoot: '/src/webshop.worktrees',
        ...noOverrides,
        config: {
          base: 'main',
          branch: '{type}/{id}-{slug}',
          copy: ['.env'],
          setup: ['npm ci'],
          run: { dev: 'npm run dev' },
          found: true,
        },
      }),
    });
    useStore.setState({ repos: [webshop], screen: repoScope });
    render(<SettingsScreen />);
    expect(await screen.findByLabelText('Setup commands item 1')).toHaveValue(
      'npm ci',
    );
    expect(screen.getByLabelText('Base branch')).toHaveValue('main');
    expect(screen.getByDisplayValue('npm run dev')).toBeInTheDocument();
  });

  it('links a repo to a connection', async () => {
    const { calls } = installFakeApi({
      'repos:setConnection': () => ({ ...webshop, connectionId: 'c1' }),
      'repos:list': () => [{ ...webshop, connectionId: 'c1' }],
    });
    useStore.setState({
      repos: [webshop],
      connections: [
        {
          id: 'c1',
          name: 'unreliablewitness',
          organizationUrl: 'https://dev.azure.com/unreliablewitness',
          project: 'Shellie',
          user: null,
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
      screen: repoScope,
    });
    render(<SettingsScreen />);
    await userEvent.selectOptions(
      screen.getByLabelText('Project for webshop'),
      'c1',
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'repos:setConnection')?.args,
      ).toEqual(['r1', 'c1']),
    );
  });

  it("saves a repo's own Claude Code command on leaving the field, and keeps the other one", async () => {
    const { calls } = installFakeApi();
    useStore.setState({
      repos: [{ ...webshop, agentCommands: { opencode: 'opencode --foo' } }],
      screen: repoScope,
    });
    render(<SettingsScreen />);
    const claude = screen.getByLabelText('Claude Code command for webshop');
    expect(claude).toHaveAttribute('placeholder', 'claude');
    expect(screen.getByLabelText('OpenCode command for webshop')).toHaveValue(
      'opencode --foo',
    );
    await userEvent.type(claude, 'claude --permission-mode acceptEdits');
    expect(calls.some((c) => c.channel === 'repos:setAgentCommands')).toBe(
      false,
    );
    await userEvent.tab();
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'repos:setAgentCommands')?.args,
      ).toEqual([
        'r1',
        {
          claude: 'claude --permission-mode acceptEdits',
          opencode: 'opencode --foo',
        },
      ]),
    );
  });

  describe('start options', () => {
    const conn = {
      id: 'c1',
      name: 'unreliablewitness',
      organizationUrl: 'https://dev.azure.com/unreliablewitness',
      project: 'Shellie',
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
      writeTimeToAdo: false,
    };
    const linked: Repo = { ...webshop, connectionId: 'c1' };
    const types = [
      {
        name: 'Task',
        color: null,
        icon: null,
        states: [
          { name: 'To Do', color: null, category: 'Proposed' },
          { name: 'Doing', color: null, category: 'InProgress' },
          { name: 'Done', color: null, category: 'Completed' },
        ],
      },
    ];
    const handlers = () => ({
      'repos:setWorkItemOnStart': (_id: string, s: unknown) => ({
        ...linked,
        workItemOnStart: s,
      }),
      'workItems:types': () => types,
    });

    it('shows both options checked for a repo with a connection', () => {
      installFakeApi(handlers() as never);
      useStore.setState({
        repos: [linked],
        connections: [conn],
        screen: repoScope,
      });
      render(<SettingsScreen />);
      expect(
        screen.getByRole('checkbox', {
          name: 'Move the work item to In Progress on start',
        }),
      ).toBeChecked();
      expect(
        screen.getByRole('checkbox', { name: 'Assign it to me if unassigned' }),
      ).toBeChecked();
    });

    it('disables both options without a connection', () => {
      installFakeApi(handlers() as never);
      useStore.setState({
        repos: [webshop],
        connections: [conn],
        screen: repoScope,
      });
      render(<SettingsScreen />);
      expect(
        screen.getByRole('checkbox', {
          name: 'Move the work item to In Progress on start',
        }),
      ).toBeDisabled();
      expect(
        screen.getByRole('checkbox', {
          name: 'Assign it to me if unassigned',
        }),
      ).toBeDisabled();
    });

    it('saves when the move option is unticked', async () => {
      const { calls } = installFakeApi(handlers() as never);
      useStore.setState({
        repos: [linked],
        connections: [conn],
        screen: repoScope,
      });
      render(<SettingsScreen />);
      await userEvent.click(
        screen.getByRole('checkbox', {
          name: 'Move the work item to In Progress on start',
        }),
      );
      await waitFor(() =>
        expect(
          calls.find((c) => c.channel === 'repos:setWorkItemOnStart')?.args,
        ).toEqual([
          'r1',
          { moveToInProgress: false, assignToMe: true, stateOverrides: {} },
        ]),
      );
    });

    it('loads types when shown and sets an override', async () => {
      const { calls } = installFakeApi(handlers() as never);
      useStore.setState({
        repos: [linked],
        connections: [conn],
        screen: repoScope,
      });
      render(<SettingsScreen />);
      const select = await screen.findByLabelText('In Progress state for Task');
      expect(
        Array.from((select as HTMLSelectElement).options).map((o) => o.text),
      ).toEqual(['Default', 'Doing']);
      await userEvent.selectOptions(select, 'Doing');
      await waitFor(() =>
        expect(
          calls.filter((c) => c.channel === 'repos:setWorkItemOnStart').at(-1)
            ?.args,
        ).toEqual([
          'r1',
          {
            moveToInProgress: true,
            assignToMe: true,
            stateOverrides: { Task: 'Doing' },
          },
        ]),
      );
    });

    it('removes the key when Default is chosen', async () => {
      const withOverride: Repo = {
        ...linked,
        workItemOnStart: {
          moveToInProgress: true,
          assignToMe: true,
          stateOverrides: { Task: 'Doing' },
        },
      };
      const { calls } = installFakeApi(handlers() as never);
      useStore.setState({
        repos: [withOverride],
        connections: [conn],
        screen: repoScope,
      });
      render(<SettingsScreen />);
      const select = await screen.findByLabelText('In Progress state for Task');
      await userEvent.selectOptions(select, 'Default');
      await waitFor(() =>
        expect(
          calls.find((c) => c.channel === 'repos:setWorkItemOnStart')?.args[1],
        ).toEqual({
          moveToInProgress: true,
          assignToMe: true,
          stateOverrides: {},
        }),
      );
    });
  });

  it('About has a Get started link that brings the page back', async () => {
    const { defaultSettings } = await import('../../shared/usage');
    const dismissed = defaultSettings();
    dismissed.onboarding.dismissedAt = '2026-10-01T00:00:00.000Z';
    dismissed.onboarding.agentsCheckedAt = '2026-10-01T00:00:00.000Z';
    const { calls } = installFakeApi({
      'settings:get': () => dismissed,
      'settings:save': (next) => next,
    });
    render(<SettingsScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Get started' }),
    );
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'get-started' }),
    );
    expect(
      (calls.find((c) => c.channel === 'settings:save')?.args[0] as AppSettings)
        .onboarding.dismissedAt,
    ).toBeNull();
  });

  it('turns anonymous usage and error data off', async () => {
    const { calls } = installFakeApi({ 'settings:save': (next) => next });
    render(<SettingsScreen />);
    const box = await screen.findByRole('checkbox', {
      name: 'Send anonymous usage and error data',
    });
    await waitFor(() => expect(box).toBeChecked());
    await userEvent.click(box);
    expect(
      calls.find((c) => c.channel === 'settings:save')?.args[0],
    ).toMatchObject({ sendTelemetry: false, showSplash: true });
    await waitFor(() => expect(box).not.toBeChecked());
  });

  it('toggles the notify-on-done setting', async () => {
    const { calls } = installFakeApi({ 'settings:save': (next) => next });
    render(<SettingsScreen />);
    const box = await screen.findByRole('checkbox', {
      name: 'Notify when an agent finishes its turn',
    });
    await waitFor(() => expect(box).toBeChecked());
    await userEvent.click(box);
    expect(
      calls.find((c) => c.channel === 'settings:save')?.args[0],
    ).toMatchObject({ notifyOnDone: false });
    await waitFor(() => expect(box).not.toBeChecked());
  });

  it('picks the theme, starting at System', async () => {
    const { calls } = installFakeApi({ 'settings:save': (next) => next });
    render(<SettingsScreen />);
    const select = await screen.findByRole('combobox', { name: 'Theme' });
    await waitFor(() => expect(select).toHaveValue('system'));
    await userEvent.selectOptions(select, 'light');
    expect(
      calls.find((c) => c.channel === 'settings:save')?.args[0],
    ).toMatchObject({ theme: 'light' });
    await waitFor(() => expect(select).toHaveValue('light'));
  });

  it('keeps the chosen theme when another appearance setting is saved', async () => {
    const stored: AppSettings = {
      version: 1 as const,
      receiverPort: 4319,
      idleMinutes: 5,
      workHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
      showSplash: true,
      notifyOnDone: true,
      theme: 'light',
      claudeBudget: {
        monthlyEur: null,
        monthStartDay: 1,
        alerts: { at80: true, forecastOver: true, at100: true },
      },
      copilotBudget: {
        monthlyEur: null,
        monthStartDay: 1,
        alerts: { at80: true, forecastOver: true, at100: true },
      },
      sendTelemetry: true,
      editor: { default: null, repos: {} },
      secrets: { productionMinutes: 60 },
      onboarding: {
        dismissedAt: null,
        agentsCheckedAt: '2026-10-22T09:00:00.000Z',
        tracker: null,
        migrated: false,
      },
      defaultTerminals: {
        claude: true,
        copilot: false,
        opencode: false,
        shell: true,
      },
    };
    const { calls } = installFakeApi({
      'settings:get': () => stored,
      'settings:save': (next) => next,
    });
    render(<SettingsScreen />);
    const box = await screen.findByRole('checkbox', {
      name: 'Show splash on start',
    });
    await waitFor(() => expect(box).toBeChecked());
    await userEvent.click(box);
    expect(
      calls.find((c) => c.channel === 'settings:save')?.args[0],
    ).toMatchObject({ theme: 'light', showSplash: false });
  });

  it('toggles the splash setting', async () => {
    const { calls } = installFakeApi({ 'settings:save': (next) => next });
    render(<SettingsScreen />);
    const box = await screen.findByRole('checkbox', {
      name: 'Show splash on start',
    });
    await waitFor(() => expect(box).toBeChecked());
    await userEvent.click(box);
    expect(calls.find((c) => c.channel === 'settings:save')?.args[0]).toEqual({
      version: 1,
      receiverPort: 4319,
      idleMinutes: 5,
      workHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
      showSplash: false,
      notifyOnDone: true,
      theme: 'system',
      claudeBudget: {
        monthlyEur: null,
        monthStartDay: 1,
        alerts: { at80: true, forecastOver: true, at100: true },
      },
      copilotBudget: {
        monthlyEur: null,
        monthStartDay: 1,
        alerts: { at80: true, forecastOver: true, at100: true },
      },
      sendTelemetry: true,
      editor: { default: null, repos: {} },
      secrets: { productionMinutes: 60 },
      onboarding: {
        dismissedAt: null,
        agentsCheckedAt: '2026-10-22T09:00:00.000Z',
        tracker: null,
        migrated: false,
      },
      defaultTerminals: {
        claude: true,
        copilot: false,
        opencode: false,
        shell: true,
      },
    });
  });

  it('keeps fields saved by the other section', async () => {
    let stored: AppSettings = {
      version: 1 as const,
      receiverPort: 4319,
      idleMinutes: 5,
      workHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
      showSplash: true,
      notifyOnDone: true,
      theme: 'system',
      claudeBudget: {
        monthlyEur: null,
        monthStartDay: 1,
        alerts: { at80: true, forecastOver: true, at100: true },
      },
      copilotBudget: {
        monthlyEur: null,
        monthStartDay: 1,
        alerts: { at80: true, forecastOver: true, at100: true },
      },
      sendTelemetry: true,
      editor: { default: null, repos: {} },
      secrets: { productionMinutes: 60 },
      onboarding: {
        dismissedAt: null,
        agentsCheckedAt: '2026-10-22T09:00:00.000Z',
        tracker: null,
        migrated: false,
      },
      defaultTerminals: {
        claude: true,
        copilot: false,
        opencode: false,
        shell: true,
      },
    };
    const { calls } = installFakeApi({
      'settings:get': () => stored,
      'settings:save': (next) => {
        stored = next;
        return next;
      },
    });
    render(<SettingsScreen />);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Show splash on start' }),
    );
    const port = await screen.findByLabelText('Usage receiver port');
    await userEvent.clear(port);
    await userEvent.type(port, '4400');
    await userEvent.click(
      screen.getByRole('button', { name: 'Save settings' }),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'settings:save')).toHaveLength(
        2,
      ),
    );
    expect(
      calls.filter((c) => c.channel === 'settings:save')[1]?.args[0],
    ).toEqual({
      version: 1,
      receiverPort: 4400,
      idleMinutes: 5,
      workHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
      showSplash: false,
      notifyOnDone: true,
      theme: 'system',
      claudeBudget: {
        monthlyEur: null,
        monthStartDay: 1,
        alerts: { at80: true, forecastOver: true, at100: true },
      },
      copilotBudget: {
        monthlyEur: null,
        monthStartDay: 1,
        alerts: { at80: true, forecastOver: true, at100: true },
      },
      sendTelemetry: true,
      editor: { default: null, repos: {} },
      secrets: { productionMinutes: 60 },
      onboarding: {
        dismissedAt: null,
        agentsCheckedAt: '2026-10-22T09:00:00.000Z',
        tracker: null,
        migrated: false,
      },
      defaultTerminals: {
        claude: true,
        copilot: false,
        opencode: false,
        shell: true,
      },
    });
  });

  it('shows the About panel with the version', async () => {
    installFakeApi();
    render(<SettingsScreen />);
    const about = await screen.findByRole('region', { name: 'About' });
    expect(about).toHaveTextContent(
      'Development tasks as isolated workspaces, with AI cost per task',
    );
    expect(about).toHaveTextContent(
      'General Systems Vehicle (accounting division)',
    );
    await waitFor(() => expect(about).toHaveTextContent('1.0.0'));
  });

  it('has a Budgets entry in the side nav after Time tracking', () => {
    installFakeApi();
    render(<SettingsScreen />);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const links = [...nav.querySelectorAll('a')].map((a) => a.textContent);
    expect(links.indexOf('Budgets')).toBe(links.indexOf('Time tracking') + 1);
    expect(screen.getByRole('link', { name: 'Budgets' })).toHaveAttribute(
      'href',
      '#budgets',
    );
  });

  it('scrolls to the section the settings screen was opened on', async () => {
    installFakeApi();
    const scroll = vi.fn();
    const proto = Element.prototype as { scrollIntoView?: unknown };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = scroll;
    try {
      useStore.setState({
        screen: { kind: 'settings', section: 'budgets' },
      });
      const { container } = render(<SettingsScreen />);
      await waitFor(() => expect(scroll).toHaveBeenCalled());
      expect(scroll.mock.contexts[0]).toBe(container.querySelector('#budgets'));
    } finally {
      proto.scrollIntoView = original;
    }
  });

  it('keeps the section in view while the layout settles, until the user scrolls', async () => {
    installFakeApi();
    const scroll = vi.fn();
    const proto = Element.prototype as { scrollIntoView?: unknown };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = scroll;
    const originalRO = globalThis.ResizeObserver;
    const callbacks: Array<() => void> = [];
    globalThis.ResizeObserver = class {
      private cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
        callbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        callbacks.splice(callbacks.indexOf(this.cb), 1);
      }
    } as unknown as typeof ResizeObserver;
    try {
      useStore.setState({
        screen: { kind: 'settings', section: 'budgets' },
      });
      const { container } = render(<SettingsScreen />);
      await waitFor(() => expect(scroll).toHaveBeenCalled());
      expect(callbacks.length).toBeGreaterThan(0);
      const before = scroll.mock.calls.length;
      [...callbacks].forEach((cb) => cb());
      expect(scroll.mock.calls.length).toBe(before + 1);
      expect(scroll.mock.contexts.at(-1)).toBe(
        container.querySelector('#budgets'),
      );
      window.dispatchEvent(new Event('wheel'));
      [...callbacks].forEach((cb) => cb());
      expect(scroll.mock.calls.length).toBe(before + 1);
    } finally {
      proto.scrollIntoView = original;
      globalThis.ResizeObserver = originalRO;
    }
  });

  describe('shell', () => {
    const api2: Repo = {
      ...webshop,
      id: 'r2',
      name: 'api',
      path: '/src/api',
    };

    it('opens on the User scope by default', () => {
      installFakeApi();
      useStore.setState({ repos: [webshop] });
      render(<SettingsScreen />);
      expect(screen.getByRole('tab', { name: 'User' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('combobox', { name: 'Theme' })).toBeVisible();
      expect(screen.queryByRole('combobox', { name: 'Repository' })).toBeNull();
      expect(screen.getByRole('link', { name: 'Projects' })).toBeVisible();
    });

    it('Repository tab shows the chosen repo', async () => {
      const { tracked } = installFakeApi();
      window.localStorage.setItem('shellie.settings.repoId', 'r2');
      useStore.setState({ repos: [webshop, api2] });
      render(<SettingsScreen />);
      await userEvent.click(screen.getByRole('tab', { name: 'Repository' }));
      expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue(
        'r2',
      );
      expect(screen.getByText('/src/api')).toBeVisible();
      expect(screen.getByRole('link', { name: 'General' })).toBeVisible();
      expect(tracked).toContainEqual(
        expect.objectContaining({
          name: 'settings.scope',
          props: { scope: 'repo' },
        }),
      );
      expect(window.localStorage.getItem('shellie.settings.scope')).toBe(
        'repo',
      );
      await userEvent.selectOptions(
        screen.getByRole('combobox', { name: 'Repository' }),
        'r1',
      );
      expect(window.localStorage.getItem('shellie.settings.repoId')).toBe('r1');
    });

    it('deep link section ado scrolls in the User scope', async () => {
      installFakeApi();
      window.localStorage.setItem('shellie.settings.scope', 'repo');
      const scroll = vi.fn();
      const proto = Element.prototype as { scrollIntoView?: unknown };
      const original = proto.scrollIntoView;
      proto.scrollIntoView = scroll;
      try {
        useStore.setState({
          repos: [webshop],
          screen: { kind: 'settings', section: 'ado' },
        });
        const { container } = render(<SettingsScreen />);
        expect(screen.getByRole('tab', { name: 'User' })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await waitFor(() => expect(scroll).toHaveBeenCalled());
        expect(scroll.mock.contexts[0]).toBe(container.querySelector('#ado'));
      } finally {
        proto.scrollIntoView = original;
      }
    });

    it('deep link repoId opens the Repository scope on that repo', () => {
      installFakeApi();
      useStore.setState({
        repos: [webshop, api2],
        screen: { kind: 'settings', repoId: 'r2' },
      });
      render(<SettingsScreen />);
      expect(screen.getByRole('tab', { name: 'Repository' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue(
        'r2',
      );
    });

    it('the old repos deep link opens the remembered repo', () => {
      installFakeApi();
      window.localStorage.setItem('shellie.settings.repoId', 'r2');
      useStore.setState({
        repos: [webshop, api2],
        screen: { kind: 'settings', section: 'repos' },
      });
      render(<SettingsScreen />);
      expect(screen.getByRole('tab', { name: 'Repository' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue(
        'r2',
      );
    });

    it('the old repos deep link opens the first repo when the remembered one is gone', () => {
      installFakeApi();
      window.localStorage.setItem('shellie.settings.repoId', 'gone');
      useStore.setState({
        repos: [webshop, api2],
        screen: { kind: 'settings', section: 'repos' },
      });
      render(<SettingsScreen />);
      expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue(
        'r1',
      );
    });

    it('searching secrets keeps the Secrets entry and no empty state', async () => {
      installFakeApi();
      render(<SettingsScreen />);
      await userEvent.type(
        screen.getByRole('searchbox', { name: 'Search settings' }),
        'secrets',
      );
      expect(screen.getByRole('link', { name: 'Secrets' })).toBeVisible();
      expect(screen.queryByText(/No settings match/)).toBeNull();
    });

    it("search 'env' finds the Secrets category", async () => {
      installFakeApi();
      useStore.setState({ repos: [webshop] });
      render(<SettingsScreen />);
      await userEvent.type(
        screen.getByRole('searchbox', { name: 'Search settings' }),
        'env',
      );
      const link = screen.getByRole('link', { name: 'Secrets' });
      expect(link).toBeVisible();
      expect(link).toHaveAttribute('href', '#secrets');
      expect(document.getElementById('secrets')).toBeVisible();
      expect(document.getElementById('secrets-repo-r1')).toBeInTheDocument();
    });

    it('finds the agent commands row by the words of its description', async () => {
      installFakeApi();
      useStore.setState({ repos: [webshop], screen: repoScope });
      render(<SettingsScreen />);
      await userEvent.type(
        screen.getByRole('searchbox', { name: 'Search settings' }),
        'permission mode',
      );
      expect(
        screen.getByLabelText('Claude Code command for webshop'),
      ).toBeVisible();
    });

    it('search filters across categories and offers the other scope', async () => {
      const { tracked } = installFakeApi();
      useStore.setState({ repos: [webshop] });
      render(<SettingsScreen />);
      await userEvent.type(
        screen.getByRole('searchbox', { name: 'Search settings' }),
        'connection',
      );
      expect(screen.getByRole('link', { name: 'Projects' })).toBeVisible();
      expect(screen.queryByRole('link', { name: 'Appearance' })).toBeNull();
      expect(screen.queryByRole('combobox', { name: 'Theme' })).toBeNull();
      const searches = () =>
        tracked.filter((t) => 'name' in t && t.name === 'settings.search');
      await waitFor(
        () =>
          expect(searches()).toEqual([
            expect.objectContaining({ props: { results: 2 } }),
          ]),
        { timeout: 2000 },
      );
      await userEvent.click(
        screen.getByRole('button', { name: '1 result in Repository' }),
      );
      expect(screen.getByRole('tab', { name: 'Repository' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByLabelText('Project for webshop')).toBeVisible();
      expect(
        screen.getByRole('button', { name: '2 results in User' }),
      ).toBeVisible();
      // Same query in the other scope: not sent again.
      await new Promise((r) => setTimeout(r, 1200));
      expect(searches()).toHaveLength(1);
      expect(JSON.stringify(tracked)).not.toContain('connection');
    });

    it('no match shows the empty state', async () => {
      installFakeApi();
      render(<SettingsScreen />);
      await userEvent.type(
        screen.getByRole('searchbox', { name: 'Search settings' }),
        'zzzz',
      );
      expect(
        screen.getByText(
          `No settings match ${String.fromCharCode(8220)}zzzz${String.fromCharCode(8221)}`,
        ),
      ).toBeVisible();
    });

    it('Cmd+F focuses the search box', async () => {
      installFakeApi();
      render(<SettingsScreen />);
      await userEvent.keyboard('{Meta>}f{/Meta}');
      expect(
        screen.getByRole('searchbox', { name: 'Search settings' }),
      ).toHaveFocus();
    });

    it('the pivot has three scopes with connections and two without', () => {
      installFakeApi();
      const { unmount } = render(<SettingsScreen />);
      expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
        'User',
        'Repository',
      ]);
      expect(screen.queryByRole('combobox', { name: 'Project' })).toBeNull();
      unmount();
      useStore.setState({ connections: [shop, platform] });
      render(<SettingsScreen />);
      expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
        'User',
        'Project',
        'Repository',
      ]);
    });

    it('the picked project starts at the active project, not the remembered one', async () => {
      installFakeApi();
      window.localStorage.setItem('shellie.settings.scope', 'project');
      window.localStorage.setItem('shellie.settings.connectionId', 'c2');
      useStore.setState({ connections: [shop, platform], connectionId: 'c1' });
      render(<SettingsScreen />);
      expect(screen.getByRole('tab', { name: 'Project' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      const picker = screen.getByRole('combobox', { name: 'Project' });
      expect(picker).toHaveValue('c1');
      expect(
        screen.getByRole('option', { name: 'contoso / Platform' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Brains' })).toBeVisible();
      expect(document.getElementById('project-connection')).toBeVisible();
      await userEvent.selectOptions(picker, 'c2');
      expect(window.localStorage.getItem('shellie.settings.connectionId')).toBe(
        'c2',
      );
      // Settings-local: the nav's project stays.
      expect(useStore.getState().connectionId).toBe('c1');
    });

    it('a nav project change while Settings is open leaves the picker alone', () => {
      installFakeApi();
      useStore.setState({
        connections: [shop, platform],
        connectionId: 'c1',
        screen: { kind: 'settings', scope: 'project' },
      });
      render(<SettingsScreen />);
      act(() => useStore.setState({ connectionId: 'c2' }));
      expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(
        'c1',
      );
    });

    it("a repoId deep link picks that repo's project", () => {
      installFakeApi();
      window.localStorage.setItem('shellie.settings.connectionId', 'c1');
      const loose: Repo = { ...webshop, id: 'r3', name: 'scripts' };
      useStore.setState({
        connections: [shop, platform],
        repos: [
          { ...webshop, connectionId: 'c1' },
          { ...api2, connectionId: 'c2' },
          loose,
        ],
        screen: { kind: 'settings', repoId: 'r2' },
      });
      render(<SettingsScreen />);
      expect(screen.getByRole('tab', { name: 'Repository' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(
        'c2',
      );
      const repoPicker = screen.getByRole('combobox', { name: 'Repository' });
      expect(repoPicker).toHaveValue('r2');
      expect(screen.queryByRole('option', { name: 'webshop' })).toBeNull();
      const group = screen.getByRole('group', { name: 'No project' });
      expect(group).toContainElement(
        screen.getByRole('option', { name: 'scripts' }),
      );
    });

    it.each([
      ['in the picked project', 'c1'],
      ['in No project', null],
    ])(
      'a repo %s moved to another project stays on screen, and the picker follows it',
      async (_, from) => {
        const moved = { ...api2, connectionId: 'c2' };
        const { emit } = installFakeApi({
          'repos:setConnection': () => moved,
        });
        useStore.setState({
          connections: [shop, platform],
          connectionId: 'c1',
          repos: [
            { ...webshop, connectionId: 'c1' },
            { ...api2, connectionId: from },
          ],
          screen: { kind: 'settings', repoId: 'r2' },
        });
        // A No project repo opens on the active project.
        render(<SettingsScreen />);
        expect(
          screen.getByRole('combobox', { name: 'Repository' }),
        ).toHaveValue('r2');
        await userEvent.selectOptions(
          screen.getByLabelText('Project for api'),
          'c2',
        );
        const next = [{ ...webshop, connectionId: 'c1' }, moved];
        act(() => {
          useStore.setState({ repos: next });
          emit('repos:changed', next);
        });
        expect(
          screen.getByRole('combobox', { name: 'Repository' }),
        ).toHaveValue('r2');
        expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(
          'c2',
        );
        expect(window.localStorage.getItem('shellie.settings.repoId')).toBe(
          'r2',
        );
        // Settings-local: the nav's project stays.
        expect(useStore.getState().connectionId).toBe('c1');
      },
    );

    it('the project-brains-new deep link opens Project > Brains with the create form focused', async () => {
      installFakeApi();
      const proto = Element.prototype as unknown as {
        scrollIntoView?: () => void;
      };
      const original = proto.scrollIntoView;
      const scrolled: string[] = [];
      proto.scrollIntoView = function (this: Element) {
        scrolled.push(this.id);
      };
      try {
        useStore.setState({
          connections: [shop, platform],
          connectionId: 'c1',
          screen: {
            kind: 'settings',
            scope: 'project',
            connectionId: 'c2',
            section: 'project-brains-new',
          },
        });
        render(<SettingsScreen />);
        expect(screen.getByRole('tab', { name: 'Project' })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        const form = screen.getByRole('form', { name: 'New brain' });
        await waitFor(() =>
          expect(within(form).getByLabelText('Name')).toHaveFocus(),
        );
        expect(within(form).getByLabelText('Name')).toHaveValue(
          'Platform brain',
        );
        expect(scrolled).toContain('project-brains-new');
      } finally {
        proto.scrollIntoView = original;
      }
    });

    it('a project deep link opens the Project scope on that project', () => {
      installFakeApi();
      useStore.setState({
        connections: [shop, platform],
        connectionId: 'c1',
        screen: {
          kind: 'settings',
          scope: 'project',
          connectionId: 'c2',
          section: 'project-brains',
        },
      });
      render(<SettingsScreen />);
      expect(screen.getByRole('tab', { name: 'Project' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(
        'c2',
      );
    });

    it('a brains deep link opens the Project scope', () => {
      installFakeApi();
      useStore.setState({
        connections: [shop],
        screen: { kind: 'settings', section: 'brains' },
      });
      render(<SettingsScreen />);
      expect(screen.getByRole('tab', { name: 'Project' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('a project deep link without connections opens the User scope', () => {
      installFakeApi();
      useStore.setState({ screen: { kind: 'settings', scope: 'project' } });
      render(<SettingsScreen />);
      expect(screen.getByRole('tab', { name: 'User' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('search counts name both other scopes', async () => {
      installFakeApi();
      useStore.setState({
        connections: [shop],
        repos: [webshop],
        screen: { kind: 'settings', scope: 'project' },
      });
      render(<SettingsScreen />);
      await userEvent.type(
        screen.getByRole('searchbox', { name: 'Search settings' }),
        'connection',
      );
      expect(
        screen.getByRole('button', { name: '2 results in User' }),
      ).toBeVisible();
      expect(
        screen.getByRole('button', { name: '1 result in Repository' }),
      ).toBeVisible();
      await userEvent.click(
        screen.getByRole('button', { name: '1 result in Repository' }),
      );
      expect(screen.getByRole('tab', { name: 'Repository' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(
        screen.getByRole('button', { name: '2 results in User' }),
      ).toBeVisible();
      expect(
        screen.getByRole('button', { name: '4 results in Project' }),
      ).toBeVisible();
    });

    it('no repos: Repository tab shows Add folder', async () => {
      installFakeApi();
      render(<SettingsScreen />);
      await userEvent.click(screen.getByRole('tab', { name: 'Repository' }));
      expect(screen.getByText(/No repositories yet/)).toBeVisible();
      expect(screen.getByRole('button', { name: ADD_FOLDER })).toBeVisible();
      expect(screen.queryByRole('combobox', { name: 'Repository' })).toBeNull();
    });
  });
});
