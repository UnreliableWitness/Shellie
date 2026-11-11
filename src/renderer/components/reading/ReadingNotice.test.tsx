import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadingNudge } from '../../readingFeed';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { readingBrain } from '../../test-helpers/readingFixture';
import { ReadingNotice } from './ReadingNotice';

const nudge = (over: Partial<ReadingNudge> = {}): ReadingNudge => ({
  brainId: 'b1',
  path: 'reads/letters/2026-11-11-returns.md',
  title: 'The credit check moved',
  minutes: 2,
  piece: 'letter',
  kind: 'changed',
  about: 'How a return becomes a credit',
  more: 0,
  ...over,
});

beforeEach(() =>
  useStore.setState({
    reading: [readingBrain()],
    readingNudge: null,
    screen: { kind: 'home' },
  }),
);
afterEach(() => vi.useRealTimers());

describe('ReadingNotice', () => {
  it('shows nothing without news', () => {
    installFakeApi();
    const { container } = render(<ReadingNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says what changed in something read, and Read opens it', async () => {
    const { tracked } = installFakeApi();
    useStore.setState({ readingNudge: nudge({ more: 2 }) });
    render(<ReadingNotice />);
    expect(
      screen.getByText('Something you read no longer holds'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'The credit check moved · about How a return becomes a credit · 2 min',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Acme · and 2 more')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Read' }));
    expect(useStore.getState().readingNudge).toBeNull();
    expect(useStore.getState().screen).toMatchObject({
      kind: 'brain',
      brainId: 'b1',
      open: { path: 'reads/letters/2026-11-11-returns.md' },
    });
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'reading.open',
      props: { from: 'notice', why: 'changed', kind: 'letter' },
    });
  });

  it('names the work a newly written long read is for', () => {
    installFakeApi();
    useStore.setState({
      readingNudge: nudge({
        path: 'reads/returns.md',
        title: 'How a return becomes a credit',
        minutes: 9,
        piece: 'read',
        kind: 'work',
        about: undefined,
        work: { id: 412, title: 'Return flow' },
      }),
    });
    render(<ReadingNotice />);
    expect(screen.getByText('A long read for your work')).toBeInTheDocument();
    expect(
      screen.getByText(
        'How a return becomes a credit · for #412 Return flow · 9 min',
      ),
    ).toBeInTheDocument();
  });

  it('closes on ×, and leaves by itself', () => {
    vi.useFakeTimers();
    installFakeApi();
    useStore.setState({ readingNudge: nudge() });
    render(<ReadingNotice />);
    act(() => vi.advanceTimersByTime(19_000));
    expect(screen.getByRole('button', { name: 'Read' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_500));
    expect(screen.queryByRole('button', { name: 'Read' })).toBeNull();

    act(() => useStore.setState({ readingNudge: nudge() }));
    act(() => screen.getByRole('button', { name: 'Dismiss' }).click());
    expect(useStore.getState().readingNudge).toBeNull();
  });
});
