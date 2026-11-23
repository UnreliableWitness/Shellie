import {
  ChevronLeft16Regular,
  ChevronRight16Regular,
} from '@fluentui/react-icons';
import { useState } from 'react';
import { api } from '../api';
import { PageHeader } from '../components/ui';
import { useLiveQuery } from '../hooks/useLiveQuery';

/** Time changes arrive every ~10 s while an agent runs; the table refetches at most this often. */
const TIME_REFRESH_MS = 5_000;

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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

/** Hours in quarter steps, like the time booked on a work item; blank for none. */
const hours = (seconds: number) =>
  seconds === 0 ? '' : String(Math.round(seconds / 900) / 4);

/** The exact time as h:mm, for the hover. */
const hmm = (seconds: number) => {
  const m = Math.round(seconds / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

function Hours({ seconds }: { seconds: number }) {
  return (
    <td className="week-hours" title={seconds ? hmm(seconds) : undefined}>
      {hours(seconds)}
    </td>
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
        after={<span className="muted">{range}</span>}
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
            <table className="week-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Project</th>
                  {DAYS.map((day, i) => (
                    <th key={day} className="week-hours">
                      {day} {dateOf(weekStart, i).getDate()}
                    </th>
                  ))}
                  <th className="week-hours">Total</th>
                </tr>
              </thead>
              <tbody>
                {week.rows.map((r) => (
                  <tr key={r.taskId}>
                    <td>
                      {r.workItem && (
                        <span className="mono muted">{r.workItem.id}</span>
                      )}
                      {r.workItem && ' '}
                      <span>{r.title}</span>
                    </td>
                    <td>{r.project ?? ''}</td>
                    {r.perDay.map((s, i) => (
                      <Hours key={i} seconds={s} />
                    ))}
                    <Hours seconds={r.totalSeconds} />
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td />
                  {week.dayTotals.map((s, i) => (
                    <Hours key={i} seconds={s} />
                  ))}
                  <Hours seconds={week.totalSeconds} />
                </tr>
              </tfoot>
            </table>
            <p className="muted week-note">
              Time in Shellie and agent time, overlap counted once, in hours
              rounded to the quarter. Hover a number for the exact time.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
