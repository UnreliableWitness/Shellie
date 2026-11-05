import { Settings20Regular } from '@fluentui/react-icons';
import { Fragment, type ReactNode, useState } from 'react';
import { ENVIRONMENT_LABEL } from '../../shared/secrets';
import type { TaskView } from '../../shared/types';
import { api, tryInvoke } from '../api';
import { eur } from '../format';
import {
  activeHome,
  activeWorkspaces,
  hasNoRepo,
} from '../../shared/workspaces';
import { useGitSummary } from '../hooks/useGitSummary';
import { useTaskUsage } from '../hooks/useTaskUsage';
import { activeConnection, type Screen, useStore } from '../store';
import { track } from '../telemetry';
import { TaskTypeIcon } from './TaskTypeIcon';
import { IconButton, MindMark } from './ui';

const UP = String.fromCharCode(0x2191);
const DOWN = String.fromCharCode(0x2193);
const DOT = String.fromCharCode(0xb7);
const SEP = String.fromCharCode(0x203a);

/** The last crumb of the pages that are not a task's own (those show the task instead). */
const PAGE_LABEL: Partial<Record<Screen['kind'], string>> = {
  home: 'Home',
  project: 'Project',
  setup: 'Setup',
  finish: 'Finish',
  'new-task': 'New task',
  settings: 'Settings',
  connect: 'Connect',
  'get-started': 'Get started',
  agents: 'Agents',
  'add-repo': 'Add repository',
  secrets: 'Secrets',
  'secrets-import': 'Secrets',
};

/** "Task 8125 PDP dynamic redirect logic", or the name of a blank task. */
const taskLabel = (task: TaskView): string =>
  task.workItem
    ? `${task.workItem.type} ${task.workItem.id} ${task.workItem.title}`
    : task.name;

function TaskDetails({
  task,
  onClose,
}: {
  task: TaskView;
  onClose: () => void;
}) {
  const notify = useStore((s) => s.notify);
  const repos = useStore((s) => s.repos);
  const workspaces = activeWorkspaces(task);
  // The task's folder: the home unless Finish dropped it, then the repo that took over.
  const home = activeHome(task);
  const noRepo = hasNoRepo(task);
  const git = useGitSummary(task.id, task.worktreeMissing, !noRepo);
  const usage = useTaskUsage(task.id);
  return (
    <div
      role="dialog"
      id="task-details"
      aria-label="Task details"
      className="callout"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="callout-row">
        {task.workItem?.url ? (
          <button
            type="button"
            className="link"
            aria-label={`Open ${task.workItem.type} ${task.workItem.id} in Azure DevOps`}
            onClick={() =>
              tryInvoke(
                () => api().invoke('shell:openExternal', task.workItem!.url!),
                notify,
              )
            }
          >
            {task.workItem.type} {task.workItem.id}
          </button>
        ) : task.workItem ? (
          <span>
            {task.workItem.type} {task.workItem.id}
          </span>
        ) : (
          <span>Blank task</span>
        )}
        <span className="muted">
          {task.status === 'ready' ? 'Active' : task.status}
        </span>
      </div>
      {noRepo ? (
        <div className="muted">No repo</div>
      ) : workspaces.length > 1 ? (
        workspaces.map((w) => (
          <div key={w.id} className="mono">
            {repos.find((r) => r.id === w.repoId)?.name ?? w.id}{' '}
            <span className="muted">{w.branch}</span>
          </div>
        ))
      ) : (
        <div className="mono">{home.branch}</div>
      )}
      {git && (
        <div className="mono muted">
          <span>{`${UP}${git.ahead} ${DOWN}${git.behind}`}</span>{' '}
          {git.files.length > 0 ? (
            <span className="text-warn">{`${git.files.length} changed`}</span>
          ) : (
            <span>clean</span>
          )}
        </div>
      )}
      <div className="mono muted">{home.worktreePath}</div>
      {usage && (
        <div className="small muted">
          Claude {eur(usage.byTool['claude-code'].costEur)} {DOT} Copilot{' '}
          {eur(usage.byTool['copilot-cli'].costEur)}
          {usage.byTool.opencode.costEur !== 0 &&
            ` ${DOT} OpenCode ${eur(usage.byTool.opencode.costEur)}`}
        </div>
      )}
    </div>
  );
}

/** The task crumb; hovering or focusing it shows the task's details. */
function TaskCrumb({ task, current }: { task: TaskView; current: boolean }) {
  const openTask = useStore((s) => s.openTask);
  const [card, setCard] = useState(false);
  return (
    <span
      className="crumb-task"
      onMouseEnter={() => setCard(true)}
      onMouseLeave={(e) => {
        if (!e.currentTarget.contains(document.activeElement)) setCard(false);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setCard(false);
      }}
    >
      <button
        type="button"
        className="crumb"
        aria-current={current ? 'page' : undefined}
        aria-expanded={card}
        aria-controls="task-details"
        onFocus={() => setCard(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && card) {
            e.preventDefault();
            setCard(false);
          }
        }}
        onClick={() => openTask(task.id)}
      >
        <TaskTypeIcon task={task} size={14} />
        <span className="crumb-text">{taskLabel(task)}</span>
      </button>
      {card && <TaskDetails task={task} onClose={() => setCard(false)} />}
    </span>
  );
}

function Crumb({
  current,
  onClick,
  children,
}: {
  current?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="crumb"
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
    >
      <span className="crumb-text">{children}</span>
    </button>
  );
}

/** The 40 px header: logo and breadcrumb on the left, Settings on the right; New task lives in the nav (#95). */
export function HeaderBar() {
  const screen = useStore((s) => s.screen);
  const go = useStore((s) => s.go);
  const connection = useStore(activeConnection);
  const task = useStore((s) => {
    const id =
      s.screen.kind === 'setup' || s.screen.kind === 'finish'
        ? s.screen.taskId
        : s.screen.kind === 'task'
          ? s.selectedTaskId
          : null;
    return s.tasks.find((t) => t.id === id) ?? null;
  });
  const sprintName = useStore((s) => s.sprintName);
  const openTask = useStore((s) => s.openTask);
  const home = () => {
    track('project.open', { from: 'crumb' });
    go({ kind: 'project' });
  };

  const crumbs: ReactNode[] = [];
  if (
    connection &&
    screen.kind !== 'settings' &&
    screen.kind !== 'home' &&
    screen.kind !== 'get-started'
  )
    crumbs.push(
      <Crumb key="project" onClick={home}>
        {connection.project}
      </Crumb>,
    );
  if (screen.kind === 'sprint')
    crumbs.push(
      <Crumb key="page" current onClick={home}>
        {sprintName ?? 'Sprint'}
      </Crumb>,
    );
  if (task)
    crumbs.push(
      <TaskCrumb key="task" task={task} current={screen.kind === 'task'} />,
    );
  // The task's secrets environment, when not Development: amber for UAT, red for Production.
  if (task && task.environment !== 'development')
    crumbs.push(
      <button
        key="env"
        type="button"
        className="crumb"
        title="Which environment's secrets this task's tabs get"
        onClick={() => openTask(task.id)}
      >
        <span className={`crumb-text crumb-env crumb-env-${task.environment}`}>
          {ENVIRONMENT_LABEL[task.environment]}
        </span>
      </button>,
    );
  const page = PAGE_LABEL[screen.kind] ?? null;
  if (page)
    crumbs.push(
      <Crumb key="page" current onClick={() => undefined}>
        {page}
      </Crumb>,
    );

  return (
    <header className="headerbar">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <button
          type="button"
          className="crumb crumb-home"
          aria-label="Shellie, go to Home"
          onClick={() => go({ kind: 'home' })}
        >
          <MindMark />
          <span className="crumb-text">Shellie</span>
        </button>
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            <span className="crumb-sep" aria-hidden="true">
              {SEP}
            </span>
            {c}
          </Fragment>
        ))}
      </nav>
      <span className="spacer" />
      <IconButton label="Settings" onClick={() => go({ kind: 'settings' })}>
        <Settings20Regular />
      </IconButton>
    </header>
  );
}
