import { useEffect, useState } from 'react';
import type { ShellieConfig } from '../../shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { errorMessage } from '../../shared/errors';

const cache = new Map<
  string,
  { config: ShellieConfig; worktreeRoot: string }
>();

/**
 * The effective .shellie.yml of a repo, cached per session and fetched again after `repos:changed` (a Settings
 * edit) while mounted. Returns null until loaded.
 */
export function useRepoConfig(repoId: string | null) {
  const notify = useStore((s) => s.notify);
  const [value, setValue] = useState(
    repoId ? (cache.get(repoId) ?? null) : null,
  );
  useEffect(() => {
    if (!repoId) return setValue(null);
    let live = true;
    const fetchConfig = () =>
      api()
        .invoke('repos:config', repoId)
        .then((r) => {
          cache.set(repoId, r);
          if (live) setValue(r);
        })
        .catch((e: unknown) => {
          if (!live) return;
          setValue(null);
          notify('error', errorMessage(e));
        });
    const hit = cache.get(repoId);
    if (hit) setValue(hit);
    else {
      setValue(null);
      void fetchConfig();
    }
    // Keeps the last value on screen while the new one loads.
    const off = api().on('repos:changed', () => {
      cache.delete(repoId);
      void fetchConfig();
    });
    return () => {
      live = false;
      off();
    };
  }, [repoId, notify]);
  return value;
}

export function invalidateRepoConfig(repoId?: string) {
  if (repoId) cache.delete(repoId);
  else cache.clear();
}
