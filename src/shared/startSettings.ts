import { StartSettingsSchema } from './types';
import type { Connection, Repo, StartSettings } from './types';

/** Where a repo's start settings come from: its own value, else its project's (connection), else the app default. */
export function startSettingsSource(
  repo: Pick<Repo, 'workItemOnStart'>,
  connection: Pick<Connection, 'workItemOnStart'> | null,
): 'repo' | 'project' | 'default' {
  if (repo.workItemOnStart) return 'repo';
  return connection ? 'project' : 'default';
}

/** The setup summary's start arguments: the effective settings, where they came from and the project's name. */
export function startOf(
  repo: Pick<Repo, 'workItemOnStart'>,
  connection: Pick<Connection, 'workItemOnStart' | 'project'> | null,
): {
  start: StartSettings;
  startSource: 'repo' | 'project' | 'default';
  project: string | null;
} {
  return {
    start: effectiveStartSettings(repo, connection),
    startSource: startSettingsSource(repo, connection),
    project: connection?.project ?? null,
  };
}

export function effectiveStartSettings(
  repo: Pick<Repo, 'workItemOnStart'>,
  connection: Pick<Connection, 'workItemOnStart'> | null,
): StartSettings {
  return (
    repo.workItemOnStart ??
    connection?.workItemOnStart ??
    StartSettingsSchema.parse({})
  );
}
