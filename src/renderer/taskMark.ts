import type { TaskSignal } from '../shared/pulse';
import type { TaskView } from '../shared/types';
import { eur } from './format';

/** The one mark a task row may carry. */
export type TaskMark = {
  kind: 'broken' | 'busy' | 'waits' | 'merged';
  /** Accessible name and first tooltip line. */
  label: string;
};

/** The first that applies: a broken task, a task at work on itself, something waiting on the developer, merged. */
export function taskMark(
  task: TaskView,
  signal: TaskSignal | null,
): TaskMark | null {
  if (task.status === 'done') return null;
  if (task.worktreeMissing)
    return { kind: 'broken', label: 'Worktree folder missing' };
  if (task.status === 'setup-failed')
    return { kind: 'broken', label: 'Setup failed' };
  if (task.status === 'setting-up')
    return { kind: 'busy', label: 'Setting up' };
  if (task.status === 'finishing') return { kind: 'busy', label: 'Finishing' };
  if (signal?.state === 'waits')
    return { kind: 'waits', label: signal.story || 'Waiting for you' };
  if (signal?.state === 'merged')
    return { kind: 'merged', label: 'Merged: finish this task' };
  return null;
}

/** A row's tooltip: what the mark means (or the PR's story when there is no mark), the repos, the cost so far. */
export function rowTitle(input: {
  mark: TaskMark | null;
  story: string;
  repos: string;
  cost: number;
}): string {
  const { mark, story, repos, cost } = input;
  return [mark ? mark.label : story, repos, cost > 0 ? eur(cost) : '']
    .filter(Boolean)
    .join('\n');
}
