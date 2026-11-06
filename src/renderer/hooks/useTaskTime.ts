import type { TaskTime } from '../../shared/time';
import { api } from '../api';
import { useLiveQuery } from './useLiveQuery';

/**
 * Time summary for one task, refetched whenever main reports a change for it.
 * `error` is true when the last load failed; `reload` fetches again.
 */
export function useTaskTime(taskId: string | null): {
  time: TaskTime | null;
  error: boolean;
  reload: () => void;
} {
  const { value, error, reload } = useLiveQuery(
    taskId ? () => api().invoke('time:task', taskId) : null,
    (refetch) =>
      api().on('time:changed', (p) => {
        if (p.taskId === taskId) refetch();
      }),
    [taskId],
  );
  return { time: value, error, reload };
}
