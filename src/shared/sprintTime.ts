import type { LocalItemTime } from './time';
import type { SprintRow } from './types';

export type SprintTimeCell = {
  spentSeconds: number | null;
  estimateHours: number | null;
  /** Where the item's own spent figure comes from; never both. */
  source: 'local' | 'ado' | null;
  /** True when a descendant's figures are included. */
  rolledUp: boolean;
};

const add = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : a + b;

/**
 * Spent and estimate per sprint row. An item's own spent is its local time (when there is any), else ADO Completed
 * Work (never both); its estimate is Original Estimate, else the recorded baseline, else Remaining + Completed.
 * Parents add their descendants (found through `parentId`) to their own figures.
 */
export function sprintTime(
  rows: SprintRow[],
  local: Record<string, LocalItemTime>,
): Map<string, SprintTimeCell> {
  const cells = new Map<string, SprintTimeCell>();
  for (const { item } of rows) {
    const l = local[item.id];
    // A local task with nothing measured or booked yet (just started, or from before time tracking) has no
    // spent figure of its own, so ADO Completed Work still shows; its baseline still counts for the estimate.
    const own = l && (l.spentSeconds > 0 || l.booked) ? l : undefined;
    const spentSeconds = own
      ? own.spentSeconds
      : item.completedWork !== null
        ? item.completedWork * 3600
        : null;
    const estimateHours =
      item.originalEstimate ??
      l?.baselineHours ??
      (item.remainingWork !== null || item.completedWork !== null
        ? (item.remainingWork ?? 0) + (item.completedWork ?? 0)
        : null);
    cells.set(item.id, {
      spentSeconds,
      estimateHours,
      source: own ? 'local' : item.completedWork !== null ? 'ado' : null,
      rolledUp: false,
    });
  }
  // Children follow their parent, so walking backwards finishes a child before its parent.
  for (let i = rows.length - 1; i >= 0; i--) {
    const { item, parentId } = rows[i];
    const parent = parentId ? cells.get(parentId) : undefined;
    const own = cells.get(item.id)!;
    if (!parent || (own.spentSeconds === null && own.estimateHours === null))
      continue;
    parent.spentSeconds = add(parent.spentSeconds, own.spentSeconds);
    parent.estimateHours = add(parent.estimateHours, own.estimateHours);
    parent.rolledUp = true;
  }
  return cells;
}

/**
 * How far an item or a sprint is through its estimate: `pct` spent of the estimate (null without a positive
 * estimate or a spent figure), `over` when the spent time passed it.
 */
export function progress(
  spentSeconds: number | null,
  estimateHours: number | null,
): { pct: number | null; over: boolean } {
  if (spentSeconds === null || estimateHours === null || estimateHours <= 0)
    return { pct: null, over: false };
  const estimateSeconds = estimateHours * 3600;
  return {
    pct: Math.round((spentSeconds / estimateSeconds) * 100),
    over: spentSeconds > estimateSeconds,
  };
}
