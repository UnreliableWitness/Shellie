import { useEffect, useMemo } from 'react';
import {
  readsForWork,
  type ReadingBrain,
  type ReadingRead,
} from '../../../shared/reading';
import { useTaskBrain } from '../../hooks/useBrains';
import { openPiece, useReadingNudges } from '../../hooks/useReadingFeed';
import { useStore } from '../../store';
import { track } from '../../telemetry';

/**
 * The long reads that bear on the task's work item and that the reader has not read (or that changed since), from
 * the brains of the task's own connection: a work item's id says nothing in another organization. None when there
 * are none, and when the nudges are off.
 */
export function useReadsForTask(
  taskId: string,
): { brain: ReadingBrain; read: ReadingRead }[] {
  const on = useReadingNudges();
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId));
  const reading = useStore((s) => s.reading);
  const connectionId = useTaskBrain(taskId)?.connectionId;
  const workItemId = task?.workItem?.id;
  return useMemo(
    () =>
      on && workItemId && connectionId
        ? reading
            .filter((b) => b.connectionId === connectionId)
            .flatMap((b) =>
              readsForWork(b, b.marks, workItemId).map((read) => ({
                brain: b,
                read,
              })),
            )
        : [],
    [on, reading, workItemId, connectionId],
  );
}

/** "Before you start" on a task's setup page: the long reads for its work item (useReadsForTask). Nothing without any. */
export function BeforeYouStart({ taskId }: { taskId: string }) {
  const rows = useReadsForTask(taskId);
  const shown = rows.length > 0;
  useEffect(() => {
    if (shown) track('reading.nudge', { kind: 'task' });
  }, [shown, taskId]);

  if (!shown) return null;
  return (
    <section className="reading-before" aria-label="Before you start">
      <h3 className="reading-before-title">Before you start</h3>
      <ul className="reading-before-list">
        {rows.map(({ brain, read }) => (
          <li key={`${brain.brainId}:${read.path}`}>
            <button
              type="button"
              className="reading-before-row"
              onClick={() =>
                openPiece(brain.brainId, read.path, 'task', 'work', 'read')
              }
            >
              <span className="reading-before-name">{read.title}</span>
              <span className="muted small">
                {read.minutes} min · a long read in {brain.name}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
