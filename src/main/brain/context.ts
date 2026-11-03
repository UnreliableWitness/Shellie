import type { Brain } from '../../shared/brain';
import type { BrainStore } from './BrainStore';

/** The brain of a task's connection and project; the first when there are several. */
export function brainForTask(
  brains: BrainStore,
  connectionId: string | null,
  project: string | null,
): Brain | null {
  if (!connectionId || !project) return null;
  return brains.forProject(connectionId, project)[0] ?? null;
}
