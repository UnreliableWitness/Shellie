import { useRef } from 'react';
import { TaskTypeIcon } from '../components/TaskTypeIcon';
import { PageHeader } from '../components/ui';
import { TerminalTabs } from '../components/TerminalTabs';
import type { TaskView } from '../../shared/types';
import { useStore } from '../store';
import { DoneTaskPage } from './DoneTaskPage';

/** The selected task: terminals when it runs, a setup notice while it sets up, the Done page once finished. */
export function TaskScreen() {
  const go = useStore((s) => s.go);
  const task = useStore(
    (s) => s.tasks.find((t) => t.id === s.selectedTaskId) ?? null,
  );
  if (!task)
    return (
      <div className="page">
        <PageHeader title="No task selected" />
        <div className="page-body">
          <p className="muted">
            Pick a task in the navigation, or create one with New task.
          </p>
        </div>
      </div>
    );
  if (task.status === 'done') return <DoneTaskPage task={task} />;
  if (task.status === 'setting-up' || task.status === 'setup-failed')
    return (
      <div className="page">
        <PageHeader
          before={<TaskTypeIcon task={task} />}
          title={task.workItem?.title ?? task.name}
        />
        <div className="page-body">
          <p className="muted">
            {task.status === 'setting-up'
              ? 'This task is still setting up.'
              : 'Setup failed for this task.'}
          </p>
          <div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => go({ kind: 'setup', taskId: task.id })}
            >
              Open setup
            </button>
          </div>
        </div>
      </div>
    );
  // A running task's terminals live in TaskTerminals, which stays mounted across pages.
  return null;
}

/** Tasks whose terminals are shown: everything between setup and done. */
const hasTerminals = (t: TaskView) =>
  t.status === 'ready' || t.status === 'finishing';

/**
 * The terminals of every running task, mounted the first time the task is shown and kept for as long as it
 * runs, hidden while another page or task is shown. Remounting would replay main's buffer into a fresh xterm,
 * which garbles full-screen TUIs. Mounting on first view spares the launch an xterm and a buffer replay for
 * every running task, most of which the user may not open in this session.
 */
export function TaskTerminals() {
  const tasks = useStore((s) => s.tasks);
  const shown = useStore((s) =>
    s.screen.kind === 'task' ? s.selectedTaskId : null,
  );
  const seen = useRef(new Set<string>());
  if (shown) seen.current.add(shown);
  const running = tasks.filter(hasTerminals);
  // A task that stopped running drops out, so it mounts afresh if it runs again.
  for (const id of seen.current)
    if (!running.some((t) => t.id === id)) seen.current.delete(id);
  return (
    <>
      {running
        .filter((t) => seen.current.has(t.id))
        .map((t) => (
          <div key={t.id} className="task-layer" hidden={t.id !== shown}>
            <TerminalTabs task={t} visible={t.id === shown} />
          </div>
        ))}
    </>
  );
}
