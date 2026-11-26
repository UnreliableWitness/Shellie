import { useStore } from '../../store';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BudgetView } from '../../../shared/budgetView';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { BudgetBand, modelColor } from './BudgetBand';

const view = (o: Partial<BudgetView> = {}): BudgetView => ({
  monthOffset: 0,
  startDay: '2026-10-01',
  endDay: '2026-10-31',
  budgetEur: 500,
  spentEur: 312,
  daysElapsed: 19,
  daysInMonth: 31,
  forecastEur: 470,
  status: 'onTrack',
  cumulative: [{ day: '2026-10-01', eur: 12 }],
  days: [],
  models: [
    { model: 'claude-opus-5-5', costEur: 241, tokens: 1_000_000, requests: 10 },
  ],
  todayEur: 14,
  todayAllowanceEur: 20,
  weekEur: 71,
  outsideShare: 0.38,
  notCounted: [],
  unpriced: [],
  sources: { claudeCode: true, openCode: true },
  scanned: true,
  alertsDue: [],
  ...o,
});

describe('BudgetBand', () => {
  it('shows spend of budget and an on-track forecast', async () => {
    installFakeApi({ 'budget:get': () => view() });
    render(<BudgetBand vendor="claude" />);
    expect(await screen.findByText('€312.00')).toBeTruthy();
    expect(screen.getByText('of €500.00')).toBeTruthy();
    expect(screen.getByText('On track: about €470.00 by Oct 31')).toBeTruthy();
    expect(
      screen.getByText('This week €71.00 · 38% outside Shellie'),
    ).toBeTruthy();
  });

  it('shows today against its daily allowance', async () => {
    installFakeApi({ 'budget:get': () => view() });
    const { container } = render(<BudgetBand vendor="claude" />);
    expect(await screen.findByText('€14.00')).toBeTruthy();
    expect(screen.getByText('today of €20.00')).toBeTruthy();
    expect(screen.getByText('€6.00 left today')).toBeTruthy();
    expect(container.querySelector('.budget-today.is-over')).toBeNull();
  });

  it('flags today when it is over its allowance', async () => {
    installFakeApi({
      'budget:get': () => view({ todayEur: 26.5, todayAllowanceEur: 20 }),
    });
    const { container } = render(<BudgetBand vendor="claude" />);
    expect(await screen.findByText('€6.50 over today')).toBeTruthy();
    expect(container.querySelector('.budget-today.is-over')).toBeTruthy();
  });

  it('shows today without an allowance when there is no budget', async () => {
    installFakeApi({
      'budget:get': () =>
        view({ budgetEur: null, status: 'none', todayAllowanceEur: null }),
    });
    render(<BudgetBand vendor="claude" />);
    expect(await screen.findByText('€14.00')).toBeTruthy();
    expect(screen.getByText('today')).toBeTruthy();
    expect(screen.queryByText(/left today|over today/)).toBeNull();
  });

  it('hides today for a past month', async () => {
    installFakeApi({
      'budget:get': (_vendor, offset) =>
        offset < 0
          ? view({ monthOffset: offset, todayEur: 0, todayAllowanceEur: null })
          : view(),
    });
    const { container } = render(<BudgetBand vendor="claude" />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Previous month' }),
    );
    await screen.findByRole('button', { name: 'Next month' });
    expect(container.querySelector('.budget-today')).toBeNull();
  });

  it('warns when the pace or the spend goes over', async () => {
    installFakeApi({
      'budget:get': () => view({ status: 'paceOver', forecastEur: 510 }),
    });
    render(<BudgetBand vendor="claude" />);
    expect(
      await screen.findByText('On pace for €510.00, €10.00 over'),
    ).toBeTruthy();
  });

  it('shows over budget', async () => {
    installFakeApi({
      'budget:get': () =>
        view({ status: 'over', spentEur: 530, forecastEur: 800 }),
    });
    render(<BudgetBand vendor="claude" />);
    expect(await screen.findByText('Over budget by €30.00')).toBeTruthy();
  });

  it('offers to set a budget when there is none', async () => {
    installFakeApi({
      'budget:get': () => view({ budgetEur: null, status: 'none' }),
    });
    render(<BudgetBand vendor="claude" />);
    expect(await screen.findByText('€312.00 this month')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Set a monthly budget' }),
    ).toBeTruthy();
  });

  it('lists usage in no budget and unpriced usage', async () => {
    installFakeApi({
      'budget:get': () =>
        view({
          notCounted: [
            {
              model: 'gpt-claude-ish',
              provider: 'openai',
              requests: 1,
              tokens: 10,
            },
          ],
          unpriced: [{ model: 'claude-mystery-9', tokens: 2_000, requests: 2 }],
        }),
    });
    render(<BudgetBand vendor="claude" />);
    expect(
      await screen.findByText(
        'Not in a budget: gpt-claude-ish via OpenAI, 1 requests',
      ),
    ).toBeTruthy();
    const line = screen.getByText(
      'Not in the total: no price for claude-mystery-9 (2k tokens)',
    );
    expect(line).toHaveClass('budget-warn');
    expect(line).not.toHaveClass('muted');
    expect(screen.queryByText(/^Unpriced:/)).toBeNull();
  });

  it('marks the headline amount while usage has no price', async () => {
    installFakeApi({
      'budget:get': () =>
        view({
          unpriced: [{ model: 'claude-mystery-9', tokens: 2_000, requests: 2 }],
        }),
    });
    const { container } = render(<BudgetBand vendor="claude" />);
    await screen.findByText('€312.00');
    const mark = screen.getByRole('img', {
      name: 'Not in the total: no price for claude-mystery-9 (2k tokens)',
    });
    expect(mark).toHaveAttribute(
      'title',
      'Not in the total: no price for claude-mystery-9 (2k tokens)',
    );
    expect(container.querySelector('.budget-total')).toContainElement(mark);
  });

  it('marks the headline without a budget too', async () => {
    installFakeApi({
      'budget:get': () =>
        view({
          budgetEur: null,
          status: 'none',
          unpriced: [{ model: 'claude-mystery-9', tokens: 2_000, requests: 2 }],
        }),
    });
    const { container } = render(<BudgetBand vendor="claude" />);
    await screen.findByText('€312.00 this month');
    expect(container.querySelector('.budget-warn-mark')).toBeTruthy();
  });

  it('has no mark and no warning line when every model has a price', async () => {
    installFakeApi({ 'budget:get': () => view() });
    const { container } = render(<BudgetBand vendor="claude" />);
    await screen.findByText('€312.00');
    expect(container.querySelector('.budget-warn-mark')).toBeNull();
    expect(container.querySelector('.budget-warn')).toBeNull();
    expect(screen.queryByText(/Not in the total/)).toBeNull();
  });

  it('says that capture is off in the Claude band until the receiver listens', async () => {
    const off = {
      listening: false,
      port: 4319,
      error: 'Port 4319 is in use by another program',
      copilot: { records: 0, unreadable: 0 },
    };
    const { emit } = installFakeApi({
      'budget:get': () => view(),
      'usage:receiverStatus': () => off,
    });
    render(<BudgetBand vendor="claude" />);
    const line = await screen.findByRole('status');
    expect(line).toHaveTextContent(
      'AI usage capture is off: Port 4319 is in use by another program. Pick another port in Settings > AI cost and invoicing.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      section: 'cost',
    });
    act(() =>
      emit('usage:receiverStatus', { ...off, listening: true, error: null }),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('leaves the capture line to the Claude band', async () => {
    installFakeApi({
      'budget:get': () => view(),
      'usage:receiverStatus': () => ({
        listening: false,
        port: 4319,
        error: 'Port 4319 is in use by another program',
        copilot: { records: 0, unreadable: 0 },
      }),
    });
    render(<BudgetBand vendor="copilot" />);
    await screen.findByText('€312.00');
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('titles the Copilot band', async () => {
    const { calls } = installFakeApi({ 'budget:get': () => view() });
    render(<BudgetBand vendor="copilot" />);
    expect(
      await screen.findByRole('heading', { name: 'Copilot budget' }),
    ).toBeTruthy();
    expect(calls.find((c) => c.channel === 'budget:get')?.args[0]).toBe(
      'copilot',
    );
    expect(screen.getByLabelText(/GitHub Copilot list prices/)).toBeTruthy();
  });

  it('says in the Claude band that Copilot Claude counts elsewhere', async () => {
    installFakeApi({ 'budget:get': () => view() });
    render(<BudgetBand vendor="claude" />);
    expect(
      await screen.findByLabelText(
        /through GitHub Copilot count in the Copilot budget/,
      ),
    ).toBeTruthy();
  });

  it('hides a Copilot band with no spend and no budget', async () => {
    const { calls } = installFakeApi({
      'budget:get': () =>
        view({ spentEur: 0, budgetEur: null, status: 'none' }),
    });
    render(<BudgetBand vendor="copilot" />);
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'budget:get')).toBe(true),
    );
    await act(async () => {});
    expect(
      screen.queryByRole('heading', { name: 'Copilot budget' }),
    ).toBeNull();
  });

  it('keeps the Copilot band when stepping back to an empty month', async () => {
    installFakeApi({
      'budget:get': (_vendor: string, offset: number) =>
        offset === 0
          ? view()
          : view({
              monthOffset: offset,
              spentEur: 0,
              budgetEur: null,
              status: 'none',
            }),
    });
    render(<BudgetBand vendor="copilot" />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Previous month' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Next month' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Copilot budget' }),
    ).toBeTruthy();
  });

  it('shows a Copilot band whose month is all unpriced', async () => {
    installFakeApi({
      'budget:get': () =>
        view({
          spentEur: 0,
          budgetEur: null,
          status: 'none',
          unpriced: [{ model: 'gpt-9', tokens: 10, requests: 1 }],
        }),
    });
    render(<BudgetBand vendor="copilot" />);
    expect(
      await screen.findByRole('heading', { name: 'Copilot budget' }),
    ).toBeTruthy();
  });

  it('keeps the Claude band with no spend and no budget', async () => {
    installFakeApi({
      'budget:get': () =>
        view({ spentEur: 0, budgetEur: null, status: 'none' }),
    });
    render(<BudgetBand vendor="claude" />);
    expect(
      await screen.findByRole('heading', { name: 'Claude budget' }),
    ).toBeTruthy();
  });

  it('says when neither tool was found', async () => {
    installFakeApi({
      'budget:get': () =>
        view({
          sources: { claudeCode: false, openCode: false },
          spentEur: 0,
          models: [],
        }),
    });
    render(<BudgetBand vendor="claude" />);
    expect(
      await screen.findByText(
        'No Claude Code or OpenCode usage found on this computer.',
      ),
    ).toBeTruthy();
  });

  it('shows a loading line until the first scan finished', async () => {
    installFakeApi({
      'budget:get': () =>
        view({
          scanned: false,
          sources: { claudeCode: false, openCode: false },
        }),
    });
    render(<BudgetBand vendor="claude" />);
    expect(await screen.findByText('Reading Claude usage…')).toBeTruthy();
    expect(
      screen.queryByText(
        'No Claude Code or OpenCode usage found on this computer.',
      ),
    ).toBeNull();
  });

  it('names the month for a past month without a budget', async () => {
    installFakeApi({
      'budget:get': (_vendor, offset) =>
        offset < 0
          ? view({
              monthOffset: offset,
              startDay: '2026-09-01',
              endDay: '2026-09-30',
              budgetEur: null,
              status: 'none',
              spentEur: 2862.42,
            })
          : view({ budgetEur: null, status: 'none' }),
    });
    render(<BudgetBand vendor="claude" />);
    expect(await screen.findByText('€312.00 this month')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(await screen.findByText('€2862.42 in Sep')).toBeTruthy();
  });

  it('steps to the previous month and tracks it', async () => {
    const { calls, tracked } = installFakeApi({
      'budget:get': (_vendor, offset) => view({ monthOffset: offset }),
    });
    render(<BudgetBand vendor="claude" />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Previous month' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Next month' }),
    ).toBeTruthy();
    expect(
      calls.some((c) => c.channel === 'budget:get' && c.args[1] === -1),
    ).toBe(true);
    expect(
      tracked.some(
        (t) =>
          t.type === 'event' &&
          t.name === 'home.clicked' &&
          t.props?.band === 'budget-month',
      ),
    ).toBe(true);
  });

  it('refetches on budget:changed', async () => {
    let spent = 1;
    const { emit } = installFakeApi({
      'budget:get': () => view({ spentEur: spent }),
    });
    render(<BudgetBand vendor="claude" />);
    expect(await screen.findByText('€1.00')).toBeTruthy();
    spent = 2;
    act(() => emit('budget:changed', {}));
    expect(await screen.findByText('€2.00')).toBeTruthy();
  });
});

describe('BudgetBand details', () => {
  it('has one hover title per cumulative point', async () => {
    installFakeApi({
      'budget:get': () =>
        view({
          cumulative: [
            { day: '2026-10-01', eur: 12 },
            { day: '2026-10-02', eur: 30 },
          ],
        }),
    });
    const { container } = render(<BudgetBand vendor="claude" />);
    await screen.findByText('€312.00');
    const titles = [
      ...container.querySelectorAll(
        '.budget-burn [data-part="burn-hit"] title',
      ),
    ].map((t) => t.textContent);
    expect(titles).toEqual(['Oct 1: €12.00', 'Oct 2: €30.00']);
  });

  it('centres the burn-down hit rects on their day', async () => {
    installFakeApi({
      'budget:get': () =>
        view({
          cumulative: [
            { day: '2026-10-01', eur: 12 },
            { day: '2026-10-02', eur: 30 },
          ],
        }),
    });
    const { container } = render(<BudgetBand vendor="claude" />);
    await screen.findByText('€312.00');
    const rects = container.querySelectorAll('[data-part="burn-hit"]');
    // 31 days on a 600 wide chart: points 20 apart, so day 1 spans -10..10.
    expect(Number(rects[0].getAttribute('x'))).toBeCloseTo(-10, 6);
    expect(Number(rects[0].getAttribute('width'))).toBeCloseTo(20, 6);
    expect(Number(rects[1].getAttribute('x'))).toBeCloseTo(10, 6);
  });

  it('outlines an empty today in a neutral colour with a minimum height', async () => {
    installFakeApi({
      'budget:get': () =>
        view({
          days: [
            {
              day: '2026-10-19',
              future: false,
              today: true,
              costEur: 0,
              byModel: [],
            },
          ],
        }),
    });
    const { container } = render(<BudgetBand vendor="claude" />);
    await screen.findByText('€312.00');
    const outline = container.querySelector('[data-part="today-outline"]')!;
    expect(outline.getAttribute('stroke')).toBe('var(--text)');
    expect(Number(outline.getAttribute('height'))).toBeGreaterThanOrEqual(4);
  });

  it('outlines today in the bars', async () => {
    const day = (d: string, today: boolean) => ({
      day: d,
      future: false,
      today,
      costEur: 5,
      byModel: [
        { model: 'claude-opus-5-5', costEur: 5, outsideEur: 1, tokens: 10 },
      ],
    });
    installFakeApi({
      'budget:get': () =>
        view({ days: [day('2026-10-18', false), day('2026-10-19', true)] }),
    });
    const { container } = render(<BudgetBand vendor="claude" />);
    await screen.findByText('€312.00');
    const groups = container.querySelectorAll('[data-part="day"]');
    expect(groups[0].querySelector('[data-part="today-outline"]')).toBeNull();
    expect(
      groups[1].querySelector('[data-part="today-outline"]'),
    ).not.toBeNull();
  });

  it('is neutral about the forecast when there is no budget', async () => {
    installFakeApi({
      'budget:get': () => view({ budgetEur: null, status: 'none' }),
    });
    render(<BudgetBand vendor="claude" />);
    expect(await screen.findByText('About €470.00 by Oct 31')).toBeTruthy();
    expect(screen.queryByText(/On track/)).toBeNull();
  });

  it('opens settings from the set-a-budget link and tracks it', async () => {
    const { tracked } = installFakeApi({
      'budget:get': () => view({ budgetEur: null, status: 'none' }),
    });
    render(<BudgetBand vendor="claude" />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Set a monthly budget' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      section: 'budgets',
    });
    expect(
      tracked.some(
        (t) =>
          t.type === 'event' &&
          t.name === 'home.clicked' &&
          t.props?.band === 'budget-settings',
      ),
    ).toBe(true);
  });
});

describe('modelColor', () => {
  it('colours by model family', () => {
    expect(modelColor('claude-opus-5-5')).toBe('var(--chart-opus)');
    expect(modelColor('claude-sonnet-4.6')).toBe('var(--chart-sonnet)');
    expect(modelColor('claude-haiku-5-5')).toBe('var(--chart-haiku)');
    expect(modelColor('claude-fable-5-1')).toBe('var(--chart-fable)');
    expect(modelColor('x')).toBe('var(--line-strong)');
    expect(modelColor('Claude Opus 5.5')).toBe('var(--chart-opus)');
    expect(modelColor('Claude Haiku 4.5')).toBe('var(--chart-haiku)');
  });
});
