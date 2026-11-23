import { ChevronDown12Regular } from '@fluentui/react-icons';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskView } from '../../shared/types';
import {
  activeWorkspaces,
  HOME_ID,
  repoColor,
  type WorkspaceView,
} from '../../shared/workspaces';
import { useLatest } from '../hooks/useLatest';
import { api, tryInvoke } from '../api';
import { useGitSummary } from '../hooks/useGitSummary';
import { useContributeCommands } from '../commands/registry';
import type { Command } from '../commands/types';
import { useStore } from '../store';
import { RepoMark } from './RepoMark';

/** A button that opens a small menu under itself; fixed-positioned because the task row clips overflow. */
function PopMenu({
  label,
  trigger,
  className,
  children,
}: {
  label: string;
  trigger: ReactNode;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t))
        setAt(null);
    };
    const onResize = () => setAt(null);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onResize);
    };
  }, [at]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={() => {
          if (at) return setAt(null);
          const r = button.current?.getBoundingClientRect();
          if (r)
            setAt({
              left: Math.max(4, Math.min(r.left, window.innerWidth - 284)),
              top: r.bottom + 2,
            });
        }}
      >
        {trigger}
      </button>
      {at && (
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          className="menu terminal-menu"
          style={{ left: at.left, top: at.top }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setAt(null);
              button.current?.focus();
            }
          }}
        >
          {children(() => setAt(null))}
        </div>
      )}
    </>
  );
}

function Item({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className="menu-item"
      onClick={onClick}
    >
      <span className="menu-title">{children}</span>
    </button>
  );
}

const UP = String.fromCharCode(0x2191);
const DOWN = String.fromCharCode(0x2193);
const BULLET = String.fromCharCode(0x2022);

/** "↑ahead ↓behind •changes" of one repo's worktree, polled while the repos menu is open. */
function RepoGit({ task, w }: { task: TaskView; w: WorkspaceView }) {
  const git = useGitSummary(task.id, task.worktreeMissing, true, w.id);
  if (!git) return null;
  return (
    <span className="mono small muted ws-chip-git">
      {`${UP}${git.ahead} ${DOWN}${git.behind} ${BULLET}${git.files.length}`}
    </span>
  );
}

/** One "3 repos" chip for a task with more than one; its menu has each repo's git state and actions. A single-repo task shows nothing. */
export function WorkspaceChips({ task }: { task: TaskView }) {
  const notify = useStore((s) => s.notify);
  const repos = useStore((s) => s.repos);
  const setTab = useStore((s) => s.setTab);
  const workspaces = activeWorkspaces(task);
  if (workspaces.length < 2) return null;
  const ready = task.status === 'ready';
  const nameOf = (w: WorkspaceView) =>
    repos.find((r) => r.id === w.repoId)?.name ?? w.branch;
  return (
    <PopMenu
      label="Repos of this task"
      className="btn btn-sm chip ws-chip"
      trigger={
        <>
          <span className="ws-chip-marks">
            {workspaces.map((w) => (
              <RepoMark key={w.id} color={repoColor(task, w.id)} />
            ))}
          </span>
          {`${workspaces.length} repos`}
          <ChevronDown12Regular aria-hidden="true" />
        </>
      }
    >
      {(close) =>
        workspaces.map((w) => {
          const name = nameOf(w);
          return (
            <div
              key={w.id}
              role="group"
              aria-label={name}
              className="ws-menu-repo"
            >
              <div className="ws-menu-head">
                <RepoMark color={repoColor(task, w.id)} />
                <span className="ws-menu-name">{name}</span>
                <RepoGit task={task} w={w} />
              </div>
              <Item
                onClick={() => {
                  close();
                  void tryInvoke(async () => {
                    const created = await api().invoke(
                      'terminals:open',
                      task.id,
                      { kind: 'shell', label: 'shell', workspaceId: w.id },
                    );
                    setTab(task.id, created.id);
                  }, notify);
                }}
              >
                New shell here
              </Item>
              <Item
                onClick={() => {
                  close();
                  void tryInvoke(
                    () => api().invoke('tasks:openInEditor', task.id, w.id),
                    notify,
                  );
                }}
              >
                Open in editor
              </Item>
              <Item
                onClick={() => {
                  close();
                  void tryInvoke(
                    () => api().invoke('editor:showFolder', task.id, w.id),
                    notify,
                  );
                }}
              >
                Open folder
              </Item>
              {w.id !== HOME_ID && ready && (
                <Item
                  onClick={() => {
                    close();
                    void tryInvoke(
                      () =>
                        api().invoke('tasks:removeWorkspace', task.id, w.id),
                      notify,
                    );
                  }}
                >
                  Remove from task
                </Item>
              )}
            </div>
          );
        })
      }
    </PopMenu>
  );
}

/** Offers two commands for the task's repos (the task menu and the palette list them): look for other repos, or join a worktree by hand. Renders nothing. */
export function WorkspaceCommands({
  task,
  offers,
}: {
  task: TaskView;
  /** Whether its items are also offered as commands: only for the task on screen. */
  offers: boolean;
}) {
  const notify = useStore((s) => s.notify);
  const scan = async () => {
    const added = await tryInvoke(
      () => api().invoke('tasks:scanWorkspaces', task.id),
      notify,
    );
    // Main announces each repo it adds; only the empty result needs a word here.
    if (added && added.length === 0)
      notify('info', 'No other repos found for this task');
  };
  const add = async () => {
    const folder = await tryInvoke(
      () => api().invoke('repos:pickFolder'),
      notify,
    );
    if (!folder) return;
    await tryInvoke(
      () => api().invoke('tasks:addWorkspace', task.id, folder),
      notify,
    );
  };
  const latest = useLatest({ scan, add });
  const commands = useMemo<Command[]>(
    () =>
      !offers
        ? []
        : [
            {
              id: 'task.scan',
              title: 'Scan for other repos',
              group: 'task',
              run: () => void latest.current.scan(),
            },
            {
              id: 'task.addWorktree',
              title: 'Add a worktree',
              group: 'task',
              run: () => void latest.current.add(),
            },
          ],
    [offers],
  );
  useContributeCommands('task.menu', commands);
  return null;
}
