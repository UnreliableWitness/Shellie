import {
  Brain16Regular,
  BranchCompare16Regular,
  Dismiss12Regular,
  Warning16Regular,
  DataPie16Regular,
  Document16Regular,
  Globe16Regular,
} from '@fluentui/react-icons';
import {
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  useContributeCommands,
  useContributedWith,
} from '../commands/registry';
import { shortcutLabel } from '../commands/shortcut';
import type { Command, Shortcut } from '../commands/types';
import { useShallow } from 'zustand/react/shallow';
import type { Events } from '../../shared/ipc';
import { brainTaskId } from '../../shared/brain';
import type { NewTerminal, TaskView, TerminalDef } from '../../shared/types';
import { useLatest } from '../hooks/useLatest';
import { api, tryInvoke } from '../api';
import { eur, plural } from '../format';
import { useTaskBrain } from '../hooks/useBrains';
import { useGitSummary } from '../hooks/useGitSummary';
import { useRepoConfig } from '../hooks/useRepoConfig';
import { useTaskCost } from '../hooks/useTaskCosts';
import { holdWatch } from '../review/holdWatch';
import { useChangeCount } from '../review/useReview';
import {
  BRAIN_TAB,
  CHANGES_TAB,
  DOCS_TAB,
  type HtmlView,
  USAGE_TAB,
  useStore,
} from '../store';
import { AttentionDot } from './AttentionDot';
import { trackBrain } from './brain/brainActions';
import { BrainTab } from './brain/BrainTab';
import { DocsTab } from './docs/DocsTab';
import { HtmlViewTab } from './HtmlViewTab';
import {
  activeHome,
  activeWorkspaces,
  hasNoRepo,
  parseDocsTarget,
  repoColor,
  type WorkspaceView,
} from '../../shared/workspaces';
import { EditorCommands } from './EditorCommands';
import { ChangesTab } from './review/ChangesTab';
import { DiscardBar } from './DiscardBar';
import { NEW_TERMINALS, NewTerminalMenu } from './NewTerminalMenu';
import { TerminalView } from './TerminalView';
import { MindMark, modKey } from './ui';
import { UsagePanel } from './UsagePanel';
import { EnvironmentBand } from './secrets/EnvironmentBand';
import { RunApproveBar } from './secrets/RunApproveBar';
import { EnvironmentMenu } from './secrets/EnvironmentMenu';
import { CleanWorktreeCommand } from './secrets/CleanWorktreeCommand';
import { ENVIRONMENT_LABEL } from '../../shared/secrets';
import { TaskBarMenu } from './TaskBarMenu';
import { WorkspaceCommands, WorkspaceChips } from './WorkspaceChips';

const SCAN_MS = 120000;
const MARKDOWN = /\.(md|markdown)$/i;
/** Build output and dependencies: Markdown there is not the task's documentation. */
const OUTPUT_DIR = /^(dist|build|out|node_modules)\//;
const UP = String.fromCharCode(0x2191);
const DOWN = String.fromCharCode(0x2193);
const DOT = String.fromCharCode(0xb7);
const DELTA = String.fromCharCode(0x394);
const DASH = String.fromCharCode(0x2014);

/** Whether the event brought something new for a tab that is not showing; cleared once the tab shows. */
function useUnseen<K extends 'docs:changed' | 'usage:changed'>(
  taskId: string,
  tab: string,
  active: string,
  event: K,
  hit: (payload: Events[K]) => boolean,
): boolean {
  const [unseen, setUnseen] = useState(false);
  useEffect(
    () =>
      api().on(event, (p) => {
        if (hit(p) && useStore.getState().activeTab(taskId) !== tab)
          setUnseen(true);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hit reads only taskId
    [taskId],
  );
  useEffect(() => {
    if (active === tab) setUnseen(false);
  }, [active, tab]);
  return unseen;
}

/** An editor installed while Shellie runs shows up when the task menu opens, checked at most this often. */
const EDITORS_EVERY_MS = 5 * 60_000;
let editorsLookedAt = Date.now();

const NO_VIEWS: HtmlView[] = [];
const NO_TABS: string[] = [];

/** The view tabs: what each shows as, and the word for "something new" in its name. */
const VIEW_TABS: Record<
  string,
  { label: string; icon: ReactNode; newWord?: string; shortcut?: Shortcut }
> = {
  [USAGE_TAB]: {
    label: 'Usage',
    icon: <DataPie16Regular aria-hidden="true" />,
    newWord: 'new usage',
    shortcut: { code: 'Digit0' },
  },
  [DOCS_TAB]: {
    label: 'Docs',
    icon: <Document16Regular aria-hidden="true" />,
    newWord: 'changed',
    shortcut: { code: 'KeyD', shift: true },
  },
  [CHANGES_TAB]: {
    label: 'Changes',
    icon: <BranchCompare16Regular aria-hidden="true" />,
  },
  [BRAIN_TAB]: {
    label: 'Brain',
    icon: <Brain16Regular aria-hidden="true" />,
    shortcut: { code: 'KeyB', shift: true },
  },
};

/** Tasks whose brain terminal was opened for `openBrainTerminalOnStart` in this app session: once per task. */
export const brainTerminalOpenedOnStart = new Set<string>();

const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

/**
 * One repo's `.shellie.yml` run entries, offered as commands: the new terminal menu and the palette list them. A
 * single-repo task runs them in the task's folder; with several repos each is named after its repo and runs in that
 * repo's worktree. Renders nothing.
 */
function RunCommands({
  workspace,
  index,
  offers,
  repoName,
  grouped,
  disabled,
  onOpen,
}: {
  workspace: WorkspaceView;
  /** The workspace's place among the task's, for the command ids. */
  index: number;
  /** Whether the entries are also offered as commands: only for the task on screen. */
  offers: boolean;
  repoName: string;
  grouped: boolean;
  disabled: boolean;
  onOpen: (def: NewTerminal) => void;
}) {
  const config = useRepoConfig(workspace.repoId);
  const run = config?.config.run;
  const latest = useLatest(onOpen);
  const commands = useMemo<Command[]>(
    () =>
      !offers || disabled
        ? []
        : Object.entries(run ?? {}).map(([name, command], i) => ({
            id: `task.run.${index}.${i}`,
            title: grouped ? `Run ${name} in ${repoName}` : `Run ${name}`,
            group: 'task',
            run: () =>
              latest.current({
                kind: 'run',
                label: name,
                command,
                ...(grouped ? { workspaceId: workspace.id } : {}),
              }),
          })),
    [offers, disabled, run, index, grouped, repoName, workspace.id],
  );
  useContributeCommands(`task.run.${index}`, commands);
  return null;
}

/** The task's AI cost; opens the Usage tab. */
function CostButton({ taskId }: { taskId: string }) {
  const openUsage = useStore((s) => s.openUsage);
  const cost = useTaskCost(taskId);
  const shown = cost === null ? null : eur(cost);
  return (
    <button
      type="button"
      className="btn btn-subtle btn-sm taskbar-cost"
      aria-label={`AI cost ${shown ?? 'unknown'}, open usage`}
      title="AI cost, open usage"
      onClick={() => openUsage(taskId)}
    >
      <span className="mono">{shown ?? DASH}</span>
    </button>
  );
}

/** A tab with a close button: a terminal, an HTML view or the brain terminal. Middle click closes, as in browsers and VS Code. */
function ClosableTab({
  selected,
  label,
  ariaLabel,
  title,
  pinned = false,
  onSelect,
  onClose,
  children,
}: {
  selected: boolean;
  /** Names the close button: "Close <label>". */
  label: string;
  /** The tab's own name when its text alone does not say it all (a count, something new). */
  ariaLabel?: string;
  title?: string;
  /** Always in the row (Changes, #386): no close button, middle click does nothing. */
  pinned?: boolean;
  onSelect: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <span className="term-tab">
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        aria-label={ariaLabel}
        className="pivot"
        title={title}
        onClick={onSelect}
        onAuxClick={(e) => {
          if (e.button === 1 && !pinned) onClose();
        }}
      >
        {children}
      </button>
      {!pinned && (
        <button
          type="button"
          className="term-tab-close"
          aria-label={`Close ${label}`}
          title={`Close ${label}`}
          onClick={onClose}
        >
          <Dismiss12Regular aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

/** The 36 px task row: pivots per terminal and Usage on the left, git state and task commands on the right. */
// Memo: TaskTerminals re-renders all running tasks for any change to one of them.
export const TerminalTabs = memo(function TerminalTabs({
  task,
  visible = true,
}: {
  task: TaskView;
  /** False while kept mounted behind another page: terminals stay alive but are not active, git is not polled. */
  visible?: boolean;
}) {
  const notify = useStore((s) => s.notify);
  const discarding = useStore((s) => s.discardTaskId === task.id);
  const repos = useStore((s) => s.repos);
  // A task without a repo (#225) has a scratch folder with no git: no Docs, Changes, branch or run entries.
  const noRepo = hasNoRepo(task);
  const git = useGitSummary(task.id, task.worktreeMissing, visible && !noRepo);
  const brain = useTaskBrain(task.id);
  // The brain's terminal is a tab of this page only (not one of the task's terminals) until it is closed.
  const [brainTerm, setBrainTerm] = useState<TerminalDef | null>(null);
  const brainTermShown = useStore(
    (s) => brainTerm !== null && s.tabByTask[task.id] === brainTerm.id,
  );
  const stored = useStore((s) => s.activeTab(task.id));
  // The Brain tab is hidden when the task has no brain (or no worktree); then it cannot stay the active one.
  const brainShown =
    !!brain && task.status === 'ready' && !task.worktreeMissing;
  const active =
    brainTermShown && brainTerm
      ? brainTerm.id
      : stored === BRAIN_TAB && !brainShown
        ? (task.terminals[0]?.id ?? USAGE_TAB)
        : stored;
  const setTab = useStore((s) => s.setTab);
  // Only this task's terminals: an agent in another task must not re-render this one.
  const attention = useStore(
    useShallow((s) =>
      Object.fromEntries(
        task.terminals.flatMap((t) =>
          s.attention[t.id] ? [[t.id, s.attention[t.id]]] : [],
        ),
      ),
    ),
  );
  // Same rule as the shell: Focus chrome only for a ready task.
  const ready = task.status === 'ready';
  const inFocus = useStore((s) => s.focus) && ready;
  // Not while Changes is open (it loads the same list); the badge keeps its count and refreshes on leaving.
  const changeCount = useChangeCount(
    task,
    visible && ready && !noRepo && active !== CHANGES_TAB,
  );
  const hasGit = ready && !task.worktreeMissing && !noRepo;
  const toggleFocus = useStore((s) => s.toggleFocus);
  const views = useStore((s) => s.viewsByTask[task.id]) ?? NO_VIEWS;
  const closeView = useStore((s) => s.closeView);
  const docsUnseen = useUnseen(
    task.id,
    DOCS_TAB,
    active,
    'docs:changed',
    (p) =>
      // Any of the task's worktrees: `<taskId>` or `<taskId>#<workspace>`.
      parseDocsTarget(p.taskId).taskId === task.id &&
      p.paths.some((f) => MARKDOWN.test(f) && !OUTPUT_DIR.test(f)),
  );
  const unseen = useUnseen(
    task.id,
    USAGE_TAB,
    active,
    'usage:changed',
    (p) => p.taskId === task.id || p.taskId === '*',
  );

  useEffect(() => {
    if (!visible || !hasGit) return;
    return holdWatch('docs:watch', task.id);
  }, [task.id, visible, hasGit]);

  // The task page looks for other repos' worktrees when shown and every 2 minutes while the window is focused.
  useEffect(() => {
    if (!visible || !ready || noRepo) return;
    const scan = () => {
      void api()
        .invoke('tasks:scanWorkspaces', task.id)
        .catch(() => undefined);
    };
    scan();
    const timer = setInterval(() => {
      if (document.hasFocus()) scan();
    }, SCAN_MS);
    return () => clearInterval(timer);
  }, [task.id, visible, ready, noRepo]);

  const inTask = activeWorkspaces(task);
  const home = activeHome(task);
  const repoName = (w: WorkspaceView) =>
    repos.find((r) => r.id === w.repoId)?.name ?? w.branch;
  const workspaces = inTask.map((w) => ({
    id: w.id,
    name: repoName(w),
    color: repoColor(task, w.id),
  }));
  const runFrom = noRepo ? [] : inTask.length > 1 ? inTask : [home];

  const open = async (def: NewTerminal) => {
    const created = await tryInvoke(
      () => api().invoke('terminals:open', task.id, def),
      notify,
    );
    if (created) setTab(task.id, created.id);
  };

  const openBrainTerminal = async () => {
    if (!brain) return;
    const def = await tryInvoke(
      () => api().invoke('brain:terminal', brain.id),
      notify,
    );
    if (!def) return;
    trackBrain('terminal');
    setBrainTerm(def);
    setTab(task.id, def.id);
  };
  // The palette and the shortcuts get this task's actions while it is the one on screen.
  const latest = useLatest({ open, openBrainTerminal });
  const offers = visible && ready;
  const terminalKey = task.terminals
    .map((t) => `${t.id}\n${t.label}`)
    .join('\n');
  const workspaceKey = workspaces.map((w) => `${w.id}\n${w.name}`).join('\n');
  const brainName = brain?.name;
  const canOpen = !task.worktreeMissing;
  const path = noRepo ? null : home.worktreePath;
  const workItemUrl = task.workItem?.url ?? null;
  const workItemName = task.workItem
    ? `${task.workItem.type} ${task.workItem.id}`
    : '';
  const commands = useMemo<Command[]>(() => {
    if (!offers) return [];
    const { id, terminals } = task;
    const { setTab, go, askDiscard } = useStore.getState();
    const show = (
      cid: string,
      title: string,
      tab: string,
      rest: Partial<Command> = {},
    ): Command => ({
      id: cid,
      title,
      group: 'task',
      run: () => setTab(id, tab),
      ...rest,
    });
    return [
      ...(hasGit
        ? [
            show('task.changes', 'Show changes', CHANGES_TAB, {
              note: changeCount ? plural(changeCount, 'file') : undefined,
            }),
          ]
        : []),
      show('task.usage', 'Show usage and cost', USAGE_TAB, {
        shortcut: VIEW_TABS[USAGE_TAB].shortcut,
      }),
      ...(hasGit
        ? [
            show('task.docs', 'Show docs', DOCS_TAB, {
              shortcut: VIEW_TABS[DOCS_TAB].shortcut,
            }),
          ]
        : []),
      ...(brainShown
        ? [
            {
              ...show('task.brain', 'Show brain', BRAIN_TAB, {
                shortcut: VIEW_TABS[BRAIN_TAB].shortcut,
              }),
              run: () => {
                if (useStore.getState().activeTab(id) !== BRAIN_TAB)
                  trackBrain('tab');
                setTab(id, BRAIN_TAB);
              },
            },
          ]
        : []),
      ...terminals.map((t, i) =>
        show(
          `task.terminal.${i + 1}`,
          `Switch to terminal ${i + 1}: ${t.label}`,
          t.id,
          {
            shortcut: i < 9 ? { code: `Digit${i + 1}` } : undefined,
          },
        ),
      ),
      ...(canOpen
        ? NEW_TERMINALS.flatMap((t): Command[] =>
            workspaces.length > 1
              ? workspaces.map((w, i) => ({
                  id: `task.new.${t.def.kind}.${i}`,
                  title: `New terminal: ${t.title} in ${w.name}`,
                  group: 'task',
                  run: () =>
                    void latest.current.open({ ...t.def, workspaceId: w.id }),
                }))
              : [
                  {
                    id: `task.new.${t.def.kind}`,
                    title: `New terminal: ${t.title}`,
                    group: 'task',
                    run: () => void latest.current.open(t.def),
                  },
                ],
          )
        : []),
      ...(canOpen && brainName !== undefined
        ? [
            {
              id: 'task.new.brain',
              title: 'New terminal: Brain',
              group: 'task' as const,
              run: () => void latest.current.openBrainTerminal(),
            },
          ]
        : []),
      ...(path
        ? [
            {
              id: 'task.copyPath',
              title: 'Copy worktree path',
              group: 'task' as const,
              run: () =>
                void navigator.clipboard
                  .writeText(path)
                  .catch(() =>
                    useStore
                      .getState()
                      .notify('error', 'Could not copy to the clipboard.'),
                  ),
            },
          ]
        : []),
      ...(workItemUrl
        ? [
            {
              id: 'task.workItem',
              title: `Open ${workItemName} in Azure DevOps`,
              group: 'task' as const,
              run: () =>
                void tryInvoke(
                  () => api().invoke('shell:openExternal', workItemUrl),
                  useStore.getState().notify,
                ),
            },
          ]
        : []),
      {
        id: 'task.finish',
        title: 'Finish task',
        group: 'task',
        last: true,
        run: () => go({ kind: 'finish', taskId: id }),
      },
      {
        id: 'task.discard',
        title: 'Discard task',
        group: 'task',
        last: true,
        run: () => askDiscard(id),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the keys stand for the terminals and workspaces
  }, [
    offers,
    task.id,
    terminalKey,
    workspaceKey,
    hasGit,
    changeCount,
    brainShown,
    brainName,
    canOpen,
    path,
    workItemUrl,
    workItemName,
  ]);
  useContributeCommands('task', commands);

  // A ready task whose brain asks for it gets the brain terminal in its tab bar, once per app session (not selected).
  const autoOpen = brainShown && !!brain?.options.openBrainTerminalOnStart;
  useEffect(() => {
    if (!autoOpen || !brain || brainTerm) return;
    if (brainTerminalOpenedOnStart.has(task.id)) return;
    brainTerminalOpenedOnStart.add(task.id);
    void tryInvoke(() => api().invoke('brain:terminal', brain.id), notify).then(
      (def) => {
        if (def) setBrainTerm((cur) => cur ?? def);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the task, its brain and the option are known
  }, [autoOpen, brain?.id, task.id]);

  // Closing only detaches the tab: the terminal belongs to the brain and stays on its page (never killed here).
  const closeBrainTerminal = () => {
    setBrainTerm(null);
    if (brainTermShown) setTab(task.id, task.terminals[0]?.id ?? USAGE_TAB);
  };

  // The row scrolls sideways when its tabs do not fit; the selected tab (a new terminal or page) is kept in view.
  const tabrow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabrow.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active, task.terminals.length]);

  // A view tab is in the row once opened, and while it is the one showing (Usage for a task without terminals).
  // Changes is always there, first, for a task with git (#386).
  const shownTabs = useStore((s) => s.shownTabsByTask[task.id]) ?? NO_TABS;
  const closeTab = useStore((s) => s.closeTab);
  const canShow: Record<string, boolean> = {
    [USAGE_TAB]: true,
    [DOCS_TAB]: hasGit,
    [CHANGES_TAB]: hasGit,
    [BRAIN_TAB]: brainShown,
  };
  const viewTabs = [
    ...new Set([
      CHANGES_TAB,
      ...shownTabs,
      ...(active in VIEW_TABS ? [active] : []),
    ]),
  ].filter((t) => canShow[t]);
  // Only the run entries, and only for the task on screen: every other offer leaves this row alone.
  const runs = useContributedWith(offers ? 'task.run.' : null);
  // Counts the task menu openings that look for the editors again (#94): at most one per EDITORS_EVERY_MS.
  const [menuOpens, setMenuOpens] = useState(0);
  // Where the task is, for the top of the task menu.
  const where = noRepo
    ? ['No repo']
    : [
        home.branch,
        ...(git
          ? [
              `${UP}${git.ahead}${git.behind ? ` ${DOWN}${git.behind}` : ''} ${DOT} ${git.files.length ? `${git.files.length}${DELTA}` : 'clean'}`,
            ]
          : []),
        ENVIRONMENT_LABEL[task.environment],
      ];
  // A closed view with something new shows it on its item in the task menu.
  const dots = {
    'task.usage': unseen && !viewTabs.includes(USAGE_TAB),
    'task.docs': docsUnseen && !viewTabs.includes(DOCS_TAB),
  };

  const closeTerminal = (id: string) =>
    tryInvoke(() => api().invoke('terminals:kill', id), notify);

  return (
    <>
      {/* First: the tab row is the window's title bar, and only it keeps clear of the window controls. */}
      <div className="taskbar">
        <div className="tabs">
          <div
            ref={tabrow}
            role="tablist"
            aria-label="Terminals"
            className="tabrow"
            onDoubleClick={(e) => {
              if (ready && e.target === e.currentTarget) toggleFocus();
            }}
          >
            {inFocus && (
              <span className="tabrow-brand">
                <MindMark size={14} />
                <span className="mono">{task.workItem?.id ?? task.name}</span>
              </span>
            )}
            {task.terminals.map((t) => (
              <ClosableTab
                key={t.id}
                selected={active === t.id}
                label={t.label}
                onSelect={() => setTab(task.id, t.id)}
                onClose={() => void closeTerminal(t.id)}
              >
                {t.label}
                {(t.kind === 'shell' || t.kind === 'run') &&
                  task.environment !== 'development' && (
                    <span
                      className={`tab-env tab-env-${task.environment}`}
                    >{` · ${ENVIRONMENT_LABEL[task.environment]}`}</span>
                  )}
                {attention[t.id] && <AttentionDot entry={attention[t.id]} />}
              </ClosableTab>
            ))}
            {views.map((v) => (
              <ClosableTab
                key={v.id}
                selected={active === v.id}
                label={v.name}
                title={v.path}
                onSelect={() => setTab(task.id, v.id)}
                onClose={() => closeView(task.id, v.id)}
              >
                <Globe16Regular aria-hidden="true" />
                {v.name}
              </ClosableTab>
            ))}
            {brainTerm && (
              <ClosableTab
                selected={active === brainTerm.id}
                label={`${brain?.name ?? 'Brain'} brain`}
                onSelect={() => setTab(task.id, brainTerm.id)}
                onClose={closeBrainTerminal}
              >
                {`${brain?.name ?? 'Brain'} brain`}
              </ClosableTab>
            )}
            {/* The views open on demand (the task menu, the palette, a shortcut) and stay until closed; Changes stays. */}
            {viewTabs.map((tab) => {
              const v = VIEW_TABS[tab];
              const isNew =
                (tab === USAGE_TAB && unseen) ||
                (tab === DOCS_TAB && docsUnseen);
              const count = tab === CHANGES_TAB ? changeCount : 0;
              return (
                <ClosableTab
                  key={tab}
                  selected={active === tab}
                  label={v.label}
                  pinned={tab === CHANGES_TAB}
                  ariaLabel={
                    isNew
                      ? `${v.label}, ${v.newWord}`
                      : count
                        ? `${v.label}, ${count} files`
                        : v.label
                  }
                  title={
                    v.shortcut && shortcutLabel(v.shortcut, modKey)
                      ? `${v.label} (${shortcutLabel(v.shortcut, modKey)})`
                      : undefined
                  }
                  onSelect={() => {
                    if (tab === BRAIN_TAB && active !== BRAIN_TAB)
                      trackBrain('tab');
                    setTab(task.id, tab);
                  }}
                  onClose={() => closeTab(task.id, tab)}
                >
                  {v.icon}
                  {v.label}
                  {count ? <span className="pivot-count">{count}</span> : null}
                  {isNew && <span className="tab-new" aria-hidden="true" />}
                </ClosableTab>
              );
            })}
          </div>
          {/* Outside the scrolling row, so it never scrolls out of sight (#215). */}
          <NewTerminalMenu
            disabled={task.worktreeMissing}
            workspaces={workspaces}
            brain={brain ? { id: brain.id, name: brain.name } : undefined}
            runs={runs}
            onOpen={(def) => void open(def)}
            onOpenBrain={() => void openBrainTerminal()}
          />
        </div>
        {/* Always free, however many tabs: something to drag the window by (shell.css). */}
        <span className="taskbar-grip" aria-hidden="true" />
        <div className="taskbar-right">
          <WorkspaceChips task={task} />
          <CostButton taskId={task.id} />
          {/* Its place in the row is where the environment menu opens. */}
          {ready && !noRepo && <EnvironmentMenu task={task} offers={visible} />}
          {ready && (
            <TaskBarMenu
              where={where}
              dots={dots}
              visible={visible}
              onOpen={() => {
                // Looking for editors starts processes in main: not on every opening of the menu.
                if (Date.now() - editorsLookedAt < EDITORS_EVERY_MS) return;
                editorsLookedAt = Date.now();
                setMenuOpens((n) => n + 1);
              }}
            />
          )}
        </div>
      </div>
      <EnvironmentBand task={task} />
      <RunApproveBar taskId={task.id} />
      {/* No buttons of their own any more: they offer the task menu and the palette their commands. */}
      {runFrom.map((w, i) => (
        <RunCommands
          key={w.id}
          workspace={w}
          index={i}
          offers={offers}
          repoName={repoName(w)}
          grouped={runFrom.length > 1}
          disabled={task.worktreeMissing}
          onOpen={(def) => void open(def)}
        />
      ))}
      {ready && visible && !noRepo && <CleanWorktreeCommand task={task} />}
      {ready && (
        <EditorCommands
          taskId={task.id}
          disabled={task.worktreeMissing}
          visible={visible}
          refresh={menuOpens}
        />
      )}
      {ready && !noRepo && <WorkspaceCommands task={task} offers={visible} />}
      {discarding && ready && <DiscardBar task={task} />}
      {task.mainCheckoutEdits.map((e) => (
        <div key={e.repoPath} role="status" className="ws-warning">
          <Warning16Regular aria-hidden="true" />
          {`Changes made in ${folderName(e.repoPath)}'s main checkout${e.branch ? ` (branch ${e.branch})` : ''}`}
        </div>
      ))}
      <div className="termhost">
        {visible && active === USAGE_TAB && <UsagePanel taskId={task.id} />}
        {visible && active === DOCS_TAB && !task.worktreeMissing && !noRepo && (
          <DocsTab task={task} />
        )}
        {visible && active === CHANGES_TAB && hasGit && (
          <ChangesTab task={task} />
        )}
        {visible && active === BRAIN_TAB && brain && brainShown && (
          <BrainTab
            brain={brain}
            taskId={task.id}
            onTerminal={(def) => {
              setBrainTerm(def);
              setTab(task.id, def.id);
            }}
          />
        )}
        {views.map(
          (v) =>
            visible &&
            active === v.id && (
              <HtmlViewTab key={v.id} taskId={task.id} view={v} />
            ),
        )}
        {brainTerm && brain && (
          <TerminalView
            key={brainTerm.id}
            terminalId={brainTerm.id}
            taskId={brainTaskId(brain.id)}
            resumes
            autoStart
            active={visible && active === brainTerm.id}
          />
        )}
        {task.terminals.map((t) => (
          <TerminalView
            key={t.id}
            terminalId={t.id}
            taskId={task.id}
            workspaceId={t.workspaceId}
            resumes={t.kind === 'claude'}
            autoStart={t.kind === 'claude' || t.kind === 'shell'}
            active={visible && active === t.id}
          />
        ))}
      </div>
    </>
  );
});
