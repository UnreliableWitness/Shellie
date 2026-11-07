import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../shared/usage';
import { defaultSettings } from '../../shared/usage';
import { Shell } from '../App';
import { useStore } from '../store';
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

function open(s: AppSettings = settings()) {
  useStore.setState({
    screen: { kind: 'get-started' },
    previous: null,
    notices: [],
    repos: [],
    tasks: [],
    connections: [],
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
      within(card('2 · Connect your tracker')).getByRole('button', {
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
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
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
