import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { DreamView } from '../../../shared/dreams';
import { viewOf } from '../../test-helpers/dreamFixtures';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { useDreamsState } from './useDreams';

function Probe({ name }: { name: string }) {
  const { view, failed, retry } = useDreamsState();
  return (
    <div>
      <span data-testid={name}>
        {failed ? 'failed' : view ? `tokens ${view.usage.tokens}` : 'loading'}
      </span>
      <button type="button" onClick={retry}>
        retry {name}
      </button>
    </div>
  );
}

const withTokens = (tokens: number): DreamView =>
  viewOf({ usage: { day: 'd', tokens, eur: 0 } });

const deferred = () => {
  let resolve!: (v: DreamView) => void;
  const promise = new Promise<DreamView>((r) => (resolve = r));
  return { promise, resolve };
};

const getCalls = (calls: { channel: string }[]) =>
  calls.filter((c) => c.channel === 'dream:get').length;

describe('useDreamsState', () => {
  it('makes one dream:get for consumers that mount together', async () => {
    const { calls } = installFakeApi({ 'dream:get': () => withTokens(1) });
    render(
      <>
        <Probe name="a" />
        <Probe name="b" />
        <Probe name="c" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('c')).toHaveTextContent('tokens 1'),
    );
    expect(screen.getByTestId('a')).toHaveTextContent('tokens 1');
    expect(getCalls(calls)).toBe(1);
  });

  it('a change during a pending dream:get leads to a second one, and its answer wins', async () => {
    const first = deferred();
    const second = deferred();
    const queue = [first, second];
    const { calls, emit } = installFakeApi({
      'dream:get': () => queue.shift()!.promise,
    });
    render(<Probe name="a" />);
    await waitFor(() => expect(getCalls(calls)).toBe(1));
    emit('dream:changed', undefined as never);
    await waitFor(() => expect(getCalls(calls)).toBe(2));
    await act(async () => second.resolve(withTokens(2)));
    await waitFor(() =>
      expect(screen.getByTestId('a')).toHaveTextContent('tokens 2'),
    );
    // The older answer arriving later does not replace the newer one.
    await act(async () => first.resolve(withTokens(1)));
    expect(screen.getByTestId('a')).toHaveTextContent('tokens 2');
  });

  it('an unmount of one consumer leaves the others updating', async () => {
    let tokens = 1;
    const { emit } = installFakeApi({ 'dream:get': () => withTokens(tokens) });
    const { rerender } = render(
      <>
        <Probe name="a" />
        <Probe name="b" />
      </>,
    );
    await screen.findByText('tokens 1', { selector: '[data-testid=b]' });
    rerender(<Probe name="b" />);
    tokens = 5;
    emit('dream:changed', undefined as never);
    await waitFor(() =>
      expect(screen.getByTestId('b')).toHaveTextContent('tokens 5'),
    );
  });

  it('gives the error state after a failed first load, and Try again fetches anew', async () => {
    let n = 0;
    const { calls } = installFakeApi({
      'dream:get': () => {
        if (n++ === 0) throw new Error('boom');
        return withTokens(7);
      },
    });
    render(<Probe name="a" />);
    await screen.findByText('failed');
    await userEvent.click(screen.getByRole('button', { name: 'retry a' }));
    await screen.findByText('tokens 7');
    expect(getCalls(calls)).toBe(2);
  });
});
