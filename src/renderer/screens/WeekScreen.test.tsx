import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeekTime } from '../../shared/time';
import { installFakeApi } from '../test-helpers/fakeApi';
import { mondayOf, shiftWeek, WeekScreen } from './WeekScreen';

const week = (weekStart: string): WeekTime => ({
  weekStart,
  rows:
    weekStart === '2026-11-16'
      ? [
          {
            taskId: 'a',
            title: 'Save a delivery address',
            project: 'Shellie',
            workItem: { id: '12', title: 'Save a delivery address' },
            perDay: [7200, 2700, 0, 0, 0, 0, 0],
            totalSeconds: 9900,
          },
          {
            taskId: 'b',
            title: 'Spike',
            project: 'Webshop',
            workItem: null,
            perDay: [0, 1800, 0, 0, 0, 0, 0],
            totalSeconds: 1800,
          },
        ]
      : [],
  dayTotals:
    weekStart === '2026-11-16'
      ? [7200, 4500, 0, 0, 0, 0, 0]
      : [0, 0, 0, 0, 0, 0, 0],
  totalSeconds: weekStart === '2026-11-16' ? 11_700 : 0,
});

describe('week helpers', () => {
  it('finds the Monday of a week, Sunday belonging to the week before', () => {
    expect(mondayOf(new Date(2026, 10, 19))).toBe('2026-11-16');
    expect(mondayOf(new Date(2026, 10, 16))).toBe('2026-11-16');
    expect(mondayOf(new Date(2026, 10, 22, 23))).toBe('2026-11-16');
  });

  it('moves a week back and forth across a month end', () => {
    expect(shiftWeek('2026-11-30', 1)).toBe('2026-12-07');
    expect(shiftWeek('2026-11-02', -1)).toBe('2026-10-26');
  });
});

describe('WeekScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 19, 10));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows this week: a row per task with hours per day, and the day totals', async () => {
    installFakeApi({ 'time:week': week });
    render(<WeekScreen />);
    const row = (await screen.findByText('Save a delivery address')).closest(
      'tr',
    )!;
    const cells = within(row).getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual([
      '12 Save a delivery address',
      'Shellie',
      '2',
      '0.75',
      '',
      '',
      '',
      '',
      '',
      '2.75',
    ]);
    expect(cells[3]).toHaveAttribute('title', '0:45');
    const foot = screen.getByRole('row', { name: /^Total/ });
    expect(
      within(foot)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['Total', '', '2', '1.25', '', '', '', '', '', '3.25']);
  });

  it('steps to the week before and back to this week', async () => {
    const api = installFakeApi({ 'time:week': week });
    render(<WeekScreen />);
    await screen.findByText('Spike');
    await userEvent.click(
      screen.getByRole('button', { name: 'Previous week' }),
    );
    expect(
      await screen.findByText('No time measured in this week.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'This week' }));
    await screen.findByText('Spike');
    expect(
      api.calls.filter((c) => c.channel === 'time:week').map((c) => c.args[0]),
    ).toEqual(['2026-11-16', '2026-11-09', '2026-11-16']);
  });
});
