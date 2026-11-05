import type { Repo, Task, Workspace } from './types';

export const HOME_ID = 'home';

export type WorkspaceView = Omit<Workspace, 'source'> & {
  source: 'home' | 'detected' | 'manual';
};

/** A task without a repo (#225): a scratch folder with terminals, no branch, no git. */
export const hasNoRepo = (task: Pick<Task, 'repoId'>): boolean =>
  task.repoId === null;

const homeView = (task: Task): WorkspaceView => ({
  id: HOME_ID,
  // A task without a repo keeps a home for its terminals' folder; it is never one of its active workspaces.
  repoId: task.repoId ?? '',
  branch: task.branch,
  worktreePath: task.worktreePath,
  baseRef: task.baseRef,
  baseSha: task.baseSha,
  source: 'home',
  summary: task.summary,
  pullRequest: task.pullRequest,
  reopen: task.reopen,
  dropped: task.homeDropped,
});

/** The home workspace (the task's flat fields) followed by the extra ones. */
export function taskWorkspaces(task: Task): WorkspaceView[] {
  return [homeView(task), ...task.extraWorkspaces];
}

/** The workspaces with a worktree; none for a task without a repo, whose scratch folder has no git. */
export function activeWorkspaces(task: Task): WorkspaceView[] {
  if (hasNoRepo(task)) return [];
  return taskWorkspaces(task).filter((w) => !w.dropped);
}

/** How many repo colors there are (`--repo-1` … in tokens.css); repos past the last wrap around. */
export const REPO_COLORS = 6;

/**
 * A repo's color, 1 to REPO_COLORS, by its place among all the task's workspaces (dropped ones keep their
 * slot, so a color never shifts). Null when the task has one repo, or the repo has left it.
 */
export function repoColor(task: Task, workspaceId: string): number | null {
  if (activeWorkspaces(task).length < 2) return null;
  const all = taskWorkspaces(task);
  const i = all.findIndex((w) => w.id === workspaceId);
  if (i < 0 || all[i].dropped) return null;
  return (i % REPO_COLORS) + 1;
}

/** Finish removes a repo without pushing when it has nothing: a known base, no commits, nothing uncommitted. */
export function dropsAtFinish(c: {
  baseKnown: boolean;
  commits: number;
  uncommitted: number;
}): boolean {
  return c.baseKnown && c.commits === 0 && c.uncommitted === 0;
}

/** The home workspace unless dropped, else the first extra still in the task, else home. */
export function activeHome(task: Task): WorkspaceView {
  const all = taskWorkspaces(task);
  return all.find((w) => !w.dropped) ?? all[0];
}

/** The task is being reopened: Reopen marked at least one workspace (home or extra) to be made again. */
export function isReopening(task: Task): boolean {
  return (
    task.reopen !== null ||
    task.extraWorkspaces.some((w) => !w.dropped && w.reopen !== null)
  );
}

/** The branches Finish pushed, for the usage comment; the home branch when none was pushed (as before #48). */
export function pushedBranches(task: Task): string[] {
  const pushed = activeWorkspaces(task)
    .filter((w) => w.summary?.pushed)
    .map((w) => w.branch);
  return pushed.length > 0 ? pushed : [activeHome(task).branch];
}

export function workspaceById(
  task: Task,
  id: string | undefined,
): WorkspaceView {
  if (id === undefined) return activeHome(task);
  const found = taskWorkspaces(task).find((w) => w.id === id);
  if (!found) throw new Error(`Unknown workspace ${id}`);
  return found;
}

/** The repos a task works in: its home and the ones it joined. */
export const taskRepoIds = (t: Task): string[] => [
  ...(t.repoId === null ? [] : [t.repoId]),
  ...t.extraWorkspaces.map((w) => w.repoId),
];

/** The connection of the task's work item: its own, else the home repo's. */
export function taskConnectionId(
  task: Pick<Task, 'connectionId' | 'repoId'>,
  repos: Pick<Repo, 'id' | 'connectionId'>[],
): string | null {
  return (
    task.connectionId ??
    repos.find((r) => r.id === task.repoId)?.connectionId ??
    null
  );
}

/** Whether a task shows under a project (#219): its own connection's tasks, plus tasks with none. */
export function inConnection(
  task: Pick<Task, 'connectionId' | 'repoId'>,
  repos: Pick<Repo, 'id' | 'connectionId'>[],
  connectionId: string,
  knownIds?: string[],
): boolean {
  const resolved = taskConnectionId(task, repos);
  // A removed connection counts as none, so the task never vanishes from every project.
  const own =
    resolved !== null && knownIds && !knownIds.includes(resolved)
      ? null
      : resolved;
  return own === null || own === connectionId;
}

/** A docs target: the task id alone (its active home) or `<taskId>#<workspaceId>` (one workspace's worktree). */
export function docsTarget(taskId: string, workspaceId?: string): string {
  return workspaceId === undefined ? taskId : `${taskId}#${workspaceId}`;
}

export function parseDocsTarget(target: string): {
  taskId: string;
  workspaceId?: string;
} {
  const i = target.indexOf('#');
  return i < 0
    ? { taskId: target }
    : { taskId: target.slice(0, i), workspaceId: target.slice(i + 1) };
}
