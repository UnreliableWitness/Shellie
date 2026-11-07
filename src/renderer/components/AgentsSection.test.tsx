import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DefaultTerminals } from '../../shared/terminals';
import { defaultSettings, type AppSettings } from '../../shared/usage';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { AgentsSection } from './AgentsSection';

beforeEach(() => useStore.setState({ notices: [] }));

const settingsWith = (
  checked: string | null,
  terminals: Record<string, boolean>,
) => ({
  'settings:get': () => ({
    ...defaultSettings(),
    defaultTerminals: terminals as DefaultTerminals,
    onboarding: {
      dismissedAt: null,
      agentsCheckedAt: checked,
      tracker: null,
      brain: null,
      migrated: false,
    },
  }),
  'settings:save': (s: AppSettings) => s,
});

const saves = (calls: { channel: string; args: unknown[] }[]) =>
  calls.filter((c) => c.channel === 'settings:save').map((c) => c.args[0]);

describe('AgentsSection', () => {
  it('shows what is found and the install command of what is not', async () => {
    installFakeApi(
      settingsWith('2026-10-22T09:00:00.000Z', {
        claude: true,
        copilot: false,
        opencode: false,
        shell: true,
      }),
    );
    render(<AgentsSection />);
    expect(await screen.findByText('Found · 2.1.307')).toBeInTheDocument();
    expect(screen.getAllByText('Not found')).toHaveLength(2);
    expect(screen.getByText('npm i -g @github/copilot')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
    expect(screen.getByText('zsh')).toBeInTheDocument();
  });

  it('pre-ticks once on first open in a single save', async () => {
    const { calls } = installFakeApi(
      settingsWith(null, {
        claude: false,
        copilot: false,
        opencode: false,
        shell: false,
      }),
    );
    render(<AgentsSection />);
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0]).toEqual(
      expect.objectContaining({
        defaultTerminals: {
          claude: true,
          copilot: false,
          opencode: false,
          shell: true,
        },
        onboarding: {
          dismissedAt: null,
          agentsCheckedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
          tracker: null,
          brain: null,
          migrated: false,
        },
      }),
    );
  });

  it('does not save on open once it has been checked', async () => {
    const { calls } = installFakeApi(
      settingsWith('2026-10-22T09:00:00.000Z', {
        claude: false,
        copilot: false,
        opencode: true,
        shell: true,
      }),
    );
    render(<AgentsSection />);
    expect(
      await screen.findByRole('checkbox', { name: /OpenCode/ }),
    ).toBeChecked();
    expect(saves(calls)).toHaveLength(0);
  });

  it('saves a click at once', async () => {
    const { calls } = installFakeApi(
      settingsWith('2026-10-22T09:00:00.000Z', {
        claude: true,
        copilot: false,
        opencode: false,
        shell: true,
      }),
    );
    render(<AgentsSection />);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: /OpenCode/ }),
    );
    await waitFor(() =>
      expect(saves(calls).at(-1)).toEqual(
        expect.objectContaining({
          defaultTerminals: {
            claude: true,
            copilot: false,
            opencode: true,
            shell: true,
          },
        }),
      ),
    );
  });

  it('shows the info card only when two agents are ticked', async () => {
    const f = { found: true, version: '1', path: '/x' };
    installFakeApi({
      ...settingsWith('2026-10-22T09:00:00.000Z', {
        claude: true,
        copilot: false,
        opencode: false,
        shell: true,
      }),
      'agents:detect': () => ({
        checkedAt: 'x',
        agents: { claude: f, copilot: { ...f, found: false }, opencode: f },
        shell: { label: 'zsh' },
      }),
    });
    render(<AgentsSection />);
    await screen.findAllByText(/^Found/);
    expect(screen.queryByText(/Both found/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /OpenCode/ }));
    expect(await screen.findByText(/Most people keep one/)).toBeInTheDocument();
  });

  it('says so when no agent CLI is found', async () => {
    const none = { found: false, version: null, path: null };
    installFakeApi({
      ...settingsWith('2026-10-22T09:00:00.000Z', {
        claude: false,
        copilot: false,
        opencode: false,
        shell: true,
      }),
      'agents:detect': () => ({
        checkedAt: 'x',
        agents: { claude: none, copilot: none, opencode: none },
        shell: { label: 'zsh' },
      }),
    });
    render(<AgentsSection />);
    expect(
      await screen.findByText(
        /No agent CLI found\. Shellie works with a shell/,
      ),
    ).toBeInTheDocument();
  });

  it('Check again forces a new detection', async () => {
    const { calls } = installFakeApi(
      settingsWith('2026-10-22T09:00:00.000Z', {
        claude: true,
        copilot: false,
        opencode: false,
        shell: true,
      }),
    );
    render(<AgentsSection />);
    await screen.findByText('Found · 2.1.307');
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.channel === 'agents:detect').at(-1)?.args[0],
      ).toBe(true),
    );
  });

  it('keeps the section usable when detection fails', async () => {
    const { calls } = installFakeApi({
      ...settingsWith('2026-10-22T09:00:00.000Z', {
        claude: true,
        copilot: false,
        opencode: false,
        shell: true,
      }),
      'agents:detect': () => {
        throw new Error('boom');
      },
    });
    render(<AgentsSection />);
    expect(
      await screen.findByText('Could not check which agents are installed.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.channel === 'agents:detect').at(-1)?.args[0],
      ).toBe(true),
    );
  });

  it('labels a ticked, found OpenCode as the default agent', async () => {
    const found = { found: true, version: '1.19.3', path: '/x' };
    const none = { found: false, version: null, path: null };
    installFakeApi({
      ...settingsWith('2026-10-22T09:00:00.000Z', {
        claude: false,
        copilot: false,
        opencode: true,
        shell: true,
      }),
      'agents:detect': () => ({
        checkedAt: 'x',
        agents: { claude: none, copilot: none, opencode: found },
        shell: { label: 'zsh' },
      }),
    });
    render(<AgentsSection />);
    const row = (await screen.findByText('OpenCode')).closest('tr');
    expect(row).toHaveTextContent('Default agent');
  });
});
