import { useCallback, useEffect, useState } from 'react';
import type { ConfigSource, OverrideKey } from '../../../../shared/repoConfig';
import type { RepoOverrides, ShellieConfig } from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import { useStore } from '../../../store';

export type RepoSettings = {
  /** The effective config; null until the first load. */
  config: ShellieConfig | null;
  sources: Record<OverrideKey, ConfigSource> | null;
  file: Partial<RepoOverrides>;
  fileError: string | null;
  /** Stores an override (null resets it to the file's or the default value). */
  set<K extends OverrideKey>(
    key: K,
    value: RepoOverrides[K] | null,
  ): Promise<void>;
  reload(): Promise<void>;
};

/**
 * A repo's merged `.shellie.yml` settings with their sources, read while `enabled` (the scope is shown) and again on
 * every `repos:changed`.
 */
export function useRepoSettings(repoId: string, enabled = true): RepoSettings {
  const notify = useStore((s) => s.notify);
  const [state, setState] = useState<{
    config: ShellieConfig | null;
    sources: Record<OverrideKey, ConfigSource> | null;
    file: Partial<RepoOverrides>;
    fileError: string | null;
  }>({ config: null, sources: null, file: {}, fileError: null });

  const reload = useCallback(async () => {
    const result = await tryInvoke(
      () => api().invoke('repos:config', repoId),
      notify,
    );
    if (result)
      setState({
        config: result.config,
        sources: result.sources,
        file: result.file,
        fileError: result.fileError,
      });
  }, [repoId, notify]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    return api().on('repos:changed', () => void reload());
  }, [enabled, reload]);

  const set = useCallback(
    async <K extends OverrideKey>(key: K, value: RepoOverrides[K] | null) => {
      const ok = await tryInvoke(
        () => api().invoke('repos:setOverride', repoId, key, value),
        notify,
      );
      if (ok) await reload();
    },
    [repoId, notify, reload],
  );

  return { ...state, set, reload };
}

/** SettingRow props for a `.shellie.yml` key: the blue bar off the default, Reset only for your override. */
export function yamlRow(settings: RepoSettings, key: OverrideKey) {
  const source = settings.sources?.[key];
  if (!source) return { source: 'app' as const };
  return {
    source,
    modified: source !== 'default',
    onReset:
      source === 'override' ? () => void settings.set(key, null) : undefined,
  };
}
