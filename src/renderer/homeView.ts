import {
  stateCategory,
  type HomeConnection,
  type HomeItem,
  type HomeSnapshot,
  type HomeSprint,
} from '../shared/home';
import { sprintTime } from '../shared/sprintTime';
import type { LocalItemTime } from '../shared/time';
import type { Connection, Repo, TaskView } from '../shared/types';
import { taskConnectionId } from '../shared/workspaces';

/** The health chip of a connection: red when its token was refused or it never loaded, amber when unreachable or Home shows old data. */
export function chipState(
  home: HomeConnection | undefined,
  connection: Connection,
): 'ok' | 'stale' | 'error' {
  if (connection.status === 'unauthorized' || home?.status === 'error')
    return 'error';
  if (connection.status === 'unreachable' || home?.status === 'stale')
    return 'stale';
  return 'ok';
}

export type CategoryOf = (
  connectionId: string,
  type: string,
  state: string,
) => string | null | undefined;

/** The task of a work item on a connection: an open one first, else the first match (the Sprint page takes the latest finished one). */
export function taskForItem(
  id: string,
  connectionId: string,
  tasks: TaskView[],
  repos: Pick<Repo, 'id' | 'connectionId'>[],
): TaskView | null {
  const matches = tasks.filter(
    (t) => t.workItem?.id === id && taskConnectionId(t, repos) === connectionId,
  );
  return matches.find((t) => t.status !== 'done') ?? matches[0] ?? null;
}

/** My not-started items in current sprints without a Shellie task, soonest sprint end first. */
export function upNext(
  snapshot: HomeSnapshot | null,
  tasks: TaskView[],
  repos: Pick<Repo, 'id' | 'connectionId'>[],
  categoryOf: CategoryOf,
  limit = 3,
): { connectionId: string; item: HomeItem }[] {
  const out: { connectionId: string; item: HomeItem; end: string }[] = [];
  for (const c of snapshot?.connections ?? [])
    for (const s of c.sprints)
      for (const item of s.items)
        if (
          stateCategory(
            categoryOf(c.connectionId, item.type, item.state),
            item.state,
          ) === 'Proposed' &&
          !taskForItem(item.id, c.connectionId, tasks, repos)
        )
          out.push({
            connectionId: c.connectionId,
            item,
            end: s.finishDate ?? '9',
          });
  return out
    .sort((a, b) => a.end.localeCompare(b.end))
    .slice(0, limit)
    .map(({ connectionId, item }) => ({ connectionId, item }));
}

/** My items of a sprint by state category, and their spent and estimated time (the Sprint page's rules per item). */
export function sprintTotals(
  sprint: Pick<HomeSprint, 'items'>,
  local: Record<string, LocalItemTime>,
  categoryOf: (type: string, state: string) => string | null | undefined,
): {
  todo: number;
  doing: number;
  done: number;
  spentSeconds: number;
  estimateHours: number | null;
} {
  const items = sprint.items.filter(
    (i) => stateCategory(categoryOf(i.type, i.state), i.state) !== 'Removed',
  );
  const cells = sprintTime(
    items.map((item) => ({
      item,
      depth: 0,
      parentId: null,
      hasChildren: false,
    })),
    local,
  );
  let todo = 0;
  let doing = 0;
  let done = 0;
  let spent = 0;
  let estimate = 0;
  let anyEstimate = false;
  for (const i of items) {
    const c = stateCategory(categoryOf(i.type, i.state), i.state);
    if (c === 'Proposed') todo++;
    else if (c === 'Completed') done++;
    else doing++;
    const cell = cells.get(i.id);
    spent += cell?.spentSeconds ?? 0;
    if (cell?.estimateHours != null) {
      estimate += cell.estimateHours;
      anyEstimate = true;
    }
  }
  return {
    todo,
    doing,
    done,
    spentSeconds: spent,
    estimateHours: anyEstimate ? estimate : null,
  };
}

const hhmm = (iso: string): string => {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** The visible line for a connection that is not ok: its data is old, or it never loaded; null when all is well. */
export function connectionNote(c: HomeConnection): string | null {
  const name = `${c.name}/${c.project}`;
  if (c.status === 'stale')
    return `Stale since ${c.fetchedAt ? hhmm(c.fetchedAt) : '?'} for ${name}${c.error ? `: ${c.error}` : ''}`;
  if (c.status === 'error')
    return `Couldn't load ${name}${c.error ? `: ${c.error}` : ''}`;
  return null;
}
