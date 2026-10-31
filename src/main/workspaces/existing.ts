import { existsSync } from 'node:fs';
import type { Task } from '../../shared/types';
import { type WorkspaceView, workspaceById } from '../../shared/workspaces';

/** The workspace itself, once its worktree folder is on disk. */
export function requireWorktree<W extends Pick<WorkspaceView, 'worktreePath'>>(
  ws: W,
): W {
  if (!existsSync(ws.worktreePath)) throw new Error('The worktree is missing');
  return ws;
}

/**
 * A task's workspace (its active home when `workspaceId` is undefined) whose worktree is on disk.
 * With `requireReady`, a task that is not ready throws first.
 */
export function existingWorkspace(
  task: Task,
  workspaceId: string | undefined,
  o: { requireReady?: boolean } = {},
): WorkspaceView {
  if (o.requireReady && task.status !== 'ready')
    throw new Error(`The task is not ready (${task.status})`);
  return requireWorktree(workspaceById(task, workspaceId));
}

/**
 * The workspace a watcher can follow: null when the task is not ready or its worktree folder is gone,
 * so the caller falls back to polling instead of failing (issue #181).
 */
export function watchableWorkspace(
  task: Task,
  workspaceId: string | undefined,
): WorkspaceView | null {
  if (task.status !== 'ready') return null;
  const ws = workspaceById(task, workspaceId);
  return existsSync(ws.worktreePath) ? ws : null;
}
