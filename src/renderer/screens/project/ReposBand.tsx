import { useMemo, useState } from 'react';
import { type GraphEdge, projectGraph } from '../../../shared/projectGraph';
import type { Connection } from '../../../shared/types';
import { Band } from '../../components/home/Band';
import { PopupMenu, StateDot } from '../../components/ui';
import { useStore } from '../../store';
import { taskStatusOf } from '../../taskStatus';
import { track } from '../../telemetry';
import { RepoGraph } from './RepoGraph';

/** The project's repositories and the tasks that tie them together. */
export function ReposBand({ connection }: { connection: Connection }) {
  const id = connection.id;
  const go = useStore((s) => s.go);
  const openTask = useStore((s) => s.openTask);
  const tasks = useStore((s) => s.tasks);
  const repos = useStore((s) => s.repos);
  const connections = useStore((s) => s.connections);
  const graph = useMemo(
    () =>
      projectGraph({
        tasks,
        repos,
        connections,
        connectionId: id,
        now: new Date(),
      }),
    [tasks, repos, connections, id],
  );
  const [open, setOpen] = useState<{
    edge: GraphEdge;
    anchor: HTMLElement;
  } | null>(null);
  const edgeTasks = open
    ? tasks.filter((t) => open.edge.taskIds.includes(t.id))
    : [];

  return (
    <Band
      title="Repositories"
      aside={
        <>
          <span className="muted small">
            {graph.linked.length} linked · {graph.elsewhere.length} used from
            elsewhere
          </span>
          <button
            type="button"
            className="btn"
            onClick={() =>
              go({ kind: 'add-repo', from: 'settings', connectionId: id })
            }
          >
            Add repository
          </button>
        </>
      }
    >
      {graph.linked.length === 0 ? (
        <p className="muted">No repositories in this project yet</p>
      ) : (
        <>
          <RepoGraph
            graph={graph}
            onNode={(repoId) => {
              track('project.graph', { target: 'node' });
              go({ kind: 'settings', scope: 'repo', repoId });
            }}
            onEdge={(edge, anchor) => {
              track('project.graph', { target: 'edge' });
              setOpen({ edge, anchor });
            }}
            onStart={(repoId) =>
              go({ kind: 'new-task', repoId, connectionId: id })
            }
          />
          <ul className="project-legend muted small">
            <li>
              <i className="project-legend-node" /> linked to this project
            </li>
            <li>
              <i className="project-legend-node is-elsewhere" /> used from
              elsewhere
            </li>
            <li>
              <i className="project-legend-line" /> tasks in both repos, thicker
              for two or more
            </li>
          </ul>
        </>
      )}
      <PopupMenu
        label="Tasks"
        anchor={open?.anchor ?? null}
        open={open !== null}
        onClose={() => setOpen(null)}
        align="start"
      >
        {edgeTasks.map((t) => {
          const s = taskStatusOf(t);
          return (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(null);
                openTask(t.id);
              }}
            >
              <span className="project-row-title">
                {t.workItem ? `#${t.workItem.id} ${t.workItem.title}` : t.name}
              </span>
              <StateDot state={s.label} color={s.color} />
            </button>
          );
        })}
      </PopupMenu>
    </Band>
  );
}
