import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach } from 'vitest';
import type { DreamView } from '../../../shared/dreams';
import { viewOf } from '../../test-helpers/dreamFixtures';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { useDreamsState } from './useDreams';
import { activateProject, projectOf } from '../../test-helpers/project';
import { useStore } from '../../store';

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

describe('useDreamsState and projects', () => {
  const byProject = () =>
    installFakeApi({
      'dream:get': (project) => withTokens(project === 'p1' ? 1 : 2),
    });
  const projectsAsked = (calls: { channel: string; args: unknown[] }[]) =>
    calls.filter((c) => c.channel === 'dream:get').map((c) => c.args[0]);

  it('reads the dreams of the active project, and of the new one when it changes', async () => {
    const { calls } = byProject();
    render(<Probe name="a" />);
    await waitFor(() =>
      expect(screen.getByTestId('a')).toHaveTextContent('tokens 1'),
    );
    act(() => {
      useStore.setState((s) => ({
        connections: [...s.connections, projectOf('p2')],
        connectionId: 'p2',
      }));
    });
    // Nothing of the other project stays on screen while the new one loads.
    expect(screen.getByTestId('a')).not.toHaveTextContent('tokens 1');
    await waitFor(() =>
      expect(screen.getByTestId('a')).toHaveTextContent('tokens 2'),
    );
    expect(projectsAsked(calls)).toEqual(['p1', 'p2']);
  });

  it('reads nothing and shows nothing without a project', async () => {
    const { calls, emit } = byProject();
    act(() => {
      useStore.setState({ connections: [], connectionId: null });
    });
    render(<Probe name="a" />);
    act(() => emit('dream:changed', {}));
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.getByTestId('a')).toHaveTextContent('loading');
    expect(projectsAsked(calls)).toEqual([]);
  });

  it('a change refetches each project that is on screen, once', async () => {
    const { calls, emit } = byProject();
    function Of({ project }: { project: string }) {
      const { view } = useDreamsState(project);
      return (
        <span data-testid={project}>{view?.usage.tokens ?? 'loading'}</span>
      );
    }
    render(
      <>
        <Of project="p1" />
        <Of project="p2" />
        <Probe name="a" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('p2')).toHaveTextContent('2'),
    );
    expect(screen.getByTestId('p1')).toHaveTextContent('1');
    act(() => emit('dream:changed', {}));
    await waitFor(() => expect(projectsAsked(calls)).toHaveLength(4));
    expect(projectsAsked(calls).sort()).toEqual(['p1', 'p1', 'p2', 'p2']);
  });
});

// Dreams belong to a project: every test here has one active.
beforeEach(() => {
  activateProject();
});
