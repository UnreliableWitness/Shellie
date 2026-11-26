import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ReceiverStatus } from '../../shared/usage';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { CostButton } from './CostButton';

const OFF: ReceiverStatus = {
  listening: false,
  port: 4319,
  error: 'Port 4319 is in use by another program',
  copilot: { records: 0, unreadable: 0 },
};
const SENTENCE =
  'AI usage capture is off: Port 4319 is in use by another program. Pick another port in Settings > AI cost and invoicing.';
const mark = () => document.querySelector('[data-part="capture-off"]');

describe('CostButton', () => {
  it('shows the cost without a mark while the receiver listens', async () => {
    const { calls } = installFakeApi({ 'usage:costs': () => ({ t1: 23 }) });
    render(<CostButton taskId="t1" />);
    const chip = await screen.findByRole('button', {
      name: 'AI cost €23.00, open usage',
    });
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'usage:receiverStatus')).toBe(
        true,
      ),
    );
    expect(chip).toHaveAttribute('title', 'AI cost, open usage');
    expect(mark()).toBeNull();
  });

  it('carries a warning mark and says why while the receiver is off', async () => {
    installFakeApi({
      'usage:costs': () => ({}),
      'usage:receiverStatus': () => OFF,
    });
    render(<CostButton taskId="t1" />);
    const chip = await screen.findByRole('button', {
      name: `AI cost €0.00, open usage. ${SENTENCE}`,
    });
    expect(chip).toHaveAttribute('title', SENTENCE);
    expect(mark()).toBeTruthy();
    await userEvent.click(chip);
    expect(useStore.getState().screen).not.toEqual(
      expect.objectContaining({ kind: 'settings' }),
    );
  });

  it('drops the mark when the receiver starts listening, without a restart', async () => {
    const { emit } = installFakeApi({ 'usage:receiverStatus': () => OFF });
    render(<CostButton taskId="t1" />);
    await waitFor(() => expect(mark()).toBeTruthy());
    act(() =>
      emit('usage:receiverStatus', {
        ...OFF,
        listening: true,
        port: 4320,
        error: null,
      }),
    );
    expect(mark()).toBeNull();
    expect(
      screen.getByRole('button', { name: 'AI cost €0.00, open usage' }),
    ).toHaveAttribute('title', 'AI cost, open usage');
  });

  it('gets the mark when a port change fails', async () => {
    const { emit } = installFakeApi();
    render(<CostButton taskId="t1" />);
    await screen.findByRole('button', { name: 'AI cost €0.00, open usage' });
    act(() => emit('usage:receiverStatus', OFF));
    expect(mark()).toBeTruthy();
  });

  it('says so when the receiver is off without an error', async () => {
    installFakeApi({
      'usage:receiverStatus': () => ({ ...OFF, error: null }),
    });
    render(<CostButton taskId="t1" />);
    await waitFor(() =>
      expect(screen.getByRole('button')).toHaveAttribute(
        'title',
        'AI usage capture is off: the usage receiver is not running. Pick another port in Settings > AI cost and invoicing.',
      ),
    );
  });
});
