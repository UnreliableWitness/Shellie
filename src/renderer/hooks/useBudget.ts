import type { Vendor } from '../../shared/budget';
import type { BudgetView } from '../../shared/budgetView';
import { api } from '../api';
import { useLiveQuery } from './useLiveQuery';

export function useBudget(
  vendor: Vendor,
  monthOffset: number,
): BudgetView | null {
  return useLiveQuery(
    () => api().invoke('budget:get', vendor, monthOffset),
    (refetch) => api().on('budget:changed', refetch),
    [vendor, monthOffset],
  ).value;
}
