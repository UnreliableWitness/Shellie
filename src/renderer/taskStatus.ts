import type { TaskStatus, TaskView } from '../shared/types';

const TASK_STATUS: Record<TaskStatus, { label: string; color: string }> = {
  'setting-up': { label: 'Setting up', color: 'var(--accent)' },
  ready: { label: 'Open', color: 'var(--green)' },
  'setup-failed': { label: 'Setup failed', color: 'var(--red)' },
  finishing: { label: 'Finishing', color: 'var(--accent)' },
  done: { label: 'Done', color: 'var(--muted)' },
};

const FOLDER_MISSING = { label: 'Folder missing', color: 'var(--red)' };

/** A task's status label and colour; a missing worktree folder outranks the stored status. */
export function taskStatusOf(
  task: Pick<TaskView, 'status' | 'worktreeMissing'>,
): { label: string; color: string } {
  return task.worktreeMissing ? FOLDER_MISSING : TASK_STATUS[task.status];
}
