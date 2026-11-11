import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReadingBrain } from '../../../shared/reading';
import type { TaskView } from '../../../shared/types';
import { useStore } from '../../store';
import { listedBrain } from '../../test-helpers/brainFixture';
import { installFakeApi } from '../../test-helpers/fakeApi';
import {
  readingBrain,
  readingRead,
  readMark,
} from '../../test-helpers/readingFixture';
import { BeforeYouStart } from './BeforeYouStart';

const work = [{ id: 412, title: 'Return flow' }];
const task = (id: string | null) =>
  ({
    id: 't1',
    status: 'ready',
    workItem: id
      ? { id, type: 'Issue', title: 'Return flow', url: null, project: null }
      : null,
  }) as TaskView;

function show(reading: ReadingBrain[], workItemId: string | null = '412') {
  const a = installFakeApi({
    'brain:forTask': () => listedBrain({ connectionId: 'c1' }),
  });
  useStore.setState({ reading, tasks: [task(workItemId)] });
  render(<BeforeYouStart taskId="t1" />);
  return a;
}

beforeEach(() =>
  useStore.setState({
    reading: [],
    tasks: [],
    settings: null,
    screen: { kind: 'home' },
  }),
);

describe('BeforeYouStart', () => {
  it('names the unread long read the task’s work item bears on, and opens it', async () => {
    const { tracked } = show([
      readingBrain({ reads: [readingRead({ work })] }),
    ]);
    const row = await screen.findByRole('button', {
      name: /How a return becomes a credit/,
    });
    expect(row).toHaveTextContent('9 min · a long read in Acme');
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'reading.nudge',
      props: { kind: 'task' },
    });
    await userEvent.click(row);
    expect(useStore.getState().screen).toMatchObject({
      kind: 'brain',
      brainId: 'b1',
      open: { path: 'reads/returns.md' },
    });
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'reading.open',
      props: { from: 'task', why: 'work', kind: 'read' },
    });
  });

  it('shows nothing once it was read, for another work item, or for a blank task', async () => {
    const reads = [readingRead({ work })];
    const a = show([
      readingBrain({ reads, marks: { 'reads/returns.md': readMark('h1') } }),
    ]);
    await waitFor(() =>
      expect(a.calls.some((c) => c.channel === 'brain:forTask')).toBe(true),
    );
    expect(
      screen.queryByRole('region', { name: 'Before you start' }),
    ).toBeNull();
    useStore.setState({
      reading: [readingBrain({ reads })],
      tasks: [task('9')],
    });
    expect(
      screen.queryByRole('region', { name: 'Before you start' }),
    ).toBeNull();
    useStore.setState({ tasks: [task(null)] });
    expect(
      screen.queryByRole('region', { name: 'Before you start' }),
    ).toBeNull();
    expect(a.tracked).toEqual([]);
  });

  it('ignores a brain of another organization: its ids are other work', async () => {
    const a = show([
      readingBrain({ connectionId: 'c2', reads: [readingRead({ work })] }),
    ]);
    await waitFor(() =>
      expect(a.calls.some((c) => c.channel === 'brain:forTask')).toBe(true),
    );
    expect(
      screen.queryByRole('region', { name: 'Before you start' }),
    ).toBeNull();
  });

  it('shows nothing when the nudges are off', async () => {
    useStore.setState({ settings: { readingNudges: false } as never });
    const a = installFakeApi({
      'brain:forTask': () => listedBrain({ connectionId: 'c1' }),
    });
    useStore.setState({
      reading: [readingBrain({ reads: [readingRead({ work })] })],
      tasks: [task('412')],
    });
    render(<BeforeYouStart taskId="t1" />);
    await waitFor(() =>
      expect(a.calls.some((c) => c.channel === 'brain:forTask')).toBe(true),
    );
    expect(
      screen.queryByRole('region', { name: 'Before you start' }),
    ).toBeNull();
    expect(a.tracked).toEqual([]);
  });
});
