import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadingBrain } from '../../shared/reading';
import { saveMarks } from '../components/brain/longReads';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import {
  readingBrain,
  readingLetter,
  readingRead,
  readMark,
} from '../test-helpers/readingFixture';
import { refreshReading, useReadingFeed } from './useReadingFeed';

function Feed() {
  useReadingFeed();
  return null;
}
const read = readingBrain({
  reads: [readingRead()],
  marks: { 'reads/returns.md': readMark('h1') },
});
const changed = readingBrain({
  reads: [readingRead({ hash: 'h2' })],
  letters: [readingLetter()],
  marks: { 'reads/returns.md': readMark('h1') },
});

function start(first: ReadingBrain[]) {
  let answer = first;
  const a = installFakeApi({ 'reading:get': () => answer });
  render(<Feed />);
  const gets = () => a.calls.filter((c) => c.channel === 'reading:get').length;
  return {
    ...a,
    gets,
    answers: (next: ReadingBrain[]) => {
      answer = next;
    },
  };
}
/** Lets the feed's settle time pass and its fetch answer. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(1600));

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  useStore.setState({
    reading: [],
    readingNudge: null,
    settings: null,
    tasks: [],
  });
});
afterEach(() => vi.useRealTimers());

describe('useReadingFeed', () => {
  it('fetches at mount, without news about what was there', async () => {
    const a = start([changed]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(useStore.getState().reading).toEqual([changed]);
    expect(useStore.getState().readingNudge).toBeNull();
    expect(a.tracked).toEqual([]);
  });

  it('fetches again a moment after a brain changed, once for a burst, and makes the news a nudge', async () => {
    const a = start([read]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    a.answers([changed]);
    a.emit('brain:changed', { brainId: 'b1' });
    a.emit('brain:changed', { brainId: 'b1' });
    await settle();
    expect(a.gets()).toBe(2);
    expect(useStore.getState().readingNudge).toMatchObject({
      kind: 'changed',
      piece: 'letter',
      title: 'The credit check moved',
    });
    // The event says what kind of news, never what it is about.
    expect(a.tracked).toEqual([
      { type: 'event', name: 'reading.nudge', props: { kind: 'changed' } },
    ]);
    // The same text is news once.
    a.emit('brain:changed', { brainId: 'b1' });
    await settle();
    expect(a.tracked).toHaveLength(1);
  });

  it('with the nudges off keeps the list and says nothing', async () => {
    useStore.setState({ settings: { readingNudges: false } as never });
    const a = start([read]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    a.answers([changed]);
    a.emit('brain:changed', { brainId: 'b1' });
    await settle();
    expect(useStore.getState().reading).toEqual([changed]);
    expect(useStore.getState().readingNudge).toBeNull();
    expect(a.tracked).toEqual([]);
  });

  it('fetches again for a mark from the phone, Home’s snapshot, a task’s work item and a mark set here', async () => {
    const a = start([read]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    a.emit('reader:marksChanged', { brainId: 'b1' });
    await settle();
    expect(a.gets()).toBe(2);
    a.emit('home:updated', undefined as never);
    await settle();
    expect(a.gets()).toBe(3);
    act(() =>
      useStore.setState({
        tasks: [
          { id: 't1', status: 'ready', workItem: { id: '412' } } as never,
        ],
      }),
    );
    await settle();
    expect(a.gets()).toBe(4);
    // A task changing in another way is no reason.
    act(() =>
      useStore.setState({
        tasks: [
          { id: 't1', status: 'finishing', workItem: { id: '412' } } as never,
        ],
      }),
    );
    await settle();
    expect(a.gets()).toBe(4);
    refreshReading();
    await settle();
    expect(a.gets()).toBe(5);
  });

  it('counts a mark set here a moment ago, before main knows it', async () => {
    saveMarks('b1', { 'reads/returns.md': readMark('h1') });
    start([readingBrain({ reads: [readingRead()], marks: {} })]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(useStore.getState().reading[0]?.marks).toEqual({
      'reads/returns.md': readMark('h1'),
    });
  });
});
