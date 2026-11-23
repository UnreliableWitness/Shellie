import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeWorkspaces } from '../../../shared/workspaces';
import type { TaskView } from '../../../shared/types';
import { useLatest } from '../../hooks/useLatest';
import { api, tryInvoke } from '../../api';
import { useContributeCommands } from '../../commands/registry';
import type { Command } from '../../commands/types';
import { useStore } from '../../store';

/**
 * Offers "Clean worktree" (the task menu and the palette list it), only while this task's copied env files still
 * hold keys Shellie now stores: it rewrites them without the keys and starts the task's secret tabs again. Renders
 * nothing.
 */
export function CleanWorktreeCommand({ task }: { task: TaskView }) {
  const notify = useStore((s) => s.notify);
  const [repoIds, setRepoIds] = useState<string[]>([]);
  // A clean under way: the command can be run again before it ends.
  const busy = useRef(false);
  const wanted = [...new Set(activeWorkspaces(task).map((w) => w.repoId))];
  const wantedKey = wanted.join(',');

  const check = useCallback(async () => {
    const dirty: string[] = [];
    for (const repoId of wantedKey.split(',').filter(Boolean)) {
      try {
        const st = await api().invoke('secrets:status', repoId);
        if (
          st.reasons.some(
            (r) => r.kind === 'worktrees' && r.taskIds.includes(task.id),
          )
        )
          dirty.push(repoId);
      } catch {
        // No status, no button.
      }
    }
    return dirty;
  }, [wantedKey, task.id]);

  useEffect(() => {
    let live = true;
    const run = () => void check().then((d) => live && setRepoIds(d));
    run();
    const off = api().on('secrets:changed', run);
    return () => {
      live = false;
      off();
    };
  }, [check]);

  const clean = async () => {
    if (busy.current) return;
    busy.current = true;
    // Main sends secrets.worktreesCleaned.
    for (const repoId of repoIds)
      await tryInvoke(
        () => api().invoke('secrets:cleanWorktrees', repoId, task.id),
        notify,
      );
    busy.current = false;
  };
  // Offered for as long as there is something to clean.
  const latest = useLatest(clean);
  const shows = repoIds.length > 0;
  const commands = useMemo<Command[]>(
    () =>
      shows
        ? [
            {
              id: 'task.cleanWorktree',
              title: 'Clean worktree',
              group: 'task',
              run: () => void latest.current(),
            },
          ]
        : [],
    [shows],
  );
  useContributeCommands('task.cleanWorktree', commands);
  return null;
}
