import {
  periodRange,
  type HomePeriod,
  type HomeStats,
} from '../../shared/home';
import {
  AGENT_TOOLS,
  clip,
  totalMs,
  unionMs,
  type AgentTool,
  type Interval,
} from '../../shared/time';
import type { Repo, Task } from '../../shared/types';
import {
  OFFICIAL_USD_TO_EUR,
  type UsageRecord,
  type UsageTool,
} from '../../shared/usage';
import { taskConnectionId } from '../../shared/workspaces';
import { baselineKey } from '../time/timeHandlers';

type UsageSource = HomeStatsInput['usage'];

/** The one billable rule: a priced record in a session marked billable. */
export function isBillableRecord(
  usage: UsageSource,
  taskId: string,
  r: UsageRecord,
): r is UsageRecord & { costUsd: number } {
  return r.costUsd !== null && usage.isBillable(taskId, r.sessionId);
}

/** Billable EUR per task id; tasks without billable usage are absent. */
export function billableEurByTask(
  usage: UsageSource,
  taskIds: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of taskIds) {
    let eur = 0;
    let any = false;
    for (const r of usage.records(id)) {
      if (!isBillableRecord(usage, id, r)) continue;
      eur += r.costUsd * OFFICIAL_USD_TO_EUR;
      any = true;
    }
    if (any) out[id] = eur;
  }
  return out;
}

export type HomeStatsInput = {
  period: HomePeriod;
  now: Date;
  tasks: Task[];
  repos: Pick<Repo, 'id' | 'connectionId'>[];
  usage: {
    records(taskId: string): UsageRecord[];
    isBillable(taskId: string, sessionId: string): boolean;
  };
  time: {
    activeIntervals(taskId: string): Interval[];
    agentIntervals(taskId: string): Record<AgentTool, Interval[]>;
    baseline(key: string): number | null;
  };
};

/** The developer's own totals for this week or month, from local data only. */
export function homeStats(d: HomeStatsInput): HomeStats {
  const { from, to } = periodRange(d.period, d.now);
  const inPeriod = (iso: string | null) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return t >= from && t <= to;
  };
  const costByTool: Record<UsageTool, number> = {
    'claude-code': 0,
    'copilot-cli': 0,
    opencode: 0,
  };
  const byConnection = new Map<string | null, number>();
  let activeMs = 0;
  let agentMs = 0;
  let booked = 0;
  let estimated = 0;
  let accuracyTasks = 0;
  let tasksFinished = 0;
  let prsOpened = 0;

  for (const task of d.tasks) {
    const connectionId = taskConnectionId(task, d.repos);
    for (const r of d.usage.records(task.id)) {
      if (!inPeriod(r.at) || !isBillableRecord(d.usage, task.id, r)) continue;
      const eur = r.costUsd * OFFICIAL_USD_TO_EUR;
      costByTool[r.tool] += eur;
      byConnection.set(
        connectionId,
        (byConnection.get(connectionId) ?? 0) + eur,
      );
    }
    activeMs += totalMs(clip(d.time.activeIntervals(task.id), from, to));
    const agent = d.time.agentIntervals(task.id);
    agentMs += unionMs(...AGENT_TOOLS.map((t) => clip(agent[t], from, to)));

    if (task.status !== 'done' || !inPeriod(task.finishedAt)) continue;
    tasksFinished++;
    prsOpened +=
      (task.pullRequest ? 1 : 0) +
      task.extraWorkspaces.filter((w) => w.pullRequest).length;
    const hours =
      connectionId && task.workItem
        ? d.time.baseline(baselineKey(connectionId, task.workItem.id))
        : null;
    if (task.time && hours !== null && hours > 0) {
      booked += task.time.bookedSeconds;
      estimated += hours * 3600;
      accuracyTasks++;
    }
  }

  return {
    period: d.period,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    costEur:
      costByTool['claude-code'] +
      costByTool['copilot-cli'] +
      costByTool.opencode,
    costByTool,
    costByConnection: [...byConnection.entries()]
      .map(([connectionId, costEur]) => ({ connectionId, costEur }))
      .sort((a, b) => b.costEur - a.costEur),
    activeSeconds: Math.round(activeMs / 1000),
    agentSeconds: Math.round(agentMs / 1000),
    accuracy: accuracyTasks > 0 ? booked / estimated : null,
    accuracyTasks,
    tasksFinished,
    prsOpened,
  };
}
