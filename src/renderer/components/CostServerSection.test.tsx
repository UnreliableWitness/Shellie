import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CostServerStatus } from '../../shared/costServer';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { CostServerSection } from './CostServerSection';

const off: CostServerStatus = {
  connected: false,
  url: null,
  email: null,
  lastSentAt: null,
  waiting: 0,
  error: null,
  budgets: null,
};
const on: CostServerStatus = {
  connected: true,
  url: 'https://cost.example',
  email: 'dries@example.com',
  lastSentAt: '2026-10-23T09:30:00.000Z',
  waiting: 12,
  error: null,
  budgets: { claude: { monthlyEur: 200, monthStartDay: 1 }, copilot: null },
};

const connection = (userUniqueName: string | null) => ({
  id: 'c1',
  name: 'unreliablewitness',
  organizationUrl: 'https://dev.azure.com/unreliablewitness',
  project: 'Shellie',
  user: 'D',
  status: 'ok' as const,
  checkedAt: null,
  userUniqueName,
  provider: 'azure-devops' as const,
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
  writeTimeToAdo: false,
});

beforeEach(() => {
  useStore.setState({
    notices: [],
    connections: [connection('dries@example.com'), connection('other@x.y')],
  });
});

describe('CostServerSection', () => {
  it('pre-fills the email from the first connection', async () => {
    installFakeApi({ 'costServer:status': () => off });
    render(<CostServerSection />);
    const email = (await screen.findByLabelText('Email')) as HTMLInputElement;
    await waitFor(() => expect(email.value).toBe('dries@example.com'));
    const key = screen.getByLabelText('Company key') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
  });

  it('shows Connected as <email>, last sent and waiting', async () => {
    const { calls } = installFakeApi({
      'costServer:status': () => off,
      'costServer:connect': () => on,
    });
    render(<CostServerSection />);
    fireEvent.change(await screen.findByLabelText('Server address'), {
      target: { value: 'https://cost.example' },
    });
    fireEvent.change(screen.getByLabelText('Company key'), {
      target: { value: 'sk-company' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test and connect' }));
    expect(
      await screen.findByText('Connected as dries@example.com'),
    ).toBeTruthy();
    expect(calls.find((c) => c.channel === 'costServer:connect')?.args).toEqual(
      [
        {
          url: 'https://cost.example',
          email: 'dries@example.com',
          key: 'sk-company',
        },
      ],
    );
    expect(screen.getByText(/^Last sent /)).toBeTruthy();
    expect(screen.getByText('12 records waiting')).toBeTruthy();
    // The key is never shown again once saved.
    const key = screen.getByLabelText('Company key') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'costServer:disconnect')).toBe(
        true,
      ),
    );
  });

  it('shows the error text', async () => {
    installFakeApi({
      'costServer:status': () => off,
      'costServer:connect': () => ({
        ...off,
        error: 'The server refused the key.',
      }),
    });
    render(<CostServerSection />);
    fireEvent.change(await screen.findByLabelText('Server address'), {
      target: { value: 'https://cost.example' },
    });
    fireEvent.change(screen.getByLabelText('Company key'), {
      target: { value: 'sk-wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test and connect' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The server refused the key.',
    );
  });
});
