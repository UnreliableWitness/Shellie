import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../shared/usage';
import type { Repo } from '../../shared/types';
import { useStore } from '../store';
import { installFakeApi, noOverrides } from '../test-helpers/fakeApi';
import { SettingsScreen } from './SettingsScreen';

const DOT = String.fromCharCode(183);
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

beforeEach(() => {
  useStore.setState({
    repos: [],
    tasks: [],
    connections: [],
    notices: [],
    screen: { kind: 'settings' },
  });
});

describe('SettingsScreen', () => {
  it('lists repos with their base branch and .shellie.yml status', () => {
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
    });
    render(<SettingsScreen />);
    expect(screen.getByText('webshop')).toBeInTheDocument();
    expect(
      screen.getByText(`/src/webshop ${DOT} base main`),
    ).toBeInTheDocument();
    expect(screen.getByText('.shellie.yml found')).toBeInTheDocument();
    expect(
      screen.getByText('No .shellie.yml, using defaults'),
    ).toBeInTheDocument();
  });

  it('marks a discovered repo and lets the user make it normal', async () => {
    const { calls } = installFakeApi({
      'repos:setDiscovered': () => ({ ...webshop, discovered: false }),
    });
    useStore.setState({ repos: [{ ...webshop, discovered: true }] });
    render(<SettingsScreen />);
    expect(screen.getByText('Found in a task')).toBeInTheDocument();
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

  it('shows the effective config for a repo', async () => {
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
    useStore.setState({ repos: [webshop] });
    render(<SettingsScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'Show setup' }));
    await waitFor(() =>
      expect(screen.getByText(/dev: npm run dev/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/copy: \[\.env\]/)).toBeInTheDocument();
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
        },
      ],
    });
    render(<SettingsScreen />);
    await userEvent.selectOptions(
      screen.getByLabelText('Connection for webshop'),
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
    });
    render(<SettingsScreen />);
    await userEvent.click(screen.getByText('Agent commands'));
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
      useStore.setState({ repos: [linked], connections: [conn] });
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

    it('shows neither option without a connection', () => {
      installFakeApi(handlers() as never);
      useStore.setState({ repos: [webshop], connections: [conn] });
      render(<SettingsScreen />);
      expect(
        screen.queryByRole('checkbox', {
          name: 'Move the work item to In Progress on start',
        }),
      ).toBeNull();
      expect(
        screen.queryByRole('checkbox', {
          name: 'Assign it to me if unassigned',
        }),
      ).toBeNull();
    });

    it('saves when the move option is unticked', async () => {
      const { calls } = installFakeApi(handlers() as never);
      useStore.setState({ repos: [linked], connections: [conn] });
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

    it('loads types on open and sets and clears an override', async () => {
      const { calls } = installFakeApi(handlers() as never);
      useStore.setState({ repos: [linked], connections: [conn] });
      render(<SettingsScreen />);
      expect(calls.some((c) => c.channel === 'workItems:types')).toBe(false);
      await userEvent.click(screen.getByText('Override per type'));
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
      useStore.setState({ repos: [withOverride], connections: [conn] });
      render(<SettingsScreen />);
      await userEvent.click(screen.getByText('Override per type'));
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
      writeTimeToAdo: false,
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
      writeTimeToAdo: false,
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
      writeTimeToAdo: false,
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
      writeTimeToAdo: false,
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
});
