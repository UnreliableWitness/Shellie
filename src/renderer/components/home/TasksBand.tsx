import { useState } from 'react';
import type { HomeItem, HomeSnapshot } from '../../../shared/home';
import type { TaskView } from '../../../shared/types';
import { taskConnectionId } from '../../../shared/workspaces';
import { eur, formatDuration } from '../../format';
import { useTaskTime } from '../../hooks/useTaskTime';
import { useTaskUsage } from '../../hooks/useTaskUsage';
import { upNext } from '../../homeView';
import { reposForConnection, startTaskFor } from '../../startTask';
import { useStore } from '../../store';
import { taskStatusOf } from '../../taskStatus';
import { track } from '../../telemetry';
import { stateMeta, useWorkItemTypes } from '../../workItemTypes';
import { WorkItemTypeIcon } from '../ui';
import { Band } from './Band';

const NO_REPO = 'Link a repo to this project in Settings to start a task';

function TaskCard({ task }: { task: TaskView }) {
  const openTask = useStore((s) => s.openTask);
  const repos = useStore((s) => s.repos);
  const connections = useStore((s) => s.connections);
  const usage = useTaskUsage(task.id);
  const { time } = useTaskTime(task.id);
  const attention = task.status === 'setup-failed' || task.worktreeMissing;
  const status = taskStatusOf(task);
  const connection = connections.find(
    (c) => c.id === taskConnectionId(task, repos),
  );
  const label = task.workItem
    ? `${task.workItem.type} ${task.workItem.id} ${task.workItem.title}`
    : task.name || task.branch;
  return (
    <button
      type="button"
      className={attention ? 'home-card is-attention' : 'home-card'}
      aria-label={`${label}, ${attention ? 'needs attention' : status.label}${connection ? `, ${connection.name}/${connection.project}` : ''}${usage && usage.billable.costEur > 0 ? `, ${eur(usage.billable.costEur)}` : ''}${time && time.activeSeconds > 0 ? `, ${formatDuration(time.activeSeconds)}` : ''}`}
      onClick={() => {
        track('home.clicked', { band: 'task' });
        openTask(task.id);
      }}
    >
      <span className="home-card-title">
        {task.workItem && (
          <WorkItemTypeIcon
            type={task.workItem.type}
            connectionId={connection?.id}
          />
        )}
        {label}
      </span>
      <span className="muted small">
        <span className="dot" style={{ background: status.color }} />{' '}
        {status.label}
        {connection && ` · ${connection.name}/${connection.project}`}
        {usage &&
          usage.billable.costEur > 0 &&
          ` · ${eur(usage.billable.costEur)}`}
        {time &&
          time.activeSeconds > 0 &&
          ` · ${formatDuration(time.activeSeconds)}`}
      </span>
    </button>
  );
}

function UpNextRow({
  connectionId,
  item,
}: {
  connectionId: string;
  item: HomeItem;
}) {
  const repos = useStore((s) => s.repos);
  const notify = useStore((s) => s.notify);
  const select = useStore((s) => s.select);
  const go = useStore((s) => s.go);
  const [starting, setStarting] = useState(false);
  const linked = reposForConnection(repos, connectionId);
  const repoId = linked[0]?.id ?? null;
  const label = `${item.type} ${item.id} ${item.title}`;
  return (
    <div className="home-upnext-row">
      <span>
        <WorkItemTypeIcon type={item.type} connectionId={connectionId} />{' '}
        {item.id} {item.title}
      </span>
      <button
        type="button"
        className="btn btn-primary"
        aria-label={`Start a task for ${label}`}
        aria-disabled={!repoId || undefined}
        title={repoId ? undefined : NO_REPO}
        disabled={starting}
        onClick={async () => {
          if (!repoId || starting) return;
          track('home.clicked', { band: 'up-next' });
          const workItem = {
            id: item.id,
            type: item.type,
            title: item.title,
            url: item.url,
          };
          // Several repos share the project: New task asks which one.
          if (linked.length > 1)
            return go({ kind: 'new-task', workItem, repoId });
          setStarting(true);
          const created = await startTaskFor(repoId, workItem, notify);
          setStarting(false);
          if (created) {
            select(created.id);
            go({ kind: 'setup', taskId: created.id });
          }
        }}
      >
        {starting ? 'Starting' : 'Start'}
      </button>
    </div>
  );
}

export function TasksBand({ snapshot }: { snapshot: HomeSnapshot | null }) {
  const tasks = useStore((s) => s.tasks);
  const repos = useStore((s) => s.repos);
  const types = useWorkItemTypes((s) => s.byConnection);
  const open = tasks
    .filter((t) => t.status !== 'done')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const next = upNext(snapshot, tasks, repos, (connectionId, type, state) => {
    const e = types[connectionId];
    return e?.status === 'ok'
      ? stateMeta(e.types.get(type.toLowerCase()), state)?.category
      : undefined;
  });
  return (
    <Band title="My tasks">
      <div className="home-cards">
        {open.map((t) => (
          <TaskCard key={t.id} task={t} />
        ))}
        {open.length === 0 && <p className="muted">No open tasks.</p>}
        {next.length > 0 && (
          <div
            className="home-card home-upnext"
            role="group"
            aria-label="Up next"
          >
            <span className="home-card-title">Up next</span>
            {next.map((n) => (
              <UpNextRow key={`${n.connectionId}:${n.item.id}`} {...n} />
            ))}
          </div>
        )}
      </div>
    </Band>
  );
}
