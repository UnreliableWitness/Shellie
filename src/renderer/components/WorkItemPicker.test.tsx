import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItemSummary } from '../../shared/types';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { WorkItemPicker } from './WorkItemPicker';

const item = (id: string, title: string, type = 'Issue'): WorkItemSummary => ({
  id,
  type,
  title,
  state: 'To Do',
  areaPath: 'Shellie',
  iterationPath: 'Shellie\\Sprint 1',
  assignedTo: null,
  url: `https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/${id}`,
  project: 'Shellie',
});

beforeEach(() => useStore.setState({ notices: [] }));
afterEach(() => vi.useRealTimers());

describe('WorkItemPicker', () => {
  it('searches the current sprint on open and lists results', async () => {
    const { calls } = installFakeApi({
      'workItems:currentIteration': () => ({
        path: 'Shellie\\Sprint 1',
        name: 'Sprint 1',
      }),
      'workItems:search': () => [
        item('12', 'Save address'),
        item('7', 'Tidy', 'Task'),
      ],
    });
    render(
      <WorkItemPicker connectionId="c1" selectedId={null} onPick={() => {}} />,
    );
    expect(await screen.findByText('Save address')).toBeInTheDocument();
    const row = screen.getByRole('button', { name: /Save address/ });
    expect(row).toHaveTextContent('12');
    expect(row).toHaveTextContent('To Do');
    expect(row).toHaveTextContent('Unassigned');
    expect(screen.getAllByRole('img', { name: 'Issue' })).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'Task' })).toBeInTheDocument();
    expect(calls.find((c) => c.channel === 'workItems:search')?.args).toEqual([
      'c1',
      { scope: 'sprint', text: '' },
    ]);
    expect(
      screen.getByRole('button', { name: 'Current sprint' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches to assigned to me', async () => {
    const { calls } = installFakeApi({
      'workItems:currentIteration': () => ({ path: 'p', name: 'Sprint 1' }),
      'workItems:search': () => [],
    });
    render(
      <WorkItemPicker connectionId="c1" selectedId={null} onPick={() => {}} />,
    );
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'workItems:search')).toBe(true),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Assigned to me' }),
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.channel === 'workItems:search').at(-1)?.args,
      ).toEqual(['c1', { scope: 'mine', text: '' }]),
    );
  });

  it('falls back to assigned to me when there is no current sprint', async () => {
    const { calls } = installFakeApi({
      'workItems:currentIteration': () => null,
      'workItems:search': () => [],
    });
    render(
      <WorkItemPicker connectionId="c1" selectedId={null} onPick={() => {}} />,
    );
    expect(await screen.findByText(/No current sprint/)).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'workItems:search')?.args).toEqual(
        ['c1', { scope: 'mine', text: '' }],
      ),
    );
    expect(
      screen.getByRole('button', { name: 'Current sprint' }),
    ).toBeDisabled();
  });

  it('debounces typed search text', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = installFakeApi({
      'workItems:currentIteration': () => ({ path: 'p', name: 'S' }),
      'workItems:search': () => [],
    });
    render(
      <WorkItemPicker connectionId="c1" selectedId={null} onPick={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText('Search work items'), 'addr');
    const texts = () =>
      calls
        .filter((c) => c.channel === 'workItems:search')
        .map((c) => (c.args[1] as { text: string }).text);
    await vi.advanceTimersByTimeAsync(200);
    expect(texts()).not.toContain('addr');
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => expect(texts().at(-1)).toBe('addr'));
    for (const partial of ['a', 'ad', 'add'])
      expect(texts()).not.toContain(partial);
  });

  it('ignores a stale search response', async () => {
    let releaseFirst: (v: WorkItemSummary[]) => void = () => {};
    const first = new Promise<WorkItemSummary[]>((res) => {
      releaseFirst = res;
    });
    let n = 0;
    installFakeApi({
      'workItems:currentIteration': () => ({ path: 'p', name: 'S' }),
      'workItems:search': () => (++n === 1 ? first : [item('2', 'Item B')]),
    });
    render(
      <WorkItemPicker connectionId="c1" selectedId={null} onPick={() => {}} />,
    );
    await waitFor(() => expect(n).toBe(1));
    await userEvent.click(
      screen.getByRole('button', { name: 'Assigned to me' }),
    );
    expect(await screen.findByText('Item B')).toBeInTheDocument();
    releaseFirst([item('1', 'Item A')]);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Item A')).not.toBeInTheDocument();
    expect(screen.getByText('Item B')).toBeInTheDocument();
  });

  it('picks an item', async () => {
    const onPick = vi.fn();
    installFakeApi({
      'workItems:currentIteration': () => ({ path: 'p', name: 'S' }),
      'workItems:search': () => [item('12', 'Save address')],
    });
    render(
      <WorkItemPicker connectionId="c1" selectedId={null} onPick={onPick} />,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /Save address/ }),
    );
    expect(onPick).toHaveBeenCalledWith({
      id: '12',
      type: 'Issue',
      title: 'Save address',
      url: 'https://dev.azure.com/unreliablewitness/Shellie/_workitems/edit/12',
      project: 'Shellie',
    });
  });

  it('shows the error and an empty list when search fails', async () => {
    installFakeApi({
      'workItems:currentIteration': () => ({ path: 'p', name: 'S' }),
      'workItems:search': () => {
        throw new Error('Azure DevOps rejected the token');
      },
    });
    render(
      <WorkItemPicker connectionId="c1" selectedId={null} onPick={() => {}} />,
    );
    await waitFor(() =>
      expect(useStore.getState().notices[0]?.message).toMatch(
        /rejected the token/,
      ),
    );
    expect(screen.getByText(/Could not load work items/)).toBeInTheDocument();
  });
});
