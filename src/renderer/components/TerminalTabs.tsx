import {
  Branch16Regular,
  Brain16Regular,
  BranchCompare16Regular,
  CheckmarkCircle16Regular,
  Delete16Regular,
  Dismiss12Regular,
  Warning16Regular,
  DataPie16Regular,
  Document16Regular,
  FullScreenMaximize16Regular,
  FullScreenMinimize16Regular,
  Globe16Regular,
} from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import type { Events } from '../../shared/ipc';
import { brainTaskId } from '../../shared/brain';
import type { NewTerminal, TaskView, TerminalDef } from '../../shared/types';
import { api, tryInvoke } from '../api';
import { eur } from '../format';
import { useTaskBrain } from '../hooks/useBrains';
import { useGitSummary } from '../hooks/useGitSummary';
import { useRepoConfig } from '../hooks/useRepoConfig';
import { useTaskUsage } from '../hooks/useTaskUsage';
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
import { OpenInEditor } from './OpenInEditor';
import { ChangesTab } from './review/ChangesTab';
import { DiscardBar } from './DiscardBar';
import { NewTerminalMenu } from './NewTerminalMenu';
import { TerminalView } from './TerminalView';
import { IconButton, MindMark, modKey } from './ui';
import { UsagePanel } from './UsagePanel';
import { EnvironmentBand } from './secrets/EnvironmentBand';
import { RunApproveBar } from './secrets/RunApproveBar';
import { EnvironmentChip } from './secrets/EnvironmentChip';
import { CleanWorktreeButton } from './secrets/CleanWorktreeButton';
import { ENVIRONMENT_LABEL } from '../../shared/secrets';
import { TaskMenu, WorkspaceChips } from './WorkspaceChips';

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

const NO_VIEWS: HtmlView[] = [];

/** Tasks whose brain terminal was opened for `openBrainTerminalOnStart` in this app session: once per task. */
export const brainTerminalOpenedOnStart = new Set<string>();

const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

/**
 * One repo's `.shellie.yml` run entries. A single-repo task shows them as before (run in the task's folder); with
 * several repos each group is named after its repo and runs in that repo's worktree.
 */
function RunChips({
  workspace,
  repoName,
  grouped,
  disabled,
  onOpen,
}: {
  workspace: WorkspaceView;
  repoName: string;
  grouped: boolean;
  disabled: boolean;
  onOpen: (def: NewTerminal) => void;
}) {
  const config = useRepoConfig(workspace.repoId);
  const entries = Object.entries(config?.config.run ?? {});
  if (entries.length === 0) return null;
  return (
    <span className="tabrow-run">
      <span className="small muted">{grouped ? `Run ${repoName}` : 'Run'}</span>
      {entries.map(([name, command]) => (
        <button
          key={name}
          type="button"
          className="btn btn-sm chip"
          aria-label={grouped ? `Run ${name} in ${repoName}` : undefined}
          onClick={() =>
            onOpen({
              kind: 'run',
              label: name,
              command,
              ...(grouped ? { workspaceId: workspace.id } : {}),
            })
          }
          disabled={disabled}
        >
          {name}
        </button>
      ))}
    </span>
  );
}

/** The task's AI cost; opens the Usage tab. */
function CostButton({ taskId }: { taskId: string }) {
  const openUsage = useStore((s) => s.openUsage);
  const usage = useTaskUsage(taskId);
  const cost = usage?.billable.costEur ?? 0;
  return (
    <button
      type="button"
      className="btn btn-subtle btn-sm taskbar-cost"
      aria-label={`AI cost ${usage ? eur(cost) : 'unknown'}, open usage`}
      title="AI cost, open usage"
      onClick={() => openUsage(taskId)}
    >
      <span className="mono">{usage ? eur(cost) : DASH}</span>
    </button>
  );
}

/** The 36 px task row: pivots per terminal and Usage on the left, git state and task commands on the right. */
export function TerminalTabs({
  task,
  visible = true,
}: {
  task: TaskView;
  /** False while kept mounted behind another page: terminals stay alive but are not active, git is not polled. */
  visible?: boolean;
}) {
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const askDiscard = useStore((s) => s.askDiscard);
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
  const attention = useStore((s) => s.attention);
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
  const navCollapsed = useStore((s) => s.navCollapsed);
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

  const closeTerminal = (id: string) =>
    tryInvoke(() => api().invoke('terminals:kill', id), notify);

  return (
    <>
      <EnvironmentBand task={task} />
      <RunApproveBar taskId={task.id} />
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
            <button
              type="button"
              role="tab"
              aria-selected={active === USAGE_TAB}
              aria-label={unseen ? 'Usage, new usage' : 'Usage'}
              className="pivot"
              onClick={() => setTab(task.id, USAGE_TAB)}
            >
              <DataPie16Regular aria-hidden="true" />
              Usage
              {unseen && <span className="tab-new" aria-hidden="true" />}
            </button>
            {hasGit && (
              <button
                type="button"
                role="tab"
                aria-selected={active === DOCS_TAB}
                aria-label={docsUnseen ? 'Docs, changed' : 'Docs'}
                className="pivot"
                title={`Docs (${modKey}+Shift+D)`}
                onClick={() => setTab(task.id, DOCS_TAB)}
              >
                <Document16Regular aria-hidden="true" />
                Docs
                {docsUnseen && <span className="tab-new" aria-hidden="true" />}
              </button>
            )}
            {hasGit && (
              <button
                type="button"
                role="tab"
                aria-selected={active === CHANGES_TAB}
                aria-label={
                  changeCount ? `Changes, ${changeCount} files` : 'Changes'
                }
                className="pivot"
                onClick={() => setTab(task.id, CHANGES_TAB)}
              >
                <BranchCompare16Regular aria-hidden="true" />
                Changes
                {changeCount ? (
                  <span className="pivot-count">{changeCount}</span>
                ) : null}
              </button>
            )}
            {brainShown && (
              <button
                type="button"
                role="tab"
                aria-selected={active === BRAIN_TAB}
                aria-label="Brain"
                className="pivot"
                title={`Brain (${modKey}+Shift+B)`}
                onClick={() => {
                  if (active !== BRAIN_TAB) trackBrain('tab');
                  setTab(task.id, BRAIN_TAB);
                }}
              >
                <Brain16Regular aria-hidden="true" />
                Brain
              </button>
            )}
            {task.terminals.map((t) => (
              <span key={t.id} className="term-tab">
                <button
                  type="button"
                  role="tab"
                  aria-selected={active === t.id}
                  className="pivot"
                  onClick={() => setTab(task.id, t.id)}
                  // Middle click closes, as in browsers and VS Code.
                  onAuxClick={(e) => {
                    if (e.button === 1) void closeTerminal(t.id);
                  }}
                >
                  {t.label}
                  {(t.kind === 'shell' || t.kind === 'run') &&
                    task.environment !== 'development' && (
                      <span
                        className={`tab-env tab-env-${task.environment}`}
                      >{` · ${ENVIRONMENT_LABEL[task.environment]}`}</span>
                    )}
                  {attention[t.id] && <AttentionDot entry={attention[t.id]} />}
                </button>
                <button
                  type="button"
                  className="term-tab-close"
                  aria-label={`Close ${t.label}`}
                  title={`Close ${t.label}`}
                  onClick={() => void closeTerminal(t.id)}
                >
                  <Dismiss12Regular aria-hidden="true" />
                </button>
              </span>
            ))}
            {views.map((v) => (
              <span key={v.id} className="term-tab">
                <button
                  type="button"
                  role="tab"
                  aria-selected={active === v.id}
                  className="pivot"
                  title={v.path}
                  onClick={() => setTab(task.id, v.id)}
                  onAuxClick={(e) => {
                    if (e.button === 1) closeView(task.id, v.id);
                  }}
                >
                  <Globe16Regular aria-hidden="true" />
                  {v.name}
                </button>
                <button
                  type="button"
                  className="term-tab-close"
                  aria-label={`Close ${v.name}`}
                  title={`Close ${v.name}`}
                  onClick={() => closeView(task.id, v.id)}
                >
                  <Dismiss12Regular aria-hidden="true" />
                </button>
              </span>
            ))}
            {brainTerm && (
              <span className="term-tab">
                <button
                  type="button"
                  role="tab"
                  aria-selected={active === brainTerm.id}
                  className="pivot"
                  onClick={() => setTab(task.id, brainTerm.id)}
                >
                  {`${brain?.name ?? 'Brain'} brain`}
                </button>
                <button
                  type="button"
                  className="term-tab-close"
                  aria-label={`Close ${brain?.name ?? 'Brain'} brain`}
                  title={`Close ${brain?.name ?? 'Brain'} brain`}
                  onClick={closeBrainTerminal}
                >
                  <Dismiss12Regular aria-hidden="true" />
                </button>
              </span>
            )}
            {runFrom.map((w) => (
              <RunChips
                key={w.id}
                workspace={w}
                repoName={repoName(w)}
                grouped={runFrom.length > 1}
                disabled={task.worktreeMissing}
                onOpen={(def) => void open(def)}
              />
            ))}
          </div>
          {/* Outside the scrolling row, so it never scrolls out of sight (#215). */}
          <NewTerminalMenu
            disabled={task.worktreeMissing}
            workspaces={workspaces}
            brain={brain ? { id: brain.id, name: brain.name } : undefined}
            onOpen={(def) => void open(def)}
            onOpenBrain={() => void openBrainTerminal()}
          />
        </div>
        <div className="taskbar-right">
          {ready && !noRepo && <EnvironmentChip task={task} />}
          {ready && visible && !noRepo && <CleanWorktreeButton task={task} />}
          <WorkspaceChips task={task} />
          {noRepo ? (
            <span className="small muted">No repo</span>
          ) : (
            <span className="mono taskbar-git" title={home.branch}>
              <Branch16Regular aria-hidden="true" />
              <span className="taskbar-branch">{home.branch}</span>
              {git &&
                ` ${UP}${git.ahead}${git.behind ? ` ${DOWN}${git.behind}` : ''} ${DOT} ${git.files.length ? `${git.files.length}${DELTA}` : 'clean'}`}
            </span>
          )}
          <CostButton taskId={task.id} />
          {ready && (
            <>
              <OpenInEditor
                taskId={task.id}
                disabled={task.worktreeMissing}
                visible={visible}
              />
              {/* Finish lives under the task in the nav (#95); only Focus without the rail has no nav. */}
              {inFocus && !navCollapsed && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  aria-label="Finish task"
                  title="Finish task: check changes, push, book time, clean up"
                  onClick={() => go({ kind: 'finish', taskId: task.id })}
                >
                  <CheckmarkCircle16Regular aria-hidden="true" />
                  Finish
                </button>
              )}
              {inFocus && !navCollapsed && (
                <IconButton
                  label="Discard task"
                  onClick={() => askDiscard(task.id)}
                >
                  <Delete16Regular />
                </IconButton>
              )}
              {!noRepo && <TaskMenu task={task} />}
              <IconButton
                label={inFocus ? 'Exit focus' : 'Focus'}
                shortcut={`${modKey}+Shift+F`}
                onClick={toggleFocus}
              >
                {inFocus ? (
                  <FullScreenMinimize16Regular />
                ) : (
                  <FullScreenMaximize16Regular />
                )}
              </IconButton>
            </>
          )}
        </div>
      </div>
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
}
