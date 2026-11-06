import type { HomePeriod, HomeStats } from '../../shared/home';
import { api } from '../api';
import { useLiveQuery } from './useLiveQuery';

/** Changes arrive every few seconds while an agent runs; stats refetch at most this often. */
const REFETCH_MS = 5_000;

/** The developer's stats for the period, refetched (throttled) when usage, time or tasks change. */
export function useHomeStats(period: HomePeriod): HomeStats | null {
  return useLiveQuery(
    () => api().invoke('home:stats', period),
    (refetch) => {
      const offs = [
        api().on('usage:changed', refetch),
        api().on('time:changed', refetch),
        api().on('tasks:changed', refetch),
      ];
      return () => offs.forEach((off) => off());
    },
    [period],
    { throttleMs: REFETCH_MS },
  ).value;
}
