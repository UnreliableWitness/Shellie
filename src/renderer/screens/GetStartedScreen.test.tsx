import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '../../shared/types';
import type { AppSettings } from '../../shared/usage';
import { defaultSettings } from '../../shared/usage';
import { Shell } from '../App';
import { useStore } from '../store';
import { listedBrain } from '../test-helpers/brainFixture';
import { installFakeApi } from '../test-helpers/fakeApi';

vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }));

const settings = (
  onboarding: Partial<AppSettings['onboarding']> = {},
): AppSettings => ({
  ...defaultSettings(),
  defaultTerminals: {
    claude: false,
    copilot: false,
    opencode: true,
    shell: true,
  },
  onboarding: {
    dismissedAt: null,
    agentsCheckedAt: '2026-10-22T09:00:00.000Z',
    tracker: null,
    brain: null,
    migrated: false,
    ...onboarding,
  },
});

const detected = {
  checkedAt: '2026-10-22T10:00:00.000Z',
  agents: {
    claude: { found: true, version: '2.1.307', path: '/bin/claude' },
    copilot: { found: false, version: null, path: null },
    opencode: { found: true, version: '1.19.3', path: '/bin/opencode' },
  },
  shell: { label: 'zsh' },
};

const conn: Connection = {
  id: 'c1',
  name: 'unreliablewitness/Shellie',
  organizationUrl: 'https://dev.azure.com/unreliablewitness',
  project: 'Shellie',
  user: 'Dries Hoebeke',
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
};

const found = (claude: boolean, opencode: boolean) => ({
  ...detected,
  agents: {
    ...detected.agents,
    claude: claude ? detected.agents.claude : detected.agents.copilot,
    opencode: opencode ? detected.agents.opencode : detected.agents.copilot,
  },
});

function open(s: AppSettings = settings(), connections: Connection[] = []) {
  useStore.setState({
    screen: { kind: 'get-started' },
    previous: null,
    notices: [],
    repos: [],
    tasks: [],
    connections,
    settings: s,
  });
}

const card = (name: string) => screen.getByRole('region', { name });

beforeEach(() => open());

describe('Get started page', () => {
  it('names the found agents and the tabs new tasks open', async () => {
    const { tracked } = installFakeApi({ 'agents:detect': () => detected });
    render(<Shell />);
    expect(
      await within(card('1 · Agents')).findByText(
        'Found Claude Code 2.1.307 and OpenCode 1.19.3 on this machine. New tasks open OpenCode and a shell.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Welcome to Shellie' }),
    ).toBeTruthy();
    expect(tracked).toContainEqual({ type: 'event', name: 'onboarding.shown' });
  });

  it('with Agents done, Connect is the primary button and Agents is ticked', async () => {
    installFakeApi({ 'agents:detect': () => detected });
    render(<Shell />);
    expect(
      within(card('2 · Connect Azure DevOps')).getByRole('button', {
        name: 'Connect',
      }),
    ).toHaveClass('btn-primary');
    expect(
      within(card('1 · Agents')).getByRole('button', { name: 'Change' }),
    ).not.toHaveClass('btn-primary');
    expect(within(card('1 · Agents')).getByLabelText('Done')).toBeTruthy();
    expect(
      within(card('3 · Add a repository')).getByRole('button', {
        name: 'Add folder…',
      }),
    ).not.toHaveClass('btn-primary');
  });

  it('a fresh install has Agents current with an Open button, naming the found agents and the tabs it will tick', async () => {
    open(settings({ agentsCheckedAt: null }));
    const { calls } = installFakeApi({ 'agents:detect': () => detected });
    render(<Shell />);
    expect(
      within(card('1 · Agents')).getByRole('button', { name: 'Open' }),
    ).toHaveClass('btn-primary');
    expect(
      await within(card('1 · Agents')).findByText(
        'Found Claude Code 2.1.307 and OpenCode 1.19.3 on this machine. New tasks open Claude Code and a shell.',
      ),
    ).toBeTruthy();
    // The cached detection: the page never forces a fresh probe.
    expect(
      calls.filter((c) => c.channel === 'agents:detect').map((c) => c.args),
    ).toEqual([[false]]);
  });

  it('Skip for now saves dismissedAt and goes Home', async () => {
    const saved: AppSettings[] = [];
    const { tracked } = installFakeApi({
      'settings:get': () => settings(),
      'settings:save': (s) => {
        saved.push(s);
        return s;
      },
    });
    render(<Shell />);
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'home' }),
    );
    expect(saved[0].onboarding.dismissedAt).toEqual(expect.any(String));
    expect(useStore.getState().settings?.onboarding.dismissedAt).toEqual(
      expect.any(String),
    );
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'onboarding.dismissed',
      props: { repos: 0, connections: 0 },
    });
  });

  it('Add folder… picks a folder and opens Add a repository on it', async () => {
    installFakeApi({ 'repos:pickFolder': () => '/src/webshop' });
    render(<Shell />);
    await userEvent.click(screen.getByRole('button', { name: 'Add folder…' }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({
        kind: 'add-repo',
        from: 'get-started',
        folder: '/src/webshop',
      }),
    );
  });

  it('Connect opens the Connect step, Change the Agents step', async () => {
    installFakeApi();
    render(<Shell />);
    await userEvent.click(
      within(card('2 · Connect Azure DevOps')).getByRole('button', {
        name: 'Connect',
      }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'connect',
      from: 'get-started',
    });
    act(() => open());
    await userEvent.click(
      await screen.findByRole('button', { name: 'Change' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'agents',
      from: 'get-started',
    });
  });
});

describe('Get started texts', () => {
  const BRAIN = '4 · A brain for your project';
  const BRAIN_TODO =
    "A local wiki of the project's documents, kept by your agent, that every task can read. Optional.";

  it('a fresh install shows the four cards with their texts and What you get', async () => {
    open(settings({ agentsCheckedAt: null }));
    installFakeApi({ 'agents:detect': () => detected });
    render(<Shell />);
    expect(
      screen.getByText(
        'A task is a git worktree with its own agent tabs, tied to a work item, with the AI cost and time it took. A few short steps and your sprint is on this page.',
      ),
    ).toBeTruthy();
    for (const title of [
      '1 · Agents',
      '2 · Connect Azure DevOps',
      '3 · Add a repository',
      BRAIN,
    ])
      expect(card(title)).toBeTruthy();
    expect(
      within(card('2 · Connect Azure DevOps')).getByText(
        'Shellie reads your sprint, moves the work item when a task starts and opens draft pull requests. GitHub later.',
      ),
    ).toBeTruthy();
    // No connection yet: the brain has no project to build on, so its button connects one.
    expect(
      within(card(BRAIN)).getByText(`${BRAIN_TODO} Connect a project first.`),
    ).toBeTruthy();
    expect(within(card(BRAIN)).queryByLabelText('Done')).toBeNull();
    const gets = screen.getByRole('heading', {
      name: 'What you get',
    }).parentElement!;
    expect(
      within(gets)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Start on a sprint item → worktree, branch, setup, agent tabs',
      'Claude Code, OpenCode and Copilot cost per task, priced in EUR',
      'A brain per project: your documents and wiki, kept as pages your agent reads',
      'Time, changes review, Docs, draft PR at Finish',
    ]);
    expect(document.body.textContent).not.toContain('writes cost');
    await userEvent.click(
      within(card(BRAIN)).getByRole('button', { name: 'Connect' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'connect',
      from: 'get-started',
    });
  });

  it.each([
    [true, true, 'Runs on Claude Code.'],
    [true, false, 'Runs on Claude Code.'],
    [false, true, 'Runs on OpenCode.'],
    [false, false, 'Needs Claude Code or OpenCode.'],
  ])(
    'with a project, Claude %s and OpenCode %s, the brain card says %s',
    async (claude, opencode, runs) => {
      open(settings(), [conn]);
      installFakeApi({ 'agents:detect': () => found(claude, opencode) });
      render(<Shell />);
      expect(
        await within(card(BRAIN)).findByText(`${BRAIN_TODO} ${runs}`),
      ).toBeTruthy();
    },
  );

  it('with no tracker the brain card is done, needs a connected project and offers Connect', async () => {
    open(settings({ tracker: 'none' }));
    installFakeApi({ 'agents:detect': () => detected });
    render(<Shell />);
    expect(
      within(card(BRAIN)).getByText('Needs a connected project.'),
    ).toBeTruthy();
    expect(within(card(BRAIN)).getByLabelText('Done')).toBeTruthy();
    expect(
      within(card(BRAIN)).queryByRole('button', { name: 'Open' }),
    ).toBeNull();
    await userEvent.click(
      within(card(BRAIN)).getByRole('button', { name: 'Connect' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'connect',
      from: 'get-started',
    });
  });

  it('a skipped brain says Skipped.', async () => {
    open(settings({ brain: 'none' }), [conn]);
    installFakeApi({ 'agents:detect': () => detected });
    render(<Shell />);
    expect(within(card(BRAIN)).getByText('Skipped.')).toBeTruthy();
  });

  it('made brains are named with their agent and Open goes to Settings › Project › Brains', async () => {
    open(settings(), [conn]);
    installFakeApi({
      'agents:detect': () => detected,
      'brain:list': () => [
        listedBrain({ name: 'Acme' }),
        listedBrain({
          id: 'b2',
          name: 'Infra',
          options: { ...listedBrain().options, agent: 'opencode' },
        }),
        listedBrain({ id: 'b3', name: 'Old', archived: true }),
      ],
    });
    render(<Shell />);
    expect(
      await within(card(BRAIN)).findByText(
        'Acme on Claude Code and Infra on OpenCode.',
      ),
    ).toBeTruthy();
    await userEvent.click(
      within(card(BRAIN)).getByRole('button', { name: 'Open' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      scope: 'project',
      connectionId: 'c1',
      section: 'project-brains',
    });
  });

  it('Create brain… opens the brain step', async () => {
    open(settings(), [conn]);
    installFakeApi();
    render(<Shell />);
    await userEvent.click(
      within(card(BRAIN)).getByRole('button', { name: 'Create brain…' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'brain-new',
      from: 'get-started',
    });
  });
});

describe('Agents step page', () => {
  it('has the step strip and Continue goes to the next unfinished step', async () => {
    useStore.setState({ screen: { kind: 'agents', from: 'get-started' } });
    const { tracked } = installFakeApi();
    render(<Shell />);
    expect(screen.getByRole('list', { name: 'Setup steps' })).toBeTruthy();
    await screen.findByRole('checkbox', { name: 'Claude Code' });
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'connect',
      from: 'get-started',
    });
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'onboarding.step',
      props: { step: 'agents', outcome: 'continued' },
    });
  });

  it('Back returns to Get started', async () => {
    useStore.setState({
      screen: { kind: 'agents', from: 'get-started' },
      previous: { kind: 'get-started' },
    });
    const { tracked } = installFakeApi();
    render(<Shell />);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(useStore.getState().screen).toEqual({ kind: 'get-started' });
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'onboarding.step',
      props: { step: 'agents', outcome: 'back' },
    });
  });
});
