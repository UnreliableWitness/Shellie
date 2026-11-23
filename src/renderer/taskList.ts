import type { Repo, TaskView } from '../shared/types';
import { inConnection } from '../shared/workspaces';

/** With a connection, only that project's tasks and tasks with no connection (#219). Open tasks newest first, and nothing else moves them. */
export function listTasks(
  all: TaskView[],
  repos: Repo[],
  connectionId: string | null | undefined,
  knownIds: string[] | undefined,
): { open: TaskView[]; done: TaskView[] } {
  const tasks = connectionId
    ? all.filter((t) => inConnection(t, repos, connectionId, knownIds))
    : all;
  // An unreadable date counts as the oldest, so the id alone orders those.
  const created = (t: TaskView) => Date.parse(t.createdAt) || 0;
  const open = tasks
    .filter((t) => t.status !== 'done')
    .sort(
      (x, y) =>
        created(y) - created(x) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    );
  return { open, done: tasks.filter((t) => t.status === 'done') };
}
