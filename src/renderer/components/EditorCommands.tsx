// src/renderer/components/EditorCommands.tsx
import { useEffect, useMemo, useState } from 'react';
import { type EditorId, type EditorOptions } from '../../shared/editors';
import { useLatest } from '../hooks/useLatest';
import { api, tryInvoke } from '../api';
import { useContributeCommands } from '../commands/registry';
import type { Command } from '../commands/types';
import { useStore } from '../store';

const fileName = (p: string) => p.split(/[\\/]/).at(-1) ?? p;

/**
 * Offers the task's folder and editors as commands (the task menu and the palette list them); renders nothing.
 * Open folder shows the worktree in Explorer or Finder (#73); Open in editor uses the chosen editor (Visual Studio
 * opens the solution, or the folder when there is none); the other installed editors and Visual Studio's solutions
 * each get a command, and without any editor the command leads to Settings.
 */
export function EditorCommands({
  taskId,
  disabled,
  visible = true,
  refresh = 0,
}: {
  /** Another number looks for the editors again: the task menu passes one when it opens (#94). */
  refresh?: number;
  taskId: string;
  disabled?: boolean;
  /** A hidden task keeps its state; the options load again when it shows. */
  visible?: boolean;
}) {
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const [opts, setOpts] = useState<EditorOptions | null>(null);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    void api()
      // A refresh detects again, so an editor installed since shows up (#94).
      .invoke('editor:options', taskId, undefined, refresh > 0)
      .then((o) => {
        if (live) setOpts(o);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [taskId, visible, refresh]);

  const open = (o: { editorId?: EditorId; solution?: string } = {}) => {
    void tryInvoke(
      () => api().invoke('editor:openFolder', taskId, undefined, o),
      notify,
    );
  };

  const showFolder = () => {
    void tryInvoke(() => api().invoke('editor:showFolder', taskId), notify);
  };

  const settings = () => go({ kind: 'settings' });
  const latest = useLatest({ open, showFolder, settings });
  const offers = visible && !disabled;
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

  return null;
}
