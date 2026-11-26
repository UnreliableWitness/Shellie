import {
  Add16Regular,
  Add20Regular,
  ArrowSprint20Regular,
  Brain20Regular,
  CheckmarkCircle12Filled,
  CheckmarkCircle16Regular,
  ChevronDown12Regular,
  ChevronRight12Regular,
  Delete16Regular,
  Document16Regular,
  Home20Regular,
  Open16Regular,
  WeatherMoon20Regular,
  PanelLeftContract20Regular,
  PanelLeftExpand20Regular,
  Search16Regular,
  Settings20Regular,
} from '@fluentui/react-icons';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useMemo,
} from 'react';
import {
  type PulseSnapshot,
  type TaskSignal,
  taskSignal,
} from '../../shared/pulse';
import type { Repo, TaskStatus, TaskView } from '../../shared/types';
import { activeHome, activeWorkspaces } from '../../shared/workspaces';
import { api, tryInvoke } from '../api';
import { statusText } from '../connectionStatus';
import { eur, plural } from '../format';
import { JoinCard } from './brain/JoinCard';
import { useProjectBrains } from '../hooks/useProjectBrains';
import { usePulse } from '../hooks/usePulse';
import { useTaskCosts } from '../hooks/useTaskCosts';
import {
  activeConnection,
  taskOnScreen,
  useStore,
  useTaskConnectionId,
} from '../store';
import { useContributeCommands } from '../commands/registry';
import { NEXT_PROJECT_SHORTCUT } from '../commands/global';
import { shortcutLabel } from '../commands/shortcut';
import type { Command } from '../commands/types';
import { PALETTE_SHORTCUT } from '../hooks/useShortcuts';
import { listTasks } from '../taskList';
import { type TaskMark, rowTitle, taskMark } from '../taskMark';
import { track } from '../telemetry';
import { clampNavWidth, NAV_WIDTH } from '../uiPrefs';
import { attentionLabel } from './AttentionDot';
import { DreamNavStatus } from './dreams/DreamNavStatus';
import { waitingCount } from './dreams/dreamWords';
import { useDreamsState } from './dreams/useDreams';
import { usePlaceCommands } from './PlaceCommands';
import { railTag } from './railTag';
import { useNarrowWindow } from '../hooks/useNarrowWindow';
import { modKey, WorkItemTypeIcon } from './ui';

/** Tasks in these states have no PR story yet: a stale pulse must not mark them. */
const NO_SIGNAL: TaskStatus[] = ['setting-up', 'setup-failed', 'finishing'];

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
          <OpenWorkItem task={task} />
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

/**
 * A task in the rail: its tag (the work item's id, or the initials of a blank task), and while the pointer or the keyboard is on it, the row folded open to the
 * right over the page: the task's name, what its mark tells, and Finish and Discard for a task that is ready.
 * The fly-out is part of the row, so the pointer can move onto it; it replaces a tooltip, which could not hold
 * the buttons.
 */
function RailRow({
  task,
  signal,
}: {
  task: TaskView;
  signal: TaskSignal | null;
}) {
  const current = useIsCurrent(task.id);
  const openTask = useStore((s) => s.openTask);
  const go = useStore((s) => s.go);
  const askDiscard = useStore((s) => s.askDiscard);
  const onItsFinish = useStore((s) => s.screen.kind === 'finish') && current;
  const mark = useMark(task, signal);
  const name = railName(task);
  // Where the fly-out goes (the row's place in the window: the list scrolls and clips), or null while folded.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const item = useRef<HTMLDivElement>(null);
  const open = () => {
    const r = item.current?.getBoundingClientRect();
    if (r) setAt({ top: r.top, left: r.right });
  };
  const close = () => setAt(null);
  const act = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <div
      ref={item}
      className="railitem"
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) close();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <button
        type="button"
        className="railrow"
        aria-label={mark ? `${name}, ${mark.label}` : name}
        aria-current={current ? 'true' : undefined}
        onClick={act(() => openTask(task.id))}
      >
        <span className="rail-tag" aria-hidden="true">
          {railTag(task)}
        </span>
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
      {at && (
        <div className="rail-fly" style={at}>
          {/* The name again, for the eye: the row's button already names the task. */}
          <span className="rail-fly-name" aria-hidden="true">
            <TypeIcon task={task} />
            {task.workItem && (
              <span className="navrow-id">{task.workItem.id}</span>
            )}
            <span className="navrow-title">
              {task.workItem?.title ?? task.name}
            </span>
          </span>
          {mark && <span className="rail-fly-mark">{mark.label}</span>}
          {task.status === 'ready' && !onItsFinish && (
            <span className="navrow-actions">
              <OpenWorkItem task={task} onOpen={close} />
              <button
                type="button"
                className="ibtn navrow-finish"
                aria-label="Finish task"
                title={FINISH_TITLE}
                onClick={act(() => go({ kind: 'finish', taskId: task.id }))}
              >
                <CheckmarkCircle16Regular aria-hidden="true" />
              </button>
              <button
                type="button"
                className="ibtn nav-discard"
                aria-label={DISCARD_LABEL}
                title={DISCARD_LABEL}
                onClick={act(() => askDiscard(task.id))}
              >
                <Delete16Regular aria-hidden="true" />
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Opens the task's work item in the browser, before Finish and Discard; nothing for a task without one. */
function OpenWorkItem({
  task,
  onOpen,
}: {
  task: TaskView;
  onOpen?: () => void;
}) {
  const url = task.workItem?.url;
  if (!url) return null;
  const label = `Open ${task.workItem!.id} in Azure DevOps`;
  return (
    <button
      type="button"
      className="ibtn navrow-workitem"
      aria-label={label}
      title={label}
      onClick={() => {
        onOpen?.();
        void tryInvoke(
          () => api().invoke('shell:openExternal', url),
          useStore.getState().notify,
        );
      }}
    >
      <Open16Regular aria-hidden="true" />
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
  dot = false,
  note,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  current: boolean;
  rail: boolean;
  /** A dot whose reason the label already gives (a For you line). */
  dot?: boolean;
  /** What a dot on this item means, when its label does not say (a brain with something to read). */
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
      title={rail || note ? named : undefined}
      onClick={onClick}
    >
      {icon}
      {!rail && <span>{label}</span>}
      {(dot || note) && <span className="navitem-dot" aria-hidden="true" />}
    </button>
  );
}

/** The project switcher: the active project's tile, which opens a menu of the projects. */
function ProjectTile({ rail }: { rail: boolean }) {
  const connections = useStore((s) => s.connections);
  const connection = useStore(activeConnection);
  const switchProject = useStore((s) => s.switchProject);
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
  // Rendered only with two or more projects, so there is always an active one.
  const name = connection?.project ?? '';
  const avatar = (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ background: avatarColor(name) }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
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
        title={`${name} (next project: ${shortcutLabel(NEXT_PROJECT_SHORTCUT, modKey)})`}
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
                switchProject(c.id);
                close(true);
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
  // A narrow window gets the rail whatever the setting, which stays as it was for when there is room again.
  const narrow = useNarrowWindow();
  const rail = navCollapsed || narrow;
  // One read for every row that shows a cost; the rail shows none.
  const costs = useTaskCosts(
    rail ? [] : [...open, ...(showDone ? done : [])].map((t) => t.id),
  );
  const { brains, toRead } = useProjectBrains();
  // Quiet while the connection is fine: the line shows only when something is wrong.
  const footer = !connection
    ? { color: 'var(--disabled)', text: 'Azure DevOps: not connected' }
    : connection.status === 'ok'
      ? null
      : {
          color: 'var(--red)',
          text: `${connection.name}: ${statusText(connection, true).text}`,
        };
  usePlaceCommands(brains, toRead);
  const dreams = useDreamsState().view;
  const dreamsWaiting = dreams ? waitingCount(dreams) : 0;
  // The palette can open the Done list, which lives here.
  const hasDone = done.length > 0;
  const commands = useMemo<Command[]>(
    () =>
      hasDone
        ? [
            {
              id: 'goto.done',
              title: 'Done tasks',
              group: 'goto',
              run: () => {
                setNavCollapsed(false);
                setShowDone(true);
              },
            },
          ]
        : [],
    [hasDone, setNavCollapsed],
  );
  useContributeCommands('nav', commands);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  return (
    <nav
      aria-label="Tasks"
      className={rail ? 'leftnav is-rail' : 'leftnav'}
      style={rail ? undefined : { width }}
    >
      <button
        type="button"
        className="nav-palette"
        aria-label="Go to or run"
        title={`Go to or run (${shortcutLabel(PALETTE_SHORTCUT, modKey)})`}
        onClick={() => setPaletteOpen(true)}
      >
        <Search16Regular aria-hidden="true" />
        {!rail && (
          <>
            <span className="nav-palette-text">Go to or run</span>
            <span className="nav-palette-key mono">
              {shortcutLabel(PALETTE_SHORTCUT, modKey)}
            </span>
          </>
        )}
      </button>
      <NavItem
        icon={<Home20Regular aria-hidden="true" />}
        label="Home"
        rail={rail}
        current={screen.kind === 'home'}
        onClick={() => go({ kind: 'home' })}
      />
      {/* One project needs no switcher; Home and the palette go to its page. */}
      {connections.length > 1 && <ProjectTile rail={rail} />}
      <NavItem
        icon={<ArrowSprint20Regular aria-hidden="true" />}
        label="Sprint"
        rail={rail}
        current={screen.kind === 'sprint'}
        onClick={() => go({ kind: 'sprint' })}
      />
      {/* A brain is a place the day goes through: one line each, with a dot while it has something to read. */}
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
      {/* The list and, over its foot, the For you block: one box, so the block takes no height from the list. */}
      <div className="leftnav-main">
        <div className="leftnav-scroll">
          <TasksHead rail={rail} />
          {open.map((t) =>
            rail ? (
              <RailRow key={t.id} task={t} signal={signal(t)} />
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
        {/*
        Laid over the foot of the list, so a line coming or going never moves a task: the list keeps its height and
        its scroll position, and has room at its end to scroll the last rows clear. Each line is there only while
        its reason holds; the heading hides with the last of them (shell.css).
      */}
        <div className="nav-foryou" role="group" aria-label="For you">
          {!rail && <div className="nav-section">For you</div>}
          <div className="nav-foryou-lines">
            {dreamsWaiting > 0 && (
              <NavItem
                icon={<WeatherMoon20Regular aria-hidden="true" />}
                label={`${plural(dreamsWaiting, 'dream')} to review`}
                rail={rail}
                current={false}
                dot
                onClick={() => go({ kind: 'dreams' })}
              />
            )}
            <DreamNavStatus rail={rail} />
            {!rail && connection && (
              <JoinCard
                connectionId={connection.id}
                project={connection.project}
              />
            )}
          </div>
        </div>
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
        {!rail && pulse?.error === 'auth' && (
          <div className="nav-status nav-status-note">
            <span className="nav-status-text">{PULSE_AUTH_NOTE}</span>
          </div>
        )}
        {!narrow && (
          <button
            type="button"
            className="ibtn nav-collapse"
            aria-label={rail ? 'Expand task list' : 'Collapse task list'}
            title={rail ? 'Expand navigation' : 'Collapse navigation'}
            onClick={() => setNavCollapsed(!rail)}
          >
            {rail ? (
              <PanelLeftExpand20Regular />
            ) : (
              <PanelLeftContract20Regular />
            )}
          </button>
        )}
      </div>
      {!rail && <NavResize width={width} onDrag={setDragWidth} />}
    </nav>
  );
}
