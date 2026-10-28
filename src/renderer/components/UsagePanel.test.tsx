import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskView } from '../../shared/types';
import type { TaskUsage } from '../../shared/usage';
import { useStore } from '../store';
import { emptyUsage, installFakeApi } from '../test-helpers/fakeApi';
import { UsagePanel } from './UsagePanel';

const EURO = String.fromCharCode(0x20ac);
const task: TaskView = {
  id: 't1',
  repoId: 'r1',
  name: '',
  workItem: {
    id: '48213',
    type: 'Issue',
    title: 'Checkout: allow saving a delivery address',
    url: null,
  },
  slug: 's',
  branch: 'feature/48213-save-delivery-address',
  worktreePath: '/w',
  baseRef: 'origin/main',
  baseSha: null,
  openPeriods: [],
  time: null,
  status: 'ready',
  setup: {
    copy: false,
    commands: [],
    startClaude: true,
    openShell: true,
    openCopilot: false,
  },
  terminals: [],
  createdAt: 'now',
  finishedAt: null,
  worktreeMissing: false,
  usageSyncedAt: null,
  usageSyncError: null,
  usageCommentId: null,
  summary: null,
  pullRequest: null,
  closedTerminals: [],
  reopen: null,
  extraWorkspaces: [],
  detachedPaths: [],
  homeDropped: false,
  connectionId: null,
  mainCheckoutEdits: [],
  environment: 'development',
  environmentUntil: null,
  pendingCleanup: [],
};
const usage: TaskUsage = {
  ...emptyUsage('t1'),
  sessions: [
    {
      sessionId: 's1',
      tool: 'claude-code',
      startedAt: '2026-10-14T09:12:00.000Z',
      lastAt: '2026-10-14T09:12:00.000Z',
      models: ['claude-opus-5-5'],
      requests: 3,
      inputTokens: 412_000,
      outputTokens: 96_000,
      cacheReadTokens: 3_100_000,
      cacheWriteTokens: 250_000,
      costUsd: 10,
      unpricedRequests: 0,
      billable: true,
    },
    {
      sessionId: 's2',
      tool: 'copilot-cli',
      startedAt: '2026-10-14T10:00:00.000Z',
      lastAt: '2026-10-14T10:00:00.000Z',
      models: ['mystery-1'],
      requests: 1,
      inputTokens: 1000,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      unpricedRequests: 1,
      billable: true,
    },
  ],
  unpricedRequests: 1,
  billable: { costUsd: 10, costEur: 9.2, tokens: 3_609_010 },
  byTool: {
    'claude-code': {
      costUsd: 10,
      costEur: 9.2,
      sessions: 1,
      tokens: 3_608_000,
    },
    'copilot-cli': { costUsd: 0, costEur: 0, sessions: 1, tokens: 1010 },
    opencode: { costUsd: 0, costEur: 0, sessions: 0, tokens: 0 },
  },
  byModel: [
    {
      tool: 'claude-code',
      model: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      costEur: 9.2,
      tokens: 3_608_000,
      requests: 3,
      unpricedRequests: 0,
    },
    {
      tool: 'copilot-cli',
      model: 'mystery-1',
      label: 'mystery-1',
      costEur: 0,
      tokens: 1010,
      requests: 1,
      unpricedRequests: 1,
    },
  ],
};
const twoModels: TaskUsage = {
  ...usage,
  billable: { ...usage.billable, costEur: 1234.56 },
  byModel: [
    { ...usage.byModel[0], label: 'Claude Sonnet 5.5', costEur: 1000 },
    { ...usage.byModel[0], label: 'Claude Haiku 5.5', costEur: 234.56 },
  ],
};

beforeEach(() => {
  useStore.setState({
    tasks: [task],
    notices: [],
    repos: [
      {
        id: 'r1',
        name: 'webshop',
        path: '/r',
        baseBranch: 'main',
        connectionId: 'c1',
        configFound: true,
        discovered: false,
        workItemOnStart: {
          moveToInProgress: true,
          assignToMe: true,
          stateOverrides: {},
        },
      },
    ],
    connections: [
      {
        id: 'c1',
        name: 'unreliablewitness',
        organizationUrl: 'https://dev.azure.com/unreliablewitness',
        project: 'Shellie',
        user: 'Dries',
        status: 'ok',
        checkedAt: null,
        userUniqueName: null,
        provider: 'azure-devops' as const,
        workItemOnStart: {
          moveToInProgress: true,
          assignToMe: true,
          stateOverrides: {},
        },
      },
    ],
  });
});

describe('UsagePanel', () => {
  it('shows tiles, sessions and unpriced usage', async () => {
    installFakeApi({
      'usage:task': () => usage,
    });
    render(<UsagePanel taskId="t1" />);
    expect(await screen.findByRole('img', { name: /Billable/ })).toBeTruthy();
    expect(screen.getAllByText(`${EURO}9.20`).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Official list prices .* USD\S+EUR 0.92/),
    ).toBeTruthy();
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText('claude-opus-5-5')).toBeTruthy();
    expect(within(rows[1]).getByText(`${EURO}9.20`)).toBeTruthy();
    expect(within(rows[1]).getByText('3.9M')).toBeTruthy();
    expect(screen.getByTestId('tokens-total')).toHaveTextContent('3.6M');
    expect(within(rows[2]).getByText('unpriced')).toBeTruthy();
    expect(
      screen.getByText(
        /1 request uses a model that is not in Shellie's official price list yet/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/work item/i)).toBeNull();
  });
  it('toggles billable and exports', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      () => undefined,
    );
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const { calls } = installFakeApi({
      'usage:task': () => usage,
      'usage:setBillable': () => ({
        ...usage,
        sessions: usage.sessions.map((s) =>
          s.sessionId === 's1' ? { ...s, billable: false } : s,
        ),
      }),
      'usage:exportCsv': () => 'time\r\n',
    });
    render(<UsagePanel taskId="t1" />);
    const boxes = await screen.findAllByRole('checkbox', { name: /Billable/ });
    await userEvent.click(boxes[0]);
    expect(calls.find((c) => c.channel === 'usage:setBillable')?.args).toEqual([
      't1',
      's1',
      false,
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'CSV' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  });
  it('shows the lineage: subagents nested under their session, folding', async () => {
    const node = {
      label: '',
      tool: 'claude-code' as const,
      model: 'claude-opus-5-5',
      modelLabel: 'Claude Opus 5.5',
      effort: 'high',
      parentId: null,
      startedAt: '2026-10-14T09:12:00.000Z',
      costUsd: 10,
      costEur: 9.2,
      tokens: 3_608_000,
      requests: 3,
      unpricedRequests: 0,
    };
    installFakeApi({
      'usage:task': () => ({
        ...usage,
        lineage: [
          {
            ...node,
            id: 's1',
            children: [
              {
                ...node,
                id: 's1:Explore',
                label: 'Explore',
                model: 'claude-haiku-5-5',
                modelLabel: 'Claude Haiku 5.5',
                effort: null,
                parentId: 's1',
                costUsd: 2,
                costEur: 1.84,
                tokens: 1000,
                requests: 1,
                children: [],
              },
            ],
          },
        ],
      }),
    });
    render(<UsagePanel taskId="t1" />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Lineage' }));
    const tree = screen.getByRole('tree', { name: 'Cost per agent' });
    const [root] = within(tree).getAllByRole('treeitem');
    expect(root).toHaveAttribute('aria-level', '1');
    expect(within(root).getByText('Opus 5.5')).toBeTruthy();
    expect(within(root).getByText('high')).toBeTruthy();
    const child = within(root).getByRole('treeitem');
    expect(child).toHaveAttribute('aria-level', '2');
    expect(within(child).getByText('Explore')).toBeTruthy();
    expect(within(child).getByText('Haiku 5.5')).toBeTruthy();
    expect(within(child).getByText(`${EURO}1.84`)).toBeTruthy();
    expect(within(child).getByText('20%')).toBeTruthy();
    await userEvent.click(
      within(root).getByRole('button', { name: 'Hide subagents' }),
    );
    expect(within(root).queryByText('Explore')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('explains an empty task', async () => {
    useStore.setState({
      repos: [
        {
          id: 'r1',
          name: 'webshop',
          path: '/r',
          baseBranch: 'main',
          connectionId: null,
          configFound: true,
          discovered: false,
          workItemOnStart: {
            moveToInProgress: true,
            assignToMe: true,
            stateOverrides: {},
          },
        },
      ],
    });
    installFakeApi();
    render(<UsagePanel taskId="t1" />);
    expect(
      await screen.findByText(/No AI usage captured for this task yet/),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Write to work item' }),
    ).toBeNull();
  });
  it('offers the CSV export and no write to the work item', async () => {
    installFakeApi({ 'usage:task': () => usage });
    render(<UsagePanel taskId="t1" />);
    expect(
      await screen.findByRole('button', { name: 'CSV' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Write to work item' }),
    ).toBeNull();
  });

  it('says the task was not found', () => {
    useStore.setState({ tasks: [] });
    installFakeApi();
    render(<UsagePanel taskId="gone" />);
    expect(screen.getByText('Task not found')).toBeTruthy();
  });
  it('splits the billable ring by model with a legend of name, euros and share', async () => {
    installFakeApi({ 'usage:task': () => twoModels });
    render(<UsagePanel taskId="t1" />);
    const ring = await screen.findByRole('img', {
      name: /Billable .*1234\.56/,
    });
    const segs = ring.querySelectorAll('[data-part="segment"]');
    expect([...segs].map((x) => x.getAttribute('stroke'))).toEqual([
      'var(--chart-sonnet)',
      'var(--chart-haiku)',
    ]);
    expect([...segs].map((x) => x.getAttribute('data-fraction'))).toEqual([
      '0.81',
      '0.19',
    ]);
    expect(segs[0].querySelector('title')?.textContent).toMatch(
      /Sonnet 5\.5 .*1000\.00/,
    );
    const legend = screen.getByRole('list', { name: 'Cost per model' });
    const rows = within(legend).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      `Sonnet 5.5${EURO}1000.0081%`,
      `Haiku 5.5${EURO}234.5619%`,
    ]);
    // The centre shows a short amount, sized down to stay inside the hole.
    const value = ring.querySelector('[data-part="center-value"]')!;
    expect(value.textContent).toBe(`${EURO}1,235`);
    expect(Number(value.getAttribute('font-size'))).toBeLessThan(9);
    expect(
      ring.querySelector('[data-part="center-caption"]')?.textContent,
    ).toBe('total');
  });
  it('shows a tiny share as <1%', async () => {
    installFakeApi({
      'usage:task': () => ({
        ...twoModels,
        byModel: [
          { ...twoModels.byModel[0], costEur: 999 },
          { ...twoModels.byModel[1], costEur: 1 },
        ],
      }),
    });
    render(<UsagePanel taskId="t1" />);
    const legend = await screen.findByRole('list', { name: 'Cost per model' });
    expect(within(legend).getAllByRole('listitem')[1]).toHaveTextContent('<1%');
  });
  it('lists an unpriced Copilot model without a share', async () => {
    installFakeApi({ 'usage:task': () => usage });
    render(<UsagePanel taskId="t1" />);
    const legend = await screen.findByRole('list', { name: 'Cost per model' });
    const rows = within(legend).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      `Opus 5.5${EURO}9.20100%`,
      'mystery-1 (Copilot)unpriced',
    ]);
    const ring = screen.getByRole('img', { name: /Billable/ });
    expect(ring.querySelectorAll('[data-part="segment"]')).toHaveLength(1);
  });
  it('shows OpenCode usage in its own colour and name', async () => {
    const now = Date.parse('2026-10-14T10:07:00.000Z');
    installFakeApi({
      'usage:task': () => ({
        ...usage,
        sessions: [
          {
            ...usage.sessions[0],
            sessionId: 'o1',
            tool: 'opencode',
            models: ['claude-sonnet-5-5'],
          },
        ],
        byModel: [
          {
            ...usage.byModel[0],
            tool: 'opencode',
            model: 'claude-sonnet-5-5',
            label: 'Claude Sonnet 5.5',
          },
        ],
        recent: [
          { at: '2026-10-14T09:20:00.000Z', tool: 'opencode', costEur: 0.5 },
        ],
      }),
    });
    render(<UsagePanel taskId="t1" now={() => now} />);
    const ring = await screen.findByRole('img', { name: /Billable/ });
    expect(
      ring.querySelector('[data-part="segment"]')?.getAttribute('stroke'),
    ).toBe('var(--chart-opencode)');
    const legend = screen.getByRole('list', { name: 'Cost per model' });
    expect(within(legend).getAllByRole('listitem')[0]).toHaveTextContent(
      'Sonnet 5.5 (OpenCode)',
    );
    const row = screen.getByRole('cell', { name: 'OpenCode' });
    expect(row).toBeTruthy();
    const used = [...document.querySelectorAll('[data-part="bin"]')].find((b) =>
      b.getAttribute('title')?.includes(EURO),
    );
    expect(used!.querySelector<HTMLElement>('span')!.style.background).toBe(
      'var(--chart-opencode)',
    );
  });
  it('labels the hours under the 6 hour chart on bin edges and titles each bin', async () => {
    const now = Date.parse('2026-10-14T10:07:00.000Z');
    installFakeApi({
      'usage:task': () => ({
        ...usage,
        recent: [
          { at: '2026-10-14T09:20:00.000Z', tool: 'claude-code', costEur: 0.5 },
        ],
      }),
    });
    render(<UsagePanel taskId="t1" now={() => now} />);
    await screen.findByRole('img', { name: /Cost per 15 minutes/ });
    const bins = [...document.querySelectorAll('[data-part="bin"]')];
    const starts = bins.map((b) => Number(b.getAttribute('data-start')));
    const ticks = [...document.querySelectorAll('[data-part="tick"]')];
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    const hhmm = (ms: number) =>
      new Date(ms).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      });
    for (const tk of ticks) {
      const at = Number(tk.getAttribute('data-at'));
      expect(new Date(at).getMinutes()).toBe(0);
      expect(tk.textContent).toBe(hhmm(at));
      const edge = starts.indexOf(at);
      const left = (tk as HTMLElement).style.left;
      expect(left).toBe(`${(100 * (edge === -1 ? 24 : edge)) / 24}%`);
    }
    const used = bins.find((b) => b.getAttribute('title')?.includes(EURO));
    expect(used?.getAttribute('title')).toBe(
      `${hhmm(Date.parse('2026-10-14T09:15:00.000Z'))}${String.fromCharCode(0x2013)}${hhmm(Date.parse('2026-10-14T09:30:00.000Z'))} ${String.fromCharCode(0xb7)} ${EURO}0.50`,
    );
    expect(screen.getByText(/0\.50 in 6 h . 15 min bars/)).toBeInTheDocument();
  });
  it('marks a session with an event in the last 5 minutes as LIVE', async () => {
    const now = Date.parse('2026-10-14T10:03:00.000Z');
    installFakeApi({
      'usage:task': () => ({
        ...usage,
        sessions: usage.sessions.map((s, i) => ({
          ...s,
          lastAt: i === 1 ? '2026-10-14T10:00:00.000Z' : s.startedAt,
        })),
      }),
    });
    render(<UsagePanel taskId="t1" now={() => now} />);
    const rows = await screen.findAllByRole('row');
    expect(rows.filter((r) => r.textContent?.includes('LIVE'))).toHaveLength(1);
  });
  it('drops LIVE once 5 minutes pass without new usage', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let clock = Date.parse('2026-10-14T10:03:00.000Z');
      installFakeApi({
        'usage:task': () => ({
          ...usage,
          sessions: [
            { ...usage.sessions[1], lastAt: '2026-10-14T10:00:00.000Z' },
          ],
        }),
      });
      render(<UsagePanel taskId="t1" now={() => clock} />);
      expect(await screen.findByText('LIVE')).toBeInTheDocument();
      expect(
        document.querySelector('[data-part="bin"].is-live'),
      ).not.toBeNull();
      clock = Date.parse('2026-10-14T10:06:00.000Z');
      act(() => vi.advanceTimersByTime(30_000));
      expect(screen.queryByText('LIVE')).toBeNull();
      expect(document.querySelector('[data-part="bin"].is-live')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it('stops its clock on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      installFakeApi({ 'usage:task': () => usage });
      const { unmount } = render(<UsagePanel taskId="t1" />);
      await screen.findByRole('img', { name: /Cost per 15 minutes/ });
      const before = vi.getTimerCount();
      unmount();
      expect(vi.getTimerCount()).toBeLessThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
  it('mutes and strikes through a non-billable session', async () => {
    installFakeApi({
      'usage:task': () => ({
        ...usage,
        sessions: [{ ...usage.sessions[0], billable: false }],
      }),
    });
    render(<UsagePanel taskId="t1" />);
    const row = (await screen.findAllByRole('row'))[1];
    expect(row).toHaveClass('is-excluded');
  });
  it('draws 24 timeline bins', async () => {
    installFakeApi({ 'usage:task': () => usage });
    render(<UsagePanel taskId="t1" />);
    expect(
      await screen.findByRole('img', { name: /Cost per 15 minutes/ }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll('[data-part="bin"]')).toHaveLength(24);
  });
});
