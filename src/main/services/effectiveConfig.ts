import type {
  Repo,
  RepoOverrides,
  ShellieConfig,
  Task,
} from '../../shared/types';
import {
  mergeConfig,
  type ConfigSource,
  type OverrideKey,
} from '../../shared/repoConfig';
import { samePath } from '../paths';
import {
  loadShellieFile,
  shellieDefaults,
  ShellieConfigError,
} from './ShellieConfig';

export type EffectiveConfig = ShellieConfig & {
  sources: Record<OverrideKey, ConfigSource>;
  /** The values `.shellie.yml` alone gives, for Settings' "file value" hints. */
  file: Partial<RepoOverrides>;
  /** Why the file could not be read (lenient loads only); null when it was fine or absent. */
  fileError: string | null;
};

export type EffectiveConfigDeps = {
  repos: () => Repo[];
  tasks: () => Task[];
  load?: typeof loadShellieFile;
};

/** The registered repo a path belongs to: its main checkout, or a task worktree (home or extra) of it. */
function repoFor(p: string, deps: EffectiveConfigDeps): Repo | undefined {
  const repos = deps.repos();
  const direct = repos.find((r) => samePath(r.path, p));
  if (direct) return direct;
  for (const t of deps.tasks()) {
    if (samePath(t.worktreePath, p))
      return repos.find((r) => r.id === t.repoId);
    const w = t.extraWorkspaces.find((x) => samePath(x.worktreePath, p));
    if (w) return repos.find((r) => r.id === w.repoId);
  }
  return undefined;
}

/**
 * `.shellie.yml` at `p` with the overrides of the repo it belongs to on top; an unknown path gets the file only.
 * A broken file throws unless `lenient` (Settings), which gets the defaults plus overrides and the error message.
 */
export async function loadEffectiveConfig(
  p: string,
  deps: EffectiveConfigDeps,
  opts: { lenient?: boolean } = {},
): Promise<EffectiveConfig> {
  const load = deps.load ?? loadShellieFile;
  let loaded: Awaited<ReturnType<typeof loadShellieFile>>;
  let fileError: string | null = null;
  try {
    loaded = await load(p);
  } catch (e) {
    if (!opts.lenient || !(e instanceof ShellieConfigError)) throw e;
    fileError = e.message;
    loaded = {
      config: await shellieDefaults(p, true),
      fileKeys: new Set(),
      file: {},
    };
  }
  const repo = repoFor(p, deps);
  const { config, sources } = mergeConfig(loaded.config, {
    overrides: repo?.overrides ?? {},
    // The stored base is refreshed only for repos without a file; with one, the live default branch stands.
    repoBase: loaded.config.found ? null : (repo?.baseBranch ?? null),
    fileKeys: loaded.fileKeys,
  });
  return { ...config, sources, file: loaded.file, fileError };
}
