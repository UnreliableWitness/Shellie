import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { Notices } from './Notices';

describe('update notice', () => {
  it('shows nothing until an update is ready, then offers Restart and update', async () => {
    const { emit, calls } = installFakeApi({
      'update:install': () => undefined,
    });
    render(<Notices />);
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'update:status')).toBe(true),
    );
    expect(screen.queryByText(/is ready/)).toBeNull();
    act(() => emit('update:ready', { version: '1.0.3' }));
    expect(screen.getByText('Shellie 1.0.3 is ready')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Restart and update' }),
    );
    expect(calls.some((c) => c.channel === 'update:install')).toBe(true);
  });

  it('shows an update that downloaded before the window opened', async () => {
    installFakeApi({ 'update:status': () => ({ version: null }) });
    render(<Notices />);
    expect(
      await screen.findByText('A new version of Shellie is ready'),
    ).toBeInTheDocument();
  });

  it('Later hides it without installing', async () => {
    const { calls } = installFakeApi({
      'update:status': () => ({ version: '1.0.3' }),
    });
    render(<Notices />);
    await userEvent.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByText('Shellie 1.0.3 is ready')).toBeNull();
    expect(calls.some((c) => c.channel === 'update:install')).toBe(false);
  });

  it('shows the card again when a newer version downloads after Later (#126)', async () => {
    const { emit } = installFakeApi({
      'update:status': () => ({ version: '1.0.3' }),
    });
    render(<Notices />);
    await userEvent.click(await screen.findByRole('button', { name: 'Later' }));
    act(() => emit('update:ready', { version: '1.0.3' }));
    expect(screen.queryByText('Shellie 1.0.3 is ready')).toBeNull();
    act(() => emit('update:ready', { version: '1.0.4' }));
    expect(screen.getByText('Shellie 1.0.4 is ready')).toBeInTheDocument();
  });

  it('stays visible with a notice when the install fails', async () => {
    installFakeApi({
      'update:status': () => ({ version: '1.0.3' }),
      'update:install': () => {
        throw new Error('No update is ready to install');
      },
    });
    render(<Notices />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Restart and update' }),
    );
    expect(
      await screen.findByText('No update is ready to install'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Restart and update' }),
    ).toBeEnabled();
  });
});

describe('notices', () => {
  beforeEach(() => useStore.setState({ notices: [] }));
  afterEach(() => {
    vi.useRealTimers();
    useStore.setState({ notices: [] });
  });
  const setup = () => {
    installFakeApi({});
    render(<Notices />);
  };

  it('keeps the close button for a long unbroken message and clamps it', async () => {
    setup();
    const msg = '/very/long/path/'.repeat(40);
    act(() => useStore.getState().notify('error', msg));
    const close = screen.getByRole('button', { name: 'Dismiss' });
    expect(close).toHaveClass('notice-close');
    expect(screen.getByText(msg)).toHaveClass('notice-clamped');
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByText(msg)).not.toHaveClass('notice-clamped');
    await userEvent.click(close);
    expect(screen.queryByText(msg)).toBeNull();
  });

  it('dismisses info after 6 s and errors after 12 s', () => {
    vi.useFakeTimers();
    setup();
    act(() => {
      useStore.getState().notify('info', 'saved');
      useStore.getState().notify('error', 'broke');
    });
    act(() => void vi.advanceTimersByTime(6000));
    expect(screen.queryByText('saved')).toBeNull();
    expect(screen.getByText('broke')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(6000));
    expect(screen.queryByText('broke')).toBeNull();
  });

  it('pauses while hovered', () => {
    vi.useFakeTimers();
    setup();
    act(() => useStore.getState().notify('error', 'broke'));
    const el = screen.getByText('broke').closest('.notice') as HTMLElement;
    act(() => void fireEvent.mouseEnter(el));
    act(() => void vi.advanceTimersByTime(60000));
    expect(screen.getByText('broke')).toBeInTheDocument();
    act(() => void fireEvent.mouseLeave(el));
    act(() => void vi.advanceTimersByTime(12000));
    expect(screen.queryByText('broke')).toBeNull();
  });

  it('Escape dismisses a focused notice', async () => {
    setup();
    act(() => useStore.getState().notify('error', 'broke'));
    screen.getByRole('button', { name: 'Dismiss' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText('broke')).toBeNull();
  });

  it('does not auto-dismiss the update card', async () => {
    installFakeApi({ 'update:status': () => ({ version: '1.0.3' }) });
    render(<Notices />);
    await screen.findByText('Shellie 1.0.3 is ready');
    vi.useFakeTimers();
    act(() => void vi.advanceTimersByTime(60000));
    expect(screen.getByText('Shellie 1.0.3 is ready')).toBeInTheDocument();
  });
});

describe('move to Applications notice', () => {
  it('shows the Move card when update:needsMove is true', async () => {
    installFakeApi({ 'update:needsMove': () => true });
    render(<Notices />);
    expect(
      await screen.findByText('Move Shellie to Applications to get updates'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  it('shows no card when update:needsMove is false', async () => {
    const { calls } = installFakeApi({ 'update:needsMove': () => false });
    render(<Notices />);
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'update:needsMove')).toBe(true),
    );
    expect(screen.queryByText(/Move Shellie to Applications/)).toBeNull();
  });

  it('Not now hides it for this launch', async () => {
    installFakeApi({ 'update:needsMove': () => true });
    render(<Notices />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Not now' }),
    );
    expect(screen.queryByText(/Move Shellie to Applications/)).toBeNull();
  });

  it('Move calls update:moveToApplications and keeps the card when it returns false', async () => {
    const { calls } = installFakeApi({
      'update:needsMove': () => true,
      'update:moveToApplications': () => false,
    });
    render(<Notices />);
    await userEvent.click(await screen.findByRole('button', { name: 'Move' }));
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'update:moveToApplications')).toBe(
        true,
      ),
    );
    expect(
      await screen.findByText('Move Shellie to Applications to get updates'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled();
  });
});
