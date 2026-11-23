import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeekTime } from '../../shared/time';
import { useStore } from '../store';
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
            stretches: [
              [{ start: 100, seconds: 7200 }],
              [{ start: 300, seconds: 2700 }],
              [],
              [],
              [],
              [],
              [],
            ],
            totalSeconds: 9900,
          },
          {
            taskId: 'b',
            title: 'Spike',
            project: 'Webshop',
            workItem: null,
            perDay: [0, 1800, 0, 0, 0, 0, 0],
            stretches: [
              [],
              [{ start: 200, seconds: 1800 }],
              [],
              [],
              [],
              [],
              [],
            ],
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

  const column = (name: RegExp) => screen.getByRole('group', { name });
  const cards = (name: RegExp) =>
    within(column(name))
      .getAllByRole('button')
      .map((b) => b.textContent);

  it('shows each day as a column of cards, in the order worked, with the day totals on top', async () => {
    installFakeApi({ 'time:week': week });
    render(<WeekScreen />);
    await screen.findByRole('group', { name: /^Monday 16/ });
    expect(column(/^Monday 16/)).toHaveAccessibleName('Monday 16, 2 hours');
    expect(column(/^Tuesday 17/)).toHaveAccessibleName(
      'Tuesday 17, 1.25 hours',
    );
    expect(column(/^Wednesday 18/)).toHaveAccessibleName(
      'Wednesday 18, no time',
    );
    // The id comes before the title; Tuesday began with the spike (start 200), then the story (start 300).
    expect(cards(/^Monday 16/)).toEqual(['2 h12 Save a delivery address']);
    expect(cards(/^Tuesday 17/)).toEqual([
      '0.5 hSpike',
      '0.75 h12 Save a delivery address',
    ]);
    expect(
      within(column(/^Tuesday 17/)).getAllByRole('button')[1],
    ).toHaveAttribute('title', expect.stringContaining('0:45'));
    expect(screen.getByText('3.25 h')).toBeInTheDocument();
  });

  it('makes a card as tall as its time, on a scale of ten hours', async () => {
    installFakeApi({ 'time:week': week });
    render(<WeekScreen />);
    await screen.findByRole('group', { name: /^Monday 16/ });
    // 40 px per hour, less the 2 px gap under each card.
    expect(within(column(/^Monday 16/)).getByRole('button').style.height).toBe(
      '78px',
    );
    expect(
      within(column(/^Tuesday 17/)).getAllByRole('button')[0].style.height,
    ).toBe('18px');
    expect(screen.getByTestId('week-axis').textContent).toBe('0 h12345678910');
  });

  it('stretches the scale for a day longer than ten hours', async () => {
    const long = (weekStart: string): WeekTime => {
      const w = week(weekStart);
      const seconds = 14 * 3600 + 900;
      w.rows[0].perDay[0] = seconds;
      w.rows[0].stretches[0] = [{ start: 100, seconds }];
      w.dayTotals[0] = seconds;
      return w;
    };
    installFakeApi({ 'time:week': long });
    render(<WeekScreen />);
    await screen.findByRole('group', { name: /^Monday 16/ });
    expect(screen.getByTestId('week-axis').textContent).toBe(
      '0 h123456789101112131415',
    );
    expect(within(column(/^Monday 16/)).getByRole('button').style.height).toBe(
      '568px',
    );
    expect(column(/^Monday 16/)).toHaveAccessibleName('Monday 16, 14.25 hours');
  });

  it('copies the id and title of a clicked card, and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    installFakeApi({ 'time:week': week });
    useStore.setState({ notices: [] });
    render(<WeekScreen />);
    await screen.findByRole('group', { name: /^Monday 16/ });
    await userEvent.click(within(column(/^Monday 16/)).getByRole('button'));
    expect(writeText).toHaveBeenCalledWith('12 Save a delivery address');
    await userEvent.click(
      within(column(/^Tuesday 17/)).getAllByRole('button')[0],
    );
    expect(writeText).toHaveBeenLastCalledWith('Spike');
    await waitFor(() =>
      expect(useStore.getState().notices.map((n) => n.message)).toEqual([
        'Copied: 12 Save a delivery address',
        'Copied: Spike',
      ]),
    );
  });

  it('lists the tasks under the columns with their colour, project and week total', async () => {
    installFakeApi({ 'time:week': week });
    render(<WeekScreen />);
    const list = await screen.findByRole('list', { name: 'Tasks this week' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['12Save a delivery addressShellie2.75', 'SpikeWebshop0.5']);
    // The first task worked on gets the first colour, like its cards.
    expect(
      within(list).getAllByRole('listitem')[0].querySelector('.week-swatch'),
    ).toHaveAttribute('data-series', '1');
    expect(within(column(/^Monday 16/)).getByRole('button')).toHaveAttribute(
      'data-series',
      '1',
    );
  });

  it('steps to the week before and back to this week', async () => {
    const api = installFakeApi({ 'time:week': week });
    render(<WeekScreen />);
    await screen.findByRole('list', { name: 'Tasks this week' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Previous week' }),
    );
    expect(
      await screen.findByText('No time measured in this week.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'This week' }));
    await screen.findByRole('list', { name: 'Tasks this week' });
    expect(
      api.calls.filter((c) => c.channel === 'time:week').map((c) => c.args[0]),
    ).toEqual(['2026-11-16', '2026-11-09', '2026-11-16']);
  });

  it('ignores a late answer for the week it has already left', async () => {
    let answerThisWeek: (w: WeekTime) => void = () => {};
    installFakeApi({
      'time:week': (weekStart: string) =>
        weekStart === '2026-11-16'
          ? new Promise<WeekTime>((resolve) => (answerThisWeek = resolve))
          : Promise.resolve(week(weekStart)),
    });
    render(<WeekScreen />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Previous week' }),
    );
    await screen.findByText('No time measured in this week.');
    await act(async () => answerThisWeek(week('2026-11-16')));
    expect(
      screen.getByText('No time measured in this week.'),
    ).toBeInTheDocument();
    expect(screen.queryAllByText('Spike')).toHaveLength(0);
  });
});
