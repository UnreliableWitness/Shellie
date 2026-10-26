import {
  ArrowClockwise16Regular,
  ArrowCollapseAll16Regular,
  ArrowExpandAll16Regular,
  ChevronDown12Regular,
  ChevronRight12Regular,
  Search16Regular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Connection,
  Repo,
  SprintIteration,
  SprintRow,
  TaskView,
} from '../../shared/types';
import { api, tryInvoke } from '../api';
import {
  PageHeader,
  StateDot,
  TimeBar,
  WorkItemTypeIcon,
} from '../components/ui';
import { sprintTime, type SprintTimeCell } from '../../shared/sprintTime';
import { formatDuration, type LocalItemTime } from '../../shared/time';
import { eur, sprintDates } from '../format';
import { useTaskUsage } from '../hooks/useTaskUsage';
import { startTaskFor } from '../startTask';
import { activeConnection, useStore } from '../store';
import { taskStatusOf } from '../taskStatus';
import { errorMessage } from '../../shared/errors';
import { taskConnectionId } from '../../shared/workspaces';

/** Window focus refreshes the sprint at most this often. */
const FOCUS_REFRESH_MS = 60_000;
/** Time changes arrive every ~10 s while an agent runs; the column refetches at most this often. */
const TIME_REFRESH_MS = 5_000;

const NO_TIME: Record<string, LocalItemTime> = {};
/** While filtering, every match shows, even under a collapsed parent. */
const NONE_COLLAPSED = new Set<string>();

function TimeCell({
  cell,
  local,
}: {
  cell: SprintTimeCell | undefined;
  local: LocalItemTime | undefined;
}) {
  const spent = cell?.spentSeconds ?? null;
  const est = cell?.estimateHours ?? null;
  if (spent === null && est === null) return <span className="muted">–</span>;
  const over = spent !== null && est !== null && est > 0 && spent > est * 3600;
  const text =
    est === null
      ? formatDuration(spent ?? 0)
      : `${spent === null ? '–' : formatDuration(spent)} / ${formatDuration(est * 3600)}`;
  const parts: string[] = [];
  // A local task with no time yet still shows ADO Completed Work (sprintTime), so the hover says where it is from.
  if (cell?.source === 'ado') parts.push('from Azure DevOps');
  else if (local)
    parts.push(
      `Measured ${formatDuration(local.measuredSeconds)}`,
      `agent ${formatDuration(local.agentSeconds)}`,
      local.booked ? 'booked' : 'not booked yet',
    );
  if (cell?.rolledUp) parts.push('includes child items');
  const pct =
    spent !== null && est !== null && est > 0
      ? Math.round((spent / (est * 3600)) * 100)
      : null;
  return (
    <span
      className={over ? 'sprint-time over' : 'sprint-time'}
      title={parts.length ? parts.join(', ') : undefined}
    >
      <span>{text}</span>
      {pct !== null && <TimeBar pct={pct} over={over} />}
    </span>
  );
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      iteration: SprintIteration | null;
      rows: SprintRow[];
      /** Without a current sprint: the open work assigned to me. */
      mine: SprintRow[];
    };

const NO_REPO = 'Link a repo to this project in Settings to start a task';

/**
 * Rows whose ID, title or assignee match every word of the query, with their parents so the tree still reads.
 * An empty query keeps every row.
 */
export function filterRows(rows: SprintRow[], query: string): SprintRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  const byId = new Map(rows.map((r) => [r.item.id, r]));
  const keep = new Set<string>();
  for (const r of rows) {
    const text =
      `${r.item.id} ${r.item.title} ${r.item.assignedTo ?? ''}`.toLowerCase();
    if (!words.every((w) => text.includes(w))) continue;
    for (
      let at: SprintRow | undefined = r;
      at && !keep.has(at.item.id);
      at = at.parentId ? byId.get(at.parentId) : undefined
    )
      keep.add(at.item.id);
  }
  return rows.filter((r) => keep.has(r.item.id));
}

/** Hides the rows under a collapsed parent. */
export function visibleRows(
  rows: SprintRow[],
  collapsed: Set<string>,
): SprintRow[] {
  const out: SprintRow[] = [];
  let hideBelow: number | null = null;
  for (const r of rows) {
    if (hideBelow !== null && r.depth > hideBelow) continue;
    hideBelow = null;
    out.push(r);
    if (r.hasChildren && collapsed.has(r.item.id)) hideBelow = r.depth;
  }
  return out;
}

/**
 * The Shellie task for a work item: an open one first, else the latest finished one. Ids are per organization, so
 * only tasks whose work item connection (else their repo's) is this sprint's match; unlinked ones never do.
 */
function taskFor(
  id: string,
  connectionId: string,
  tasks: TaskView[],
  repos: Repo[],
): TaskView | null {
  const matches = tasks.filter(
    (t) => t.workItem?.id === id && taskConnectionId(t, repos) === connectionId,
  );
  return (
    matches.find((t) => t.status !== 'done') ??
    matches.sort((a, b) =>
      (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''),
    )[0] ??
    null
  );
}

function TaskCell({ task, label }: { task: TaskView; label: string }) {
  const openTask = useStore((s) => s.openTask);
  const usage = useTaskUsage(task.id);
  const s = taskStatusOf(task);
  return (
    <button
      type="button"
      className="sprint-task"
      aria-label={`Open the task for ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        openTask(task.id);
      }}
    >
      <span className="dot" style={{ background: s.color }} />
      {s.label}
      {usage && usage.billable.costEur > 0 && (
        <span className="muted">{eur(usage.billable.costEur)}</span>
      )}
    </button>
  );
}

function Row({
  row,
  connectionId,
  task,
  repoId,
  collapsed,
  onToggle,
  timeCell,
  localTime,
}: {
  row: SprintRow;
  timeCell: SprintTimeCell | undefined;
  localTime: LocalItemTime | undefined;
  connectionId: string;
  task: TaskView | null;
  repoId: string | null;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const go = useStore((s) => s.go);
  const select = useStore((s) => s.select);
  const notify = useStore((s) => s.notify);
  const [starting, setStarting] = useState(false);
  const w = row.item;
  const label = `${w.type} ${w.id} ${w.title}`;
  // The row opens the work item in Azure DevOps; the title is the same link for keyboard users.
  const openInAdo = () =>
    void tryInvoke(() => api().invoke('shell:openExternal', w.url), notify);
  return (
    <div
      role="row"
      className="grid-row sprint-row"
      aria-level={row.depth + 1}
      onClick={openInAdo}
    >
      <span role="cell" className="sprint-chevron">
        {row.hasChildren && (
          <button
            type="button"
            className="ibtn sprint-toggle"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${w.type} ${w.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {collapsed ? (
              <ChevronRight12Regular aria-hidden="true" />
            ) : (
              <ChevronDown12Regular aria-hidden="true" />
            )}
          </button>
        )}
      </span>
      <span
        role="cell"
        className="sprint-title"
        style={{ paddingLeft: row.depth * 24 }}
        title={w.areaPath}
      >
        <WorkItemTypeIcon type={w.type} connectionId={connectionId} />
        <span className="grid-id">{w.id}</span>
        <button
          type="button"
          className="sprint-open grid-title"
          aria-label={`Open ${label} in Azure DevOps`}
          onClick={(e) => {
            e.stopPropagation();
            openInAdo();
          }}
        >
          {w.title}
        </button>
      </span>
      <span role="cell">
        <StateDot state={w.state} type={w.type} connectionId={connectionId} />
      </span>
      <span role="cell" className="grid-muted">
        {w.assignedTo ?? ''}
      </span>
      <span role="cell" className="sprint-num">
        {w.remainingWork ?? ''}
      </span>
      <span role="cell">
        <TimeCell cell={timeCell} local={localTime} />
      </span>
      <span role="cell" className="sprint-shellie">
        {task ? (
          <TaskCell task={task} label={label} />
        ) : (
          <button
            type="button"
            className="btn btn-primary sprint-start"
            // aria-disabled, not disabled: the button stays focusable so keyboard users hear why.
            aria-disabled={!repoId || undefined}
            title={repoId ? undefined : NO_REPO}
            aria-label={`Start a task for ${label}`}
            aria-description={repoId ? undefined : NO_REPO}
            disabled={starting}
            onClick={async (e) => {
              e.stopPropagation();
              if (!repoId || starting) return;
              setStarting(true);
              const created = await startTaskFor(
                repoId,
                { id: w.id, type: w.type, title: w.title, url: w.url },
                notify,
              );
              setStarting(false);
              if (created) {
                select(created.id);
                go({ kind: 'setup', taskId: created.id });
              }
            }}
          >
            {starting ? 'Starting' : 'Start'}
          </button>
        )}
      </span>
    </div>
  );
}

function SprintGrid({
  rows,
  connectionId,
  collapsed,
  onToggle,
  label,
  allRows,
  local,
}: {
  allRows: SprintRow[];
  local: Record<string, LocalItemTime>;
  rows: SprintRow[];
  connectionId: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  label: string;
}) {
  const tasks = useStore((s) => s.tasks);
  const repos = useStore((s) => s.repos);
  const repoId =
    repos.find((r) => r.connectionId === connectionId && !r.discovered)?.id ??
    null;
  // Totals cover the whole sprint, so a filter never changes a parent's roll-up.
  const times = useMemo(() => sprintTime(allRows, local), [allRows, local]);
  return (
    <div role="table" aria-label={label} className="grid sprint-grid">
      <div role="row" className="grid-head">
        <span role="columnheader" aria-label="Expand" />
        <span role="columnheader">Title</span>
        <span role="columnheader">State</span>
        <span role="columnheader">Assigned to</span>
        <span role="columnheader" className="sprint-num">
          Remaining work
        </span>
        <span role="columnheader">Spent / est.</span>
        <span role="columnheader">Shellie</span>
      </div>
      <div role="rowgroup" className="grid-body">
        {visibleRows(rows, collapsed).map((r) => (
          <Row
            key={r.item.id}
            row={r}
            connectionId={connectionId}
            task={taskFor(r.item.id, connectionId, tasks, repos)}
            repoId={repoId}
            collapsed={collapsed.has(r.item.id)}
            onToggle={() => onToggle(r.item.id)}
            timeCell={times.get(r.item.id)}
            localTime={local[r.item.id]}
          />
        ))}
      </div>
    </div>
  );
}

/** A backlog grid, or a note when the filter hides every row. */
function Backlog({
  query,
  ...grid
}: Parameters<typeof SprintGrid>[0] & { query: string }) {
  return grid.rows.length === 0 ? (
    <div className="empty">{`No work items match "${query.trim()}".`}</div>
  ) : (
    <SprintGrid {...grid} />
  );
}

function SprintPage({ connection }: { connection: Connection }) {
  const setSprintName = useStore((s) => s.setSprintName);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  /** The sprint picked in the dropdown; null follows the current sprint. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [iterations, setIterations] = useState<SprintIteration[]>([]);
  const lastLoad = useRef(0);
  const seq = useRef(0);
  const [local, setLocal] = useState(NO_TIME);
  const lastTime = useRef(0);
  const timeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTime = useCallback(async () => {
    lastTime.current = Date.now();
    try {
      setLocal(await api().invoke('time:sprint', connection.id));
    } catch {
      // The column falls back to Azure DevOps figures.
    }
  }, [connection.id]);

  useEffect(() => {
    const off = api().on('time:changed', () => {
      if (timeTimer.current) return;
      const wait = Math.max(
        0,
        TIME_REFRESH_MS - (Date.now() - lastTime.current),
      );
      timeTimer.current = setTimeout(() => {
        timeTimer.current = null;
        void loadTime();
      }, wait);
    });
    return () => {
      off();
      if (timeTimer.current) clearTimeout(timeTimer.current);
      timeTimer.current = null;
    };
  }, [loadTime]);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    lastLoad.current = Date.now();
    setBusy(true);
    try {
      const [sprint] = await Promise.all([
        selectedId
          ? api().invoke('workItems:sprint', connection.id, selectedId)
          : api().invoke('workItems:sprint', connection.id),
        loadTime(),
      ]);
      // The picked sprint is gone: go back to the current one.
      if (selectedId && !sprint.iteration) {
        if (mine === seq.current) setSelectedId(null);
        return;
      }
      const assigned = sprint.iteration
        ? []
        : (
            await api().invoke('workItems:search', connection.id, {
              scope: 'mine',
              text: '',
            })
          ).map((item) => ({
            item: {
              ...item,
              remainingWork: null,
              originalEstimate: null,
              completedWork: null,
            },
            depth: 0,
            parentId: null,
            hasChildren: false,
          }));
      if (mine !== seq.current) return;
      setLoad({
        status: 'ok',
        iteration: sprint.iteration,
        rows: sprint.rows,
        mine: assigned,
      });
      setSprintName(sprint.iteration?.name ?? null);
    } catch (e) {
      if (mine !== seq.current) return;
      setSprintName(null);
      setLoad({
        status: 'error',
        message: errorMessage(e),
      });
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, [connection.id, selectedId, setSprintName, loadTime]);

  useEffect(() => {
    let live = true;
    api()
      .invoke('workItems:iterations', connection.id)
      .then((list) => {
        if (live) setIterations(list);
      })
      .catch(() => {
        // Without the list there is no dropdown; the current sprint still shows.
      });
    return () => {
      live = false;
    };
  }, [connection.id]);

  useEffect(() => {
    setSprintName(null);
    void refresh();
    const onFocus = () => {
      if (Date.now() - lastLoad.current >= FOCUS_REFRESH_MS) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      seq.current++;
    };
  }, [refresh, setSprintName]);

  const rows = load.status === 'ok' ? load.rows : [];
  const searching = query.trim() !== '';
  const parents = rows.filter((r) => r.hasChildren).map((r) => r.item.id);
  const allCollapsed =
    parents.length > 0 && parents.every((id) => collapsed.has(id));
  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };
  const iteration = load.status === 'ok' ? load.iteration : null;
  const dates =
    iteration && sprintDates(iteration.startDate, iteration.finishDate);

  return (
    <div className="page page-sprint">
      <PageHeader
        title={
          iteration?.name ??
          (load.status === 'ok' ? 'No current sprint' : 'Sprint')
        }
        after={dates && <span className="muted">{dates}</span>}
        inline
        commands={
          <>
            {iterations.length > 1 && (
              <select
                className="field"
                aria-label="Sprint"
                value={selectedId ?? iteration?.id ?? ''}
                onChange={(e) => setSelectedId(e.target.value || null)}
              >
                {!selectedId && !iteration && (
                  <option value="">No current sprint</option>
                )}
                {iterations.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.timeframe === 'current' ? `${i.name} (current)` : i.name}
                  </option>
                ))}
              </select>
            )}
            <label className="sprint-search">
              <Search16Regular aria-hidden="true" />
              <input
                type="search"
                className="field"
                placeholder="Filter by ID or text"
                aria-label="Filter work items by ID or text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setQuery('');
                }}
              />
            </label>
            <button
              type="button"
              className="btn btn-subtle"
              disabled={busy}
              onClick={() => void refresh()}
            >
              <ArrowClockwise16Regular aria-hidden="true" />
              Refresh
            </button>
            {parents.length > 0 && !searching && (
              <button
                type="button"
                className="btn btn-subtle"
                onClick={() =>
                  setCollapsed(allCollapsed ? new Set() : new Set(parents))
                }
              >
                {allCollapsed ? (
                  <ArrowExpandAll16Regular aria-hidden="true" />
                ) : (
                  <ArrowCollapseAll16Regular aria-hidden="true" />
                )}
                {allCollapsed ? 'Expand all' : 'Collapse all'}
              </button>
            )}
          </>
        }
      />
      <div className="sprint-body" aria-busy={busy}>
        {load.status === 'loading' && <div className="empty">Loading...</div>}
        {load.status === 'error' && (
          <div className="empty sprint-empty" role="alert">
            <p>Could not load the sprint: {load.message}</p>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </div>
        )}
        {load.status === 'ok' && load.iteration && (
          <>
            {rows.length === 0 ? (
              <div className="empty">No work items in this sprint.</div>
            ) : (
              <Backlog
                query={query}
                label={`${load.iteration.name} backlog`}
                rows={filterRows(rows, query)}
                allRows={rows}
                local={local}
                connectionId={connection.id}
                collapsed={searching ? NONE_COLLAPSED : collapsed}
                onToggle={toggle}
              />
            )}
          </>
        )}
        {load.status === 'ok' && !load.iteration && (
          <>
            <div className="sprint-note">
              <p>This project has no current sprint.</p>
              <h2>Assigned to me</h2>
            </div>
            {load.mine.length === 0 ? (
              <div className="empty">
                No open work items are assigned to you.
              </div>
            ) : (
              <Backlog
                query={query}
                label="Assigned to me"
                rows={filterRows(load.mine, query)}
                allRows={load.mine}
                local={local}
                connectionId={connection.id}
                collapsed={collapsed}
                onToggle={toggle}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The home page: the current sprint of the active project, in ADO's backlog order. */
export function SprintScreen() {
  const connection = useStore(activeConnection);
  const go = useStore((s) => s.go);
  if (!connection)
    return (
      <div className="page page-sprint">
        <PageHeader title="Sprint" />
        <div className="empty sprint-empty">
          <p>Connect Azure DevOps in Settings to see the current sprint.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => go({ kind: 'settings' })}
          >
            Open Settings
          </button>
        </div>
      </div>
    );
  return <SprintPage key={connection.id} connection={connection} />;
}
