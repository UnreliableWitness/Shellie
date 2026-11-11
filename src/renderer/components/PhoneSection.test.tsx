import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReaderStatus } from '../../shared/reader';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { PhoneSection } from './PhoneSection';

const off: ReaderStatus = {
  connected: false,
  url: null,
  lastPush: null,
  refused: false,
};
const on: ReaderStatus = {
  connected: true,
  url: 'https://reader.example',
  lastPush: {
    at: '2026-11-11T09:30:00.000Z',
    ok: true,
    pieces: 12,
    error: null,
  },
  refused: false,
};
const LINK = `https://reader.example/#${'a'.repeat(43)}`;

beforeEach(() => {
  useStore.setState({ notices: [] });
});

const fill = async () => {
  fireEvent.change(await screen.findByLabelText('Server address'), {
    target: { value: 'https://reader.example' },
  });
  fireEvent.change(screen.getByLabelText('Invitation code'), {
    target: { value: 'the-code' },
  });
};

describe('PhoneSection', () => {
  it('connects with an address and an invitation code, then shows the QR code', async () => {
    const { calls } = installFakeApi({
      'reader:status': () => off,
      'reader:connect': () => on,
      'reader:link': () => LINK,
    });
    render(<PhoneSection />);
    const connect = await screen.findByRole('button', { name: 'Connect' });
    expect(connect).toBeDisabled();
    const code = screen.getByLabelText('Invitation code') as HTMLInputElement;
    expect(code.type).toBe('password');
    await fill();
    fireEvent.click(connect);
    expect(
      await screen.findByText('Connected to https://reader.example'),
    ).toBeInTheDocument();
    expect(calls).toContainEqual({
      channel: 'reader:connect',
      args: ['https://reader.example', 'the-code'],
    });
    expect(
      await screen.findByRole('img', { name: 'The link for your phone' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/12 pieces on your phone/)).toBeInTheDocument();
    // The link is in the code, never on the page as text.
    expect(document.body.textContent).not.toContain('aaaa');
  });

  it('says what was wrong and keeps the form', async () => {
    installFakeApi({
      'reader:status': () => off,
      'reader:connect': () => ({
        ...off,
        error: 'The reader server refused the invitation code.',
      }),
    });
    render(<PhoneSection />);
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'refused the invitation code',
    );
    expect(
      (screen.getByLabelText('Invitation code') as HTMLInputElement).value,
    ).toBe('the-code');
  });

  it('asks for the link only when the code is shown, hides it again, and copies it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { calls } = installFakeApi({
      'reader:status': () => on,
      'reader:link': () => LINK,
    });
    render(<PhoneSection />);
    const show = await screen.findByRole('button', { name: 'Show QR code' });
    expect(calls.some((c) => c.channel === 'reader:link')).toBe(false);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    fireEvent.click(show);
    const qr = await screen.findByRole('img', {
      name: 'The link for your phone',
    });
    // Dark on white whatever the theme, with a quiet zone.
    expect(qr.querySelector('rect')).toHaveAttribute('fill', '#fff');
    expect(qr.querySelector('path')).toHaveAttribute('fill', '#000');
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(
      await screen.findByRole('button', { name: 'Copied' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('sends now, and follows what main reports', async () => {
    const { calls, emit } = installFakeApi({
      'reader:status': () => ({ ...on, lastPush: null }),
      'reader:send': () => on,
    });
    render(<PhoneSection />);
    expect(await screen.findByText('Nothing sent yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    expect(
      await screen.findByText(/12 pieces on your phone/),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.channel === 'reader:send')).toBe(true);
    act(() =>
      emit('reader:changed', {
        ...on,
        lastPush: {
          at: '2026-11-11T10:00:00.000Z',
          ok: false,
          pieces: 12,
          error: 'The reader server could not be reached',
        },
      }),
    );
    expect(
      await screen.findByText(/Not sent at .*could not be reached/),
    ).toBeInTheDocument();
  });

  it('a refused connection says to connect again, and sends nothing', async () => {
    installFakeApi({ 'reader:status': () => ({ ...on, refused: true }) });
    render(<PhoneSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'no longer knows this connection',
    );
    expect(screen.getByRole('button', { name: 'Send now' })).toBeDisabled();
  });

  it('disconnects after asking, and offers "anyway" only when the server cannot be reached', async () => {
    const { calls } = installFakeApi({
      'reader:status': () => on,
      'reader:link': () => LINK,
      'reader:disconnect': (anyway) =>
        anyway
          ? off
          : { ...on, error: 'The reader server could not be reached.' },
    });
    render(<PhoneSection />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Show QR code' }),
    );
    await screen.findByRole('img');
    expect(
      screen.queryByRole('button', { name: 'Disconnect anyway' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(calls.some((c) => c.channel === 'reader:disconnect')).toBe(false);
    const bar = screen
      .getByText('Disconnect your phone?')
      .closest('div')!.parentElement!;
    fireEvent.click(within(bar).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'could not be reached',
    );
    expect(calls).toContainEqual({
      channel: 'reader:disconnect',
      args: [false],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect anyway' }));
    expect(await screen.findByLabelText('Server address')).toBeInTheDocument();
    expect(calls).toContainEqual({
      channel: 'reader:disconnect',
      args: [true],
    });
    // The code went with the connection.
    await waitFor(() =>
      expect(screen.queryByRole('img')).not.toBeInTheDocument(),
    );
  });
});
