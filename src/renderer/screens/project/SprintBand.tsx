import { useEffect, useMemo } from 'react';
import type { HomeConnection } from '../../../shared/home';
import { projectTasks } from '../../../shared/projectGraph';
import type { Connection } from '../../../shared/types';
import { Band } from '../../components/home/Band';
import { daysLeft } from '../../components/home/SprintsBand';
import { StateDot, WorkItemTypeIcon } from '../../components/ui';
import { statusText } from '../../connectionStatus';
import { eur, sprintDates } from '../../format';
import { useSprint } from '../../hooks/useSprint';
import { useTaskCosts } from '../../hooks/useTaskCosts';
import { chipState, sprintTotals, taskForItem } from '../../homeView';
import { useStore } from '../../store';
import { taskStatusOf } from '../../taskStatus';
import { stateMeta, useWorkItemTypes } from '../../workItemTypes';

const MY_ITEMS = 5;

/** The project's current sprint: whole-sprint counts from the Sprint page's fetch, my items from Home's snapshot. */
export function SprintBand({
  connection,
  home,
}: {
  connection: Connection;
  home: HomeConnection | undefined;
}) {
  const id = connection.id;
  const go = useStore((s) => s.go);
  const openTask = useStore((s) => s.openTask);
  const tasks = useStore((s) => s.tasks);
  const repos = useStore((s) => s.repos);
  const { sprint, loading, error } = useSprint(id);
  const types = useWorkItemTypes((s) => s.byConnection[id]);
  const loadTypes = useWorkItemTypes((s) => s.load);
  useEffect(() => loadTypes(id), [id, loadTypes]);

  const iteration = sprint?.iteration ?? null;
  const totals = sprint
    ? sprintTotals(
        { items: sprint.rows.map((r) => r.item) },
        {},
        (type, state) =>
          types?.status === 'ok'
            ? stateMeta(types.types.get(type.toLowerCase()), state)?.category
            : undefined,
      )
    : null;
  const total = totals ? totals.todo + totals.doing + totals.done : 0;
  const mySprint = iteration
    ? home?.sprints.find((s) => s.iterationId === iteration.id)
    : undefined;
  const mine = mySprint?.items ?? [];

  // The AI cost of this project's tasks whose work item is in the sprint.
  const sprintTaskIds = useMemo(() => {
    if (!sprint) return [];
    const inSprint = new Set(sprint.rows.map((r) => r.item.id));
    return projectTasks(tasks, repos, id, new Date())
      .filter((t) => t.workItem && inSprint.has(t.workItem.id))
      .map((t) => t.id);
  }, [sprint, tasks, repos, id]);
  const costs = useTaskCosts(sprintTaskIds);
  const aiEur = sprintTaskIds.reduce((sum, t) => sum + (costs[t] ?? 0), 0);

  const health = chipState(home, connection);
  const left = daysLeft(iteration?.finishDate ?? null);
  const dates = sprintDates(
    iteration?.startDate ?? null,
    iteration?.finishDate ?? null,
  );
  return (
    <Band
      title="Sprint"
      aside={
        <button
          type="button"
          className="btn"
          onClick={() => go({ kind: 'sprint' })}
        >
          Open sprint
        </button>
      }
    >
      {health === 'error' && (
        <p className="project-warning" role="status">
          Not connected: {home?.error ?? statusText(connection).text}.{' '}
          <button
            type="button"
            onClick={() =>
              go({
                kind: 'settings',
                scope: 'project',
                connectionId: id,
                section: 'project-connection',
              })
            }
          >
            Update token
          </button>
        </p>
      )}
      {iteration && totals ? (
        <>
          <div className="project-sprint-head">
            <b>{iteration.name}</b>
            <span className="muted small">
              {[left, dates].filter(Boolean).join(' · ')}
            </span>
          </div>
          <div
            className="project-progress"
            role="progressbar"
            aria-label="Done"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={totals.done}
          >
            <i
              style={{ width: `${total ? (totals.done / total) * 100 : 0}%` }}
            />
          </div>
          <div className="project-chips">
            <span className="project-chip">Mine {mine.length}</span>
            <span className="project-chip">In progress {totals.doing}</span>
            <span className="project-chip">
              Done {totals.done} / {total}
            </span>
            {aiEur !== null && (
              <span className="project-chip">AI this sprint {eur(aiEur)}</span>
            )}
          </div>
          {mine.length === 0 ? (
            <p className="muted small">Nothing assigned to you.</p>
          ) : (
            <ul className="project-list">
              {mine.slice(0, MY_ITEMS).map((w) => {
                const task = taskForItem(w.id, id, tasks, repos);
                const status = task && taskStatusOf(task);
                return (
                  <li key={w.id} className="project-row">
                    <WorkItemTypeIcon type={w.type} connectionId={id} />
                    <span className="project-row-title">
                      #{w.id} {w.title}
                    </span>
                    <StateDot state={w.state} type={w.type} connectionId={id} />
                    {task && status ? (
                      <button
                        type="button"
                        className="sprint-task"
                        onClick={() => openTask(task.id)}
                      >
                        <span
                          className="dot"
                          style={{ background: status.color }}
                        />
                        {status.label}
                      </button>
                    ) : (
                      <span className="muted small">
                        To do ·{' '}
                        <button
                          type="button"
                          className="link"
                          aria-label={`Start a task for ${w.type} ${w.id}`}
                          onClick={() =>
                            go({
                              kind: 'new-task',
                              connectionId: id,
                              workItem: {
                                id: w.id,
                                type: w.type,
                                title: w.title,
                                url: w.url,
                                project: w.project ?? null,
                              },
                            })
                          }
                        >
                          Start
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : loading ? (
        <p className="muted">Loading</p>
      ) : error ? (
        health !== 'error' && (
          <p className="muted small">Couldn't load the sprint: {error}</p>
        )
      ) : (
        sprint && <p className="muted">No current sprint.</p>
      )}
    </Band>
  );
}
