import type { Handlers } from '../../shared/ipc';
import {
  AGENT_TOOLS,
  type LocalItemTime,
  type WeekRow,
} from '../../shared/time';
import type { Task } from '../../shared/types';
import type { AppSettings } from '../../shared/usage';
import type { ActivityTracker } from './ActivityTracker';
import type { TimeStore } from './TimeStore';
import { timeCsv } from './timeCsv';
import { weekBounds } from './weekTime';

type TimeChannels =
  | 'time:focus'
  | 'time:task'
  | 'time:sprint'
  | 'time:week'
  | 'time:exportCsv';

export type TimeDeps = {
  time: TimeStore;
  tasks: () => Task[];
  task: (id: string) => Task;
  settings: () => AppSettings;
  /** The connection of the task's repo, null when the repo has none (or is gone). */
  connectionOf: (task: Task) => string | null;
  /** The name the Week page groups a task under: its Azure DevOps project, else its repo; null for neither. */
  projectOf: (task: Task) => string | null;
  tracker?: Pick<ActivityTracker, 'setTask'>;
  now?: () => number;
};

/** The baseline key of a work item: estimates are per connection, since ids repeat across organizations. */
export const baselineKey = (connectionId: string, workItemId: string): string =>
  `${connectionId}:${workItemId}`;

export function createTimeHandlers(d: TimeDeps): Pick<Handlers, TimeChannels> {
  const now = d.now ?? Date.now;
  const summarize = (task: Task) =>
    d.time.summarize(task, d.settings().workHours, now());

  return {
    'time:focus': async (taskId) => {
      // Finished tasks never count (their Done page is a task page too); a reopened one counts again.
      const task =
        taskId === null ? undefined : d.tasks().find((t) => t.id === taskId);
      d.tracker?.setTask(task && task.status !== 'done' ? task.id : null);
    },
    'time:task': async (taskId) => {
      const task = d.task(taskId);
      const connectionId = d.connectionOf(task);
      const hours =
        connectionId && task.workItem
          ? d.time.baseline(baselineKey(connectionId, task.workItem.id))
          : null;
      return {
        ...summarize(task),
        estimate: hours === null ? null : { hours, source: 'baseline' },
      };
    },
    'time:exportCsv': async (taskId) => {
      const task = d.task(taskId);
      const s = summarize(task);
      return timeCsv([
        {
          task: task.branch,
          workItem: task.workItem?.id ?? '',
          booked: s.booking?.bookedSeconds ?? null,
          measured: s.activeSeconds,
          realistic: s.realisticSeconds,
          wallClock: s.wallClockSeconds,
          claude: s.agentSeconds['claude-code'],
          copilot: s.agentSeconds['copilot-cli'],
          opencode: s.agentSeconds.opencode,
        },
      ]);
    },
    'time:sprint': async (connectionId) => {
      const out: Record<string, LocalItemTime> = {};
      for (const task of d.tasks()) {
        if (!task.workItem || d.connectionOf(task) !== connectionId) continue;
        const id = task.workItem.id;
        const s = summarize(task);
        // Booked once finished; a reopened task adds what was measured since the reopen.
        const spent = !s.booking
          ? s.activeSeconds
          : task.status === 'done'
            ? s.booking.bookedSeconds
            : s.booking.bookedSeconds + s.measuredSinceReopenSeconds;
        const item = (out[id] ??= {
          spentSeconds: 0,
          measuredSeconds: 0,
          agentSeconds: 0,
          booked: false,
          baselineHours: d.time.baseline(baselineKey(connectionId, id)),
        });
        item.spentSeconds += spent;
        item.measuredSeconds += s.activeSeconds;
        item.agentSeconds += AGENT_TOOLS.reduce(
          (n, t) => n + s.agentSeconds[t],
          0,
        );
        item.booked ||= s.booking !== null;
      }
      return out;
    },
    'time:week': async (weekStart) => {
      const bounds = weekBounds(weekStart);
      const at = now();
      const rows: WeekRow[] = [];
      // Open and finished tasks alike: a timesheet wants every task worked on that week.
      for (const task of d.tasks()) {
        const perDay = d.time.weekSeconds(task, bounds, at);
        const totalSeconds = perDay.reduce((n, s) => n + s, 0);
        if (totalSeconds === 0) continue;
        rows.push({
          taskId: task.id,
          title: task.workItem?.title ?? (task.name || task.branch),
          project: d.projectOf(task),
          workItem: task.workItem
            ? { id: task.workItem.id, title: task.workItem.title }
            : null,
          perDay,
          totalSeconds,
        });
      }
      rows.sort((a, b) => b.totalSeconds - a.totalSeconds);
      const dayTotals = bounds
        .slice(0, -1)
        .map((_, i) => rows.reduce((n, r) => n + r.perDay[i], 0));
      return {
        weekStart,
        rows,
        dayTotals,
        totalSeconds: dayTotals.reduce((n, s) => n + s, 0),
      };
    },
  };
}
