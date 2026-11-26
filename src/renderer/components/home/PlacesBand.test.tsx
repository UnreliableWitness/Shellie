import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { BudgetBand } from './BudgetBand';
import { PlacesBand } from './PlacesBand';

describe('PlacesBand', () => {
  // The tile counts billable usage in Shellie's tasks; the budget band counts the whole month, outside Shellie too.
  it('says its cost is the tasks, next to a budget headline that counts more', async () => {
    installFakeApi({
      'home:stats': (period) => ({
        period,
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-26T09:00:00.000Z',
        costEur: 0,
        costByTool: { 'claude-code': 0, 'copilot-cli': 0, opencode: 0 },
        costByConnection: [],
        activeSeconds: 0,
        agentSeconds: 0,
        accuracy: null,
        accuracyTasks: 0,
        tasksFinished: 0,
        prsOpened: 0,
      }),
      'budget:get': (_vendor, monthOffset) => ({
        monthOffset,
        startDay: '2026-11-01',
        endDay: '2026-11-30',
        budgetEur: null,
        spentEur: 907.62,
        daysElapsed: 26,
        daysInMonth: 30,
        forecastEur: null,
        status: 'none',
        cumulative: [],
        days: [],
        models: [],
        todayEur: 0,
        todayAllowanceEur: null,
        weekEur: 0,
        outsideShare: 1,
        notCounted: [],
        unpriced: [],
        sources: { claudeCode: true, openCode: false },
        scanned: true,
        alertsDue: [],
      }),
    });
    render(
      <>
        <PlacesBand />
        <BudgetBand vendor="claude" />
      </>,
    );
    expect(await screen.findByText('€907.62 this month')).toBeTruthy();
    const tile = await screen.findByRole('button', { name: /^Cost/ });
    expect(tile).toHaveTextContent('Cost€0.00 in tasks this month');
    expect(screen.getAllByText(/this month$/)).toHaveLength(2);
    expect(screen.queryByText('€0.00 this month')).toBeNull();
  });
});
