import {
  ChevronLeft16Regular,
  ChevronRight16Regular,
} from '@fluentui/react-icons';
import { type CSSProperties, useMemo, useState } from 'react';
import type { WeekRow } from '../../shared/time';
import { api } from '../api';
import { PageHeader } from '../components/ui';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { useStore } from '../store';
import { dayBlocks, scaleHours, taskSlots } from '../weekColumns';

/** Time changes arrive every ~10 s while an agent runs; the page refetches at most this often. */
const TIME_REFRESH_MS = 5_000;

const DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/** The height of an hour in a day's column; a card is as tall as its time, less the gap under it. */
const HOUR_PX = 40;
const GAP_PX = 2;
/** A card this tall has room for its hours above its title; a lower one shows both on one line, a sliver neither. */
const TWO_LINES_PX = 43;
const ONE_LINE_PX = 16;

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const dateOf = (weekStart: string, plusDays = 0) => {
  const [y, m, d] = weekStart.split('-').map(Number);
  return new Date(y, m - 1, d + plusDays);
};

/** The local Monday (YYYY-MM-DD) of the week `d` falls in; weeks start on Monday. */
export const mondayOf = (d: Date): string =>
  iso(
    new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() - ((d.getDay() + 6) % 7),
    ),
  );

/** The Monday `weeks` weeks from `weekStart`. */
export const shiftWeek = (weekStart: string, weeks: number): string =>
  iso(dateOf(weekStart, weeks * 7));

/** Hours in quarter steps, like the time booked on a work item. */
const quarters = (seconds: number) => Math.round(seconds / 900) / 4;

/** The exact time as h:mm, for the hover. */
const hmm = (seconds: number) => {
  const m = Math.round(seconds / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

/** A cell of the table: hours to the quarter, blank for none, the exact time on hover. */
function Hours({ seconds }: { seconds: number }) {
  return (
    <td className="week-hours" title={seconds ? hmm(seconds) : undefined}>
      {seconds ? quarters(seconds) : ''}
    </td>
  );
}

/** A task as its cards and the table name it: the work item id before the title. */
const nameOf = (r: WeekRow) =>
  r.workItem ? `${r.workItem.id} ${r.title}` : r.title;

/** The colour of a task's cards and swatch: its slot's series, or the shared one once the colours ran out. */
const seriesOf = (slot: number | null | undefined) =>
  slot == null ? 'other' : String(slot + 1);

function TaskName({ row }: { row: WeekRow }) {
  return (
    <>
      {row.workItem && <span className="mono">{row.workItem.id}</span>}
      {row.workItem && ' '}
      {row.title}
    </>
  );
}

/**
 * The week as seven columns, Monday to Sunday, on a scale of hours worked (not of the clock): each day's work is
 * stacked from the top as cards, one per task per stretch, in the order worked and as tall as the time it took.
 * The scale is ten hours, or as many as the longest day needs. Under the columns, the tasks with their week totals.
 */
function WeekColumns({
  weekStart,
  rows,
  dayTotals,
}: {
  weekStart: string;
  rows: WeekRow[];
  dayTotals: number[];
}) {
  const notify = useStore((s) => s.notify);
  const blocks = useMemo(() => dayBlocks(rows), [rows]);
  const slots = useMemo(() => taskSlots(rows), [rows]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.taskId, r])), [rows]);
  const scale = scaleHours(dayTotals);
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => notify('info', `Copied: ${text}`),
      () => notify('error', 'Could not copy to the clipboard.'),
    );
  return (
    <>
      <section className="week-chart" aria-label="Hours per day, by task">
        <div className="week-grid">
          <span />
          {DAYS.map((day, i) => (
            <div
              key={day}
              className={i > 4 ? 'week-day is-weekend' : 'week-day'}
              aria-hidden="true"
            >
              <span>
                {day.slice(0, 3)}{' '}
                <span className="muted">{dateOf(weekStart, i).getDate()}</span>
              </span>
              <span
                className={dayTotals[i] ? 'week-day-total mono' : 'muted'}
                title={dayTotals[i] ? hmm(dayTotals[i]) : undefined}
              >
                {dayTotals[i] ? quarters(dayTotals[i]) : 'none'}
              </span>
            </div>
          ))}
          <div
            className="week-axis mono"
            data-testid="week-axis"
            aria-hidden="true"
            style={{ height: scale * HOUR_PX }}
          >
            {Array.from({ length: scale + 1 }, (_, h) => (
              <span
                key={h}
                className={h === 8 ? 'is-day' : undefined}
                style={{ top: h * HOUR_PX }}
              >
                {h === 0 ? '0 h' : h}
              </span>
            ))}
          </div>
          {DAYS.map((day, i) => {
            const total = quarters(dayTotals[i]);
            return (
              <div
                key={day}
                role="group"
                aria-label={`${day} ${dateOf(weekStart, i).getDate()}, ${
                  dayTotals[i]
                    ? `${total} ${total === 1 ? 'hour' : 'hours'}`
                    : 'no time'
                }`}
                className="week-col"
                style={
                  {
                    height: scale * HOUR_PX,
                    '--week-hour': `${HOUR_PX}px`,
                  } as CSSProperties
                }
              >
                {blocks[i].map((b, n) => {
                  const row = byId.get(b.taskId);
                  if (!row) return null;
                  // Never more than its time: a sliver of minutes is a line, so a day's cards end at its total.
                  const height = Math.max(
                    1,
                    Math.round((b.seconds / 3600) * HOUR_PX) - GAP_PX,
                  );
                  const worked = quarters(b.seconds);
                  const name = nameOf(row);
                  return (
                    <button
                      key={n}
                      type="button"
                      className="week-card"
                      data-series={seriesOf(slots.get(b.taskId))}
                      data-size={
                        height >= TWO_LINES_PX
                          ? 'l'
                          : height >= ONE_LINE_PX
                            ? 's'
                            : 'xs'
                      }
                      style={
                        {
                          height,
                          // The title's lines under the hours: 10 px of padding, 17 px for the hours, 16 px a line.
                          '--week-lines': Math.max(
                            1,
                            Math.floor((height - 27) / 16),
                          ),
                        } as CSSProperties
                      }
                      aria-label={`${name}, ${day}, ${worked} ${worked === 1 ? 'hour' : 'hours'}. Copy to the clipboard`}
                      title={`${name}\n${day}: ${hmm(b.seconds)}\nClick to copy`}
                      onClick={() => copy(name)}
                    >
                      <span className="week-card-hours mono">{worked} h</span>
                      <span className="week-card-title">
                        <TaskName row={row} />
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>
      {/* The exact numbers, for a timesheet: each task's hours per day, which the cards only round and stack. */}
      <table className="week-table" aria-label="Tasks this week">
        <thead>
          <tr>
            <th>Task</th>
            <th>Project</th>
            {DAYS.map((day, i) => (
              <th key={day} className="week-hours">
                {day.slice(0, 3)} {dateOf(weekStart, i).getDate()}
              </th>
            ))}
            <th className="week-hours">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.taskId}>
              <td>
                <span
                  className="week-swatch"
                  data-series={seriesOf(slots.get(r.taskId))}
                  aria-hidden="true"
                />
                {r.workItem && (
                  <span className="mono muted">{r.workItem.id}</span>
                )}
                {r.workItem && ' '}
                <span>{r.title}</span>
              </td>
              <td className="muted">{r.project ?? ''}</td>
              {r.perDay.map((sec, i) => (
                <Hours key={i} seconds={sec} />
              ))}
              <Hours seconds={r.totalSeconds} />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td />
            {dayTotals.map((sec, i) => (
              <Hours key={i} seconds={sec} />
            ))}
            <Hours seconds={dayTotals.reduce((n, sec) => n + sec, 0)} />
          </tr>
        </tfoot>
      </table>
    </>
  );
}

/** Every task worked on in a week, across all projects, with its time per day: for filling in timesheets. */
export function WeekScreen() {
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const thisWeek = mondayOf(new Date());
  const { value: week, error } = useLiveQuery(
    () => api().invoke('time:week', weekStart),
    (refetch) => api().on('time:changed', refetch),
    [weekStart],
    { throttleMs: TIME_REFRESH_MS },
  );

  const first = dateOf(weekStart);
  const last = dateOf(weekStart, 6);
  const range = `${first.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${last.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;

  return (
    <div className="page page-week">
      <PageHeader
        title="Week"
        after={
          <>
            <span className="muted">{range}</span>
            {week && week.totalSeconds > 0 && (
              <span className="week-total mono" title={hmm(week.totalSeconds)}>
                {quarters(week.totalSeconds)} h
              </span>
            )}
          </>
        }
        inline
        commands={
          <>
            <button
              type="button"
              className="btn"
              aria-label="Previous week"
              title="Previous week"
              onClick={() => setWeekStart(shiftWeek(weekStart, -1))}
            >
              <ChevronLeft16Regular aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn"
              disabled={weekStart === thisWeek}
              onClick={() => setWeekStart(thisWeek)}
            >
              This week
            </button>
            <button
              type="button"
              className="btn"
              aria-label="Next week"
              title="Next week"
              disabled={weekStart >= thisWeek}
              onClick={() => setWeekStart(shiftWeek(weekStart, 1))}
            >
              <ChevronRight16Regular aria-hidden="true" />
            </button>
          </>
        }
      />
      <div className="week-body">
        {!week && error ? (
          <div className="empty" role="alert">
            <p>Could not load the week</p>
          </div>
        ) : !week ? (
          <div className="empty">Loading...</div>
        ) : week.rows.length === 0 ? (
          <div className="empty">No time measured in this week.</div>
        ) : (
          <>
            <WeekColumns
              weekStart={weekStart}
              rows={week.rows}
              dayTotals={week.dayTotals}
            />
            <p className="muted week-note">
              Time in Shellie and agent time, overlap counted once, in hours
              rounded to the quarter, each number on its own, so rounded numbers
              need not add up. Hover a card or a number for the exact time;
              click a card to copy its task.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
