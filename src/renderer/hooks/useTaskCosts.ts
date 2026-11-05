import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Billable EUR per task id for a list of tasks (a missing id means 0), refetched when main reports usage
 * for one of them (or '*' for all tasks). Keyed on the ids themselves, so a new array with the same ids
 * does not refetch.
 */
export function useTaskCosts(taskIds: string[]): Record<string, number> {
  const key = taskIds.join(',');
  const [costs, setCosts] = useState<Record<string, number>>({});
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    if (ids.length === 0) {
      setCosts({});
      return;
    }
    let live = true;
    const load = () =>
      api()
        .invoke('usage:costs', ids)
        .then((c) => {
          if (live) setCosts(c);
        })
        .catch(() => undefined);
    void load();
    const off = api().on('usage:changed', (p) => {
      if (p.taskId === '*' || ids.includes(p.taskId)) void load();
    });
    return () => {
      live = false;
      off();
    };
  }, [key]);
  return costs;
}
