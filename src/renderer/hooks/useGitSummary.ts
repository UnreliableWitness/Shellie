import { useEffect, useState } from 'react';
import type { GitSummary } from '../../shared/types';
import { api } from '../api';

const POLL_MS = 5000;

export function useGitSummary(
  taskId: string,
  worktreeMissing: boolean,
  enabled = true,
  workspaceId?: string,
): GitSummary | null {
  const [git, setGit] = useState<GitSummary | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const refresh = () =>
      api()
        .invoke('tasks:gitSummary', taskId, workspaceId)
        .then((g) => {
          if (live) setGit(g);
        })
        .catch(() => {
          if (live) setGit(null);
        });
    void refresh();
    // Like the other polls, only while the window has focus; a return to it refreshes at once.
    const timer = setInterval(() => {
      if (document.hasFocus()) void refresh();
    }, POLL_MS);
    window.addEventListener('focus', refresh);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [taskId, worktreeMissing, enabled, workspaceId]);

  return git;
}
