import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskFailed, AskFoot, AskStopped, AskWorking } from './AskRows';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AskWorking', () => {
  it('shows the word, the time as it counts, and Stop', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onStop = vi.fn();
    render(
      <AskWorking
        word="Answering"
        startedAt={Date.now() - 11_000}
        onStop={onStop}
      />,
    );
    const row = () => screen.getByRole('status').closest('p');
    expect(row()).toHaveTextContent('Answering · 11 s');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(row()).toHaveTextContent('Answering · 13 s');
    // Said once when the run starts: the counting time is not in the live region.
    expect(screen.getByRole('status')).toHaveTextContent(/^Answering$/);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('AskStopped', () => {
  it('says how long it ran and is not an alert', async () => {
    const onAgain = vi.fn();
    render(<AskStopped afterMs={18_200} onAgain={onAgain} />);
    expect(
      screen.getByText('Stopped after 18 s. Nothing was changed.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(onAgain).toHaveBeenCalledTimes(1);
  });
  it('leaves the time out when it is not known', () => {
    render(<AskStopped afterMs={null} onAgain={() => undefined} againOff />);
    expect(
      screen.getByText('Stopped. Nothing was changed.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeDisabled();
  });
});

describe('AskFailed', () => {
  it('is an alert with the reason and Try again', async () => {
    const onRetry = vi.fn();
    render(<AskFailed reason="Another model answered" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not finish. Another model answered',
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it('offers the way to the cause when there is one', async () => {
    const run = vi.fn();
    render(
      <AskFailed
        reason="x"
        onRetry={() => undefined}
        second={{ label: 'Open settings', run }}
      />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Open settings' }),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('AskFoot', () => {
  it('joins what is there and is nothing when nothing is', () => {
    const { container } = render(
      <AskFoot parts={['Took 18 s', null, false, '€0.02']} />,
    );
    expect(container).toHaveTextContent('Took 18 s · €0.02');
    cleanup();
    const empty = render(<AskFoot parts={[null]} />);
    expect(empty.container).toBeEmptyDOMElement();
  });
});
