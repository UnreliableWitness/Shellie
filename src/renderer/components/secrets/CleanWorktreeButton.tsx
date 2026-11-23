import { useCallback, useEffect, useMemo, useState } from 'react';
import { activeWorkspaces } from '../../../shared/workspaces';
import type { TaskView } from '../../../shared/types';
import { useLatest } from '../../hooks/useLatest';
import { api, tryInvoke } from '../../api';
import { useContributeCommands } from '../../commands/registry';
import type { Command } from '../../commands/types';
import { useStore } from '../../store';

/**
 * In the task bar, only while this task's copied env files still hold keys Shellie now stores: rewrites them
 * without the keys and starts the task's secret tabs again. Nothing otherwise.
 */
export function CleanWorktreeButton({
  task,
  headless = false,
}: {
  task: TaskView;
  /** No button: only offers its command (the task menu and the palette show it). */
  headless?: boolean;
}) {
  const notify = useStore((s) => s.notify);
  const [repoIds, setRepoIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
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
    // The command can be run again while the first clean is under way.
    if (busy) return;
    setBusy(true);
    // Main sends secrets.worktreesCleaned.
    for (const repoId of repoIds)
      await tryInvoke(
        () => api().invoke('secrets:cleanWorktrees', repoId, task.id),
        notify,
      );
    setBusy(false);
  };
  // Offered as a command for as long as the button shows.
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
  if (!shows || headless) return null;
  return (
    <button
      type="button"
      className="btn btn-sm"
      disabled={busy}
      title="Remove the stored keys from this worktree's copied env files and restart the tabs that use them"
      onClick={() => void clean()}
    >
      Clean worktree
    </button>
  );
}
