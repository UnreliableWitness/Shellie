import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from '../../../shared/types';
import { type AppSettings, defaultSettings } from '../../../shared/usage';
import { BudgetSection } from '../../components/BudgetSection';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { SettingsScreen } from '../SettingsScreen';

const conn: Connection = {
  id: 'c1',
  name: 'unreliablewitness',
  organizationUrl: 'https://dev.azure.com/unreliablewitness',
  project: 'Shellie',
  user: 'Dries Hoebeke',
  status: 'ok',
  checkedAt: '2026-10-14T10:00:00.000Z',
  userUniqueName: null,
  provider: 'azure-devops' as const,
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
  writeTimeToAdo: false,
};

const settings = (patch: Partial<AppSettings>): AppSettings => ({
  ...defaultSettings(),
  onboarding: {
    ...defaultSettings().onboarding,
    agentsCheckedAt: '2026-10-22T09:00:00.000Z',
  },
  ...patch,
});

/** The row element of a setting, found by its "Category: Title" heading. */
const row = (text: string) => {
  const title = screen
    .getAllByText((_, el) => el?.classList.contains('setting-title') ?? false)
    .find((el) => el.textContent === text);
  if (!title) throw new Error(`No row ${text}`);
  return title.closest('.setting-row') as HTMLElement;
};

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

describe('UserScope rows', () => {
  it('theme row shows modified when not system and Reset saves system', async () => {
    let stored = settings({ theme: 'dark' });
    const { calls } = installFakeApi({
      'settings:get': () => stored,
      'settings:save': (next) => (stored = next),
    });
    render(<SettingsScreen />);
    const select = await screen.findByRole('combobox', { name: 'Theme' });
    await waitFor(() => expect(select).toHaveValue('dark'));
    const theme = row('Appearance: Theme');
    expect(theme).toHaveAttribute('data-modified', 'true');
    await userEvent.click(
      within(theme).getByRole('button', { name: 'More actions for Theme' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reset' }));
    await waitFor(() => expect(select).toHaveValue('system'));
    expect(
      calls.filter((c) => c.channel === 'settings:save').at(-1)?.args[0],
    ).toMatchObject({ theme: 'system' });
    expect(row('Appearance: Theme')).not.toHaveAttribute('data-modified');
  });

  it("search 'idle' finds Time tracking: Idle minutes only", async () => {
    installFakeApi();
    render(<SettingsScreen />);
    await screen.findByLabelText('Idle minutes');
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search settings' }),
      'idle',
    );
    const rows = document.querySelectorAll('.settings-scope .setting-row');
    expect(
      [...rows].map((r) => r.querySelector('.setting-title')?.textContent),
    ).toEqual(['Time tracking: Idle minutes']);
    expect(screen.getByRole('link', { name: 'Time tracking' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Appearance' })).toBeNull();
  });

  it('budgets row is read-only when managed', async () => {
    installFakeApi({
      'settings:get': () =>
        settings({
          claudeBudget: {
            monthlyEur: 300,
            monthStartDay: 5,
            alerts: { at80: true, forecastOver: true, at100: true },
          },
        }),
    });
    render(<BudgetSection managed={{ claude: true, copilot: false }} />);
    const claude = within(
      await screen.findByRole('group', { name: 'Claude budget' }),
    );
    expect(claude.getByLabelText('Monthly budget (€)')).toBeDisabled();
    const amount = row('Budgets: Claude monthly budget');
    expect(amount).not.toHaveAttribute('data-modified');
    await userEvent.click(
      within(amount).getByRole('button', {
        name: 'More actions for Claude monthly budget',
      }),
    );
    expect(screen.getByRole('menuitem', { name: 'Reset' })).toBeDisabled();
  });

  it('deep link conn-<id> still opens the token form', async () => {
    installFakeApi();
    useStore.setState({
      connections: [conn],
      screen: { kind: 'settings', section: 'conn-c1' },
    });
    render(<SettingsScreen />);
    expect(screen.getByRole('tab', { name: 'User' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByLabelText('New personal access token')).toBeVisible();
    expect(document.getElementById('conn-c1')).toBeVisible();
    expect(row('Projects: Azure DevOps')).toContainElement(
      document.getElementById('conn-c1'),
    );
  });

  it('Projects lists connections and a project name opens its scope', async () => {
    installFakeApi();
    useStore.setState({ connections: [conn] });
    render(<SettingsScreen />);
    const projects = row('Projects: Azure DevOps');
    expect(projects).toHaveTextContent('Connected as Dries Hoebeke');
    expect(
      within(projects).queryByRole('button', { name: 'Verify' }),
    ).toBeNull();
    expect(
      within(projects).queryByRole('button', { name: 'Remove' }),
    ).toBeNull();
    await userEvent.click(
      within(projects).getByRole('button', { name: 'Shellie' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      scope: 'project',
      connectionId: 'c1',
    });
  });

  it('User has no Brains category', async () => {
    installFakeApi();
    render(<SettingsScreen />);
    await screen.findByLabelText('Idle minutes');
    expect(document.getElementById('brains')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Brains' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Projects' })).toBeVisible();
  });
});
