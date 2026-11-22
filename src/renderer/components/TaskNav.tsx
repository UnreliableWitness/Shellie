import {
  Add16Regular,
  Add20Regular,
  Brain20Regular,
  ArrowSprint20Regular,
  CalendarLtr20Regular,
  CheckmarkCircle12Filled,
  CheckmarkCircle16Regular,
  CheckmarkCircle20Regular,
  ChevronDown12Regular,
  ChevronRight12Regular,
  Delete16Regular,
  Delete20Regular,
  Document16Regular,
  Grid20Regular,
  Home20Regular,
  PanelLeftContract20Regular,
  PanelLeftExpand20Regular,
  Settings20Regular,
} from '@fluentui/react-icons';
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type PulseSnapshot,
  type TaskSignal,
  taskSignal,
} from '../../shared/pulse';
import type { Repo, TaskStatus, TaskView } from '../../shared/types';
import {
  activeHome,
  activeWorkspaces,
  inConnection,
} from '../../shared/workspaces';
import { api } from '../api';
import { statusText } from '../connectionStatus';
import { eur, plural } from '../format';
import { useBrains } from '../hooks/useBrains';
import { JoinCard } from './brain/JoinCard';
import { useReading, useReadingNudges } from '../hooks/useReadingFeed';
import { usePulse } from '../hooks/usePulse';
import { useTaskCosts } from '../hooks/useTaskCosts';
import { hasEvent } from '../readingFeed';
import {
  activeConnection,
  taskOnScreen,
  useStore,
  useTaskConnectionId,
} from '../store';
import { type TaskMark, rowTitle, taskMark } from '../taskMark';
import { track } from '../telemetry';
import { clampNavWidth, NAV_WIDTH } from '../uiPrefs';
import { attentionLabel } from './AttentionDot';
import { DreamNavStatus } from './dreams/DreamNavStatus';
import { DreamsNavItem } from './dreams/DreamsNavItem';
import { WorkItemTypeIcon } from './ui';

/** Tasks in these states have no PR story yet: a stale pulse must not mark them. */
const NO_SIGNAL: TaskStatus[] = ['setting-up', 'setup-failed', 'finishing'];

/** With a connection, only that project's tasks and tasks with no connection (#219). Open tasks newest first, and nothing else moves them. */
export function listTasks(
  all: TaskView[],
  repos: Repo[],
  connectionId: string | null | undefined,
  knownIds: string[] | undefined,
): { open: TaskView[]; done: TaskView[] } {
  const tasks = connectionId
    ? all.filter((t) => inConnection(t, repos, connectionId, knownIds))
    : all;
  // An unreadable date counts as the oldest, so the id alone orders those.
  const created = (t: TaskView) => Date.parse(t.createdAt) || 0;
  const open = tasks
    .filter((t) => t.status !== 'done')
    .sort(
      (x, y) =>
        created(y) - created(x) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    );
  return { open, done: tasks.filter((t) => t.status === 'done') };
}

const AVATAR = ['#0078d4', '#8764b8', '#038387', '#ca5010', '#498205'];
const avatarColor = (name: string) =>
  AVATAR[[...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % AVATAR.length];

/** The nav highlights a task only while one of its pages is open. */
const useIsCurrent = (taskId: string) =>
  useStore((s) => taskOnScreen(s) === taskId);

/** The task's terminal whose agent is blocked on the developer, if any. */
const useBlocked = (task: TaskView) =>
  useStore((s) =>
    task.terminals
      .flatMap((d) => s.attention[d.id] ?? [])
      .find((e) => e.reason === 'blocked'),
  );

function TypeIcon({ task, size = 16 }: { task: TaskView; size?: number }) {
  const connectionId = useTaskConnectionId(task);
  return task.workItem ? (
    <WorkItemTypeIcon
      type={task.workItem.type}
      connectionId={connectionId}
      size={size}
    />
  ) : (
    <Document16Regular className="navrow-blank" aria-label="Blank task" />
  );
}

/** What each open task's PRs and agents ask of the developer, read now. Null for a task with no PR story yet. */
function useSignals(): {
  pulse: PulseSnapshot | null;
  signal: (t: TaskView) => TaskSignal | null;
} {
  const pulse = usePulse();
  const attention = useStore((s) => s.attention);
  const signal = (t: TaskView): TaskSignal | null =>
    NO_SIGNAL.includes(t.status)
      ? null
      : taskSignal({
          pulses: pulse?.tasks[t.id] ?? [],
          agentBlocked: t.terminals.some((d) =>
            [attention[d.id] ?? []].flat().some((e) => e.reason === 'blocked'),
          ),
          now: Date.now(),
        });
  return { pulse, signal };
}

/** The task's one mark. A blocked agent says what it asks for; a PR's trouble keeps its own story. */
function useMark(task: TaskView, signal: TaskSignal | null): TaskMark | null {
  const blocked = useBlocked(task);
  const mark = taskMark(task, signal);
  return mark?.kind === 'waits' && !signal?.prWorkspaceId && blocked
    ? { ...mark, label: attentionLabel(blocked) }
    : mark;
}

/** The home repo's name and how many more the task spans, for the tooltip. */
function repoLine(task: TaskView, repos: Repo[]): string {
  const name = repos.find((r) => r.id === activeHome(task).repoId)?.name ?? '';
  const extras = activeWorkspaces(task).length - 1;
  return extras > 0 ? `${name} +${plural(extras, 'repo')}`.trim() : name;
}

/** The row's one mark. Merged opens the Finish page and a PR's trouble opens the PR; the others only tell. */
function Mark({
  task,
  mark,
  prUrl,
}: {
  task: TaskView;
  mark: TaskMark;
  prUrl?: string;
}) {
  const go = useStore((s) => s.go);
  const shared = {
    className: `navmark navmark-${mark.kind}`,
    'aria-label': mark.label,
    title: mark.label,
  };
  if (mark.kind === 'merged')
    return (
      <button
        type="button"
        {...shared}
        onClick={() => {
          track('nav.chipClicked', { kind: 'merged' });
          go({ kind: 'finish', taskId: task.id });
        }}
      >
        <CheckmarkCircle16Regular aria-hidden="true" />
      </button>
    );
  const dot = <span className="navmark-dot" aria-hidden="true" />;
  if (mark.kind === 'waits' && prUrl)
    return (
      <button
        type="button"
        {...shared}
        onClick={() => {
          track('nav.chipClicked', { kind: 'waits' });
          void api()
            .invoke('links:open', prUrl)
            .catch(() => undefined);
        }}
      >
        {dot}
      </button>
    );
  return (
    <span role="img" {...shared}>
      {dot}
    </span>
  );
}

function Row({
  task,
  cost,
  repos = '',
  signal = null,
  pulse,
}: {
  task: TaskView;
  cost: number;
  /** For the tooltip. */
  repos?: string;
  signal?: TaskSignal | null;
  pulse?: PulseSnapshot | null;
}) {
  const current = useIsCurrent(task.id);
  const openTask = useStore((s) => s.openTask);
  const go = useStore((s) => s.go);
  const askDiscard = useStore((s) => s.askDiscard);
  // Finish and Discard sit inside the current task's row, so no row ever grows or moves. They take the mark's place there; the tooltip still tells what the mark would.
  const hasFinish = useShowsFinish(task);
  const mark = useMark(task, signal);
  const done = task.status === 'done';
  const prUrl = signal?.prWorkspaceId
    ? (pulse?.tasks[task.id] ?? []).find(
        (p) => p.workspaceId === signal.prWorkspaceId,
      )?.pr?.url
    : undefined;
  const title = done
    ? ''
    : rowTitle({ mark, story: signal?.story ?? '', repos, cost });
  return (
    <div className="navrow" data-current={current ? 'true' : undefined}>
      <button
        type="button"
        className="navrow-main"
        aria-current={current ? 'true' : undefined}
        title={title || undefined}
        onClick={() => openTask(task.id)}
      >
        <TypeIcon task={task} />
        {task.workItem && <span className="navrow-id">{task.workItem.id}</span>}
        <span className="navrow-title">
          {task.workItem?.title ?? task.name}
        </span>
      </button>
      {mark && !hasFinish && <Mark task={task} mark={mark} prUrl={prUrl} />}
      {hasFinish && (
        <span className="navrow-actions">
          <button
            type="button"
            className="ibtn navrow-finish"
            aria-label="Finish task"
            title={FINISH_TITLE}
            onClick={() => go({ kind: 'finish', taskId: task.id })}
          >
            <CheckmarkCircle16Regular aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ibtn nav-discard"
            aria-label={DISCARD_LABEL}
            title={DISCARD_LABEL}
            onClick={() => askDiscard(task.id)}
          >
            <Delete16Regular aria-hidden="true" />
          </button>
        </span>
      )}
      {done && cost > 0 && <span className="navrow-cost">{eur(cost)}</span>}
    </div>
  );
}

const railName = (task: TaskView) =>
  `${task.workItem?.id ?? ''} ${task.workItem?.title ?? task.name}`.trim();

const RAIL_DOT = { broken: 'red', busy: 'accent', waits: 'amber' } as const;

function RailRow({
  task,
  signal,
}: {
  task: TaskView;
  signal: TaskSignal | null;
}) {
  const current = useIsCurrent(task.id);
  const openTask = useStore((s) => s.openTask);
  const mark = useMark(task, signal);
  const name = railName(task);
  return (
    <button
      type="button"
      className="railrow"
      aria-label={name}
      title={mark ? `${name} · ${mark.label}` : name}
      aria-current={current ? 'true' : undefined}
      onClick={() => openTask(task.id)}
    >
      <TypeIcon task={task} />
      {mark &&
        (mark.kind === 'merged' ? (
          <span className="rail-check" aria-hidden="true">
            <CheckmarkCircle12Filled />
          </span>
        ) : (
          <span
            className={`rail-dot rail-dot-${RAIL_DOT[mark.kind]}`}
            aria-hidden="true"
          />
        ))}
    </button>
  );
}

/** Whether the Finish action shows for a current task: ready, and not on its own Finish page already. */
function useShowsFinish(task: TaskView) {
  const current = useIsCurrent(task.id);
  const onFinish = useStore((s) => s.screen.kind === 'finish');
  return current && !onFinish && task.status === 'ready';
}

const FINISH_TITLE = 'Finish task: check changes, push, book time, clean up';
const DISCARD_LABEL = 'Discard task';

/** The rail's Finish: a filled square under the current task's icon. */
function RailFinish({ task }: { task: TaskView }) {
  const go = useStore((s) => s.go);
  if (!useShowsFinish(task)) return null;
  return (
    <button
      type="button"
      className="railrow rail-finish"
      aria-label="Finish task"
      title={FINISH_TITLE}
      onClick={() => go({ kind: 'finish', taskId: task.id })}
    >
      <span className="rail-finish-mark">
        <CheckmarkCircle20Regular aria-hidden="true" />
      </span>
    </button>
  );
}

/** The rail's Discard, under its Finish (#124). */
function RailDiscard({ task }: { task: TaskView }) {
  const askDiscard = useStore((s) => s.askDiscard);
  if (!useShowsFinish(task)) return null;
  return (
    <button
      type="button"
      className="railrow rail-discard"
      aria-label={DISCARD_LABEL}
      title={DISCARD_LABEL}
      onClick={() => askDiscard(task.id)}
    >
      <Delete20Regular aria-hidden="true" />
    </button>
  );
}

/** Tasks section header with New task on its right; in the rail a + icon heads the task icons. */
function TasksHead({ rail }: { rail: boolean }) {
  const go = useStore((s) => s.go);
  const current = useStore((s) => s.screen.kind === 'new-task');
  if (rail)
    return (
      <button
        type="button"
        className="railrow rail-new"
        aria-label="New task"
        title="New task"
        aria-current={current ? 'true' : undefined}
        onClick={() => go({ kind: 'new-task' })}
      >
        <Add20Regular aria-hidden="true" />
      </button>
    );
  return (
    <div className="nav-section nav-tasks-head">
      <span className="spacer">Tasks</span>
      <button
        type="button"
        className="nav-new"
        title="New task from a work item or a blank one"
        aria-current={current ? 'page' : undefined}
        onClick={() => go({ kind: 'new-task' })}
      >
        <Add16Regular aria-hidden="true" />
        New task
      </button>
    </div>
  );
}

function NavItem({
  icon,
  label,
  current,
  rail,
  note,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  current: boolean;
  rail: boolean;
  /** Something waits behind this item: a dot, with these words for a screen reader and the tooltip. */
  note?: string;
  onClick: () => void;
}) {
  const named = note ? `${label}, ${note}` : label;
  return (
    <button
      type="button"
      className="navitem"
      aria-current={current ? 'page' : undefined}
      aria-label={rail || note ? named : undefined}
      title={rail ? named : note}
      onClick={onClick}
    >
      {icon}
      {!rail && <span>{label}</span>}
      {note && <span className="navitem-dot" aria-hidden="true" />}
    </button>
  );
}

/** The project tile; with more than one connection it opens a project switcher. */
function ProjectTile({ rail }: { rail: boolean }) {
  const connections = useStore((s) => s.connections);
  const connection = useStore(activeConnection);
  const setConnectionId = useStore((s) => s.setConnectionId);
  const go = useStore((s) => s.go);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  // On open, focus the current project; a click outside closes the menu.
  useEffect(() => {
    if (!open) return;
    const items = [
      ...(menu.current?.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"]',
      ) ?? []),
    ];
    (
      items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0]
    )?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const onMenuKey = (e: KeyboardEvent) => {
    const items = [
      ...(menu.current?.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"]',
      ) ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(-1);
    else if (e.key === 'Tab') setOpen(false);
  };
  const name = connection?.project ?? 'No project';
  const avatar = (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        background: connection ? avatarColor(name) : 'var(--bg-selected)',
        color: connection ? undefined : 'var(--muted)',
      }}
    >
      {connection ? name.charAt(0).toUpperCase() : '?'}
    </span>
  );
  if (connections.length < 2)
    return (
      <div className="projecttile" title={name}>
        {avatar}
        {!rail && <span className="projecttile-name">{name}</span>}
      </div>
    );
  return (
    <div className="projecttile-wrap" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="projecttile"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Project ${name}, switch project`}
        title={name}
        onClick={() => setOpen(!open)}
      >
        {avatar}
        {!rail && <span className="projecttile-name">{name}</span>}
        {!rail && <ChevronDown12Regular aria-hidden="true" />}
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="Projects"
          className="menu"
          onKeyDown={onMenuKey}
        >
          {connections.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              aria-checked={c.id === connection?.id}
              className="menu-item"
              onClick={() => {
                setConnectionId(c.id);
                setOpen(false);
                go({ kind: 'project' });
                track('project.open', { from: 'switcher' });
              }}
            >
              <span className="menu-title">{c.project}</span>
              <span className="small muted">{c.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const NAV_STEP = 16;
const PULSE_AUTH_NOTE = 'PR status unavailable: check the Azure DevOps token';

/** The drag handle on the nav's right edge (#160): drag, arrow keys, double-click resets. */
function NavResize({
  width,
  onDrag,
}: {
  width: number;
  onDrag(px: number | null): void;
}) {
  const setNavWidth = useStore((s) => s.setNavWidth);
  const start = useRef<{ x: number; width: number } | null>(null);
  const dragged = (clientX: number) =>
    clampNavWidth(start.current!.width + clientX - start.current!.x);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize task list"
      aria-valuenow={width}
      aria-valuemin={NAV_WIDTH.min}
      aria-valuemax={NAV_WIDTH.max}
      tabIndex={0}
      className="leftnav-resize"
      title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => {
        if (start.current) onDrag(dragged(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        setNavWidth(dragged(e.clientX));
        start.current = null;
        onDrag(null);
      }}
      onPointerCancel={() => {
        start.current = null;
        onDrag(null);
      }}
      onDoubleClick={() => setNavWidth(NAV_WIDTH.default)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        setNavWidth(width + (e.key === 'ArrowRight' ? NAV_STEP : -NAV_STEP));
      }}
    />
  );
}

export function TaskNav() {
  const tasks = useStore((s) => s.tasks);
  const repos = useStore((s) => s.repos);
  const screen = useStore((s) => s.screen);
  const go = useStore((s) => s.go);
  const connection = useStore(activeConnection);
  const connections = useStore((s) => s.connections);
  const navCollapsed = useStore((s) => s.navCollapsed);
  const setNavCollapsed = useStore((s) => s.setNavCollapsed);
  const navWidth = useStore((s) => s.navWidth);
  // The width while a drag is under way; stored only on release.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? navWidth;
  const [showDone, setShowDone] = useState(false);
  const { pulse, signal } = useSignals();
  const { open, done } = listTasks(
    tasks,
    repos,
    connection?.id,
    connections.map((c) => c.id),
  );
  const rail = navCollapsed;
  // One read for every row that shows a cost; the rail shows none.
  const costs = useTaskCosts(
    rail ? [] : [...open, ...(showDone ? done : [])].map((t) => t.id),
  );
  // Like tasks, only the active project's brains (#229); none without a connection.
  const brains = useBrains().filter(
    (b) => b.connectionId === connection?.id && !b.archived,
  );
  const nudges = useReadingNudges();
  const reading = useReading();
  // A dot for an event (a long read for your work, a change in one you read), never for the pile of unread ones.
  const toRead = new Set(
    nudges ? reading.filter(hasEvent).map((r) => r.brain.brainId) : [],
  );
  // Quiet while the connection is fine: the line shows only when something is wrong.
  const footer = !connection
    ? { color: 'var(--disabled)', text: 'Azure DevOps: not connected' }
    : connection.status === 'ok'
      ? null
      : {
          color: 'var(--red)',
          text: `${connection.name}: ${statusText(connection, true).text}`,
        };
  return (
    <nav
      aria-label="Tasks"
      className={rail ? 'leftnav is-rail' : 'leftnav'}
      style={rail ? undefined : { width }}
    >
      <ProjectTile rail={rail} />
      <NavItem
        icon={<Home20Regular aria-hidden="true" />}
        label="Home"
        rail={rail}
        current={screen.kind === 'home'}
        onClick={() => go({ kind: 'home' })}
      />
      {connection && (
        <NavItem
          icon={<Grid20Regular aria-hidden="true" />}
          label="Project"
          rail={rail}
          current={screen.kind === 'project'}
          onClick={() => {
            go({ kind: 'project' });
            track('project.open', { from: 'nav' });
          }}
        />
      )}
      <NavItem
        icon={<ArrowSprint20Regular aria-hidden="true" />}
        label="Sprint"
        rail={rail}
        current={screen.kind === 'sprint'}
        onClick={() => go({ kind: 'sprint' })}
      />
      <NavItem
        icon={<CalendarLtr20Regular aria-hidden="true" />}
        label="Week"
        rail={rail}
        current={screen.kind === 'week'}
        onClick={() => go({ kind: 'week' })}
      />
      <DreamsNavItem rail={rail} />
      {!rail && connection && (
        <JoinCard connectionId={connection.id} project={connection.project} />
      )}
      {brains.map((b) => (
        <NavItem
          key={b.id}
          icon={<Brain20Regular aria-hidden="true" />}
          label={b.name}
          rail={rail}
          current={screen.kind === 'brain' && screen.brainId === b.id}
          note={toRead.has(b.id) ? 'something to read' : undefined}
          onClick={() => go({ kind: 'brain', brainId: b.id })}
        />
      ))}
      <div className="leftnav-scroll">
        <TasksHead rail={rail} />
        {open.map((t) =>
          rail ? (
            <Fragment key={t.id}>
              <RailRow task={t} signal={signal(t)} />
              <RailFinish task={t} />
              <RailDiscard task={t} />
            </Fragment>
          ) : (
            <Row
              key={t.id}
              task={t}
              cost={costs[t.id] ?? 0}
              repos={repoLine(t, repos)}
              signal={signal(t)}
              pulse={pulse}
            />
          ),
        )}
        {open.length === 0 && !rail && (
          <div className="nav-empty">No open tasks.</div>
        )}
        {done.length > 0 && !rail && (
          <>
            <button
              type="button"
              className="nav-section nav-section-toggle"
              aria-expanded={showDone}
              onClick={() => setShowDone(!showDone)}
            >
              {showDone ? (
                <ChevronDown12Regular aria-hidden="true" />
              ) : (
                <ChevronRight12Regular aria-hidden="true" />
              )}
              Done ({done.length})
            </button>
            {showDone &&
              done.map((t) => (
                <Row key={t.id} task={t} cost={costs[t.id] ?? 0} />
              ))}
          </>
        )}
      </div>
      <div className="leftnav-foot">
        <NavItem
          icon={<Settings20Regular aria-hidden="true" />}
          label="Settings"
          rail={rail}
          current={screen.kind === 'settings'}
          onClick={() => go({ kind: 'settings' })}
        />
        {footer && (
          <div className="nav-status" title={footer.text}>
            <span className="dot" style={{ background: footer.color }} />
            {!rail && <span className="nav-status-text">{footer.text}</span>}
          </div>
        )}
        <DreamNavStatus rail={rail} />
        {!rail && pulse?.error === 'auth' && (
          <div className="nav-status nav-status-note">
            <span className="nav-status-text">{PULSE_AUTH_NOTE}</span>
          </div>
        )}
        <button
          type="button"
          className="ibtn nav-collapse"
          aria-label={rail ? 'Expand task list' : 'Collapse task list'}
          title={rail ? 'Expand navigation' : 'Collapse navigation'}
          onClick={() => setNavCollapsed(!rail)}
        >
          {rail ? <PanelLeftExpand20Regular /> : <PanelLeftContract20Regular />}
        </button>
      </div>
      {!rail && <NavResize width={width} onDrag={setDragWidth} />}
    </nav>
  );
}
