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

  it("shows one card per task a day with the day's total, and each stretch on its own when asked", async () => {
    localStorage.clear();
    const base = week('2026-11-16');
    const interleaved = (): WeekTime => ({
      ...base,
      rows: [
        {
          ...base.rows[0],
          perDay: [9000, 2700, 0, 0, 0, 0, 0],
          stretches: [
            [
              { start: 100, seconds: 7200 },
              { start: 300, seconds: 1800 },
            ],
            ...base.rows[0].stretches.slice(1),
          ],
          totalSeconds: 11_700,
        },
        {
          ...base.rows[1],
          perDay: [3600, 1800, 0, 0, 0, 0, 0],
          stretches: [
            [{ start: 200, seconds: 3600 }],
            ...base.rows[1].stretches.slice(1),
          ],
          totalSeconds: 5400,
        },
      ],
      dayTotals: [12_600, 4500, 0, 0, 0, 0, 0],
      totalSeconds: 17_100,
    });
    installFakeApi({ 'time:week': interleaved });
    const user = userEvent.setup();
    const { unmount } = render(<WeekScreen />);
    await screen.findByRole('group', { name: /^Monday 16/ });
    expect(screen.getByRole('button', { name: 'Per task' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(cards(/^Monday 16/)).toEqual([
      '2.5 h12 Save a delivery address',
      '1 hSpike',
    ]);

    await user.click(screen.getByRole('button', { name: 'As worked' }));
    expect(cards(/^Monday 16/)).toEqual([
      '2 h12 Save a delivery address',
      '1 hSpike',
      '0.5 h12 Save a delivery address',
    ]);

    // The choice is remembered for the next time the page opens.
    unmount();
    render(<WeekScreen />);
    await screen.findByRole('group', { name: /^Monday 16/ });
    expect(screen.getByRole('button', { name: 'As worked' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    localStorage.clear();
  });

  it("makes a card as tall as its time, on a scale that ends at the week's longest day", async () => {
    installFakeApi({ 'time:week': week });
    render(<WeekScreen />);
    await screen.findByRole('group', { name: /^Monday 16/ });
    // No layout here, so an hour is its least, 40 px; a card is its time less the 2 px gap under it.
    expect(within(column(/^Monday 16/)).getByRole('button').style.height).toBe(
      '78px',
    );
    expect(
      within(column(/^Tuesday 17/)).getAllByRole('button')[0].style.height,
    ).toBe('18px');
    expect(screen.getByTestId('week-axis').textContent).toBe('0 h12');
  });

  it('runs the scale as far as a long day needs', async () => {
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

  it('shares the height the page has over the hours of the scale, and again when it changes', async () => {
    let pageHeight = 632;
    const height = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(() => pageHeight);
    const resized: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(onResize: () => void) {
          resized.push(onResize);
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      installFakeApi({ 'time:week': week });
      render(<WeekScreen />);
      await screen.findByRole('group', { name: /^Monday 16/ });
      const monday = () => within(column(/^Monday 16/)).getByRole('button');
      // Two hours on a scale of two: the card takes the whole 632 px, less its gap.
      expect(monday().style.height).toBe('630px');
      expect(screen.getByTestId('week-axis').style.height).toBe('632px');
      pageHeight = 400;
      act(() => resized.forEach((fn) => fn()));
      expect(monday().style.height).toBe('398px');
    } finally {
      height.mockRestore();
      vi.unstubAllGlobals();
    }
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

  it('lists under the columns each task with its exact hours per day, and the totals', async () => {
    installFakeApi({ 'time:week': week });
    render(<WeekScreen />);
    const table = await screen.findByRole('table', { name: 'Tasks this week' });
    const row = within(table)
      .getByText('Save a delivery address')
      .closest('tr')!;
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
    expect(
      within(screen.getByRole('row', { name: /^Total/ }))
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['Total', '', '2', '1.25', '', '', '', '', '', '3.25']);
    // The first task worked on gets the first colour, like its cards.
    expect(row.querySelector('.week-swatch')).toHaveAttribute(
      'data-series',
      '1',
    );
    expect(within(column(/^Monday 16/)).getByRole('button')).toHaveAttribute(
      'data-series',
      '1',
    );
  });

  it('names a card for a screen reader by its task, day and hours, and what a click does', async () => {
    installFakeApi({ 'time:week': week });
    render(<WeekScreen />);
    await screen.findByRole('group', { name: /^Monday 16/ });
    expect(
      within(column(/^Tuesday 17/)).getAllByRole('button')[1],
    ).toHaveAccessibleName(
      '12 Save a delivery address, Tuesday, 0.75 hours. Copy to the clipboard',
    );
  });

  it('gives a card of minutes a line with its text, out of the longer card of its day', async () => {
    const small = (weekStart: string): WeekTime => {
      const w = week(weekStart);
      w.rows[0].stretches[2] = [{ start: 400, seconds: 300 }];
      w.rows[1].stretches[2] = [{ start: 500, seconds: 3600 }];
      return w;
    };
    installFakeApi({ 'time:week': small });
    render(<WeekScreen />);
    await screen.findByRole('group', { name: /^Monday 16/ });
    const [minutes, hour] = within(column(/^Wednesday 18/)).getAllByRole(
      'button',
    );
    // Five minutes are 3 px on the scale; the card gets a line (20 px with its gap) and shows its task.
    expect(minutes.style.height).toBe('18px');
    expect(minutes).toHaveAttribute('data-size', 's');
    // Its hours would round to none, so it gives its minutes.
    expect(minutes).toHaveTextContent('5 min12 Save a delivery address');
    expect(minutes).toHaveAccessibleName(
      '12 Save a delivery address, Wednesday, 5 minutes. Copy to the clipboard',
    );
    // The hour gives up what the minutes got: the day's 65 minutes still end at 43 px.
    expect(hour.style.height).toBe('21px');
    expect(hour).toHaveAttribute('data-size', 's');
  });

  it('steps to the week before and back to this week', async () => {
    const api = installFakeApi({ 'time:week': week });
    render(<WeekScreen />);
    await screen.findByRole('table', { name: 'Tasks this week' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Previous week' }),
    );
    expect(
      await screen.findByText('No time measured in this week.'),
    ).toBeInTheDocument();
    // The empty week says how time gets measured.
    expect(
      screen.getByText(
        "Time counts while a task is open in Shellie with the window in front and you are at the keyboard, and while a task's agent is working.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'This week' }));
    await screen.findByRole('table', { name: 'Tasks this week' });
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
