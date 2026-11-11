import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Rate } from '../../shared/usage';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { CostSection } from './CostSection';

const rates: Rate[] = [
  {
    id: 'anthropic-opus-5-5',
    label: 'Claude Opus 5.5',
    match: ['claude-opus-5-5'],
    minInputTokens: 0,
    fast: false,
    inputPerM: 4,
    cachedInputPerM: 0.2,
    cacheWritePerM: 5,
    outputPerM: 20,
  },
];
const settings = {
  version: 1 as const,
  receiverPort: 4319,
  writeTimeToAdo: false,
  idleMinutes: 5,
  workHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
  showSplash: true,
  notifyOnDone: true,
  readingNudges: true,
  theme: 'system' as const,
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

beforeEach(() => {
  useStore.setState({
    notices: [],
    connections: [
      {
        id: 'c1',
        name: 'unreliablewitness',
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
        writeTimeToAdo: false,
      },
    ],
  });
});

describe('CostSection', () => {
  it('has no controls for writing cost to Azure DevOps', async () => {
    installFakeApi({
      'settings:get': () => settings,
      'rates:list': () => ({ rates, officialAsOf: '2026-10-14' }),
    });
    render(<CostSection />);
    await screen.findByLabelText('Usage receiver port');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/Azure DevOps/)).toBeNull();
    expect(screen.queryByText(/Work item fields/)).toBeNull();
  });

  it('saves the port, and has no exchange rate or markup inputs', async () => {
    const { calls } = installFakeApi({
      'settings:get': () => settings,
      'settings:save': (s) => s,
      'rates:list': () => ({ rates, officialAsOf: '2026-10-14' }),
    });
    render(<CostSection />);
    await screen.findByLabelText('Usage receiver port');
    expect(screen.queryByLabelText('USD to EUR')).toBeNull();
    expect(screen.queryByLabelText('Markup %')).toBeNull();
    expect(screen.getByText('EUR at 0.92 per USD (built in)')).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Save settings' }),
    );
    expect(calls.find((c) => c.channel === 'settings:save')?.args[0]).toEqual({
      version: 1,
      receiverPort: 4319,
      writeTimeToAdo: false,
      idleMinutes: 5,
      workHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
      showSplash: true,
      notifyOnDone: true,
      readingNudges: true,
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
    });
  });
  it('shows the receiver status and Copilot counters', async () => {
    installFakeApi({
      'settings:get': () => settings,
      'rates:list': () => ({ rates, officialAsOf: '2026-10-14' }),
      'usage:receiverStatus': () => ({
        listening: false,
        port: 4319,
        error: 'Port 4319 is in use by another program',
        copilot: { records: 3, unreadable: 1 },
      }),
    });
    render(<CostSection />);
    expect(await screen.findByText(/Port 4319 is in use/)).toBeTruthy();
    expect(
      screen.getByText(
        'Copilot CLI: 3 records captured, 1 unreadable (unverified: built from documentation)',
      ),
    ).toBeTruthy();
  });
  it('shows the official rates read-only', async () => {
    installFakeApi({
      'settings:get': () => settings,
      'rates:list': () => ({ rates, officialAsOf: '2026-10-14' }),
    });
    render(<CostSection />);
    expect(
      await screen.findByText(
        'Official list prices as of 2026-10-14 (USD per 1M tokens)',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Claude Opus 5.5')).toBeTruthy();
    expect(screen.getByText('claude-opus-5-5')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add rate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save rates' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Reset to official prices' }),
    ).toBeNull();
    expect(
      screen
        .queryAllByRole('spinbutton')
        .filter((i) => (i.getAttribute('aria-label') ?? '').includes('per 1M')),
    ).toHaveLength(0);
  });
  it('shows nothing of the rate table until the official prices load', async () => {
    installFakeApi({
      'settings:get': () => settings,
      'rates:list': () => new Promise(() => {}),
    });
    render(<CostSection />);
    expect(await screen.findByLabelText('Usage receiver port')).toBeTruthy();
    expect(screen.queryByText(/Official list prices as of\s+\(/)).toBeNull();
  });
  it('refuses to save blank settings numbers', async () => {
    const { calls } = installFakeApi({
      'settings:get': () => settings,
      'settings:save': (s) => s,
      'rates:list': () => ({ rates, officialAsOf: '2026-10-14' }),
    });
    render(<CostSection />);
    await userEvent.clear(await screen.findByLabelText('Usage receiver port'));
    await userEvent.click(
      screen.getByRole('button', { name: 'Save settings' }),
    );
    expect(
      await screen.findByText('Usage receiver port must be a number'),
    ).toBeTruthy();
    expect(calls.some((c) => c.channel === 'settings:save')).toBe(false);
  });
});
