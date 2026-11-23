// src/renderer/components/OpenInEditor.tsx
import {
  ChevronDown16Regular,
  Code16Regular,
  FolderOpen16Regular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type EditorId, type EditorOptions } from '../../shared/editors';
import { api, tryInvoke } from '../api';
import { useContributeCommands } from '../commands/registry';
import type { Command } from '../commands/types';
import { useStore } from '../store';
import { PopupMenu } from './ui';

const fileName = (p: string) => p.split(/[\\/]/).at(-1) ?? p;

/**
 * Opens the worktree folder in Explorer or Finder (#73); the menu opens it in any installed editor instead (the
 * chosen one first; Visual Studio opens the solution, or the folder when there is none) or one of Visual Studio's
 * solutions.
 */
export function OpenInEditor({
  taskId,
  workspaceId,
  disabled,
  visible = true,
  headless = false,
  refresh = 0,
}: {
  /** Another number looks for the editors again: the task menu passes how often it was opened (#94). */
  refresh?: number;
  /** No buttons: only offers its commands (the task menu and the palette show them). */
  headless?: boolean;
  taskId: string;
  workspaceId?: string;
  disabled?: boolean;
  /** A hidden row keeps its state; options load again when it shows or its menu opens. */
  visible?: boolean;
}) {
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const [opts, setOpts] = useState<EditorOptions | null>(null);
  const [menu, setMenu] = useState(false);
  // Counts menu openings: options load again on open, not on close.
  const [opens, setOpens] = useState(0);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const close = useCallback(() => setMenu(false), []);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    void api()
      // Opening the menu detects again, so an editor installed since shows up (#94).
      .invoke('editor:options', taskId, workspaceId, opens + refresh > 0)
      .then((o) => {
        if (live) setOpts(o);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [taskId, workspaceId, visible, opens, refresh]);

  const open = (o: { editorId?: EditorId; solution?: string } = {}) => {
    setMenu(false);
    void tryInvoke(
      () => api().invoke('editor:openFolder', taskId, workspaceId, o),
      notify,
    );
  };

  const showFolder = () => {
    setMenu(false);
    void tryInvoke(
      () => api().invoke('editor:showFolder', taskId, workspaceId),
      notify,
    );
  };

  // The task's own row offers its folder and editors as commands; a repo's row in a multi-repo task does not.
  const settings = () => go({ kind: 'settings' });
  const latest = useRef({ open, showFolder, settings });
  useEffect(() => {
    latest.current = { open, showFolder, settings };
  });
  const offers = visible && !disabled && workspaceId === undefined;
  const commands = useMemo<Command[]>(() => {
    if (!offers) return [];
    const others = (opts?.editors ?? []).filter((e) => e.id !== opts?.chosen);
    // As in the menu: Visual Studio's solutions whenever it is installed and there is a choice of them (#94).
    const slns =
      opts?.editors.some((e) => e.id === 'visualstudio') &&
      opts.solutions.length > 1
        ? opts.solutions
        : [];
    return [
      // Before the editors are known the command opens with whichever is chosen; with none, it says so.
      opts && !opts.chosen
        ? {
            id: 'task.editor',
            title: 'No editor found: choose one in Settings',
            group: 'task',
            run: () => latest.current.settings(),
          }
        : {
            id: 'task.editor',
            title: 'Open in editor',
            group: 'task',
            run: () => latest.current.open(),
          },
      ...others.map((e): Command => ({
        id: `task.editor.${e.id}`,
        title: `Open in ${e.label}`,
        group: 'task',
        run: () => latest.current.open({ editorId: e.id }),
      })),
      ...slns.map((sln, i): Command => ({
        id: `task.editor.solution.${i}`,
        title: `Open ${fileName(sln)}`,
        group: 'task',
        run: () =>
          latest.current.open({ editorId: 'visualstudio', solution: sln }),
      })),
      {
        id: 'task.folder',
        title: 'Open folder',
        group: 'task',
        run: () => latest.current.showFolder(),
      },
    ];
  }, [offers, opts]);
  useContributeCommands('task.editor', commands);

  const chosen = opts?.chosen ?? null;
  const editors = chosen
    ? [
        ...(opts?.editors.filter((e) => e.id === chosen) ?? []),
        ...(opts?.editors.filter((e) => e.id !== chosen) ?? []),
      ]
    : [];
  // Visual Studio's solutions whenever it is installed, also when another editor is the choice (#94).
  const solutions =
    opts?.editors.some((e) => e.id === 'visualstudio') &&
    opts.solutions.length > 1
      ? opts.solutions
      : [];
  if (headless) return null;
  return (
    <span className="split-btn">
      <button
        type="button"
        className="btn btn-subtle btn-sm"
        disabled={disabled}
        title="Open the task's folder"
        onClick={showFolder}
      >
        <FolderOpen16Regular aria-hidden="true" />
        {/* A narrow task bar keeps the icon only; the text stays the button's name. */}
        <span className="open-in-label">Open folder</span>
      </button>
      <button
        ref={setAnchor}
        type="button"
        className="btn btn-subtle btn-sm"
        aria-label="Open in an editor"
        title="Open in an editor"
        aria-haspopup="menu"
        aria-expanded={menu}
        disabled={disabled}
        onClick={() => {
          if (!menu) setOpens((n) => n + 1);
          setMenu(!menu);
        }}
      >
        <Code16Regular aria-hidden="true" />
        <ChevronDown16Regular aria-hidden="true" />
      </button>
      <PopupMenu
        label="Open in editor"
        anchor={anchor}
        open={menu}
        onClose={close}
      >
        {editors.map((e) => (
          <button
            key={e.id}
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => open(e.id === chosen ? {} : { editorId: e.id })}
          >
            <span className="menu-title">{`Open in ${e.label}`}</span>
          </button>
        ))}
        {solutions.map((s) => (
          <button
            key={s}
            type="button"
            role="menuitem"
            className="menu-item"
            aria-label={`Open ${fileName(s)}`}
            onClick={() => open({ editorId: 'visualstudio', solution: s })}
          >
            <span className="menu-title">{`Open ${fileName(s)}`}</span>
            <span className="small muted mono">{s}</span>
          </button>
        ))}
        {opts && !chosen && (
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setMenu(false);
              go({ kind: 'settings' });
            }}
          >
            <span className="menu-title">
              No editor found: choose one in Settings
            </span>
          </button>
        )}
      </PopupMenu>
    </span>
  );
}
