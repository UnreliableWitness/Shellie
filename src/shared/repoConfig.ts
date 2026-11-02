import type { RepoOverrides, ShellieConfig } from './types';

export type OverrideKey = keyof RepoOverrides;
export type ConfigSource = 'default' | 'file' | 'override';

export const OVERRIDE_KEYS: readonly OverrideKey[] = [
  'base',
  'branch',
  'copy',
  'copyAgentConfig',
  'setup',
  'run',
  'apm',
  'reviewCollapse',
];

/**
 * Layers a repo's own overrides over what `.shellie.yml` gave (`base` is what
 * `loadShellieConfig` returned). `fileKeys` are the keys the file sets.
 * Base: override, then the file's, then the repo's stored base, then `base.base`.
 */
export function mergeConfig(
  base: ShellieConfig,
  opts: {
    overrides: RepoOverrides;
    repoBase: string | null;
    fileKeys: ReadonlySet<OverrideKey>;
  },
): { config: ShellieConfig; sources: Record<OverrideKey, ConfigSource> } {
  const { overrides, repoBase, fileKeys } = opts;
  const config: ShellieConfig = { ...base };
  const sources = {} as Record<OverrideKey, ConfigSource>;
  for (const k of OVERRIDE_KEYS) {
    sources[k] =
      overrides[k] !== undefined
        ? 'override'
        : fileKeys.has(k)
          ? 'file'
          : 'default';
  }
  if (overrides.base !== undefined) config.base = overrides.base;
  else if (!fileKeys.has('base') && repoBase) config.base = repoBase;
  if (overrides.branch !== undefined) config.branch = overrides.branch;
  if (overrides.copy !== undefined) config.copy = overrides.copy;
  if (overrides.copyAgentConfig !== undefined)
    config.copyAgentConfig = overrides.copyAgentConfig;
  if (overrides.setup !== undefined) config.setup = overrides.setup;
  if (overrides.run !== undefined) config.run = overrides.run;
  if (overrides.apm === 'auto') delete config.apm;
  else if (overrides.apm !== undefined) config.apm = overrides.apm;
  if (overrides.reviewCollapse !== undefined)
    config.reviewCollapse = overrides.reviewCollapse;
  return { config, sources };
}
