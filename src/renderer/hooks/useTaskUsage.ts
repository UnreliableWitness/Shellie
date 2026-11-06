import type { TaskUsage } from '../../shared/usage';
import { api } from '../api';
import { useLiveQuery } from './useLiveQuery';

/** Usage summary for one task, refetched whenever main reports a change for it (or '*' for all tasks). */
export function useTaskUsage(taskId: string | null): TaskUsage | null {
  return useLiveQuery(
    taskId ? () => api().invoke('usage:task', taskId) : null,
    (refetch) =>
      api().on('usage:changed', (p) => {
        if (p.taskId === taskId || p.taskId === '*') refetch();
      }),
    [taskId],
  ).value;
}
