import { api } from '../api';
import { useLiveQuery } from './useLiveQuery';

const NONE: Record<string, number> = {};

/**
 * Billable EUR per task id for a list of tasks (a missing id means 0), refetched when main reports usage
 * for one of them (or '*' for all tasks). Keyed on the ids themselves, so a new array with the same ids
 * does not refetch.
 */
export function useTaskCosts(taskIds: string[]): Record<string, number> {
  return useTaskCostsOrNull(taskIds) ?? NONE;
}

/** One task's billable EUR; null until the first reading arrives, so a control can show "unknown" rather than €0.00. */
export function useTaskCost(taskId: string): number | null {
  const costs = useTaskCostsOrNull([taskId]);
  return costs ? (costs[taskId] ?? 0) : null;
}

function useTaskCostsOrNull(taskIds: string[]): Record<string, number> | null {
  const key = taskIds.join(',');
  const ids = key ? key.split(',') : [];
  return useLiveQuery(
    ids.length > 0 ? () => api().invoke('usage:costs', ids) : null,
    (refetch) =>
      api().on('usage:changed', (p) => {
        if (p.taskId === '*' || ids.includes(p.taskId)) refetch();
      }),
    [key],
  ).value;
}
