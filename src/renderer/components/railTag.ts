import type { TaskView } from '../../shared/types';

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * What a task shows in the collapsed nav, where there is room for a few characters: its work item's id (the
 * last four characters after an ellipsis when it is longer than five), else the initials of the first two
 * words of its name (the first two letters of a one-word name).
 */
export function railTag(task: Pick<TaskView, 'workItem' | 'name'>): string {
  const id = task.workItem ? String(task.workItem.id) : '';
  if (id) return id.length > 5 ? `…${id.slice(-4)}` : id;
  const words = task.name.match(WORD) ?? [];
  if (words.length === 0) return '•';
  const letters =
    words.length === 1
      ? [...words[0]].slice(0, 2)
      : words.slice(0, 2).map((w) => [...w][0]);
  return letters.join('').toUpperCase();
}
