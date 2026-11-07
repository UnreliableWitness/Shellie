import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installFakeApi } from '../test-helpers/fakeApi';
import type { AppSettings } from '../../shared/usage';
import { BudgetSection } from './BudgetSection';

const alertsOn = { at80: true, forecastOver: true, at100: true };
const base: AppSettings = {
  version: 1,
  receiverPort: 4319,
  writeTimeToAdo: false,
  idleMinutes: 5,
  workHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
  showSplash: true,
  notifyOnDone: true,
  theme: 'system',
  claudeBudget: { monthlyEur: null, monthStartDay: 1, alerts: alertsOn },
  copilotBudget: { monthlyEur: null, monthStartDay: 1, alerts: alertsOn },
  sendTelemetry: true,
  editor: { default: null, repos: {} },
  secrets: { productionMinutes: 60 },
  onboarding: {
    dismissedAt: null,
    agentsCheckedAt: null,
    tracker: null,
    brain: null,
    migrated: false,
  },
  defaultTerminals: {
    claude: true,
    copilot: false,
    opencode: false,
    shell: true,
  },
};

describe('BudgetSection', () => {
  it('saves a budget, start day and alert toggles', async () => {
    const { calls } = installFakeApi();
    render(<BudgetSection />);
    const claude = within(
      await screen.findByRole('group', { name: 'Claude budget' }),
    );
    fireEvent.change(await claude.findByLabelText('Monthly budget (€)'), {
      target: { value: '500' },
    });
    fireEvent.change(claude.getByLabelText('Month starts on day'), {
      target: { value: '15' },
    });
    fireEvent.click(claude.getByLabelText('Warn when the forecast goes over'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const saved = calls.filter((c) => c.channel === 'settings:save').at(-1)
        ?.args[0] as { claudeBudget: unknown };
      expect(saved.claudeBudget).toEqual({
        monthlyEur: 500,
        monthStartDay: 15,
        alerts: { at80: true, forecastOver: false, at100: true },
      });
    });
  });

  it('rejects a bad start day without saving', async () => {
    const { calls } = installFakeApi();
    render(<BudgetSection />);
    const claude = within(
      await screen.findByRole('group', { name: 'Claude budget' }),
    );
    fireEvent.change(claude.getByLabelText('Month starts on day'), {
      target: { value: '31' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Month start day must be 1 to 28.'),
    ).toBeTruthy();
    expect(calls.some((c) => c.channel === 'settings:save')).toBe(false);
  });

  it('edits both budgets', async () => {
    const { calls } = installFakeApi();
    render(<BudgetSection />);
    const copilot = within(
      await screen.findByRole('group', { name: 'Copilot budget' }),
    );
    fireEvent.change(copilot.getByLabelText('Monthly budget (€)'), {
      target: { value: '120' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const saved = calls.filter((c) => c.channel === 'settings:save').at(-1)
        ?.args[0] as {
        copilotBudget: { monthlyEur: number };
        claudeBudget: { monthlyEur: number | null };
      };
      expect(saved.copilotBudget.monthlyEur).toBe(120);
      expect(saved.claudeBudget.monthlyEur).toBeNull();
    });
  });

  it('locks a managed budget', async () => {
    const { calls } = installFakeApi();
    render(<BudgetSection managed={{ claude: false, copilot: true }} />);
    const copilot = within(
      await screen.findByRole('group', { name: 'Copilot budget' }),
    );
    expect(
      (copilot.getByLabelText('Monthly budget (€)') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (copilot.getByLabelText('Month starts on day') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(copilot.getByText('Set by your cost server')).toBeTruthy();
    const claude = within(screen.getByRole('group', { name: 'Claude budget' }));
    expect(claude.queryByText('Set by your cost server')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const saved = calls.filter((c) => c.channel === 'settings:save').at(-1)
        ?.args[0] as Record<string, unknown>;
      expect(saved.claudeBudget).toBeDefined();
      expect(saved.copilotBudget).toMatchObject({
        monthlyEur: null,
        monthStartDay: 1,
      });
    });
  });

  it('shows the cost server tier read-only', async () => {
    installFakeApi({
      'costServer:status': () => ({
        connected: true,
        url: 'https://cost.example',
        email: 'a@b.c',
        lastSentAt: null,
        waiting: 0,
        error: null,
        budgets: {
          claude: { monthlyEur: 250, monthStartDay: 15 },
          copilot: null,
        },
      }),
    });
    render(<BudgetSection />);
    const claude = within(
      await screen.findByRole('group', { name: 'Claude budget' }),
    );
    const eur = claude.getByLabelText('Monthly budget (€)') as HTMLInputElement;
    await waitFor(() => expect(eur.value).toBe('250'));
    expect(eur.disabled).toBe(true);
    expect(
      (claude.getByLabelText('Month starts on day') as HTMLInputElement).value,
    ).toBe('15');
    expect(claude.getByText('Set by your cost server')).toBeTruthy();
    const copilot = within(
      screen.getByRole('group', { name: 'Copilot budget' }),
    );
    expect(
      (copilot.getByLabelText('Monthly budget (€)') as HTMLInputElement)
        .disabled,
    ).toBe(false);
  });

  it('saves the alerts of a managed budget with the local amount', async () => {
    const { calls } = installFakeApi({
      'settings:get': () => ({
        ...base,
        claudeBudget: {
          monthlyEur: 80,
          monthStartDay: 3,
          alerts: { at80: true, forecastOver: true, at100: true },
        },
      }),
      'costServer:status': () => ({
        connected: true,
        url: 'https://cost.example',
        email: 'a@b.c',
        lastSentAt: null,
        waiting: 0,
        error: null,
        budgets: {
          claude: { monthlyEur: 250, monthStartDay: 15 },
          copilot: null,
        },
      }),
    });
    render(<BudgetSection />);
    const claude = within(
      await screen.findByRole('group', { name: 'Claude budget' }),
    );
    const eur = claude.getByLabelText('Monthly budget (€)') as HTMLInputElement;
    await waitFor(() => expect(eur.value).toBe('250'));
    fireEvent.click(claude.getByLabelText('Warn at 80% of the budget'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const saved = calls.filter((c) => c.channel === 'settings:save').at(-1)
        ?.args[0] as { claudeBudget: unknown };
      expect(saved.claudeBudget).toEqual({
        monthlyEur: 80,
        monthStartDay: 3,
        alerts: { at80: false, forecastOver: true, at100: true },
      });
    });
  });
});
